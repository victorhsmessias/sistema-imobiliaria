import { createHash } from 'node:crypto';
import type {
  ImportItemDto,
  ImportItemStatus,
  ImportJobDto,
  ImportSourceDto,
  ImportSourceInput,
  ImportStats,
  PropertyType,
} from '@imob/contracts';
import {
  slugify,
  withTenant,
  type ImportItem,
  type ImportJob,
  type ImportSource,
  type NewProperty,
  type Property,
  type Tx,
} from '@imob/db';
import { AppError, notFound, validationFailed } from '../../lib/errors.js';
import { processPropertyImage } from '../../lib/image.js';
import { FetchFailedError, safeFetch, UnsafeUrlError } from '../../lib/safe-fetch.js';
import { buildStorageKey, deleteObject, putObject } from '../../lib/storage.js';
import { recordAudit } from '../audit/service.js';
import { resolveNeighborhood } from '../catalog/repository.js';
import * as mediaRepo from '../media/repository.js';
import * as propertyRepo from '../properties/repository.js';
import type { ActorContext } from '../properties/service.js';
import { viaCepLookup, type CepLookup, type CepResult } from './cep.js';
import { resolvePropertyType } from './property-types.js';
import * as repo from './repository.js';
import {
  decodeXml,
  FeedFormatError,
  parseVrSyncFeed,
  type NormalizedListing,
  type NormalizedLocation,
  type ParsedListing,
  type ParsedMedia,
} from './vrsync-parser.js';

/**
 * Importacao de carteira via XML VrSync.
 *
 * Fluxo de uma execucao:
 *  1. le o feed (URL da fonte, via safeFetch, ou arquivo enviado);
 *  2. para cada <Listing>: resolve cidade e bairro (nome, alias, CEP), traduz
 *     o tipo, compara com o que ja foi importado e grava -- ou so relata, no
 *     dry-run;
 *  3. sincroniza as fotos do <Media>: baixa as novas, re-hospeda sob chave
 *     opaca depois do strip de EXIF, remove as que sairam do feed;
 *  4. arquiva o que estava na fonte e sumiu do feed.
 *
 * As fotos do XML NUNCA sao servidas pela URL original: ela aponta para o
 * dominio da imobiliaria e entregaria o dono no HTML da busca.
 *
 * Nada aqui cai por um anuncio ruim: cada problema vira um item no relatorio
 * (import_items), e o job so falha inteiro quando o feed em si e inutilizavel.
 */

export interface ImportDeps {
  fetchFeed: (url: string) => Promise<string>;
  fetchImage: (url: string) => Promise<Buffer>;
  cepLookup: CepLookup;
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  deleteObject: (key: string) => Promise<void>;
}

const FEED_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

export const defaultDeps: ImportDeps = {
  async fetchFeed(url) {
    const { body } = await safeFetch(url, {
      maxBytes: FEED_MAX_BYTES,
      timeoutMs: 60_000,
      accept: (type) => type === null || /xml|text\/plain|octet-stream/.test(type),
    });
    return decodeXml(body);
  },
  async fetchImage(url) {
    const { body } = await safeFetch(url, {
      maxBytes: IMAGE_MAX_BYTES,
      timeoutMs: 20_000,
      // Muito servidor de imagem responde octet-stream. Quem decide se e foto
      // de verdade e o sharp, logo em seguida.
      accept: (type) =>
        type === null || type.startsWith('image/') || type === 'application/octet-stream',
    });
    return body;
  },
  cepLookup: viaCepLookup,
  putObject,
  deleteObject,
};

type Changes = Record<string, { from: unknown; to: unknown }>;

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const emptyStats = (): ImportStats => ({
  listings: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  archived: 0,
  skipped: 0,
  needsCuration: 0,
  failed: 0,
  photosDownloaded: 0,
  photosReused: 0,
  photosFailed: 0,
  photosRemoved: 0,
});

const STAT_BY_STATUS: Record<ImportItemStatus, keyof ImportStats> = {
  created: 'created',
  updated: 'updated',
  unchanged: 'unchanged',
  archived: 'archived',
  skipped: 'skipped',
  needs_curation: 'needsCuration',
  failed: 'failed',
};

const TYPE_TITLES: Record<PropertyType, string> = {
  apartamento: 'Apartamento',
  casa: 'Casa',
  casa_condominio: 'Casa em condomínio',
  terreno: 'Terreno',
  sala_comercial: 'Sala comercial',
  galpao: 'Galpão',
  loja: 'Loja',
  sitio_chacara: 'Sítio ou chácara',
  outro: 'Imóvel',
};

