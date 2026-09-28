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
  assertTenantId(tenantId);

  return db.transaction(async (tx) => {
    await setTenant(tx, tenantId);
    return fn(tx);
  });
}

/**
 * Transacao da plataforma que so descobre o tenant no meio do caminho.
 *
 * Caso de uso: platform_admin nao tem tenant, e o dono da linha so e conhecido
 * depois de uma funcao SECURITY DEFINER (ex.: `connection_revoke_by_platform`).
 * Abrir duas transacoes -- uma para a funcao, outra com withTenant para a
 * trilha -- deixa uma janela em que a mudanca fica gravada sem o evento.
 *
 * Ate `enterTenant` ser chamado, a transacao nao tem app.tenant_id e o RLS
 * devolve zero linhas de dado de parceiro; so funcoes SECURITY DEFINER passam.
 * Depois dele, vale exatamente o mesmo regime de withTenant.
 */
export async function withLateTenant<T>(
  fn: (tx: Tx, enterTenant: (tenantId: string) => Promise<void>) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  return db.transaction(async (tx) => {
    let entered = false;
    return fn(tx, async (tenantId) => {
      if (entered) throw new Error('withLateTenant: tenant ja definido nesta transacao');
      assertTenantId(tenantId);
      await setTenant(tx, tenantId);
      entered = true;
    });
  });
}

function assertTenantId(tenantId: string): void {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`tenantId invalido: ${JSON.stringify(tenantId)}`);
  }
}

async function setTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
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
