import { closeDb } from '@imob/db';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readMetadata } from '../src/lib/image.js';
import { FetchFailedError } from '../src/lib/safe-fetch.js';
import { deleteObject, putObject, signedReadUrl } from '../src/lib/storage.js';
import type { ActorContext } from '../src/modules/properties/service.js';
import * as imports from '../src/modules/imports/service.js';
import { loginAs, withOracle } from './helpers.js';

/**
 * Importacao de carteira via XML VrSync, de ponta a ponta contra Postgres e
 * MinIO reais. So a rede externa e substituida: o download das fotos devolve
 * um JPEG com EXIF, e o CEP e resolvido por uma tabela fixa.
 */

const ALFA = 'admin@alfa.test';
const ALFA_CORRETOR = 'corretor@alfa.test';
const BETA = 'admin@beta.test';

const FOTOS = 'https://fotos.alfa-imoveis.test';

async function fotoComExif(): Promise<Buffer> {
  return sharp({
    create: { width: 1000, height: 750, channels: 3, background: { r: 120, g: 150, b: 90 } },
  })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'Alfa Imoveis Londrina', Artist: 'Fotografo Alfa' } })
    .toBuffer();
}

interface Anuncio {
  id?: string;
  transaction: string;
  type: string;
  neighborhood: string;
  zone?: string;
  postalCode?: string;
  listPrice?: string;
  rentalPrice?: string;
  iptuMensal?: string;
  fotos?: Array<{ url: string; primary?: boolean; caption?: string }>;
}

function feed(anuncios: Anuncio[]): string {
  const listing = (a: Anuncio) => `
    <Listing>
      ${a.id ? `<ListingID>${a.id}</ListingID>` : ''}
      <Title><![CDATA[Anuncio ${a.id ?? 'sem id'} da Alfa Imoveis]]></Title>
      <TransactionType>${a.transaction}</TransactionType>
      <Media>
        ${(a.fotos ?? [])
          .map(
            (f) =>
              `<Item medium="image"${f.caption ? ` caption="${f.caption}"` : ''}${f.primary ? ' primary="true"' : ''}>${f.url}</Item>`,
          )
          .join('\n        ')}
        <Item medium="video">https://www.youtube.com/watch?v=alfaimoveis</Item>
      </Media>
      <Details>
        <PropertyType>${a.type}</PropertyType>
        <Description><![CDATA[Falar com Renata Alves, da Alfa Imoveis.]]></Description>
        ${a.listPrice ? `<ListPrice currency="BRL">${a.listPrice}</ListPrice>` : ''}
        ${a.rentalPrice ? `<RentalPrice currency="BRL" period="Monthly">${a.rentalPrice}</RentalPrice>` : ''}
        ${a.iptuMensal ? `<Iptu currency="BRL" period="Monthly">${a.iptuMensal}</Iptu>` : ''}
        <LivingArea unit="square metres">120</LivingArea>
        <Bedrooms>3</Bedrooms><Bathrooms>2</Bathrooms><Suites>1</Suites><Garage>2</Garage>
      </Details>
      <Location displayAddress="Neighborhood">
        <Country abbreviation="BR">Brasil</Country>
        <State abbreviation="PR">Paraná</State>
        <City>Londrina</City>
        ${a.zone ? `<Zone>${a.zone}</Zone>` : ''}
        <Neighborhood>${a.neighborhood}</Neighborhood>
        <Address>Rua Particular da Alfa</Address>
        <StreetNumber>1234</StreetNumber>
        ${a.postalCode ? `<PostalCode>${a.postalCode}</PostalCode>` : ''}
      </Location>
      <ContactInfo><Name>Alfa Imoveis</Name><Email>feed@alfa.test</Email></ContactInfo>
    </Listing>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<ListingDataFeed xmlns="http://www.vivareal.com/schemas/1.0/VRSync">
  <Header><Provider>CRM da Alfa</Provider><Email>ti@alfa.test</Email></Header>
  <Listings>${anuncios.map(listing).join('')}
  </Listings>
</ListingDataFeed>`;
}