/** Texto que pode ir para o relatorio: erro nosso sim; mensagem de driver ou SQL, nunca. */
function safeMessage(error: unknown, fallback: string): string {
  if (
    error instanceof FeedFormatError ||
    error instanceof UnsafeUrlError ||
    error instanceof FetchFailedError ||
    error instanceof AppError
  ) {
    return error.message;
  }
  return fallback;
}

// -- DTOs ------------------------------------------------------------------------

function toSourceDto(row: ImportSource): ImportSourceDto {
  return {
    id: row.id,
    name: row.name,
    format: 'vrsync',
    feedUrl: row.feedUrl,
    publishToNetwork: row.publishToNetwork,
    active: row.active,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toJobDto(row: ImportJob): ImportJobDto {
  return {
    id: row.id,
    sourceId: row.sourceId,
    status: row.status,
    dryRun: row.dryRun,
    stats: row.stats as Partial<ImportStats>,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toItemDto(row: ImportItem): ImportItemDto {
  const needsReview = row.status === 'needs_curation' || row.status === 'failed';
  return {
    id: row.id,
    externalId: row.externalId,
    propertyId: row.propertyId,
    status: row.status,
    changes: row.changes as Changes,
    warnings: row.warnings as string[],
    errors: row.errors as string[],
    ...(needsReview ? { rawPayload: row.rawPayload } : {}),
  };
}

// -- Fontes e consultas --------------------------------------------------------

export async function createSource(actor: ActorContext, input: ImportSourceInput): Promise<ImportSourceDto> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await repo.insertSource(tx, {
      tenantId: actor.tenantId,
      name: input.name,
      feedUrl: input.feedUrl,
      publishToNetwork: input.publishToNetwork,
      createdBy: actor.userId,
    });
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'import_source.created',
      entityType: 'import_source',
      entityId: row.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return toSourceDto(row);
  });
}

export async function listSources(actor: ActorContext): Promise<ImportSourceDto[]> {
  return withTenant(actor.tenantId, async (tx) => (await repo.listSources(tx)).map(toSourceDto));
}

export async function getJob(actor: ActorContext, jobId: string): Promise<ImportJobDto> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await repo.findJob(tx, jobId);
    // 404 tambem para execucao de outro parceiro: o RLS nao distingue, e nem deveria.
    if (!row) throw notFound('Importação não encontrada.');
    return toJobDto(row);
  });
}

export async function listItems(
  actor: ActorContext,
  jobId: string,
  status?: ImportItemStatus,
): Promise<ImportItemDto[]> {
  return withTenant(actor.tenantId, async (tx) => {
    if (!(await repo.findJob(tx, jobId))) throw notFound('Importação não encontrada.');
    return (await repo.listItems(tx, jobId, status)).map(toItemDto);
  });
}

// -- Execucao --------------------------------------------------------------------

/**
 * Cria a execucao e dispara o processamento.
 *
 * Devolve o job ja criado e a promessa do termino. A rota responde 202 com o
 * job; a suite de testes espera `done`. Quando a fila (pg-boss) entrar, e so
 * `done` que muda de dono -- o resto do fluxo continua igual.
 */
export async function startJob(
  actor: ActorContext,
  sourceId: string,
  options: { dryRun: boolean; xml?: string },
  deps: ImportDeps = defaultDeps,
): Promise<{ job: ImportJobDto; done: Promise<ImportJobDto> }> {
  const job = await withTenant(actor.tenantId, async (tx) => {
    const source = await repo.findSource(tx, sourceId);
    if (!source) throw notFound('Feed não encontrado.');
    if (!source.active) throw validationFailed({ source: 'Este feed está desativado.' });
    if (options.xml === undefined && !source.feedUrl) {
      throw validationFailed({ feedUrl: 'Este feed não tem URL cadastrada. Envie o arquivo XML.' });
    }
    if (await repo.hasActiveJob(tx, sourceId)) {
      throw validationFailed({ source: 'Já existe uma importação em andamento para este feed.' });
    }
    return repo.insertJob(tx, {
      tenantId: actor.tenantId,
      sourceId,
      dryRun: options.dryRun,
      createdBy: actor.userId,
    });
  });

  return { job: toJobDto(job), done: runJob(actor, job.id, options.xml, deps) };
}

