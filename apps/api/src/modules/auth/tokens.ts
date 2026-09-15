import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../env.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'imob.api';
const AUDIENCE = 'imob.web';

export interface AccessClaims {
  /** userId */
  sub: string;
  /** tenantId; nulo para admin de plataforma */
  tid: string | null;
  role: string;
  /** token_version do usuario no momento da emissao */
  tv: number;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ tid: claims.tid, role: claims.role, tv: claims.tv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.tv !== 'number') return null;
    return {
      sub: payload.sub,
      tid: typeof payload.tid === 'string' ? payload.tid : null,
      role: typeof payload.role === 'string' ? payload.role : '',
      tv: payload.tv,
    };
  } catch {
    // Assinatura invalida, expirado, issuer errado -- para o chamador e tudo
    // a mesma coisa: nao ha sessao.
    return null;
  }
}

/**
 * Refresh token opaco.
 *
 * O banco guarda apenas o SHA-256. Um dump do banco -- backup vazado, acesso
 * de leitura indevido -- nao permite personificar ninguem, porque o valor
 * armazenado nao serve como token.
 *
 * SHA-256 puro basta aqui, ao contrario de senha: o token tem 256 bits de
 * entropia real, entao nao ha o que forcar por dicionario.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Comparacao de hashes em tempo constante. */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function refreshExpiryDate(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
