import '../src/load-env.js';
import pg from 'pg';

/**
 * Conexoes cruas para os testes de seguranca.
 *
 * Os testes usam `pg` direto em vez do drizzle de proposito: queremos observar
 * o que o BANCO faz, sem nenhuma camada nossa no meio que pudesse mascarar o
 * resultado. Um teste de RLS que passa por causa de um filtro do ORM nao
 * testou nada.
 */

export function appClient(): pg.Client {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL ausente');
  return new pg.Client({ connectionString: url });
}

export function migratorClient(): pg.Client {
  const url = process.env.DATABASE_URL_MIGRATOR;
  if (!url) throw new Error('DATABASE_URL_MIGRATOR ausente');
  return new pg.Client({ connectionString: url });
}

/**
 * Conexao "oraculo": enxerga tudo, sem RLS.
 *
 * Um teste de anonimizacao precisa conhecer a verdade para poder afirmar que
 * ela nao vazou -- precisa dos nomes, telefones e enderecos reais do tenant B
 * para procurar por eles na resposta que o tenant A recebeu.
 *
 * app_migrator nao serve: properties e property_media tem FORCE ROW LEVEL
 * SECURITY, entao ate o dono das tabelas e filtrado (o que e o
 * comportamento desejado -- so torna o migrator inutil como oraculo).
 *
 * Existe apenas em dev e CI.
 */
export function oracleClient(): pg.Client {
  const url = process.env.DATABASE_URL_TEST_ORACLE;
  if (!url) {
    throw new Error(
      'DATABASE_URL_TEST_ORACLE ausente. A suite de seguranca precisa de uma conexao ' +
        'sem RLS para comparar. Veja .env.example.',
    );
  }
  return new pg.Client({ connectionString: url });
}

/** Abre o oraculo, roda `fn` e fecha. */
export async function withOracle<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = oracleClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface SeededTenant {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  userEmails: string[];
  userNames: string[];
  userPhones: string[];
}

/** Le os parceiros criados pelo seed, pelo oraculo. */
export async function loadSeededTenants(): Promise<SeededTenant[]> {
  return withOracle(async (client) => {
    const { rows } = await client.query<SeededTenant>(`
      SELECT t.id,
             t.slug,
             t.legal_name    AS "legalName",
             t.display_name  AS "displayName",
             -- O cast ::text[] importa. Sem ele o '{}' e do tipo "unknown", o
             -- Postgres resolve a coluna inteira como text, o driver devolve a
             -- string "{a@b.test,c@d.test}" em vez de um array, e qualquer
             -- iteracao passa a percorrer CARACTERES. Num teste que procura
             -- substrings, isso vira falso positivo em todo lugar.
             coalesce(array_agg(u.email::text) FILTER (WHERE u.email IS NOT NULL), '{}'::text[]) AS "userEmails",
             coalesce(array_agg(u.name)        FILTER (WHERE u.name  IS NOT NULL), '{}'::text[]) AS "userNames",
             coalesce(array_agg(u.phone)       FILTER (WHERE u.phone IS NOT NULL), '{}'::text[]) AS "userPhones"
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id
      GROUP BY t.id
      ORDER BY t.slug
    `);
    return rows;
  });
}

/** Executa uma query como app_user com o tenant ativo, dentro de uma transacao. */
export async function asTenant<T>(
  client: pg.Client,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