interface RunContext {
  actor: ActorContext;
  source: ImportSource;
  jobId: string;
  dryRun: boolean;
  deps: ImportDeps;
  stats: ImportStats;
  mappings: Map<string, PropertyType>;
  cities: Map<string, { id: string; slug: string } | null>;
  neighborhoods: Map<string, { id: string; name: string } | null>;
  ceps: Map<string, CepResult | null>;
}

const externalSourceOf = (source: ImportSource): string => `import:${source.id}`;

async function runJob(
  actor: ActorContext,
  jobId: string,
  xml: string | undefined,
  deps: ImportDeps,
): Promise<ImportJobDto> {
  const { job, source } = await withTenant(actor.tenantId, async (tx) => {
    const found = await repo.findJob(tx, jobId);
    const foundSource = found ? await repo.findSource(tx, found.sourceId) : null;
    if (!found || !foundSource) throw notFound('Importação não encontrada.');
    await repo.updateJob(tx, jobId, { status: 'running', startedAt: new Date() });
    return { job: found, source: foundSource };
  });

  const stats = emptyStats();

  try {
    const content = xml ?? (await deps.fetchFeed(source.feedUrl!));
    const feed = parseVrSyncFeed(content);
    stats.listings = feed.listings.length + feed.rejected.length;

    const ctx: RunContext = {
      actor,
      source,
      jobId,
      dryRun: job.dryRun,
      deps,
      stats,
      mappings: await repo.loadPropertyTypeMappings(),
      cities: new Map(),
      neighborhoods: new Map(),
      ceps: new Map(),
    };

    for (const rejected of feed.rejected) {
      await withTenant(actor.tenantId, (tx) =>
        recordItem(ctx, tx, {
          externalId: rejected.externalId,
          status: 'failed',
          errors: rejected.errors,
          rawPayload: rejected.raw,
        }),
      );
    }

    for (const listing of feed.listings) {
      await importListing(ctx, listing);
    }

    // Feed sem nenhum anuncio valido e mais provavelmente exportacao quebrada
    // do que carteira zerada: nao arquiva nada nesse caso.
    if (feed.listings.length > 0) {
      const present = new Set<string>(feed.listings.map((l) => l.externalId));
      for (const rejected of feed.rejected) if (rejected.externalId) present.add(rejected.externalId);
      await archiveMissing(ctx, present);
    }

    const finished = await withTenant(actor.tenantId, async (tx) => {
      const row = await repo.updateJob(tx, jobId, { status: 'succeeded', stats, finishedAt: new Date() });
      await repo.touchSource(tx, source.id);
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: job.dryRun ? 'import.dry_run' : 'import.completed',
        entityType: 'import_job',
        entityId: jobId,
        metadata: { ...stats },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return row;
    });
    return toJobDto(finished);
  } catch (error) {
    const failed = await withTenant(actor.tenantId, (tx) =>
      repo.updateJob(tx, jobId, {
        status: 'failed',
        stats,
        error: safeMessage(error, 'Falha inesperada na importação.'),
        finishedAt: new Date(),
      }),
    );
    return toJobDto(failed);
  }
}

async function recordItem(
  ctx: RunContext,
  tx: Tx,
  item: {
    externalId: string | null;
    status: ImportItemStatus;
    propertyId?: string | null;
    changes?: Changes;
    warnings?: string[];
    errors?: string[];
    rawPayload: unknown;
  },
): Promise<void> {
  await repo.insertItem(tx, {
    tenantId: ctx.actor.tenantId,
    jobId: ctx.jobId,
    externalId: item.externalId,
    propertyId: item.propertyId ?? null,
    status: item.status,
    changes: item.changes ?? {},
    warnings: item.warnings ?? [],
    errors: item.errors ?? [],
    rawPayload: item.rawPayload ?? {},
  });
  ctx.stats[STAT_BY_STATUS[item.status]]++;
}

