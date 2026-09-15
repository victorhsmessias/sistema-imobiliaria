import type { FastifyReply } from 'fastify';
import { env } from '../env.js';

export const ACCESS_COOKIE = 'imob_at';
export const REFRESH_COOKIE = 'imob_rt';

/**
 * Cookies de sessao.
 *
 * httpOnly: o token nunca e legivel por JavaScript, entao um XSS em qualquer
 *   ponto do front nao vira roubo de sessao.
 * sameSite lax: a aplicacao e uma rede fechada; nao ha fluxo cross-site
 *   legitimo, e lax ja barra CSRF em POST.
 * path do refresh: restrito a /auth. Ele so e util para renovar, entao nao
 *   viaja junto de toda request -- menos exposicao em log de proxy, menos
 *   superficie se algo vazar do lado do servidor.
 */
function baseOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax' as const,
    domain: env.COOKIE_DOMAIN,
  };
}

export function setSessionCookies(
  reply: FastifyReply,
  tokens: { accessToken: string; refreshToken: string },
): void {
  reply.setCookie(ACCESS_COOKIE, tokens.accessToken, {
    ...baseOptions(),
    path: '/',
    // Sem maxAge: cookie de sessao do browser. A validade real e a do JWT.
  });

  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...baseOptions(),
    path: '/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { ...baseOptions(), path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { ...baseOptions(), path: '/auth' });
}
