import type {
  CreatePropertyInput,
  PropertyDto,
  PropertyListItem,
  UpdatePropertyInput,
} from '@imob/contracts';
import { properties, withTenant, type Tx } from '@imob/db';
import { notFound, validationFailed } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { findNeighborhoodById } from '../catalog/repository.js';
import * as repo from './repository.js';

export interface ActorContext {
  tenantId: string;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/** numeric do Postgres chega como string; area e coordenada viram number na borda. */
const num = (value: string | null): number | null => (value === null ? null : Number(value));

function toDto(row: repo.PropertyRow, media: repo.PropertyMediaRow[]): PropertyDto {
  return {
    id: row.id,
    referenceCode: row.referenceCode,
    title: row.title,
    description: row.description,
    purpose: row.purpose,
    type: row.type,
    status: row.status,
    city: { id: row.cityId, name: row.cityName, uf: row.cityUf },
    neighborhood: {
      id: row.neighborhoodId,
      cityId: row.cityId,
      name: row.neighborhoodName,
      slug: row.neighborhoodSlug,
    },
    street: row.street,
    streetNumber: row.streetNumber,
    complement: row.complement,
    zip: row.zip,
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    bedrooms: row.bedrooms,
    suites: row.suites,
    bathrooms: row.bathrooms,
    parkingSpots: row.parkingSpots,
    areaTotal: num(row.areaTotal),
    areaBuilt: num(row.areaBuilt),
    salePriceCents: row.salePriceCents,
    rentPriceCents: row.rentPriceCents,
    condoFeeCents: row.condoFeeCents,
    iptuCents: row.iptuCents,
    currency: row.currency,
    acceptsExchange: row.acceptsExchange,
    isExclusive: row.isExclusive,
    publishedToNetwork: row.publishedToNetwork,
    media: media.map((m) => ({
      id: m.id,
      kind: m.kind,
      position: m.position,
      width: m.width,
      height: m.height,
      sanitizedAt: m.sanitizedAt?.toISOString() ?? null,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toListItem(row: repo.PropertyRow): PropertyListItem {
  return {
    id: row.id,
    referenceCode: row.referenceCode,
    title: row.title,
    purpose: row.purpose,
    type: row.type,
    status: row.status,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    parkingSpots: row.parkingSpots,
    areaBuilt: num(row.areaBuilt),
    salePriceCents: row.salePriceCents,
    rentPriceCents: row.rentPriceCents,
    publishedToNetwork: row.publishedToNetwork,
    updatedAt: row.updatedAt.toISOString(),
    neighborhood: { id: row.neighborhoodId, name: row.neighborhoodName },
  };
}

/**
 * Deriva a cidade a partir do bairro.
 *
 * A cidade nunca vem do cliente. Se viesse, seria possivel gravar um bairro de
 * Londrina carimbado com outra cidade, e o filtro por cidade passaria a mentir
 * -- sem erro, sem log, so com resultado errado.
 */
async function resolveLocation(neighborhoodId: string) {
  const neighborhood = await findNeighborhoodById(neighborhoodId);
  if (!neighborhood) {
    throw validationFailed({ neighborhoodId: 'Bairro não encontrado no catálogo.' });
  }
  return neighborhood;
}

export async function list(
  actor: ActorContext,
  options: { status?: string; search?: string; limit: number; offset: number },
): Promise<{ items: PropertyListItem[]; total: number }> {
  return withTenant(actor.tenantId, async (tx) => {
    const { rows, total } = await repo.listOwn(tx, options);
    return { items: rows.map(toListItem), total };
  });
}

export async function getById(actor: ActorContext, id: string): Promise<PropertyDto> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await repo.findById(tx, id);
    // 404 e nao 403: um 403 confirmaria que o imovel existe, e com uma
    // sequencia de ids daria para medir a carteira do concorrente.
    if (!row) throw notFound('Imóvel não encontrado.');
    const media = await repo.findMedia(tx, id);
    return toDto(row, media);
  });
}

export async function create(
  actor: ActorContext,
  input: CreatePropertyInput,
): Promise<PropertyDto> {
  const neighborhood = await resolveLocation(input.neighborhoodId);

  return withTenant(actor.tenantId, async (tx) => {
    const { id } = await repo.insertProperty(tx, {
      ...toColumns(input),
      // title e type sao obrigatorios na criacao; o schema de entrada garante
      // que existem, entao vao explicitos para o tipo do insert fechar.
      title: input.title,
      type: input.type,
      tenantId: actor.tenantId,
      createdBy: actor.userId,
      cityId: neighborhood.cityId,
      neighborhoodId: neighborhood.id,
    });

    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'property.created',
      entityType: 'property',
      entityId: id,
      metadata: { title: input.title, status: input.status },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });

    return loadOrFail(tx, id);
  });
}

export async function update(
  actor: ActorContext,
  id: string,
  input: UpdatePropertyInput,
): Promise<PropertyDto> {
  const location =
    input.neighborhoodId === undefined ? null : await resolveLocation(input.neighborhoodId);

  return withTenant(actor.tenantId, async (tx) => {
    const values = {
      ...toColumns(input),
      ...(location
        ? { cityId: location.cityId, neighborhoodId: location.id }
        : {}),
    };

    const affected = await repo.updateProperty(tx, id, values);
    // Zero linhas significa "nao existe OU e de outro parceiro" -- o RLS nao
    // distingue os dois casos, e essa e a resposta certa para ambos.
    if (affected === 0) throw notFound('Imóvel não encontrado.');

    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'property.updated',
      entityType: 'property',
      entityId: id,
      metadata: { fields: Object.keys(input) },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });

    return loadOrFail(tx, id);
  });
}