async function importListing(ctx: RunContext, listing: ParsedListing): Promise<void> {
  const warnings = [...listing.warnings];
  const base = { externalId: listing.externalId, rawPayload: listing.raw };

  try {
    const location = await resolveLocation(ctx, listing.data.location, warnings);
    if ('curation' in location) {
      await withTenant(ctx.actor.tenantId, (tx) =>
        recordItem(ctx, tx, { ...base, status: 'needs_curation', warnings, errors: [location.curation] }),
      );
      return;
    }

    const { type, matchedKey } = resolvePropertyType(listing.data.propertyTypeRaw, ctx.mappings);
    if (!matchedKey) {
      warnings.push(
        listing.data.propertyTypeRaw
          ? `PropertyType "${listing.data.propertyTypeRaw}" sem tradução cadastrada; importado como "outro".`
          : 'PropertyType ausente; importado como "outro".',
      );
    }

    const columns = toColumns(listing.data, type, location);
    const externalSource = externalSourceOf(ctx.source);

    const outcome = await withTenant(ctx.actor.tenantId, async (tx) => {
      const existing = await repo.findImportedProperty(tx, externalSource, listing.externalId);

      if (existing?.deletedAt) {
        return { status: 'skipped' as const, propertyId: existing.id, changes: {} as Changes };
      }

      if (!existing) {
        if (ctx.dryRun) return { status: 'created' as const, propertyId: null, changes: {} as Changes };
        const { id } = await propertyRepo.insertProperty(tx, {
          ...columns,
          tenantId: ctx.actor.tenantId,
          createdBy: ctx.actor.userId,
          status: 'active',
          publishedToNetwork: ctx.source.publishToNetwork,
          externalSource,
          externalId: listing.externalId,
        });
        return { status: 'created' as const, propertyId: id, changes: {} as Changes };
      }

      const changes = diffColumns(existing, columns);
      // Saiu do feed, foi arquivado, e voltou: volta ao ar.
      if (existing.status === 'archived') changes.status = { from: 'archived', to: 'active' };

      if (Object.keys(changes).length === 0) {
        return { status: 'unchanged' as const, propertyId: existing.id, changes };
      }
      if (!ctx.dryRun) {
        await propertyRepo.updateProperty(tx, existing.id, {
          ...columns,
          ...(changes.status ? { status: 'active' as const } : {}),
        });
      }
      return { status: 'updated' as const, propertyId: existing.id, changes };
    });

    let status: ImportItemStatus = outcome.status;
    const changes: Changes = { ...outcome.changes };

    if (outcome.status === 'skipped') {
      warnings.push('Imóvel excluído na plataforma; a importação não o recria.');
    } else if (!ctx.dryRun && outcome.propertyId) {
      const photos = await syncMedia(ctx, outcome.propertyId, listing.data.media, warnings);
      if (photos.added > 0 || photos.removed > 0) {
        changes.fotos = { from: photos.before, to: photos.after };
        if (status === 'unchanged') status = 'updated';
      }
    }

    await withTenant(ctx.actor.tenantId, (tx) =>
      recordItem(ctx, tx, { ...base, status, propertyId: outcome.propertyId, changes, warnings }),
    );
  } catch (error) {
    await withTenant(ctx.actor.tenantId, (tx) =>
      recordItem(ctx, tx, {
        ...base,
        status: 'failed',
        warnings,
        errors: [safeMessage(error, 'Erro inesperado ao gravar o anúncio.')],
      }),
    );
  }
}

interface ResolvedLocation {
  cityId: string;
  neighborhoodId: string;
  neighborhoodName: string;
}

/**
 * Cidade e bairro do catalogo para o <Location> do feed.
 *
 * Bairro: nome como veio (slug e aliases) e, se nao casar, o bairro que o CEP
 * indica -- desde que o CEP seja da mesma cidade. Sem correspondencia, o
 * anuncio vai para curadoria: criar bairro automaticamente traria de volta
 * "Jd. America" e "Jardim America" como dois bairros, e o filtro que e o
 * produto passaria a esconder imoveis sem erro nenhum.
 */
