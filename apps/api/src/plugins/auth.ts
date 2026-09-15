import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { unauthenticated } from '../lib/errors.js';
import { ACCESS_COOKIE } from '../lib/cookies.js';
import { findUserById } from '../modules/auth/repository.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

export interface AuthContext {
  userId: string;
  /** Nulo apenas para platform_admin. */
  tenantId: string | null;
  role: string;
  name: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
  interface FastifyInstance {
    /** preHandler: exige sessao valida e popula request.auth. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler: exige sessao valida COM tenant (exclui platform_admin). */
    requireTenant: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('auth', undefined);

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const token = request.cookies[ACCESS_COOKIE];
    if (!token) throw unauthenticated();

    const claims = await verifyAccessToken(token);
    if (!claims) throw unauthenticated();

    /**
     * Confere o usuario no banco a cada request, e nao apenas a assinatura
     * do JWT.
     *
     * Sem isso, desligar um corretor so faz efeito quando o access token
     * expira -- ate 15 minutos em que um ex-funcionario continua navegando na
     * carteira agregada da rede. Numa rede fechada B2B, onde o desligamento
     * costuma ser exatamente o momento em que o acesso precisa acabar, essa
     * janela e o caso que mais importa.
     *
     * O custo e uma busca por chave primaria. No volume da v1 e irrelevante;
     * se um dia pesar, o remedio e cache curto em memoria, nao remover a
     * checagem.
     */
    const user = await findUserById(claims.sub);
    if (!user || user.status !== 'active') throw unauthenticated();

    // token_version diferente = sessoes revogadas depois que este token saiu.
    if (user.token_version !== claims.tv) throw unauthenticated();

    if (user.role !== 'platform_admin' && user.tenant_status !== 'active') {
      throw unauthenticated('Parceiro suspenso ou inativo.');
    }

    request.auth = {
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
      name: user.name,
      email: user.email,
    };
  });

  app.decorate('requireTenant', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (!request.auth?.tenantId) {
      throw unauthenticated('Sessão sem parceiro associado.');
    }
  });
}

/** Lê o tenant da request, ou falha. Use nos services em vez do optional chain. */
export function tenantOf(request: FastifyRequest): string {
  const tenantId = request.auth?.tenantId;
  if (!tenantId) throw unauthenticated('Sessão sem parceiro associado.');
  return tenantId;
}
