import { closeDb } from '@imob/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadFixture, loginAs, withOracle, type SeedFixture } from './helpers.js';

/**
 * Curadoria de grafias de bairro.
 *
 * O catalogo e vocabulario compartilhado da rede: um alias errado tira imoveis
 * do resultado de busca de TODOS os parceiros. Por isso a escrita nao e do
 * app_user (ver rls.test.ts) e passa por uma funcao de superficie minima.
 */

const ALFA = 'admin@alfa.test';
const ALFA_CORRETOR = 'corretor@alfa.test';

describe('catalogo: grafias de bairro', () => {
  let app: FastifyInstance;
  let fixture: SeedFixture;
  let admin: Record<string, string>;
  let higienopolis: string;
  let centro: string;
  const criados = ['grafia-do-feed-xyz'];

  beforeAll(async () => {
    app = await buildApp({ rateLimit: false });
    await app.ready();
    fixture = await loadFixture();
    admin = (await loginAs(app, ALFA)).cookies;

    higienopolis = fixture.neighborhoods.find((n) => n.name === 'Jardim Higienópolis')!.id;
    centro = fixture.neighborhoods.find((n) => n.name === 'Centro')!.id;
  });

  afterAll(async () => {
    await withOracle((client) =>
      client.query('DELETE FROM neighborhood_aliases WHERE alias_slug = ANY($1::text[])', [criados]),
    );
    await app.close();
    await closeDb();
  });

  it('cria a grafia e ela passa a resolver o bairro na importacao', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/catalog/neighborhoods/${higienopolis}/aliases`,
      cookies: admin,
      payload: { alias: 'Grafia do Feed XYZ' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().alias).toMatchObject({ aliasSlug: 'grafia-do-feed-xyz', created: true });

    // O teste que importa: a resolucao usada pela importacao agora encontra.
    const cityId = fixture.neighborhoods.find((n) => n.id === higienopolis)!.cityId;
    const resolve = await app.inject({
      method: 'GET',
      url: `/catalog/cities/${cityId}/neighborhoods/resolve?name=Grafia%20do%20Feed%20XYZ`,
      cookies: admin,
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().neighborhood.id).toBe(higienopolis);
    expect(resolve.json().matchedBy).toBe('alias');
  });

  it('pedir a mesma grafia de novo nao e erro', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/catalog/neighborhoods/${higienopolis}/aliases`,
      cookies: admin,
      payload: { alias: 'grafia-do-feed-xyz' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().alias.created).toBe(false);
  });

  it('nao sequestra grafia que ja aponta para outro bairro', async () => {
    // "higienopolis" e alias do seed para Jardim Higienopolis.
    const response = await app.inject({
      method: 'POST',
      url: `/catalog/neighborhoods/${centro}/aliases`,
      cookies: admin,
      payload: { alias: 'higienopolis' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fields.alias).toMatch(/Higienópolis/);

    // E o alias continua onde estava.
    const dono = await withOracle(async (client) => {
      const { rows } = await client.query<{ neighborhood_id: string }>(
        `SELECT neighborhood_id FROM neighborhood_aliases WHERE alias_slug = 'higienopolis'`,
      );
      return rows[0]!.neighborhood_id;
    });
    expect(dono).toBe(higienopolis);
  });

  it('corretor nao mexe no catalogo da rede', async () => {
    const { cookies } = await loginAs(app, ALFA_CORRETOR);
    const response = await app.inject({
      method: 'POST',
      url: `/catalog/neighborhoods/${higienopolis}/aliases`,
      cookies,
      payload: { alias: 'tentativa do corretor' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('bairro inexistente devolve 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/catalog/neighborhoods/11111111-1111-1111-1111-111111111111/aliases',
      cookies: admin,
      payload: { alias: 'qualquer grafia' },
    });
    expect(response.statusCode).toBe(404);
  });
});
