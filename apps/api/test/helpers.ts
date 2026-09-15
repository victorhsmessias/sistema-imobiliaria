import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';

/**
 * Extrai os cookies de uma resposta num formato pronto para reenviar.
 *
 * `app.inject()` nao mantem cookie jar, entao os testes carregam a sessao a
 * mao. Isso e uma vantagem aqui: deixa explicito qual cookie esta indo em
 * cada request, que e exatamente o que os testes de sessao precisam controlar.
 */
export function cookiesFrom(response: LightMyRequestResponse): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const cookie of response.cookies) {
    // Cookie apagado (clearCookie) vem com valor vazio; nao faz sentido reenviar.
    if (cookie.value !== '') jar[cookie.name] = cookie.value;
  }
  return jar;
}

/**
 * Conexao "oraculo": enxerga tudo, sem RLS.
 *
 * Os testes precisam conhecer a verdade -- nomes, telefones, enderecos reais
 * de cada parceiro -- para poder afirmar que ela nao apareceu na resposta que
 * o outro parceiro recebeu. So existe em dev e CI.
 */
export async function withOracle<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL_TEST_ORACLE;
  if (!url) throw new Error('DATABASE_URL_TEST_ORACLE ausente. Veja .env.example.');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface SeedFixture {
  tenants: Array<{
    id: string;
    slug: string;
    legalName: string;
    displayName: string;
    emails: string[];
    names: string[];
    phones: string[];
  }>;
  neighborhoods: Array<{ id: string; name: string; cityId: string }>;
}

export async function loadFixture(): Promise<SeedFixture> {
  return withOracle(async (client) => {
    const tenants = await client.query(`
      SELECT t.id, t.slug, t.legal_name AS "legalName", t.display_name AS "displayName",
             coalesce(array_agg(u.email::text) FILTER (WHERE u.email IS NOT NULL), '{}'::text[]) AS emails,
             coalesce(array_agg(u.name)        FILTER (WHERE u.name  IS NOT NULL), '{}'::text[]) AS names,
             coalesce(array_agg(u.phone)       FILTER (WHERE u.phone IS NOT NULL), '{}'::text[]) AS phones
        FROM tenants t LEFT JOIN users u ON u.tenant_id = t.id
       GROUP BY t.id ORDER BY t.slug
    `);

    const neighborhoods = await client.query(`
      SELECT id, name, city_id AS "cityId"
        FROM neighborhoods ORDER BY name
    `);

    return {
      tenants: tenants.rows as SeedFixture['tenants'],
      neighborhoods: neighborhoods.rows as SeedFixture['neighborhoods'],
    };
  });
}

/** Faz login e devolve o jar de cookies resultante. */
export async function loginAs(
  app: FastifyInstance,
  email: string,
  password = 'demo1234',
): Promise<{ cookies: Record<string, string>; body: Record<string, unknown>; statusCode: number }> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  return {
    cookies: cookiesFrom(response),
    body: response.json(),
    statusCode: response.statusCode,
  };
}
