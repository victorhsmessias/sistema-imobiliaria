import { closeDb, COUNTERPART_FIELDS } from '@imob/db';
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

  /** Contato de pessoa de um parceiro: nunca atravessa, em nenhum estado. */
  function contatosDe(slug: string): string[] {
    const tenant = fixture.tenants.find((t) => t.slug === slug)!;
    return [...tenant.emails, ...tenant.names, ...tenant.phones];
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
      // Enquanto pende, quem pediu nao sabe de quem e o imovel.
      expect(connection.counterpart).toBeUndefined();
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
    it('o dono ve so a marca de quem pediu, sem contato', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/connections?role=received',
        cookies: beta,
      });
      expect(response.statusCode).toBe(200);

      const item = response.json().items.find((i: { id: string }) => i.id === criados[0]);
      expect(item.role).toBe('owner');
      expect(item.counterpart).toEqual({ partnerName: 'Alfa Imóveis' });
      expect(Object.keys(item.counterpart)).toEqual([...COUNTERPART_FIELDS]);
      expect(item.message).toMatch(/cliente/i);
      expect(contatosDe('alfa-imoveis').filter((v) => response.body.includes(v))).toEqual([]);
    });

    it('quem pediu nao ve o dono enquanto o pedido pende', async () => {
      const response = await app.inject({ method: 'GET', url: '/connections?role=sent', cookies: alfa });
      const item = response.json().items.find((i: { id: string }) => i.id === criados[0]);

      expect(item.status).toBe('pending');
      expect(item.counterpart).toBeUndefined();
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

    it('o dono aprova e so entao a marca dele aparece, nunca o contato', async () => {
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
      expect(connection.counterpart).toEqual({ partnerName: 'Beta Imóveis' });
      expect(contatosDe('beta-imoveis').filter((v) => visao.body.includes(v))).toEqual([]);

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

      // Abrir o detalhe nao grava mais evento: nao ha contato a "revelar".
      expect(events.map((e: { type: string; actor: string }) => [e.type, e.actor])).toEqual([
        ['requested', 'you'],
        ['approved', 'other'],
      ]);
    });

    it('a lista de quem pediu traz a marca do dono depois do aceite', async () => {
      const response = await app.inject({ method: 'GET', url: '/connections?role=sent', cookies: alfa });
      const item = response.json().items.find((i: { id: string }) => i.id === criados[0]);

      expect(item.status).toBe('approved');
      expect(item.counterpart).toEqual({ partnerName: 'Beta Imóveis' });
      expect(contatosDe('beta-imoveis').filter((v) => response.body.includes(v))).toEqual([]);
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
      expect(visao.json().connection.counterpart).toBeUndefined();
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

  describe('revogacao pela plataforma', () => {
    let adminCookies: Record<string, string>;
    let approvedId: string;

    beforeAll(async () => {
      // O platform_admin vem do seed, com a mesma senha de demo dos parceiros.
      const loginResult = await loginAs(app, 'admin@platform.test');
      expect(loginResult.statusCode).toBe(200);
      adminCookies = loginResult.cookies;

      // Aprova um pedido para testar revogacao
      const response = await pedir(betaListings[5]!);
      const id = response.json().connection.id;
      await app.inject({
        method: 'POST',
        url: `/connections/${id}/approve`,
        cookies: beta,
      });
      approvedId = id;
    });

    it('revoga uma conexao aprovada com motivo', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/connections/${approvedId}/revoke`,
        cookies: adminCookies,
        payload: { reason: 'Parceiro suspenso por violacao de uso aceitavel' },
      });

      expect(response.statusCode).toBe(200);
      const connection = response.json().connection;
      expect(connection.status).toBe('revoked');
      expect(connection.role).toBe('owner'); // Ve como dono
    });

    it('idempotencia: revogar de novo nao da erro', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/connections/${approvedId}/revoke`,
        cookies: adminCookies,
        payload: { reason: 'Segunda tentativa' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().connection.status).toBe('revoked');
    });

    it('nao-admin nao consegue revogar (403)', async () => {
      const response = await pedir(betaListings[6]!);
      const id = response.json().connection.id;
      await app.inject({
        method: 'POST',
        url: `/connections/${id}/approve`,
        cookies: beta,
      });

      const revoga = await app.inject({
        method: 'POST',
        url: `/connections/${id}/revoke`,
        cookies: alfa,
        payload: { reason: 'Motivo qualquer' },
      });

      expect(revoga.statusCode).toBe(403);
    });

    it('conexao inexistente retorna 404', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/connections/00000000-0000-0000-0000-000000000000/revoke',
        cookies: adminCookies,
        payload: { reason: 'Qualquer motivo' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('nao revoga conexao que nao esta approved (422)', async () => {
      const response = await pedir(betaListings[7]!);
      const id = response.json().connection.id;

      const revoga = await app.inject({
        method: 'POST',
        url: `/connections/${id}/revoke`,
        cookies: adminCookies,
        payload: { reason: 'Motivo qualquer' },
      });

      expect(revoga.statusCode).toBe(422);
      expect(revoga.json().fields).toHaveProperty('status');
    });

    it('revogacao registra evento sem ator e auditoria', async () => {
      const response = await pedir(betaListings[8]!);
      const id = response.json().connection.id;

      // Aprova
      await app.inject({
        method: 'POST',
        url: `/connections/${id}/approve`,
        cookies: beta,
      });

      // Revoga
      await app.inject({
        method: 'POST',
        url: `/connections/${id}/revoke`,
        cookies: adminCookies,
        payload: { reason: 'Teste de auditoria' },
      });

      // Verifica evento
      const details = await app.inject({
        method: 'GET',
        url: `/connections/${id}`,
        cookies: beta,
      });

      const events = details.json().events;
      const revokedEvent = events.find((e: { type: string }) => e.type === 'revoked');
      expect(revokedEvent).toBeDefined();
      expect(revokedEvent!.actor).toBe('platform'); // Nenhum tenant, é a plataforma
    });

    it('depois da revogacao, quem pediu continua vendo so a marca', async () => {
      const response = await pedir(betaListings[9]!);
      const id = response.json().connection.id;
      await app.inject({ method: 'POST', url: `/connections/${id}/approve`, cookies: beta });
      await app.inject({
        method: 'POST',
        url: `/connections/${id}/revoke`,
        cookies: adminCookies,
        payload: { reason: 'Abuso comprovado' },
      });

      const visao = await app.inject({ method: 'GET', url: `/connections/${id}`, cookies: alfa });
      expect(visao.json().connection.status).toBe('revoked');
      expect(visao.json().connection.counterpart).toEqual({ partnerName: 'Beta Imóveis' });
      expect(contatosDe('beta-imoveis').filter((v) => visao.body.includes(v))).toEqual([]);
    });
  });

  describe('nenhum contato atravessa', () => {
    /** GETs de conexao de um lado, sobre tudo o que a suite criou. */
    async function respostasDe(cookies: Record<string, string>): Promise<string[]> {
      const urls = [
        '/connections?role=sent&limit=100',
        '/connections?role=received&limit=100',
        ...criados.map((id) => `/connections/${id}`),
      ];
      const bodies: string[] = [];
      for (const url of urls) {
        const response = await app.inject({ method: 'GET', url, cookies });
        bodies.push(response.body);
      }
      return bodies;
    }

    it('a Alfa nunca recebe contato da Beta, e a Beta nunca recebe o da Alfa', async () => {
      const daBeta = contatosDe('beta-imoveis');
      const daAlfa = contatosDe('alfa-imoveis');

      for (const body of await respostasDe(alfa)) {
        expect(daBeta.filter((v) => body.includes(v))).toEqual([]);
      }
      for (const body of await respostasDe(beta)) {
        expect(daAlfa.filter((v) => body.includes(v))).toEqual([]);
      }
    });
  });
});
