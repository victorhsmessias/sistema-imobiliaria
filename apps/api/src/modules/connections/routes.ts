import { connectionListQuery, createConnectionInput, decideConnectionInput, revokeConnectionInput } from '@imob/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { tenantOf } from '../../plugins/auth.js';
import type { ActorContext } from '../properties/service.js';
import * as service from './service.js';

const idParams = z.object({ id: z.string().uuid() });

function actorOf(request: FastifyRequest): ActorContext {
  return {
    tenantId: tenantOf(request),
    userId: request.auth!.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/** Guard para verificar se é platform_admin. */
async function requirePlatformAdmin(request: FastifyRequest): Promise<void> {
  if (request.auth?.role !== 'platform_admin') {
    throw forbidden('Apenas administradores da plataforma podem revogar conexões.');
  }
}

/**
 * Conexoes.
 *
 * Qualquer usuario do parceiro pede e decide: a conexao e um ato comercial da
 * imobiliaria, nao uma configuracao da conta (por isso nao exige
 * partner_admin, ao contrario da importacao).
 */
export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: app.requireTenant };

  app.post('/connections', guard, async (request, reply) => {
    const input = parseOrThrow(createConnectionInput, request.body);
    const connection = await service.request(actorOf(request), input);
    return reply.code(201).send({ connection });
  });

  app.get('/connections', guard, async (request) => {
    const query = parseOrThrow(connectionListQuery, request.query);
    const { items, total } = await service.list(actorOf(request), query);
    return { items, total, limit: query.limit, offset: query.offset };
  });

  app.get('/connections/:id', guard, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return service.getById(actorOf(request), id);
  });

  app.post('/connections/:id/approve', guard, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    const input = parseOrThrow(decideConnectionInput, request.body ?? {});
    return { connection: await service.approve(actorOf(request), id, input) };
  });

  app.post('/connections/:id/reject', guard, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    const input = parseOrThrow(decideConnectionInput, request.body ?? {});
    return { connection: await service.reject(actorOf(request), id, input) };
  });

  app.post('/connections/:id/cancel', guard, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return { connection: await service.cancel(actorOf(request), id) };
  });

  app.post(
    '/connections/:id/revoke',
    { preHandler: [app.authenticate, requirePlatformAdmin] },
    async (request, reply) => {
      const { id } = parseOrThrow(idParams, request.params);
      const input = parseOrThrow(revokeConnectionInput, request.body);
      // A revogacao usa ownerTenantId da conexao para contexto (obtido dentro do service).
      // Aqui so passamos userId para auditoria.
      const actor: ActorContext = {
        tenantId: request.auth!.userId,
        userId: request.auth!.userId,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      };
      return reply.code(200).send({ connection: await service.revoke(actor, id, input.reason) });
    },
  );
}