async function resolveLocation(
  ctx: RunContext,
  location: NormalizedLocation,
  warnings: string[],
): Promise<ResolvedLocation | { curation: string }> {
  if (!location.city || !location.stateAbbr) {
    return { curation: 'Cidade ou UF ausente em <Location>.' };
  }

  const cityKey = `${location.stateAbbr}|${location.city}`;
  if (!ctx.cities.has(cityKey)) {
    ctx.cities.set(cityKey, await repo.findCity(location.stateAbbr, location.city));
  }
  const city = ctx.cities.get(cityKey);
  if (!city) {
    return { curation: `Cidade fora do catálogo: ${location.city}/${location.stateAbbr}.` };
  }

  if (location.neighborhood) {
    const byName = await cachedNeighborhood(ctx, city.id, location.neighborhood);
    if (byName) return { cityId: city.id, neighborhoodId: byName.id, neighborhoodName: byName.name };
  }

  if (location.postalCode) {
    if (!ctx.ceps.has(location.postalCode)) {
      ctx.ceps.set(location.postalCode, await ctx.deps.cepLookup(location.postalCode));
    }
    const cep = ctx.ceps.get(location.postalCode);
    const sameCity = cep?.uf === location.stateAbbr && slugify(cep?.city ?? '') === city.slug;

    if (cep?.neighborhood && sameCity) {
      const byCep = await cachedNeighborhood(ctx, city.id, cep.neighborhood);
      if (byCep) {
        warnings.push(
          `Bairro "${location.neighborhood ?? '(vazio)'}" não reconhecido; resolvido pelo CEP como "${byCep.name}".`,
        );
        return { cityId: city.id, neighborhoodId: byCep.id, neighborhoodName: byCep.name };
      }
    }
  }

  return {
    curation: location.neighborhood
      ? `Bairro não reconhecido no catálogo: "${location.neighborhood}" (${location.city}/${location.stateAbbr}). Cadastre o bairro ou um alias.`
      : 'Bairro ausente e sem CEP que o identifique.',
  };
}

async function cachedNeighborhood(
  ctx: RunContext,
  cityId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const key = `${cityId}|${name}`;
  if (!ctx.neighborhoods.has(key)) {
    const match = await resolveNeighborhood(cityId, name);
    ctx.neighborhoods.set(key, match ? { id: match.neighborhood.id, name: match.neighborhood.name } : null);
  }
  return ctx.neighborhoods.get(key) ?? null;
}

const numericText = (value: number | null): string | null => (value === null ? null : String(value));

function toColumns(data: NormalizedListing, type: PropertyType, location: ResolvedLocation) {
  return {
    title:
      data.title && data.title.length >= 3
        ? data.title
        : `${TYPE_TITLES[type]} em ${location.neighborhoodName}`,
    description: data.description,
    referenceCode: data.externalId.slice(0, 60),
    purpose: data.purpose,
    type,
    cityId: location.cityId,
    neighborhoodId: location.neighborhoodId,
    street: data.location.street,
    streetNumber: data.location.streetNumber,
    complement: data.location.complement,
    zip: data.location.postalCode,
    latitude: numericText(data.location.latitude),
    longitude: numericText(data.location.longitude),
    bedrooms: data.bedrooms,
    suites: data.suites,
    bathrooms: data.bathrooms,
    parkingSpots: data.parkingSpots,
    areaBuilt: numericText(data.areaBuilt),
    areaTotal: numericText(data.areaTotal),
    salePriceCents: data.salePriceCents,
    rentPriceCents: data.rentPriceCents,
    condoFeeCents: data.condoFeeCents,
    iptuCents: data.iptuCents,
  } satisfies Partial<NewProperty>;
}

// numeric chega do banco como "92.00"; do feed, como "92".
const NUMERIC_COLUMNS = new Set(['latitude', 'longitude', 'areaBuilt', 'areaTotal']);

function comparable(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return NUMERIC_COLUMNS.has(key) ? Number(value) : value;
}

function diffColumns(existing: Property, next: ReturnType<typeof toColumns>): Changes {
  const current = existing as unknown as Record<string, unknown>;
  const changes: Changes = {};
  for (const [key, value] of Object.entries(next)) {
    if (comparable(key, current[key]) !== comparable(key, value)) {
      changes[key] = { from: current[key] ?? null, to: value ?? null };
    }
  }
  return changes;
}

/**
 * Sincroniza as fotos do <Media> com as fotos importadas do imovel.
 *
 * A identidade de uma foto entre execucoes e o hash da URL de origem: a mesma
 * URL nao e baixada de novo. Foto nova e baixada por safeFetch, passa por
 * processPropertyImage (resize, WebP, sem EXIF) e sobe sob chave opaca; so
 * entao ganha linha, ja com sanitized_at. Foto que saiu do feed sai do imovel.
 * Fotos enviadas pela tela nao sao tocadas -- so vao para depois das do feed.
 */
