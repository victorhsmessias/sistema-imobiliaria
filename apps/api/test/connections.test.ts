import { closeDb } from '@imob/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadFixture, loginAs, withOracle, type SeedFixture } from './helpers.js';

/**
 * Fluxo de conexao.
 *
 * O teste que mais importa aqui e o mesmo da busca: enquanto o pedido esta
 * pendente, NADA do dono pode aparecer na resposta que o solicitante recebe.
 * A revelacao so existe depois do aceite, e mesmo assim sem endereco.
 */

const ALFA = 'admin@alfa.test';
const BETA = 'admin@beta.test';
const CARLOS = 'carlos@cdias.test';

describe('conexoes entre parceiros', () => {
  let app: FastifyInstance;
  let fixture: SeedFixture;
  let alfa: Record<string, string>;
  let beta: Record<string, string>;
  let carlos: Record<string, string>;
  /** Imoveis da Beta visiveis na rede, um por cenario. */
  let betaListings: string[];
  let alfaListing: string;
  const criados: string[] = [];

  async function pedir(listingId: string, message = 'Tenho cliente para este imóvel.') {
    const response = await app.inject({
      method: 'POST',
      url: '/connections',
      cookies: alfa,
      payload: { listingId, message },
    });
    if (response.statusCode === 201) criados.push(response.json().connection.id);
    return response;
  }

  /** Identificadores da Beta que jamais podem aparecer para a Alfa antes do aceite. */
  function identificadoresDaBeta(): string[] {
    const beta = fixture.tenants.find((t) => t.slug === 'beta-imoveis')!;
    return [beta.id, beta.legalName, beta.displayName, beta.slug, ...beta.emails, ...beta.names, ...beta.phones];
  }

  beforeAll(async () => {
    app = await buildApp({ rateLimit: false });
    await app.ready();

    fixture = await loadFixture();
    alfa = (await loginAs(app, ALFA)).cookies;
    beta = (await loginAs(app, BETA)).cookies;
    carlos = (await loginAs(app, CARLOS)).cookies;

    const rows = await withOracle(async (client) => {
      const { rows } = await client.query<{ id: string; slug: string }>(`
        SELECT p.id, t.slug
          FROM properties p JOIN tenants t ON t.id = p.tenant_id
         WHERE p.deleted_at IS NULL AND p.status = 'active' AND p.published_to_network
         ORDER BY t.slug, p.id
      `);
      return rows;
    });
    betaListings = rows.filter((r) => r.slug === 'beta-imoveis').map((r) => r.id);
    alfaListing = rows.find((r) => r.slug === 'alfa-imoveis')!.id;
    expect(betaListings.length).toBeGreaterThan(5);
  });

  afterAll(async () => {
    await withOracle(async (client) => {
      await client.query('DELETE FROM connection_events WHERE connection_request_id = ANY($1::uuid[])', [criados]);
      await client.query('DELETE FROM connection_requests WHERE id = ANY($1::uuid[])', [criados]);
    });
    await app.close();
    await closeDb();
  });

  describe('pedido', () => {
    it('cria o pedido sem revelar NADA do dono', async () => {
      const response = await pedir(betaListings[0]!);
      expect(response.statusCode).toBe(201);

      const connection = response.json().connection;
      expect(connection.status).toBe('pending');
      expect(connection.role).toBe('requester');
      // Enquanto pende, nao ha revelacao: nem marca, nem contato.
      expect(connection.disclosure).toBeUndefined();
      expect(connection.requester).toBeUndefined();
      // O imovel aparece com os mesmos campos da busca, sem endereco.
      expect(connection.listing.neighborhoodName).toBeTruthy();
      expect(JSON.stringify(connection.listing)).not.toMatch(/street|zip|latitude/i);

      const vazados = identificadoresDaBeta().filter((valor) => response.body.includes(valor));
      expect(vazados).toEqual([]);
      expect(response.body).not.toContain('tenant');
    });

    it('recusa pedido repetido no mesmo imovel', async () => {
      const response = await pedir(betaListings[0]!);
      expect(response.statusCode).toBe(422);
      expect(response.json().fields).toHaveProperty('listingId');
    });

    it('recusa pedido no proprio imovel', async () => {
      const response = await pedir(alfaListing);
      expect(response.statusCode).toBe(422);
      expect(response.json().fields.listingId).toMatch(/sua carteira/i);
    });

    it('recusa imovel que nao esta na rede', async () => {
      const response = await pedir('11111111-1111-1111-1111-111111111111');
      expect(response.statusCode).toBe(404);
    });

    it('a busca passa a mostrar a situacao do proprio pedido', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/network/search?limit=50',
        cookies: alfa,
      });
      const listing = response
        .json()
        .items.find((i: { listingId: string }) => i.listingId === betaListings[0]);
      expect(listing.connection.status).toBe('pending');

      // Para o DONO, o mesmo anuncio nao tem "conexao": pedido recebido nao e
      // pedido feito.
      const doDono = await app.inject({ method: 'GET', url: '/network/search?limit=50', cookies: beta });
      const mesmo = doDono
        .json()
        .items.find((i: { listingId: string }) => i.listingId === betaListings[0]);
      expect(mesmo.connection).toBeNull();
    });
  });

  describe('caixa de cada lado', () => {
    it('o dono ve quem pediu, com contato: pedir e se identificar', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/connections?role=received',
        cookies: beta,
      });
      expect(response.statusCode).toBe(200);

      const item = response.json().items.find((i: { id: string }) => i.id === criados[0]);
      expect(item.role).toBe('owner');
      expect(item.requester.partnerName).toBe('Alfa Imóveis');
      expect(item.requester.brokerName).toBeTruthy();
      expect(item.requester.brokerEmail).toBe(ALFA);
      expect(item.message).toMatch(/cliente/i);
      expect(item.disclosure).toBeUndefined();
    });

    it('quem pediu nao ve o dono enquanto o pedido pende', async () => {
      const response = await app.inject({ method: 'GET', url: '/connections?role=sent', cookies: alfa });
      const item = response.json().items.find((i: { id: string }) => i.id === criados[0]);

      expect(item.status).toBe('pending');
      expect(item.disclosure).toBeUndefined();
      expect(identificadoresDaBeta().filter((v) => response.body.includes(v))).toEqual([]);
    });

    it('um terceiro parceiro nao enxerga a conexao dos outros', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/connections/${criados[0]}`,
        cookies: carlos,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('decisao', () => {
    it('quem pediu nao aprova, e o dono nao cancela', async () => {
      const aprovar = await app.inject({
        method: 'POST',
        url: `/connections/${criados[0]}/approve`,
        cookies: alfa,
      });
      expect(aprovar.statusCode).toBe(403);

      const cancelar = await app.inject({
        method: 'POST',
        url: `/connections/${criados[0]}/cancel`,
        cookies: beta,
      });
      expect(cancelar.statusCode).toBe(403);
    });

    it('o dono aprova e so entao o contato dele aparece', async () => {
      const aprovado = await app.inject({
        method: 'POST',
        url: `/connections/${criados[0]}/approve`,
        cookies: beta,
      });
      expect(aprovado.statusCode).toBe(200);
      expect(aprovado.json().connection.status).toBe('approved');

      const visao = await app.inject({
        method: 'GET',
        url: `/connections/${criados[0]}`,
        cookies: alfa,
      });
      const { connection, events } = visao.json();

      expect(connection.status).toBe('approved');
      expect(connection.disclosure.partnerName).toBe('Beta Imóveis');
      expect(connection.disclosure.brokerEmail).toBe(BETA);
      expect(connection.disclosure.brokerPhone).toBeTruthy();

      // Mesmo aprovado, endereco nao: com ele o solicitante acha o anuncio
      // original num portal e fecha por fora.
      const endereco = await withOracle(async (client) => {
        const { rows } = await client.query<{ street: string; zip: string; title: string }>(
          'SELECT street, zip, title FROM properties WHERE id = $1',
          [betaListings[0]],
        );
        return rows[0]!;
      });
      for (const valor of [endereco.street, endereco.zip, endereco.title]) {
        expect(visao.body.includes(valor), `"${valor}" vazou na conexão aprovada`).toBe(false);
      }

      // A trilha diz de que lado veio cada ato, nunca quem e. O terceiro
      // evento e esta propria leitura: abrir os dados revelados fica
      // registrado, e e o que sustenta uma disputa de comissao depois.
      expect(events.map((e: { type: string; actor: string }) => [e.type, e.actor])).toEqual([
        ['requested', 'you'],
        ['approved', 'other'],
        ['disclosed', 'you'],
      ]);
    });

    it('nivel de disclosure "partner" mostra a marca e esconde o contato', async () => {
      const response = await pedir(betaListings[1]!);
      const id = response.json().connection.id;

      await withOracle((client) =>
        client.query(`UPDATE connection_requests SET disclosure_level = 'partner' WHERE id = $1`, [id]),
      );
      await app.inject({ method: 'POST', url: `/connections/${id}/approve`, cookies: beta });

      const visao = await app.inject({ method: 'GET', url: `/connections/${id}`, cookies: alfa });
      const disclosure = visao.json().connection.disclosure;

      expect(disclosure.partnerName).toBe('Beta Imóveis');
      expect(disclosure.brokerName).toBeNull();
      expect(disclosure.brokerPhone).toBeNull();
      expect(disclosure.brokerEmail).toBeNull();
    });

    it('recusa com motivo, sem revelar o dono', async () => {
      const response = await pedir(betaListings[2]!);
      const id = response.json().connection.id;

      const recusado = await app.inject({
        method: 'POST',
        url: `/connections/${id}/reject`,
        cookies: beta,
        payload: { note: 'Imóvel já está em negociação.' },
      });
      expect(recusado.statusCode).toBe(200);

      const visao = await app.inject({ method: 'GET', url: `/connections/${id}`, cookies: alfa });
      expect(visao.json().connection.status).toBe('rejected');
      expect(visao.json().connection.decisionNote).toMatch(/negociação/i);
      expect(visao.json().connection.disclosure).toBeUndefined();
      expect(identificadoresDaBeta().filter((v) => visao.body.includes(v))).toEqual([]);
    });

    it('quem pediu cancela o proprio pedido', async () => {
      const response = await pedir(betaListings[3]!);
      const id = response.json().connection.id;

      const cancelado = await app.inject({
        method: 'POST',
        url: `/connections/${id}/cancel`,
        cookies: alfa,
      });
      expect(cancelado.statusCode).toBe(200);
      expect(cancelado.json().connection.status).toBe('cancelled');
    });

    it('nao decide duas vezes o mesmo pedido', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/connections/${criados[0]}/approve`,
        cookies: beta,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().fields).toHaveProperty('status');
    });
  });

  describe('expiracao', () => {
    it('pedido vencido vira expirado na leitura, com evento sem ator', async () => {
      const response = await pedir(betaListings[4]!);
      const id = response.json().connection.id;

      await withOracle((client) =>
        client.query(`UPDATE connection_requests SET expires_at = now() - interval '1 day' WHERE id = $1`, [id]),
      );

      const visao = await app.inject({ method: 'GET', url: `/connections/${id}`, cookies: alfa });
      expect(visao.json().connection.status).toBe('expired');
      expect(visao.json().events.map((e: { type: string; actor: string }) => [e.type, e.actor])).toContainEqual([
        'expired',
        'platform',
      ]);

      // E o dono ja nao pode aprovar o que venceu.
      const tarde = await app.inject({ method: 'POST', url: `/connections/${id}/approve`, cookies: beta });
      expect(tarde.statusCode).toBe(422);
    });
  });
});
