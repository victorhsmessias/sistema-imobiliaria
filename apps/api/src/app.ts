import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ERROR_CODES } from '@imob/contracts';
import { assertRuntimeRole } from '@imob/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './env.js';
import { AppError } from './lib/errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { importRoutes } from './modules/imports/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { propertyRoutes } from './modules/properties/routes.js';
import { searchRoutes } from './modules/search/routes.js';
import { registerAuth } from './plugins/auth.js';

export interface BuildAppOptions {
  /**
   * Desliga o rate limit. Serve para a suite de testes, que faz dezenas de
   * logins seguidos e bateria no limite de 8 por 5 minutos. Existe um teste
   * dedicado que sobe a app com o limite ligado.
   */
  rateLimit?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { rateLimit: rateLimitEnabled = true } = options;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        // Senha e cookie em log de acesso sao vazamento permanente: ficam em
        // disco, em backup e no agregador de logs, fora de qualquer controle
        // de retencao do banco.
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
          'body.password',
        ],
        censor: '[redacted]',
      },
    },
    /**
     * Quantos proxies a frente da API sao confiaveis -- nunca `true`.
     *
     * Com `true`, o Fastify usa o IP mais a esquerda do X-Forwarded-For, que e
     * justamente o que o cliente consegue escrever. Bastaria mandar um XFF
     * diferente a cada tentativa para zerar o rate limit do login e varrer
     * e-mails de parceiros a vontade.
     *
     * Em producao a cadeia e cliente -> Traefik -> Next (BFF) -> API. O Traefik
     * anexa o IP real, o BFF repassa sem acrescentar nada, e a API confia
     * apenas no salto imediato (o BFF). Resultado: o IP que conta e o que o
     * Traefik viu, nao o que o cliente declarou.
     */
    // Funcao em vez de numero: o runtime aceita numero, mas os tipos do Fastify
    // nao. hop 0 e o par imediato (o BFF); confiar em hop < N confia nos N
    // saltos mais proximos e usa o endereco seguinte como IP do cliente.
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS,
  });

  /**
   * Trava de credencial, antes de qualquer rota.
   *
   * O isolamento entre parceiros depende de a aplicacao falar com o banco
   * como app_user. Se DATABASE_URL apontar para a credencial de migration --
   * o tipo de erro que acontece copiando .env entre ambientes -- as policies
   * de RLS continuam la, corretas, e param de filtrar qualquer coisa. Nao ha
   * erro nem log: a busca simplesmente passa a devolver os imoveis de todos
   * os parceiros com o dono junto.
   *
   * Por isso derruba o boot em vez de avisar.
   */
  await assertRuntimeRole();

  await app.register(cookie);

  await app.register(cors, {
    origin: env.WEB_PUBLIC_URL,
    credentials: true,
  });

  if (rateLimitEnabled) {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
      // Rede fechada: a chave e o IP, e o limite global e generoso. Os limites
      // que importam sao os por rota (ver /auth/login).
      keyGenerator: (request) => request.ip,
    });
  }

  await app.register(multipart, {
    limits: {
      // 15 MB cobre foto de celular sem reencode. Acima disso e quase sempre
      // engano -- e um upload de 200 MB numa VPS pequena derruba o processo.
      fileSize: 15 * 1024 * 1024,
      files: 1,
      fields: 4,
    },
  });

  registerAuth(app);

  app.setErrorHandler((error: unknown, request, reply) => {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : undefined;
    const message =
      error instanceof Error ? error.message : 'Erro interno. Tente novamente.';

    if (error instanceof AppError) {
      // Erro esperado de negocio: log em nivel baixo, sem stack.
      request.log.info(
        { code: error.code, statusCode: error.statusCode, path: request.url },
        error.message,
      );
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
      });
    }

    if (statusCode === 429) {
      return reply.code(429).send({
        code: ERROR_CODES.RATE_LIMITED,
        message: 'Muitas tentativas. Aguarde alguns minutos.',
      });
    }

    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        code: ERROR_CODES.VALIDATION,
        message,
      });
    }

    request.log.error({ err: error, path: request.url }, 'erro nao tratado');
    // Nunca devolver a mensagem original: ela costuma trazer nome de tabela,
    // de coluna e trecho de SQL.
    return reply.code(500).send({
      code: ERROR_CODES.INTERNAL,
      message: 'Erro interno. Tente novamente.',
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(propertyRoutes);
  await app.register(mediaRoutes);
  await app.register(searchRoutes);
  await app.register(importRoutes);

  return app;
}
