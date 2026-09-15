import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { appDatabaseUrl, migratorDatabaseUrl } from './env.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

// numeric/decimal chegam do driver como string. Deixamos assim de proposito:
// converter valor monetario para float no driver e como o erro de arredondamento
// entra sem ninguem ver. Precos usam bigint em centavos; areas ficam em string
// e sao formatadas na borda.

function createDb(connectionString: string, max: number): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'sistema-imob',
  });
  return { db: drizzle(pool, { schema, casing: 'snake_case' }), pool };
}

let appHandle: { db: Database; pool: pg.Pool } | null = null;

/** Conexao de runtime da aplicacao (app_user). Sujeita a RLS. */
export function getDb(): Database {
  appHandle ??= createDb(appDatabaseUrl(), 10);
  return appHandle.db;
}

export function getPool(): pg.Pool {
  appHandle ??= createDb(appDatabaseUrl(), 10);
  return appHandle.pool;
}

export async function closeDb(): Promise<void> {
  if (appHandle) {
    await appHandle.pool.end();
    appHandle = null;
  }
}

/** Conexao de migration (app_migrator). Cria um pool proprio e efemero. */
export function createMigratorDb(): { db: Database; pool: pg.Pool } {
  return createDb(migratorDatabaseUrl(), 2);
}

/**
 * Trava de boot. A API deve chamar isto antes de aceitar a primeira request.
 *
 * O isolamento inteiro depende de a aplicacao se conectar como app_user. Se
 * alguem apontar DATABASE_URL para a credencial de migration -- o tipo de
 * erro que acontece copiando .env entre ambientes as 23h -- todas as policies
 * de RLS continuam existindo, continuam corretas, e param de filtrar
 * qualquer coisa. Nao ha erro, nao ha log: a busca simplesmente passa a
 * devolver os imoveis de todos os parceiros com o dono junto.
 *
 * Por isso a verificacao e no boot e derruba o processo, em vez de avisar.
 */
export async function assertRuntimeRole(db: Database = getDb()): Promise<void> {
  const result = await db.execute<{
    current_user: string;
    bypassrls: boolean;
    is_superuser: boolean;
  }>(sql`
    SELECT current_user,
           r.rolbypassrls AS bypassrls,
           r.rolsuper     AS is_superuser
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);

  const row = result.rows[0];
  if (!row) {
    throw new Error('Nao foi possivel identificar o role de conexao do banco.');
  }

  const problems: string[] = [];
  if (row.current_user !== 'app_user') {
    problems.push(`conectado como "${row.current_user}", esperado "app_user"`);
  }
  if (row.bypassrls) problems.push('o role tem BYPASSRLS');
  if (row.is_superuser) problems.push('o role e SUPERUSER');

  if (problems.length > 0) {
    throw new Error(
      `Credencial de banco insegura para runtime: ${problems.join('; ')}. ` +
        'Com esta conexao o RLS nao filtra nada e a busca vazaria dados entre parceiros. ' +
        'Verifique DATABASE_URL (deve apontar para app_user, nunca para app_migrator).',
    );
  }
}
