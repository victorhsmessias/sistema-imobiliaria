import { closeDb } from '@imob/db';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readMetadata } from '../src/lib/image.js';
import { loginAs, withOracle } from './helpers.js';

const ALFA = 'admin@alfa.test';
const BETA = 'admin@beta.test';

/**
 * Gera um JPEG COM EXIF -- GPS, autor e copyright preenchidos.
 *
 * É a foto que um corretor tira no celular: coordenada exata do imóvel no
 * metadado e, muitas vezes, o nome da imobiliária nos campos Artist e
 * Copyright. Servir esse arquivo entrega o dono e o endereço com todos os
 * campos do JSON perfeitamente anonimizados -- o vazamento vai dentro do
 * binário.
 */
async function fotoComExif(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 900, channels: 3, background: { r: 190, g: 130, b: 70 } },
  })
    .jpeg()
    .withExif({
      IFD0: {
        Copyright: 'Alfa Imoveis Londrina',
        Artist: 'Fotografo da Alfa Imoveis',
        Make: 'Apple',
        Model: 'iPhone 15 Pro',
      },
      // GPS vive na IFD3 na nomenclatura do libvips (exif-ifd3-GPS*).
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '23/1 18/1 37/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '51/1 9/1 46/1',
      },
    })
    .toBuffer();
}

