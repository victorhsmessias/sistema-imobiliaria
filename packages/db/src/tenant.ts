import { sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { getDb, type Database } from './client.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executa `fn` dentro de uma transacao com o tenant ativo.
 *
 * ESTE E O UNICO CAMINHO para ler ou escrever dado de parceiro. Repositorio
 * que pega conexao por fora nao passa em revisao.
 *
 * Dois detalhes que nao sao decorativos:
 *
 *  1. `set_config(..., true)` -- o terceiro argumento torna o valor local a
 *     TRANSACAO. Sem ele, o tenant ficaria grudado na conexao do pool e a
 *     proxima request a pegar essa conexao herdaria o tenant anterior. Esse
 *     e exatamente o bug que vaza carteira de um parceiro para outro, e ele
 *     aparece so sob concorrencia, em producao.
 *
 *  2. `set_config` com parametro bindado, e nao `SET LOCAL`. SET LOCAL nao
 *     aceita parametro: seria preciso interpolar o uuid na string do comando.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`tenantId invalido: ${JSON.stringify(tenantId)}`);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Leitura da base agregada da rede (views network_*).
 *
 * Nome distinto de proposito: quando este identificador aparece num diff, a
 * revisao sabe que aquele trecho cruza a fronteira de tenant e olha com mais
 * atencao. Nao seta app.tenant_id -- as views tem dono com BYPASSRLS e
 * expoem apenas colunas da allow-list (ver sql/10_security.sql).
 */
export async function readNetwork<T>(
  fn: (tx: Tx) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

export type { PgTransaction };