const IMP1: Anuncio = {
  id: 'IMP-1',
  transaction: 'Sale/Rent',
  type: 'Residential / Penthouse',
  neighborhood: 'Jd. Higienópolis',
  zone: 'Zona Sul',
  listPrice: '1.250.000,00',
  rentalPrice: '6500',
  iptuMensal: '400',
  fotos: [
    { url: `${FOTOS}/imp-1/sala.jpg`, caption: 'Sala' },
    { url: `${FOTOS}/imp-1/fachada.jpg`, caption: 'Fachada Alfa Imoveis', primary: true },
    { url: `${FOTOS}/imp-1/fora-do-ar.jpg` },
  ],
};

const IMP2: Anuncio = {
  id: 'IMP-2',
  transaction: 'For Sale',
  type: 'Residential / Home',
  neighborhood: 'Palhano Premium Residence',
  postalCode: '86050-190',
  listPrice: '780000',
  fotos: [{ url: `${FOTOS}/imp-2/casa.jpg` }],
};

const IMP3: Anuncio = {
  id: 'IMP-3',
  transaction: 'For Rent',
  type: 'Residential / Apartment',
  neighborhood: 'Bairro Que Nao Existe',
  zone: 'Zona Norte',
  postalCode: '86000-000',
  rentalPrice: '1800',
};

const IMP4: Anuncio = {
  id: 'IMP-4',
  transaction: 'For Sale',
  type: 'Commercial / Hotel',
  neighborhood: 'Centro',
  listPrice: '3500000',
};

const SEM_ID: Anuncio = { transaction: 'For Sale', type: 'Residential / Apartment', neighborhood: 'Centro' };

const FEED_V1 = feed([IMP1, IMP2, IMP3, IMP4, SEM_ID]);
const FEED_V2 = feed([
  {
    ...IMP1,
    listPrice: '1.200.000,00',
    // "sala" saiu do feed.
    fotos: [IMP1.fotos![1]!, IMP1.fotos![2]!],
  },
  IMP2,
  IMP3,
]);

