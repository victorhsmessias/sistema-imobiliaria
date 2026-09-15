import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NETWORK_ALLOWED_COLUMNS,
  NETWORK_MEDIA_ALLOWED_COLUMNS,
  OWNER_IDENTIFYING_COLUMNS,
} from '../src/sensitive-fields.js';
import { appClient, loadSeededTenants, withOracle, type SeededTenant } from './helpers.js';

/**
 * Anonimizacao cross-tenant.
 *
 * Esta e a regra central do produto: se o solicitante consegue identificar o
 * dono do imovel, ele fecha por fora e a plataforma perde a razao de existir.
 *
 * A abordagem nao e verificar campo a campo o que lembramos de esconder --
 * e serializar a resposta INTEIRA e procurar por qualquer identificador
 * conhecido dentro dela. Assim um campo novo que vaze e pego mesmo que
 * ninguem tenha se lembrado de escrever um teste para ele.
 */
describe('anonimizacao da busca cross-tenant', () => {
  let client: pg.Client;
  let tenants: SeededTenant[];

  beforeAll(async () => {
    tenants = await loadSeededTenants();
    client = appClient();
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('a view expoe exatamente a allow-list declarada em sensitive-fields.ts', async () => {
    // Guarda de duas pontas: adicionar coluna na view sem adicionar aqui
    // (ou o contrario) quebra o build. Expor um campo novo na rede passa a
    // ser um ato deliberado, revisado nos dois lugares.
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'network_listings' ORDER BY ordinal_position`,
    );
    const actual = rows.map((r) => r.column_name).sort();
    expect(actual).toEqual([...NETWORK_ALLOWED_COLUMNS].sort());
  });

  it('a view de midia expoe exatamente a allow-list, e nunca storage_key', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'network_listing_media' ORDER BY ordinal_position`,
    );
    const actual = rows.map((r) => r.column_name).sort();
    expect(actual).toEqual([...NETWORK_MEDIA_ALLOWED_COLUMNS].sort());
    expect(actual).not.toContain('storage_key');
  });

  it('nenhuma coluna identificadora do dono aparece nas views', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT DISTINCT column_name FROM information_schema.columns
        WHERE table_name IN ('network_listings','network_listing_media')`,
    );
    for (const { column_name } of rows) {
      const reason = OWNER_IDENTIFYING_COLUMNS[column_name];
      expect(reason, `coluna "${column_name}" identifica o dono: ${reason}`).toBeUndefined();
    }
  });

  it('a resposta serializada da busca nao contem NENHUM identificador de parceiro', async () => {
    const { rows } = await client.query(
      `SELECT l.*, n.name AS neighborhood_name, c.name AS city_name
         FROM network_listings l
         JOIN neighborhoods n ON n.id = l.neighborhood_id
         JOIN cities c         ON c.id = l.city_id`,
    );
    expect(rows.length).toBeGreaterThan(0);

    const payload = JSON.stringify(rows);

    const forbidden: Array<{ value: string; label: string }> = [];
    for (const t of tenants) {
      forbidden.push({ value: t.id, label: `tenant_id de ${t.slug}` });
      forbidden.push({ value: t.legalName, label: `razao social de ${t.slug}` });
      forbidden.push({ value: t.displayName, label: `marca de ${t.slug}` });
      forbidden.push({ value: t.slug, label: `slug de ${t.slug}` });
      for (const email of t.userEmails) forbidden.push({ value: email, label: `e-mail (${t.slug})` });
      for (const name of t.userNames) forbidden.push({ value: name, label: `nome de corretor (${t.slug})` });
      for (const phone of t.userPhones) forbidden.push({ value: phone, label: `telefone (${t.slug})` });
    }

    // Guarda contra fixture degenerada. Se `forbidden` vier vazio ou cheio de
    // strings de 1 caractere, a busca por substring passa a nao significar
    // nada -- e o teste ficaria verde justamente quando parou de testar.
    expect(forbidden.length, 'fixture sem identificadores para procurar').toBeGreaterThan(10);
    for (const f of forbidden) {
      expect(
        typeof f.value === 'string' && f.value.length > 3,
        `identificador curto demais para busca por substring (${f.label}): ${JSON.stringify(f.value)}`,
      ).toBe(true);
    }

    const leaked = forbidden.filter((f) => f.value && payload.includes(f.value));
    expect(
      leaked.map((l) => `${l.label}: "${l.value}"`),
      'identificadores vazaram no resultado de busca',
    ).toEqual([]);
  });

  it('a resposta nao contem texto livre nem endereco vindos de properties', async () => {
    const sensitive = await withOracle(async (oracle) => {
      const { rows } = await oracle.query<Record<string, string>>(`
        SELECT title, description, street, reference_code
          FROM properties WHERE deleted_at IS NULL LIMIT 200
      `);
      return rows;
    });
    expect(sensitive.length).toBeGreaterThan(0);

    const { rows: listings } = await client.query('SELECT * FROM network_listings');
    const payload = JSON.stringify(listings);

    const leaked: string[] = [];
    for (const row of sensitive) {
      for (const [field, value] of Object.entries(row)) {
        if (typeof value === 'string' && value.length > 6 && payload.includes(value)) {
          leaked.push(`${field}: "${value.slice(0, 60)}"`);
        }
      }
    }
    expect(leaked, 'texto livre ou endereco vazou na busca').toEqual([]);
  });

  it('a string "tenant_id" nao aparece em lugar nenhum da resposta', async () => {
    const { rows } = await client.query('SELECT * FROM network_listings LIMIT 5');
    expect(JSON.stringify(rows)).not.toContain('tenant_id');
    expect(Object.keys(rows[0] ?? {})).not.toContain('tenant_id');
  });

  it('so aparecem na rede imoveis ativos e explicitamente publicados', async () => {
    const { expected, held } = await withOracle(async (oracle) => {
      const { rows } = await oracle.query<{ expected: string; held: string }>(`
        SELECT count(*) FILTER (
                 WHERE deleted_at IS NULL AND status = 'active' AND published_to_network
               )::text AS expected,
               count(*) FILTER (
                 WHERE NOT published_to_network OR status <> 'active'
               )::text AS held
          FROM properties
      `);
      return { expected: rows[0]?.expected, held: rows[0]?.held };
    });

    const { rows: actual } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM network_listings',
    );
    expect(actual[0]?.count).toBe(expected);

    // E realmente existe imovel retido -- senao a assercao acima seria vacua.
    expect(Number(held)).toBeGreaterThan(0);
  });

  it('midia ainda nao sanitizada nunca aparece na rede', async () => {
    // Foto com EXIF original carrega GPS, autor e copyright do dono. Enquanto
    // sanitized_at for nulo, ela nao existe para a rede.
    const { rows } = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
        FROM network_listing_media m
        JOIN property_media pm ON pm.id = m.media_id
       WHERE pm.sanitized_at IS NULL
    `);
    // A subquery acima nao devolve nada porque property_media esta sob RLS;
    // a checagem util e a de baixo, com a credencial administrativa.
    expect(rows[0]?.count).toBe('0');

    const pendingId = await withOracle(async (oracle) => {
      const { rows } = await oracle.query<{ id: string }>(
        'SELECT id FROM property_media WHERE sanitized_at IS NULL LIMIT 1',
      );
      return rows[0]?.id;
    });
    expect(pendingId, 'o seed deveria deixar midia pendente de sanitizacao').toBeTruthy();

    const { rows: visible } = await client.query(
      'SELECT media_id FROM network_listing_media WHERE media_id = $1',
      [pendingId],
    );
    expect(visible).toHaveLength(0);

    // E a funcao que resolve a chave de storage tambem recusa.
    const { rows: key } = await client.query<{ key: string | null }>(
      'SELECT network_media_storage_key($1) AS key',
      [pendingId],
    );
    expect(key[0]?.key).toBeNull();
  });

  it('a chave de storage nunca e devolvida junto com a listagem', async () => {
    const { rows } = await client.query('SELECT * FROM network_listing_media LIMIT 10');
    expect(rows.length).toBeGreaterThan(0);
    const payload = JSON.stringify(rows);
    expect(payload).not.toContain('media/');
    expect(payload).not.toContain('storage_key');
  });

  it('as views de busca pertencem ao role de bypass, e so a ele', async () => {
    const { rows } = await client.query<{ viewname: string; viewowner: string }>(
      `SELECT viewname, viewowner FROM pg_views
        WHERE viewname IN ('network_listings','network_listing_media')`,
    );
    expect(rows).toHaveLength(2);
    for (const v of rows) {
      // Com o dono errado a view para de atravessar o RLS e a busca volta
      // vazia -- falha barulhenta, nao vazamento. Ainda assim, checamos.
      expect(v.viewowner, `${v.viewname} com dono inesperado`).toBe('app_network_reader');
    }
  });
});
