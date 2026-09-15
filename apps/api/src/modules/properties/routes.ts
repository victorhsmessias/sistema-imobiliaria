import { createPropertyInput, propertyStatus, updatePropertyInput } from '@imob/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '../../lib/validate.js';
import { tenantOf } from '../../plugins/auth.js';
import * as service from './service.js';

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: propertyStatus.optional(),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function actorOf(request: FastifyRequest): service.ActorContext {
  return {
    tenantId: tenantOf(request),
    userId: request.auth!.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

export async function propertyRoutes(app: FastifyInstance): Promise<void> {
  // requireTenant, e nao apenas authenticate: um admin de plataforma nao tem
  // carteira, e deixar a rota aberta para ele produziria erro confuso mais
  // adiante em vez de uma recusa clara aqui.
  const guard = { preHandler: app.requireTenant };

  app.get('/properties', guard, async (request) => {
    const query = parseOrThrow(listQuery, request.query);
    const { items, total } = await service.list(actorOf(request), {
      status: query.status,
      search: query.q,
      limit: query.limit,
      offset: query.offset,
    });
    return { items, total, limit: query.limit, offset: query.offset };
  });

  app.get('/properties/:id', guard, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return { property: await service.getById(actorOf(request), id) };
  });

  app.post('/properties', guard, async (request, reply) => {
    const input = parseOrThrow(createPropertyInput, request.body);
    const property = await service.create(actorOf(request), input);
    return reply.code(201).send({ property });
  });

  app.patch('/properties/:id', guard, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    const input = parseOrThrow(updatePropertyInput, request.body);
    return { property: await service.update(actorOf(request), id, input) };
  });

  app.delete('/properties/:id', guard, async (request, reply) => {
    const { id } = parseOrThrow(idParams, request.params);
    await service.remove(actorOf(request), id);
    return reply.code(204).send();
  });
}