export async function remove(actor: ActorContext, id: string): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    const affected = await repo.softDelete(tx, id);
    if (affected === 0) throw notFound('Imóvel não encontrado.');

    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'property.deleted',
      entityType: 'property',
      entityId: id,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  });
}

async function loadOrFail(tx: Tx, id: string): Promise<PropertyDto> {
  const row = await repo.findById(tx, id);
  if (!row) throw notFound('Imóvel não encontrado.');
  const media = await repo.findMedia(tx, id);
  return toDto(row, media);
}

/**
 * Converte a entrada validada para colunas.
 *
 * Escrito campo a campo, e nao por copia generica: um Record<string, unknown>
 * compila, mas apaga os tipos e deixa passar coluna inexistente ou tipo
 * errado direto para o INSERT.
 *
 * Campos ausentes continuam ausentes -- update parcial nao apaga o que nao
 * foi enviado. numeric vai como string para o valor nao passar por float no
 * caminho.
 */
type PropertyColumns = Partial<typeof properties.$inferInsert>;

const asNumeric = (value: number | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value === null ? null : String(value);

function toColumns(input: Partial<CreatePropertyInput>): PropertyColumns {
  const values: PropertyColumns = {};

  if (input.title !== undefined) values.title = input.title;
  if (input.description !== undefined) values.description = input.description;
  if (input.referenceCode !== undefined) values.referenceCode = input.referenceCode;
  if (input.purpose !== undefined) values.purpose = input.purpose;
  if (input.type !== undefined) values.type = input.type;
  if (input.status !== undefined) values.status = input.status;

  if (input.street !== undefined) values.street = input.street;
  if (input.streetNumber !== undefined) values.streetNumber = input.streetNumber;
  if (input.complement !== undefined) values.complement = input.complement;
  if (input.zip !== undefined) values.zip = input.zip;

  if (input.bedrooms !== undefined) values.bedrooms = input.bedrooms;
  if (input.suites !== undefined) values.suites = input.suites;
  if (input.bathrooms !== undefined) values.bathrooms = input.bathrooms;
  if (input.parkingSpots !== undefined) values.parkingSpots = input.parkingSpots;

  if (input.salePriceCents !== undefined) values.salePriceCents = input.salePriceCents;
  if (input.rentPriceCents !== undefined) values.rentPriceCents = input.rentPriceCents;
  if (input.condoFeeCents !== undefined) values.condoFeeCents = input.condoFeeCents;
  if (input.iptuCents !== undefined) values.iptuCents = input.iptuCents;

  if (input.acceptsExchange !== undefined) values.acceptsExchange = input.acceptsExchange;
  if (input.isExclusive !== undefined) values.isExclusive = input.isExclusive;
  if (input.publishedToNetwork !== undefined) {
    values.publishedToNetwork = input.publishedToNetwork;
  }

  const areaTotal = asNumeric(input.areaTotal);
  if (areaTotal !== undefined) values.areaTotal = areaTotal;
  const areaBuilt = asNumeric(input.areaBuilt);
  if (areaBuilt !== undefined) values.areaBuilt = areaBuilt;
  const latitude = asNumeric(input.latitude);
  if (latitude !== undefined) values.latitude = latitude;
  const longitude = asNumeric(input.longitude);
  if (longitude !== undefined) values.longitude = longitude;

  return values;
}
