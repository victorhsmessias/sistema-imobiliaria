import { closeDb } from '@imob/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadFixture, loginAs, withOracle, type SeedFixture } from './helpers.js';

const ALFA = 'admin@alfa.test';
const BETA = 'admin@beta.test';

describe('carteira do parceiro', () => {
  let app: FastifyInstance;
  let fixture: SeedFixture;
  let alfaCookies: Record<string, string>;
  let betaCookies: Record<string, string>;
  let neighborhoodId: string;

  beforeAll(async () => {
    app = await buildApp({ rateLimit: false });
    await app.ready();

    fixture = await loadFixture();
    neighborhoodId = fixture.neighborhoods[0]!.id;

    alfaCookies = (await loginAs(app, ALFA)).cookies;
    betaCookies = (await loginAs(app, BETA)).cookies;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  async function createProperty(cookies: Record<string, string>, overrides = {}) {
    return app.inject({
      method: 'POST',
      url: '/properties',
      cookies,
      payload: {
        title: 'Apartamento de teste',
        type: 'apartamento',
        purpose: 'sale',
        status: 'active',
        neighborhoodId,
        bedrooms: 3,
        suites: 1,
        bathrooms: 2,
        parkingSpots: 1,
        areaBuilt: 92,
        areaTotal: 92,
        salePriceCents: 58_000_000,
        ...overrides,
      },
    });
  }

  describe('acesso', () => {
    it('exige sessao', async () => {
      const response = await app.inject({ method: 'GET', url: '/properties' });
      expect(response.statusCode).toBe(401);
    });

    it('lista apenas a propria carteira', async () => {
      const alfa = await app.inject({ method: 'GET', url: '/properties', cookies: alfaCookies });
      const beta = await app.inject({ method: 'GET', url: '/properties', cookies: betaCookies });

      expect(alfa.statusCode).toBe(200);
      expect(beta.statusCode).toBe(200);

      const alfaIds = new Set(alfa.json().items.map((p: { id: string }) => p.id));
      const betaIds: string[] = beta.json().items.map((p: { id: string }) => p.id);

      expect(alfaIds.size).toBeGreaterThan(0);
      expect(betaIds.length).toBeGreaterThan(0);
      // Nenhum imovel aparece nas duas carteiras.
      expect(betaIds.some((id) => alfaIds.has(id))).toBe(false);
    });
  });

  describe('criacao', () => {
    it('cria e devolve o imovel completo', async () => {
      const response = await createProperty(alfaCookies);
      expect(response.statusCode).toBe(201);

      const property = response.json().property;
      expect(property.title).toBe('Apartamento de teste');
      expect(property.bedrooms).toBe(3);
      expect(property.areaBuilt).toBe(92);
      expect(property.salePriceCents).toBe(58_000_000);
      expect(property.rentPriceCents).toBeNull();

      await app.inject({
        method: 'DELETE',
        url: `/properties/${property.id}`,
        cookies: alfaCookies,
      });
    });

    it('venda e aluguel guarda os dois valores', async () => {
      const response = await createProperty(alfaCookies, {
        purpose: 'sale_rent',
        salePriceCents: 58_000_000,
        rentPriceCents: 320_000,
      });
      expect(response.statusCode).toBe(201);

      const property = response.json().property;
      expect(property.salePriceCents).toBe(58_000_000);
      expect(property.rentPriceCents).toBe(320_000);

      await app.inject({ method: 'DELETE', url: `/properties/${property.id}`, cookies: alfaCookies });
    });

    it('recusa valor de aluguel em imovel so a venda', async () => {
      const response = await createProperty(alfaCookies, { purpose: 'sale', rentPriceCents: 320_000 });
      expect(response.statusCode).toBe(422);
      expect(response.json().fields).toHaveProperty('rentPriceCents');
    });

    it('deriva a cidade do bairro, sem aceita-la do cliente', async () => {
      // Se a cidade viesse do cliente, daria para gravar um bairro de Londrina
      // carimbado com outra cidade, e o filtro por cidade passaria a mentir
      // sem nenhum erro.
      const alvo = fixture.neighborhoods[0]!;

      const response = await app.inject({
        method: 'POST',
        url: '/properties',
        cookies: alfaCookies,
        payload: {
          title: 'Derivacao de cidade',
          type: 'casa',
          neighborhoodId: alvo.id,
          // Tentativa deliberada de carimbar outra localizacao:
          cityId: '00000000-0000-0000-0000-000000000000',
          zoneId: '00000000-0000-0000-0000-000000000000',
        },
      });

      expect(response.statusCode).toBe(201);
      const property = response.json().property;
      expect(property.city.id).toBe(alvo.cityId);
      expect(property.neighborhood.id).toBe(alvo.id);
      expect(property.neighborhood).not.toHaveProperty('zone');

      await app.inject({
        method: 'DELETE',
        url: `/properties/${property.id}`,
        cookies: alfaCookies,
      });
    });

    it('recusa bairro fora do catalogo', async () => {
      const response = await createProperty(alfaCookies, {
        neighborhoodId: '11111111-1111-1111-1111-111111111111',
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().fields).toHaveProperty('neighborhoodId');
    });

    it('recusa mais suites do que quartos', async () => {
      const response = await createProperty(alfaCookies, { bedrooms: 1, suites: 3 });
      expect(response.statusCode).toBe(422);
      expect(response.json().fields.suites).toMatch(/su[ií]tes/i);
    });

    it('recusa area construida maior que a total', async () => {
      const response = await createProperty(alfaCookies, { areaBuilt: 200, areaTotal: 100 });
      expect(response.statusCode).toBe(422);
      expect(response.json().fields).toHaveProperty('areaBuilt');
    });

    it('registra o evento na trilha de auditoria', async () => {
      const created = await createProperty(alfaCookies);
      const id = created.json().property.id;

      const events = await withOracle(async (client) => {
        const { rows } = await client.query(
          `SELECT action, entity_id FROM audit_log
            WHERE entity_id = $1 AND action = 'property.created'`,
          [id],
        );
        return rows;
      });

      expect(events).toHaveLength(1);

      await app.inject({ method: 'DELETE', url: `/properties/${id}`, cookies: alfaCookies });
    });
  });

  describe('isolamento entre parceiros', () => {
    it('responde 404 -- e nao 403 -- para imovel de outro parceiro', async () => {
      // 403 confirmaria que o imovel existe. Com uma sequencia de ids, daria
      // para medir o tamanho da carteira do concorrente.
      const created = await createProperty(betaCookies);
      const betaId = created.json().property.id;

      const read = await app.inject({
        method: 'GET',
        url: `/properties/${betaId}`,
        cookies: alfaCookies,
      });
      expect(read.statusCode).toBe(404);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/properties/${betaId}`,
        cookies: alfaCookies,
        payload: { title: 'sequestrado' },
      });
      expect(patch.statusCode).toBe(404);

      const remove = await app.inject({
        method: 'DELETE',
        url: `/properties/${betaId}`,
        cookies: alfaCookies,
      });
      expect(remove.statusCode).toBe(404);

      // E o dono continua com o imovel intacto.
      const owner = await app.inject({
        method: 'GET',
        url: `/properties/${betaId}`,
        cookies: betaCookies,
      });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().property.title).toBe('Apartamento de teste');

      await app.inject({ method: 'DELETE', url: `/properties/${betaId}`, cookies: betaCookies });
    });
  });

  describe('atualizacao e exclusao', () => {
    it('atualiza parcialmente sem apagar o que nao foi enviado', async () => {
      const created = await createProperty(alfaCookies);
      const id = created.json().property.id;

      const patched = await app.inject({
        method: 'PATCH',
        url: `/properties/${id}`,
        cookies: alfaCookies,
        payload: { salePriceCents: 61_000_000 },
      });

      expect(patched.statusCode).toBe(200);
      const property = patched.json().property;
      expect(property.salePriceCents).toBe(61_000_000);
      expect(property.title).toBe('Apartamento de teste');
      expect(property.bedrooms).toBe(3);

      await app.inject({ method: 'DELETE', url: `/properties/${id}`, cookies: alfaCookies });
    });

    it('exclui logicamente e some da carteira', async () => {
      const created = await createProperty(alfaCookies);
      const id = created.json().property.id;

      const removed = await app.inject({
        method: 'DELETE',
        url: `/properties/${id}`,
        cookies: alfaCookies,
      });
      expect(removed.statusCode).toBe(204);

      const read = await app.inject({
        method: 'GET',
        url: `/properties/${id}`,
        cookies: alfaCookies,
      });
      expect(read.statusCode).toBe(404);

      // A linha continua no banco: o historico de conexoes da Fase 1 aponta
      // para ela. O que muda e deleted_at, que tira o imovel da rede.
      const stillThere = await withOracle(async (client) => {
        const { rows } = await client.query(
          'SELECT deleted_at FROM properties WHERE id = $1',
          [id],
        );
        return rows[0];
      });
      expect(stillThere?.deleted_at).not.toBeNull();
    });
  });
});
