import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appClient, asTenant, loadSeededTenants, withOracle, type SeededTenant } from './helpers.js';

/**
 * Isolamento por tenant.
 *
 * Estes testes existem porque a falha que eles previnem e SILENCIOSA. Um RLS
 * quebrado nao lanca erro nem aparece no log: a busca simplesmente passa a
 * devolver imoveis de outros parceiros, e ninguem descobre ate um parceiro
 * ver a carteira do concorrente.
 */
describe('isolamento por tenant (RLS)', () => {
  let client: pg.Client;
  let tenants: SeededTenant[];
  let alfa: SeededTenant;
  let beta: SeededTenant;

  beforeAll(async () => {
    tenants = await loadSeededTenants();
    expect(tenants.length).toBeGreaterThanOrEqual(2);
    alfa = tenants[0] as SeededTenant;
    beta = tenants[1] as SeededTenant;

    client = appClient();
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('conecta como app_user, sem BYPASSRLS e sem superuser', async () => {
    const { rows } = await client.query<{
      current_user: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      `SELECT current_user, r.rolbypassrls, r.rolsuper
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]?.current_user).toBe('app_user');
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolsuper).toBe(false);
  });

  it('FAIL-CLOSED: sem tenant no contexto, properties devolve zero linhas', async () => {
    // A propriedade que mais importa no arquivo inteiro. Esquecer de setar o
    // tenant tem que resultar em NADA, nunca em TUDO.
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM properties',
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('fail-closed tambem em property_media e audit_log', async () => {
    for (const table of ['property_media', 'audit_log']) {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(rows[0]?.count, `${table} deveria devolver zero sem tenant`).toBe('0');
    }
  });

  it('com o tenant ativo, enxerga apenas a propria carteira', async () => {
    const alfaTenantIds = await asTenant(client, alfa.id, async () => {
      const { rows } = await client.query<{ tenant_id: string }>(
        'SELECT DISTINCT tenant_id FROM properties',
      );
      return rows.map((r) => r.tenant_id);
    });

    expect(alfaTenantIds).toEqual([alfa.id]);

    const betaTenantIds = await asTenant(client, beta.id, async () => {
      const { rows } = await client.query<{ tenant_id: string }>(
        'SELECT DISTINCT tenant_id FROM properties',
      );
      return rows.map((r) => r.tenant_id);
    });

    expect(betaTenantIds).toEqual([beta.id]);
  });

  it('nao encontra um imovel de outro parceiro nem buscando pelo id exato', async () => {
    const betaPropertyId = await withOracle(async (oracle) => {
      const { rows } = await oracle.query<{ id: string }>(
        'SELECT id FROM properties WHERE tenant_id = $1 LIMIT 1',
        [beta.id],
      );
      return rows[0]?.id as string;
    });
    expect(betaPropertyId).toBeTruthy();

    const found = await asTenant(client, alfa.id, async () => {
      const { rows } = await client.query('SELECT id FROM properties WHERE id = $1', [
        betaPropertyId,
      ]);
      return rows;
    });

    // Zero linhas, e nao erro de permissao: a API responde 404. Um 403 aqui
    // ja confirmaria ao solicitante que o imovel existe.
    expect(found).toHaveLength(0);
  });

  it('recusa INSERT carimbado com o tenant de outro parceiro', async () => {
    await expect(
      asTenant(client, alfa.id, async () => {
        await client.query(
          `INSERT INTO properties (tenant_id, title, type, city_id, neighborhood_id)
           SELECT $1, 'invasao', 'casa', c.id, n.id
             FROM cities c, neighborhoods n LIMIT 1`,
          [beta.id],
        );
      }),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('UPDATE cross-tenant nao afeta nenhuma linha', async () => {
    const affected = await asTenant(client, alfa.id, async () => {
      const result = await client.query('UPDATE properties SET title = $1 WHERE tenant_id = $2', [
        'sequestrado',
        beta.id,
      ]);
      return result.rowCount;
    });
    expect(affected).toBe(0);
  });

  it('o tenant nao gruda na conexao entre transacoes', async () => {
    // set_config(..., true) e LOCAL a transacao. Se alguem trocar por
    // SET SESSION, este teste quebra -- e e exatamente o bug que faz uma
    // request herdar o tenant da request anterior que usou a mesma conexao
    // do pool. So aparece sob concorrencia, em producao.
    await asTenant(client, alfa.id, async () => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM properties',
      );
      expect(Number(rows[0]?.count)).toBeGreaterThan(0);
    });

    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM properties',
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('nao tem acesso nenhum a refresh_tokens', async () => {
    await expect(client.query('SELECT * FROM refresh_tokens LIMIT 1')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('nao consegue alterar nem apagar a trilha de auditoria', async () => {
    await expect(
      asTenant(client, alfa.id, () => client.query('UPDATE audit_log SET action = $1', ['x'])),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asTenant(client, alfa.id, () => client.query('DELETE FROM audit_log')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('nao consegue escrever no catalogo geografico', async () => {
    await expect(
      client.query("INSERT INTO cities (uf, name, slug) VALUES ('RJ', 'x', 'x')"),
    ).rejects.toThrow(/permission denied/i);
  });

  describe('importacao XML', () => {
    const IMPORT_TABLES = ['import_sources', 'import_jobs', 'import_items'];

    it('fail-closed nas tabelas de importacao', async () => {
      for (const table of IMPORT_TABLES) {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        expect(rows[0]?.count, `${table} deveria devolver zero sem tenant`).toBe('0');
      }
    });

    it('recusa feed carimbado com o tenant de outro parceiro', async () => {
      await expect(
        asTenant(client, alfa.id, () =>
          client.query(`INSERT INTO import_sources (tenant_id, name) VALUES ($1, 'feed invasor')`, [
            beta.id,
          ]),
        ),
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('um parceiro nao enxerga a URL do feed de outro', async () => {
      // A URL do feed e o dominio da imobiliaria: vazar isto e vazar o dono.
      const sourceId = await asTenant(client, beta.id, async () => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO import_sources (tenant_id, name, feed_url)
           VALUES ($1, 'Feed da Beta', 'https://beta-imoveis.test/feed.xml') RETURNING id`,
          [beta.id],
        );
        return rows[0]!.id;
      });

      try {
        const visto = await asTenant(client, alfa.id, async () => {
          const { rows } = await client.query('SELECT id FROM import_sources WHERE id = $1', [sourceId]);
          return rows;
        });
        expect(visto).toHaveLength(0);
      } finally {
        await asTenant(client, beta.id, () =>
          client.query('DELETE FROM import_sources WHERE id = $1', [sourceId]),
        );
      }
    });

    it('le a traducao de PropertyType, mas nao escreve nela', async () => {
      const { rows } = await client.query<{ type: string }>(
        `SELECT type FROM property_type_mappings WHERE source_key = 'apartment'`,
      );
      expect(rows[0]?.type).toBe('apartamento');

      await expect(
        client.query(`INSERT INTO property_type_mappings (source_key, type) VALUES ('invasao', 'casa')`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('conexoes (linha de dois donos)', () => {
    /** Cria um pedido da Alfa num imovel da Beta, pelo oraculo. */
    async function criarPedido(): Promise<string> {
      return withOracle(async (oracle) => {
        const { rows } = await oracle.query<{ id: string }>(
          `INSERT INTO connection_requests
             (property_id, requester_tenant_id, requester_user_id, owner_tenant_id, expires_at)
           SELECT p.id, $1, u.id, $2, now() + interval '7 days'
             FROM properties p, users u
            WHERE p.tenant_id = $2 AND u.tenant_id = $1
            LIMIT 1
           RETURNING id`,
          [alfa.id, beta.id],
        );
        return rows[0]!.id;
      });
    }

    it('fail-closed: sem tenant no contexto, nao ha conexao nem trilha', async () => {
      for (const table of ['connection_requests', 'connection_events']) {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        expect(rows[0]?.count, `${table} deveria devolver zero sem tenant`).toBe('0');
      }
    });

    it('as DUAS pontas enxergam a mesma linha, e mais ninguem', async () => {
      const id = await criarPedido();
      const carlos = tenants[2] as SeededTenant;

      try {
        for (const tenant of [alfa, beta]) {
          const visto = await asTenant(client, tenant.id, async () => {
            const { rows } = await client.query('SELECT id FROM connection_requests WHERE id = $1', [id]);
            return rows;
          });
          expect(visto, `${tenant.slug} deveria ver a conexao`).toHaveLength(1);
        }

        const terceiro = await asTenant(client, carlos.id, async () => {
          const { rows } = await client.query('SELECT id FROM connection_requests WHERE id = $1', [id]);
          return rows;
        });
        expect(terceiro).toHaveLength(0);
      } finally {
        await withOracle((oracle) => oracle.query('DELETE FROM connection_requests WHERE id = $1', [id]));
      }
    });

    it('nao da para pedir conexao em nome de outro parceiro', async () => {
      // Os ids vem pelo oraculo: montar o INSERT com um SELECT sujeito ao RLS
      // faria a consulta interna devolver zero linhas, e o teste passaria sem
      // nunca ter exercitado a policy.
      const { propertyId, betaUserId } = await withOracle(async (oracle) => {
        const { rows } = await oracle.query<{ propertyId: string; betaUserId: string }>(
          `SELECT p.id AS "propertyId", u.id AS "betaUserId"
             FROM properties p, users u
            WHERE p.tenant_id = $1 AND u.tenant_id = $1
            LIMIT 1`,
          [beta.id],
        );
        return rows[0]!;
      });

      // Alfa tentando registrar um pedido como se fosse a Beta.
      await expect(
        asTenant(client, alfa.id, () =>
          client.query(
            `INSERT INTO connection_requests
               (property_id, requester_tenant_id, requester_user_id, owner_tenant_id, expires_at)
             VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
            [propertyId, beta.id, betaUserId, alfa.id],
          ),
        ),
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('a trilha da conexao e append-only', async () => {
      await expect(
        asTenant(client, alfa.id, () => client.query('UPDATE connection_events SET type = $1', ['approved'])),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        asTenant(client, alfa.id, () => client.query('DELETE FROM connection_events')),
      ).rejects.toThrow(/permission denied/i);
    });

    it('conexao nao se apaga, muda de status', async () => {
      await expect(
        asTenant(client, alfa.id, () => client.query('DELETE FROM connection_requests')),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('RLS esta habilitado, e FORCE onde o dono tambem precisa ser barrado', async () => {
    const forced = [
      'properties',
      'property_media',
      'refresh_tokens',
      'import_sources',
      'import_jobs',
      'import_items',
      'connection_requests',
      'connection_events',
    ];
    const all = [...forced, 'users', 'tenants', 'audit_log'];

    const { rows } = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relkind = 'r'
          AND relname = ANY($1::text[])`,
      [all],
    );

    const byName = new Map(rows.map((r) => [r.relname, r]));
    for (const table of all) {
      expect(byName.get(table)?.relrowsecurity, `${table} sem RLS`).toBe(true);
    }
    for (const table of forced) {
      expect(byName.get(table)?.relforcerowsecurity, `${table} sem FORCE`).toBe(true);
    }
  });
});
