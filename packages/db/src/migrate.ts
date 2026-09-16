import './load-env.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createMigratorDb } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

/**
 * Migration em duas etapas, nesta ordem:
 *
 *  1. Migrations do drizzle-kit (DDL versionada, gerada a partir do schema).
 *  2. sql/10_security.sql -- policies de RLS, views de busca e funcoes de auth.
 *
 * A etapa 2 e idempotente e roda sempre. Isso mantem as policies coladas ao
 * arquivo que as descreve: nao existe estado de seguranca no banco que nao
 * esteja neste repositorio.
 *
 * Roda como app_migrator. Nunca chamado pelo processo da API -- e um step
 * separado no deploy, e nao o entrypoint do container. Migration no start
 * com mais de uma replica vira corrida entre containers.
 */
async function main(): Promise<void> {
  const { db, pool } = createMigratorDb();

  try {
    const role = await pool.query<{ current_user: string }>('SELECT current_user');
    console.log(`[migrate] conectado como ${role.rows[0]?.current_user}`);

    console.log('[migrate] aplicando migrations do drizzle...');
    await migrate(db, { migrationsFolder: join(packageRoot, 'drizzle') });

    console.log('[migrate] aplicando sql/10_security.sql (RLS, views, funcoes)...');
    const securitySql = await readFile(join(packageRoot, 'sql', '10_security.sql'), 'utf8');
    await pool.query(securitySql);

    await verify(pool);
    console.log('[migrate] ok');
  } finally {
    await pool.end();
  }
}

/**
 * Confere o resultado em vez de confiar nele. Uma policy que deixou de ser
 * aplicada e silenciosa: nada falha, a busca so passa a devolver mais do que
 * devia.
 */
/** Tabelas com dado de parceiro em que nem o dono da tabela escapa da policy. */
const FORCED_TABLES = [
  'properties',
  'property_media',
  'refresh_tokens',
  'import_sources',
  'import_jobs',
  'import_items',
  'connection_requests',
  'connection_events',
];
const RLS_TABLES = [...FORCED_TABLES, 'users', 'tenants', 'audit_log'];

async function verify(pool: import('pg').Pool): Promise<void> {
  const forced = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
      WHERE relname = ANY($1::text[])
        AND relkind = 'r'`,
    [RLS_TABLES],
  );

  const missing = RLS_TABLES.filter(
    (table) => !forced.rows.some((r) => r.relname === table && r.relrowsecurity),
  );
  if (missing.length > 0) {
    throw new Error(`[migrate] RLS nao esta habilitado em: ${missing.join(', ')}`);
  }

  const notForced = FORCED_TABLES.filter(
    (table) => !forced.rows.some((r) => r.relname === table && r.relforcerowsecurity),
  );
  if (notForced.length > 0) {
    throw new Error(`[migrate] FORCE ROW LEVEL SECURITY ausente em: ${notForced.join(', ')}`);
  }

  const viewOwner = await pool.query<{ viewname: string; viewowner: string }>(
    `SELECT viewname, viewowner FROM pg_views
      WHERE viewname IN ('network_listings','network_listing_media')`,
  );
  if (viewOwner.rows.length !== 2) {
    throw new Error('[migrate] views de busca da rede ausentes.');
  }
  for (const v of viewOwner.rows) {
    if (v.viewowner !== 'app_network_reader') {
      throw new Error(
        `[migrate] view ${v.viewname} pertence a ${v.viewowner}; deveria ser app_network_reader. ` +
          'Com o dono errado ela nao atravessa o RLS e a busca da rede volta vazia.',
      );
    }
  }

  for (const row of forced.rows) {
    console.log(
      `[migrate]   ${row.relname.padEnd(16)} rls=${row.relrowsecurity} force=${row.relforcerowsecurity}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error('[migrate] falhou:', error);
  process.exit(1);
});