async function syncMedia(
  ctx: RunContext,
  propertyId: string,
  media: ParsedMedia[],
  warnings: string[],
): Promise<{ added: number; removed: number; before: number; after: number }> {
  const tenantId = ctx.actor.tenantId;
  const desired = media.map((item, position) => ({ ...item, position, hash: sha256(item.url) }));

  const current = await withTenant(tenantId, (tx) => repo.listMediaForSync(tx, propertyId));
  const importedHashes = new Set(
    current.map((m) => m.sourceUrlHash).filter((hash): hash is string => hash !== null),
  );

  const uploads: Array<{
    item: (typeof desired)[number];
    storageKey: string;
    image: Awaited<ReturnType<typeof processPropertyImage>>;
    contentSha256: string;
  }> = [];

  for (const item of desired) {
    if (importedHashes.has(item.hash)) {
      ctx.stats.photosReused++;
      continue;
    }
    try {
      const bytes = await ctx.deps.fetchImage(item.url);
      const image = await processPropertyImage(bytes);
      const storageKey = buildStorageKey('webp');
      await ctx.deps.putObject(storageKey, image.buffer, image.contentType);
      uploads.push({ item, storageKey, image, contentSha256: sha256(bytes) });
      ctx.stats.photosDownloaded++;
    } catch (error) {
      ctx.stats.photosFailed++;
      warnings.push(`Foto ${item.position + 1} não importada: ${safeMessage(error, 'falha inesperada.')}`);
    }
  }

  const wanted = new Set(desired.map((d) => d.hash));
  const removed = current.filter((m) => m.sourceUrlHash !== null && !wanted.has(m.sourceUrlHash));
  const order = new Map(desired.map((d) => [d.hash, d.position]));

  try {
    await withTenant(tenantId, async (tx) => {
      for (const upload of uploads) {
        await mediaRepo.insertMedia(tx, {
          tenantId,
          propertyId,
          storageKey: upload.storageKey,
          kind: 'photo',
          position: upload.item.position,
          width: upload.image.width,
          height: upload.image.height,
          byteSize: upload.image.byteSize,
          contentType: upload.image.contentType,
          sourceUrl: upload.item.url,
          sourceUrlHash: upload.item.hash,
          contentSha256: upload.contentSha256,
          caption: upload.item.caption,
          // A sanitizacao ja aconteceu, sincrona, em processPropertyImage().
          sanitizedAt: new Date(),
        });
      }
      for (const media of removed) await mediaRepo.deleteMedia(tx, media.id);

      // Fotos do feed na ordem do feed (a principal primeiro); as enviadas pela
      // tela vem depois, na ordem que ja tinham.
      const all = await repo.listMediaForSync(tx, propertyId);
      const fromFeed = all
        .filter((m) => m.sourceUrlHash !== null)
        .sort((a, b) => (order.get(a.sourceUrlHash!) ?? 0) - (order.get(b.sourceUrlHash!) ?? 0));
      const manual = all.filter((m) => m.sourceUrlHash === null);
      for (const [index, m] of [...fromFeed, ...manual].entries()) {
        if (m.position !== index) await mediaRepo.setPosition(tx, m.id, index);
      }
    });
  } catch (error) {
    // Os objetos ja subiram; sem linha apontando para eles, virariam lixo no bucket.
    for (const upload of uploads) await ctx.deps.deleteObject(upload.storageKey).catch(() => undefined);
    throw error;
  }

  // Depois do commit, como na exclusao pela tela.
  for (const media of removed) await ctx.deps.deleteObject(media.storageKey).catch(() => undefined);
  ctx.stats.photosRemoved += removed.length;

  const before = importedHashes.size;
  return { added: uploads.length, removed: removed.length, before, after: before + uploads.length - removed.length };
}

/** O que a fonte trouxe antes e sumiu deste feed sai do ar (arquivado, nao excluido). */
async function archiveMissing(ctx: RunContext, present: Set<string>): Promise<void> {
  await withTenant(ctx.actor.tenantId, async (tx) => {
    const imported = await repo.listImportedProperties(tx, externalSourceOf(ctx.source));
    for (const property of imported) {
      if (property.externalId === null || present.has(property.externalId)) continue;
      // Vendido ou ja arquivado: nada a fazer.
      if (property.status === 'archived' || property.status === 'sold_rented') continue;

      if (!ctx.dryRun) await propertyRepo.updateProperty(tx, property.id, { status: 'archived' });
      await recordItem(ctx, tx, {
        externalId: property.externalId,
        status: 'archived',
        propertyId: property.id,
        changes: { status: { from: property.status, to: 'archived' } },
        warnings: ['Saiu do feed: o imóvel foi arquivado e deixou a busca da rede.'],
        rawPayload: {},
      });
    }
  });
}