function multipart(file: Buffer, filename: string, contentType: string) {
  const boundary = '----imobtestboundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, file, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('midia de imovel', () => {
  let app: FastifyInstance;
  let alfaCookies: Record<string, string>;
  let betaCookies: Record<string, string>;
  let alfaPropertyId: string;
  let betaPropertyId: string;

  beforeAll(async () => {
    app = await buildApp({ rateLimit: false });
    await app.ready();

    alfaCookies = (await loginAs(app, ALFA)).cookies;
    betaCookies = (await loginAs(app, BETA)).cookies;

    const ids = await withOracle(async (client) => {
      const { rows } = await client.query<{ slug: string; id: string }>(`
        SELECT DISTINCT ON (t.slug) t.slug, p.id
          FROM properties p JOIN tenants t ON t.id = p.tenant_id
         WHERE p.deleted_at IS NULL AND p.status = 'active' AND p.published_to_network
         ORDER BY t.slug, p.id
      `);
      return Object.fromEntries(rows.map((r) => [r.slug, r.id]));
    });

    alfaPropertyId = ids['alfa-imoveis']!;
    betaPropertyId = ids['beta-imoveis']!;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  async function upload(cookies: Record<string, string>, propertyId: string, file?: Buffer) {
    const bytes = file ?? (await fotoComExif());
    return app.inject({
      method: 'POST',
      url: `/properties/${propertyId}/media`,
      cookies,
      ...multipart(bytes, 'IMG_4821 - Alfa Imoveis.jpg', 'image/jpeg'),
    });
  }

  async function bytesDaUrlAssinada(
    cookies: Record<string, string>,
    url: string,
  ): Promise<Buffer> {
    const redirect = await app.inject({ method: 'GET', url, cookies });
    expect(redirect.statusCode).toBe(302);

    const signed = redirect.headers.location as string;
    const response = await fetch(signed);
    expect(response.ok, `storage respondeu ${response.status}`).toBe(true);
    return Buffer.from(await response.arrayBuffer());
  }

  describe('upload', () => {
    it('aceita a foto e ja marca como sanitizada', async () => {
      const response = await upload(alfaCookies, alfaPropertyId);
      expect(response.statusCode).toBe(201);

      const media = response.json().media;
      expect(media.kind).toBe('photo');
      // sanitizedAt preenchido e o que libera a foto para a rede.
      expect(media.sanitizedAt).not.toBeNull();
      expect(media.width).toBeGreaterThan(0);

      await app.inject({
        method: 'DELETE',
        url: `/properties/${alfaPropertyId}/media/${media.id}`,
        cookies: alfaCookies,
      });
    });

    // =====================================================================
    // O gate desta suite.
    // =====================================================================
    it('remove TODO o EXIF do arquivo armazenado', async () => {
      const original = await fotoComExif();

      // Primeiro confirma que a fixture realmente tem EXIF -- senao o teste
      // abaixo passaria por nao haver nada para remover.
      const antes = await readMetadata(original);
      expect(antes.exif, 'a fixture deveria ter EXIF').toBeInstanceOf(Buffer);
      expect(original.toString('latin1')).toContain('Alfa Imoveis Londrina');

      const created = await upload(alfaCookies, alfaPropertyId, original);
      expect(created.statusCode).toBe(201);
      const mediaId = created.json().media.id;

      const stored = await bytesDaUrlAssinada(
        alfaCookies,
        `/properties/${alfaPropertyId}/media/${mediaId}`,
      );

      const depois = await readMetadata(stored);
      expect(depois.exif, 'EXIF sobreviveu ao processamento').toBeUndefined();
      expect(depois.iptc).toBeUndefined();
      expect(depois.xmp).toBeUndefined();

      // E nenhum rastro textual do dono dentro do binario.
      const cru = stored.toString('latin1');
      for (const agulha of ['Alfa', 'Imoveis', 'iPhone', 'Apple', 'Copyright', 'GPS']) {
        expect(cru.includes(agulha), `"${agulha}" ainda aparece no arquivo`).toBe(false);
      }

      await app.inject({
        method: 'DELETE',
        url: `/properties/${alfaPropertyId}/media/${mediaId}`,
        cookies: alfaCookies,
      });
    });

    it('normaliza para WebP e limita a 1920px', async () => {
      const grande = await sharp({
        create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 90, b: 160 } },
      })
        .png()
        .toBuffer();

      const created = await upload(alfaCookies, alfaPropertyId, grande);
      const media = created.json().media;
      expect(media.width).toBe(1920);
      expect(media.height).toBe(1440);

      const stored = await bytesDaUrlAssinada(
        alfaCookies,
        `/properties/${alfaPropertyId}/media/${media.id}`,
      );
      expect((await readMetadata(stored)).format).toBe('webp');

      await app.inject({
        method: 'DELETE',
        url: `/properties/${alfaPropertyId}/media/${media.id}`,
        cookies: alfaCookies,
      });
    });

    it('recusa arquivo que nao e imagem', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/properties/${alfaPropertyId}/media`,
        cookies: alfaCookies,
        ...multipart(Buffer.from('isto aqui e um PDF, prometo'), 'contrato.pdf', 'application/pdf'),
      });
      expect(response.statusCode).toBe(422);
    });

    it('recusa upload em imovel de outro parceiro', async () => {
      const response = await upload(alfaCookies, betaPropertyId);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('ordenacao e exclusao', () => {
    it('reordena e depois exclui', async () => {
      const a = (await upload(alfaCookies, alfaPropertyId)).json().media;
      const b = (await upload(alfaCookies, alfaPropertyId)).json().media;
      expect(b.position).toBe(a.position + 1);

      // A ordem precisa cobrir todas as midias do imovel, nao so as duas novas:
      // uma lista parcial deixaria as demais com posicao indefinida.
      const atual = await app.inject({
        method: 'GET',
        url: `/properties/${alfaPropertyId}/media`,
        cookies: alfaCookies,
      });
      const todas: string[] = atual.json().media.map((m: { id: string }) => m.id);
      const resto = todas.filter((id) => id !== a.id && id !== b.id);

      const reordered = await app.inject({
        method: 'PATCH',
        url: `/properties/${alfaPropertyId}/media/order`,
        cookies: alfaCookies,
        payload: { order: [b.id, a.id, ...resto] },
      });
      expect(reordered.statusCode).toBe(200);
      expect(reordered.json().media.slice(0, 2).map((m: { id: string }) => m.id)).toEqual([
        b.id,
        a.id,
      ]);

      for (const id of [a.id, b.id]) {
        const removed = await app.inject({
          method: 'DELETE',
          url: `/properties/${alfaPropertyId}/media/${id}`,
          cookies: alfaCookies,
        });
        expect(removed.statusCode).toBe(204);
      }

      const rest = await app.inject({
        method: 'GET',
        url: `/properties/${alfaPropertyId}/media`,
        cookies: alfaCookies,
      });
      const ids = rest.json().media.map((m: { id: string }) => m.id);
      expect(ids).not.toContain(a.id);
      expect(ids).not.toContain(b.id);
    });

    it('recusa ordem que nao cobre exatamente as midias do imovel', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/properties/${alfaPropertyId}/media/order`,
        cookies: alfaCookies,
        payload: { order: ['11111111-1111-1111-1111-111111111111'] },
      });
      expect(response.statusCode).toBe(422);
    });
  });

  describe('foto vista pela rede', () => {
    it('serve a foto de outro parceiro sem revelar nada do dono', async () => {
      const created = await upload(betaCookies, betaPropertyId);
      const mediaId = created.json().media.id;

      // Alfa busca na rede e encontra o anuncio da Beta.
      const busca = await app.inject({
        method: 'GET',
        url: `/network/search?limit=50`,
        cookies: alfaCookies,
      });
      const listing = busca
        .json()
        .items.find((i: { listingId: string }) => i.listingId === betaPropertyId);
      expect(listing, 'o imovel da Beta deveria aparecer na busca').toBeTruthy();
      expect(listing.isOwn).toBe(false);
      expect(listing.photoCount).toBeGreaterThan(0);

      const redirect = await app.inject({
        method: 'GET',
        url: `/network/listings/${betaPropertyId}/media/${mediaId}`,
        cookies: alfaCookies,
      });
      expect(redirect.statusCode).toBe(302);

      const url = redirect.headers.location as string;
      // A URL assinada nao carrega nome de arquivo, marca nem tenant.
      for (const agulha of ['alfa', 'beta', 'imoveis', 'IMG_4821', 'tenant']) {
        expect(url.toLowerCase().includes(agulha.toLowerCase()), `"${agulha}" na URL`).toBe(false);
      }

      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      expect((await readMetadata(bytes)).exif).toBeUndefined();

      await app.inject({
        method: 'DELETE',
        url: `/properties/${betaPropertyId}/media/${mediaId}`,
        cookies: betaCookies,
      });
    });

    it('recusa midia que nao pertence ao anuncio informado', async () => {
      // Sem essa checagem o id do anuncio na URL seria decorativo, e daria
      // para varrer midias trocando so o mediaId.
      const created = await upload(betaCookies, betaPropertyId);
      const mediaId = created.json().media.id;

      const response = await app.inject({
        method: 'GET',
        url: `/network/listings/${alfaPropertyId}/media/${mediaId}`,
        cookies: alfaCookies,
      });
      expect(response.statusCode).toBe(404);

      await app.inject({
        method: 'DELETE',
        url: `/properties/${betaPropertyId}/media/${mediaId}`,
        cookies: betaCookies,
      });
    });

    it('nunca serve midia ainda nao sanitizada', async () => {
      // O seed deixa uma foto por imovel com sanitized_at nulo, simulando
      // midia que ainda nao passou pelo pipeline.
      const pendente = await withOracle(async (client) => {
        const { rows } = await client.query<{ id: string; property_id: string }>(`
          SELECT m.id, m.property_id
            FROM property_media m
            JOIN properties p ON p.id = m.property_id
           WHERE m.sanitized_at IS NULL
             AND p.status = 'active' AND p.published_to_network AND p.deleted_at IS NULL
           LIMIT 1
        `);
        return rows[0];
      });

      expect(pendente, 'o seed deveria ter midia pendente').toBeTruthy();

      const response = await app.inject({
        method: 'GET',
        url: `/network/listings/${pendente!.property_id}/media/${pendente!.id}`,
        cookies: alfaCookies,
      });
      expect(response.statusCode).toBe(404);
    });

    it('exige sessao', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/network/listings/${alfaPropertyId}/media/11111111-1111-1111-1111-111111111111`,
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
