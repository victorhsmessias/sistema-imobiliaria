import { getDb, sql } from '@imob/db';

/**
 * Acesso ao banco para autenticacao.
 *
 * Todas as chamadas aqui passam por funcoes SECURITY DEFINER declaradas em
 * packages/db/sql/10_security.sql. O motivo: no momento do login ainda nao
 * existe tenant no contexto -- descobrir qual e o tenant e justamente o que o
 * login faz -- entao estas leituras nao podem passar pelas policies de RLS.
 *
 * A superficie e deliberadamente minima. refresh_tokens, em particular, nao
 * tem privilegio nenhum para app_user: so estas funcoes a tocam.
 */

export interface AuthUserRow {
  id: string;
  tenant_id: string | null;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  status: string;
  token_version: number;
  tenant_status: string | null;
  tenant_display_name: string | null;
  tenant_slug: string | null;
}

export type AuthUserWithoutSecret = Omit<AuthUserRow, 'password_hash'>;

// O retorno cru do driver e Record<string, unknown>; a forma da linha e
// garantida pela assinatura RETURNS TABLE das funcoes em sql/10_security.sql.
// A conversao fica aqui, na borda, e nao espalhada pelos services.

export async function findUserByEmail(email: string): Promise<AuthUserRow | null> {
  const { rows } = await getDb().execute(
    sql`SELECT * FROM auth_find_user_by_email(${email}::citext)`,
  );
  return (rows[0] as AuthUserRow | undefined) ?? null;
}

export async function findUserById(userId: string): Promise<AuthUserWithoutSecret | null> {
  const { rows } = await getDb().execute(
    sql`SELECT * FROM auth_find_user_by_id(${userId}::uuid)`,
  );
  return (rows[0] as AuthUserWithoutSecret | undefined) ?? null;
}

export async function touchLastLogin(userId: string): Promise<void> {
  await getDb().execute(sql`SELECT auth_touch_last_login(${userId}::uuid)`);
}

export async function issueRefreshToken(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<void> {
  await getDb().execute(sql`
    SELECT auth_issue_refresh_token(
      ${input.userId}::uuid,
      ${input.tokenHash},
      ${input.expiresAt.toISOString()}::timestamptz,
      ${input.userAgent ?? null},
      ${input.ip ?? null}::inet
    )
  `);
}

/**
 * Consome o refresh token e o invalida no mesmo comando (uso unico).
 *
 * Se dois requests chegarem com o mesmo token, apenas um recebe linha de
 * volta. O outro ve zero linhas -- ou o token foi roubado e reutilizado, ou
 * duas abas renovaram ao mesmo tempo. Em ambos os casos a sessao cai.
 */
export async function consumeRefreshToken(tokenHash: string): Promise<{ user_id: string } | null> {
  const { rows } = await getDb().execute(
    sql`SELECT * FROM auth_consume_refresh_token(${tokenHash})`,
  );
  return (rows[0] as { user_id: string } | undefined) ?? null;
}

export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  await getDb().execute(sql`SELECT auth_revoke_refresh_token(${tokenHash})`);
}

/** Derruba todas as sessoes e invalida os access tokens ja emitidos. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await getDb().execute(sql`SELECT auth_revoke_all_sessions(${userId}::uuid)`);
}
