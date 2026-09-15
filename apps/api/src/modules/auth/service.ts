import type { SessionUser } from '@imob/contracts';
import { invalidCredentials, unauthenticated } from '../../lib/errors.js';
import { referenceHash, verifyPassword } from '../../lib/password.js';
import * as repo from './repository.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiryDate,
  signAccessToken,
} from './tokens.js';

export interface SessionResult {
  user: SessionUser;
  accessToken: string;
  refreshToken: string;
}

function toSessionUser(row: {
  id: string;
  email: string;
  name: string;
  role: string;
  tenant_id: string | null;
  tenant_display_name: string | null;
  tenant_slug: string | null;
}): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as SessionUser['role'],
    tenant:
      row.tenant_id && row.tenant_display_name && row.tenant_slug
        ? { id: row.tenant_id, displayName: row.tenant_display_name, slug: row.tenant_slug }
        : null,
  };
}

export async function login(input: {
  email: string;
  password: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<SessionResult> {
  const user = await repo.findUserByEmail(input.email);

  // E-mail inexistente ainda paga o custo de um verify, contra hash real.
  // Ver lib/password.ts para o motivo.
  if (!user) {
    await verifyPassword(await referenceHash(), input.password);
    throw invalidCredentials();
  }

  const passwordOk = await verifyPassword(user.password_hash, input.password);
  if (!passwordOk) throw invalidCredentials();

  // Usuario desligado ou parceiro suspenso responde igual a senha errada:
  // nao confirmamos sequer que a conta existe.
  if (user.status !== 'active') throw invalidCredentials();
  if (user.role !== 'platform_admin' && user.tenant_status !== 'active') {
    throw invalidCredentials();
  }

  return issueSession(user, input.userAgent, input.ip);
}

async function issueSession(
  user: repo.AuthUserWithoutSecret,
  userAgent?: string | null,
  ip?: string | null,
): Promise<SessionResult> {
  const accessToken = await signAccessToken({
    sub: user.id,
    tid: user.tenant_id,
    role: user.role,
    tv: user.token_version,
  });

  const refresh = generateRefreshToken();
  await repo.issueRefreshToken({
    userId: user.id,
    tokenHash: refresh.hash,
    expiresAt: refreshExpiryDate(),
    userAgent: userAgent ?? null,
    ip: ip ?? null,
  });
  await repo.touchLastLogin(user.id);

  return { user: toSessionUser(user), accessToken, refreshToken: refresh.token };
}

/**
 * Rotaciona a sessao. O token antigo e invalidado pela propria consulta que o
 * consome, entao reapresenta-lo nao funciona.
 */
export async function refresh(input: {
  refreshToken: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<SessionResult> {
  const consumed = await repo.consumeRefreshToken(hashRefreshToken(input.refreshToken));
  if (!consumed) throw unauthenticated();

  const user = await repo.findUserById(consumed.user_id);
  if (!user || user.status !== 'active') throw unauthenticated();
  if (user.role !== 'platform_admin' && user.tenant_status !== 'active') {
    throw unauthenticated();
  }

  return issueSession(user, input.userAgent, input.ip);
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await repo.revokeRefreshToken(hashRefreshToken(refreshToken));
}

export async function me(userId: string): Promise<SessionUser> {
  const user = await repo.findUserById(userId);
  if (!user || user.status !== 'active') throw unauthenticated();
  return toSessionUser(user);
}
