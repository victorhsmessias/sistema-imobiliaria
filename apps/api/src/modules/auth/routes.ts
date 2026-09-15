import { loginInput } from '@imob/contracts';
import type { FastifyInstance } from 'fastify';
import { clearSessionCookies, REFRESH_COOKIE, setSessionCookies } from '../../lib/cookies.js';
import { validationFailed } from '../../lib/errors.js';
import * as service from './service.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Login.
   *
   * Rate limit mais apertado que o global: 8 tentativas por IP a cada 5
   * minutos. Nao e so contra forca bruta de senha -- e tambem contra varredura
   * de e-mails para descobrir quem sao os parceiros da rede.
   */
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: { max: 8, timeWindow: '5 minutes' },
      },
    },
    async (request, reply) => {
      const parsed = loginInput.safeParse(request.body);
      if (!parsed.success) {
        const fields: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          fields[issue.path.join('.') || 'body'] = issue.message;
        }
        throw validationFailed(fields);
      }

      const session = await service.login({
        email: parsed.data.email,
        password: parsed.data.password,
        userAgent: request.headers['user-agent'] ?? null,
        ip: request.ip,
      });

      setSessionCookies(reply, session);
      return reply.send({ user: session.user });
    },
  );

  app.post(
    '/auth/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE];
      if (!token) {
        clearSessionCookies(reply);
        return reply.code(401).send({ code: 'unauthenticated', message: 'Sem sessão.' });
      }

      try {
        const session = await service.refresh({
          refreshToken: token,
          userAgent: request.headers['user-agent'] ?? null,
          ip: request.ip,
        });
        setSessionCookies(reply, session);
        return reply.send({ user: session.user });
      } catch (error) {
        // Refresh que falha sempre limpa os cookies: deixar um token morto no
        // browser faz o front tentar renovar em loop.
        clearSessionCookies(reply);
        throw error;
      }
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    await service.logout(request.cookies[REFRESH_COOKIE]);
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    const user = await service.me(request.auth!.userId);
    return reply.send({ user });
  });
}