describe('importacao VrSync', () => {
  let app: FastifyInstance;
  let actor: ActorContext;
  let sourceId: string;
  let betaCookies: Record<string, string>;
  const downloads: string[] = [];

  const deps: imports.ImportDeps = {
    fetchFeed: async () => {
      throw new Error('os testes enviam o XML direto');
    },
    fetchImage: async (url) => {
      downloads.push(url);
      if (url.includes('fora-do-ar')) throw new FetchFailedError('O servidor respondeu HTTP 404.');
      return fotoComExif();
    },
    cepLookup: async (cep) =>
      cep === '86050-190' ? { neighborhood: 'Gleba Palhano', city: 'Londrina', uf: 'PR' } : null,
    putObject,
    deleteObject,
  };

  async function run(xml: string, dryRun: boolean) {
    downloads.length = 0;
    const { done } = await imports.startJob(actor, sourceId, { dryRun, xml }, deps);
    const job = await done;
    expect(job.status, job.error ?? '').toBe('succeeded');
    return job;
  }

  async function imported(externalId: string) {
    return withOracle(async (client) => {
      const { rows } = await client.query(
        `SELECT p.*, n.name AS neighborhood_name
           FROM properties p JOIN neighborhoods n ON n.id = p.neighborhood_id
          WHERE p.external_source = $1 AND p.external_id = $2`,
        [`import:${sourceId}`, externalId],
      );
      return rows[0];
    });
  }

  beforeAll(async () => {
    app = await buildApp({ rateLimit: false });
    await app.ready();

    actor = await withOracle(async (client) => {
      const { rows } = await client.query<{ tenantId: string; userId: string }>(
        `SELECT tenant_id AS "tenantId", id AS "userId" FROM users WHERE email = $1`,
        [ALFA],
      );
      return rows[0]!;
    });

    const source = await imports.createSource(actor, {
      name: 'Feed de teste da Alfa',
      feedUrl: null,
      publishToNetwork: true,
    });
    sourceId = source.id;
    betaCookies = (await loginAs(app, BETA)).cookies;
  });

  afterAll(async () => {
    const keys = await withOracle(async (client) => {
      const { rows } = await client.query<{ storage_key: string }>(
        `SELECT m.storage_key FROM property_media m JOIN properties p ON p.id = m.property_id
          WHERE p.external_source = $1`,
        [`import:${sourceId}`],
      );
      await client.query(
        `DELETE FROM property_media WHERE property_id IN (SELECT id FROM properties WHERE external_source = $1)`,
        [`import:${sourceId}`],
      );
      await client.query(`DELETE FROM import_sources WHERE id = $1`, [sourceId]);
      await client.query(`DELETE FROM properties WHERE external_source = $1`, [`import:${sourceId}`]);
      await client.query(`DELETE FROM import_sources WHERE name = 'Feed via rota'`);
      return rows.map((r) => r.storage_key);
    });
    for (const key of keys) await deleteObject(key).catch(() => undefined);

    await app.close();
    await closeDb();
  });

  it('dry-run relata tudo e nao grava imovel nem baixa foto', async () => {
    const job = await run(FEED_V1, true);

    expect(job.stats).toMatchObject({ listings: 5, created: 3, needsCuration: 1, failed: 1 });
    expect(downloads).toEqual([]);
    expect(await imported('IMP-1')).toBeUndefined();
  });

  describe('primeira importacao gravando', () => {
    let jobId: string;

    beforeAll(async () => {
      const job = await run(FEED_V1, false);
      jobId = job.id;
      expect(job.stats).toMatchObject({
        listings: 5,
        created: 3,
        needsCuration: 1,
        failed: 1,
        photosDownloaded: 3,
        photosFailed: 1,
      });
    });

    it('Sale/Rent mantem venda e aluguel, e o IPTU mensal vira anual', async () => {
      const row = await imported('IMP-1');
      expect(row.purpose).toBe('sale_rent');
      expect(Number(row.sale_price_cents)).toBe(125_000_000);
      expect(Number(row.rent_price_cents)).toBe(650_000);
      expect(Number(row.iptu_cents)).toBe(400 * 12 * 100);
      expect(row.status).toBe('active');
      expect(row.published_to_network).toBe(true);
    });

    it('resolve o bairro pelo alias e traduz Penthouse para apartamento pela tabela', async () => {
      const row = await imported('IMP-1');
      expect(row.neighborhood_name).toBe('Jardim Higienópolis');
      expect(row.type).toBe('apartamento');
    });

    it('resolve pelo CEP o bairro que o nome nao identifica, avisando', async () => {
      const row = await imported('IMP-2');
      expect(row.neighborhood_name).toBe('Gleba Palhano');

      const items = await imports.listItems(actor, jobId);
      const item = items.find((i) => i.externalId === 'IMP-2')!;
      expect(item.status).toBe('created');
      expect(item.warnings.join(' ')).toMatch(/CEP/);
    });

    it('bairro desconhecido vai para curadoria, com <Zone> so no payload bruto', async () => {
      expect(await imported('IMP-3')).toBeUndefined();

      const [item] = await imports.listItems(actor, jobId, 'needs_curation');
      expect(item!.externalId).toBe('IMP-3');
      expect(item!.errors.join(' ')).toMatch(/Bairro Que Nao Existe/);
      expect(JSON.stringify(item!.rawPayload)).toContain('Zona Norte');

      // Zona nao virou coluna em lugar nenhum.
      const zoneColumns = await withOracle(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name ILIKE '%zone%'`,
        );
        return rows[0]!.count;
      });
      expect(zoneColumns).toBe('0');
    });

    it('tipo sem traducao vira "outro", com aviso', async () => {
      expect((await imported('IMP-4')).type).toBe('outro');
      const item = (await imports.listItems(actor, jobId)).find((i) => i.externalId === 'IMP-4')!;
      expect(item.warnings.join(' ')).toMatch(/sem tradução/);
    });

    it('anuncio sem ListingID falha sozinho, sem derrubar o feed', async () => {
      const [item] = await imports.listItems(actor, jobId, 'failed');
      expect(item!.errors.join(' ')).toMatch(/ListingID ausente/);
    });

    it('fotos do <Media> sao re-hospedadas sob chave opaca, sem EXIF, com a principal primeiro', async () => {
      const row = await imported('IMP-1');
      const media = await withOracle(async (client) => {
        const { rows } = await client.query(
          `SELECT position, caption, source_url, source_url_hash, sanitized_at, storage_key
             FROM property_media WHERE property_id = $1 ORDER BY position`,
          [row.id],
        );
        return rows;
      });

      expect(media).toHaveLength(2);
      expect(media[0].source_url).toBe(`${FOTOS}/imp-1/fachada.jpg`);
      expect(media[1].source_url).toBe(`${FOTOS}/imp-1/sala.jpg`);
      for (const m of media) {
        expect(m.sanitized_at).not.toBeNull();
        expect(m.source_url_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(m.storage_key).toMatch(/^media\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/);
      }

      const bytes = Buffer.from(await (await fetch(await signedReadUrl(media[0].storage_key))).arrayBuffer());
      expect((await readMetadata(bytes)).exif).toBeUndefined();
      expect(bytes.toString('latin1')).not.toContain('Alfa');

      const item = (await imports.listItems(actor, jobId)).find((i) => i.externalId === 'IMP-1')!;
      expect(item.warnings.join(' ')).toMatch(/Foto 3 não importada/);
      expect(item.warnings.join(' ')).toMatch(/vídeo/);
    });

    it('na busca de outro parceiro: aparece em venda e em aluguel, sem nada do feed', async () => {
      const row = await imported('IMP-1');

      for (const purpose of ['sale', 'rent']) {
        const response = await app.inject({
          method: 'GET',
          url: `/network/search?purpose=${purpose}&neighborhoodIds=${row.neighborhood_id}&limit=50`,
          cookies: betaCookies,
        });
        expect(response.statusCode).toBe(200);

        const listing = response.json().items.find((i: { listingId: string }) => i.listingId === row.id);
        expect(listing, `IMP-1 deveria aparecer na busca de ${purpose}`).toBeTruthy();
        expect(listing.salePriceCents).toBe(125_000_000);
        expect(listing.rentPriceCents).toBe(650_000);

        for (const agulha of [
          'fotos.alfa-imoveis.test',
          'Fachada',
          'IMP-1',
          `import:${sourceId}`,
          'Renata',
          'Rua Particular',
          'Zona Sul',
          'youtube',
        ]) {
          expect(response.body.includes(agulha), `"${agulha}" vazou na busca`).toBe(false);
        }
      }
    });
  });

  describe('reimportacao', () => {
    let jobId: string;

    beforeAll(async () => {
      const job = await run(FEED_V2, false);
      jobId = job.id;
    });

    it('atualiza o que mudou, mantem o resto e arquiva o que saiu do feed', async () => {
      const job = await imports.getJob(actor, jobId);
      expect(job.stats).toMatchObject({
        listings: 3,
        updated: 1,
        unchanged: 1,
        needsCuration: 1,
        archived: 1,
        failed: 0,
      });

      expect(Number((await imported('IMP-1')).sale_price_cents)).toBe(120_000_000);
      expect((await imported('IMP-4')).status).toBe('archived');

      const items = await imports.listItems(actor, jobId);
      const imp1 = items.find((i) => i.externalId === 'IMP-1')!;
      expect(imp1.changes.salePriceCents).toEqual({ from: 125_000_000, to: 120_000_000 });
      expect(imp1.changes.fotos).toEqual({ from: 2, to: 1 });
    });

    it('nao baixa de novo foto que ja foi importada e remove a que saiu do feed', async () => {
      // So a que continua fora do ar e tentada de novo.
      expect(downloads).toEqual([`${FOTOS}/imp-1/fora-do-ar.jpg`]);

      const job = await imports.getJob(actor, jobId);
      expect(job.stats).toMatchObject({ photosDownloaded: 0, photosReused: 2, photosRemoved: 1 });

      const row = await imported('IMP-1');
      const urls = await withOracle(async (client) => {
        const { rows } = await client.query<{ source_url: string }>(
          'SELECT source_url FROM property_media WHERE property_id = $1 ORDER BY position',
          [row.id],
        );
        return rows.map((r) => r.source_url);
      });
      expect(urls).toEqual([`${FOTOS}/imp-1/fachada.jpg`]);
    });
  });

  describe('rotas', () => {
    it('corretor nao importa carteira: so o administrador do parceiro', async () => {
      const { cookies } = await loginAs(app, ALFA_CORRETOR);
      const response = await app.inject({
        method: 'POST',
        url: '/imports/sources',
        cookies,
        payload: { name: 'Feed do corretor' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('outro parceiro recebe 404 para a execucao e os itens da Alfa', async () => {
      const { done, job } = await imports.startJob(actor, sourceId, { dryRun: true, xml: FEED_V2 }, deps);
      await done;

      for (const url of [`/imports/jobs/${job.id}`, `/imports/jobs/${job.id}/items`]) {
        const response = await app.inject({ method: 'GET', url, cookies: betaCookies });
        expect(response.statusCode, url).toBe(404);
      }
    });

    it('recebe o arquivo XML, responde 202 e processa em dry-run por padrao', async () => {
      const { cookies } = await loginAs(app, ALFA);

      const created = await app.inject({
        method: 'POST',
        url: '/imports/sources',
        cookies,
        payload: { name: 'Feed via rota' },
      });
      expect(created.statusCode).toBe(201);
      const routeSourceId = created.json().source.id;

      const xml = feed([{ id: 'ROTA-1', transaction: 'For Sale', type: 'Residential / Apartment', neighborhood: 'Centro', listPrice: '400000' }]);
      const started = await app.inject({
        method: 'POST',
        url: `/imports/sources/${routeSourceId}/upload`,
        cookies,
        headers: { 'content-type': 'application/xml' },
        payload: xml,
      });
      expect(started.statusCode).toBe(202);
      expect(started.json().job.dryRun).toBe(true);

      let job = started.json().job;
      for (let attempt = 0; attempt < 50 && (job.status === 'queued' || job.status === 'running'); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        job = (await app.inject({ method: 'GET', url: `/imports/jobs/${job.id}`, cookies })).json().job;
      }
      expect(job.status).toBe('succeeded');
      expect(job.stats).toMatchObject({ listings: 1, created: 1 });
    });

    it('recusa feed com URL para rede interna ja no cadastro de execucao', async () => {
      const { cookies } = await loginAs(app, ALFA);
      const created = await app.inject({
        method: 'POST',
        url: '/imports/sources',
        cookies,
        payload: { name: 'Feed via rota', feedUrl: 'http://169.254.169.254/latest/meta-data/' },
      });
      expect(created.statusCode).toBe(201);

      const started = await app.inject({
        method: 'POST',
        url: `/imports/sources/${created.json().source.id}/jobs?dryRun=true`,
        cookies,
      });
      expect(started.statusCode).toBe(202);

      let job = started.json().job;
      for (let attempt = 0; attempt < 50 && (job.status === 'queued' || job.status === 'running'); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        job = (await app.inject({ method: 'GET', url: `/imports/jobs/${job.id}`, cookies })).json().job;
      }
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/rede interna/);
    });
  });
});
