import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, validationFailed } from '../../lib/errors.js';
import { ERROR_CODES } from '@imob/contracts';
import { parseOrThrow } from '../../lib/validate.js';
import { tenantOf } from '../../plugins/auth.js';
import type { ActorContext } from '../properties/service.js';
import * as service from './service.js';

const propertyParams = z.object({ propertyId: z.string().uuid() });
const mediaParams = z.object({
  propertyId: z.string().uuid(),
  mediaId: z.string().uuid(),
});
const networkParams = z.object({
  listingId: z.string().uuid(),
  mediaId: z.string().uuid(),
});
const orderBody = z.object({ order: z.array(z.string().uuid()).min(1).max(60) });

function actorOf(request: FastifyRequest): ActorContext {
  return {
    tenantId: tenantOf(request),
    userId: request.auth!.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: app.requireTenant };

  app.post('/properties/:propertyId/media', guard, async (request, reply) => {
    const { propertyId } = parseOrThrow(propertyParams, request.params);

    const file = await request.file();
    if (!file) {
      throw validationFailed({ file: 'Envie um arquivo no campo "file".' });
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      // @fastify/multipart lanca aqui quando o arquivo estoura o limite.
      throw new AppError(413, ERROR_CODES.VALIDATION, 'Arquivo maior que o limite de 15 MB.');
    }

    const media = await service.upload(actorOf(request), propertyId, {
      buffer,
      originalFilename: file.filename ?? null,
    });

    return reply.code(201).send({ media });
  });

  app.get('/properties/:propertyId/media', guard, async (request) => {
    const { propertyId } = parseOrThrow(propertyParams, request.params);
    return { media: await service.list(actorOf(request), propertyId) };
  });

  app.patch('/properties/:propertyId/media/order', guard, async (request) => {
    const { propertyId } = parseOrThrow(propertyParams, request.params);
    const { order } = parseOrThrow(orderBody, request.body);
    return { media: await service.reorder(actorOf(request), propertyId, order) };
  });

  app.delete('/properties/:propertyId/media/:mediaId', guard, async (request, reply) => {
    const { mediaId } = parseOrThrow(mediaParams, request.params);
    await service.remove(actorOf(request), mediaId);
    return reply.code(204).send();
  });

  /**
   * Foto da propria carteira.
   *
   * Redirect 302 para URL assinada em vez de servir os bytes pela API: o
   * download vai direto do storage para o navegador, sem passar por esta
   * maquina. Numa VPS pequena isso e a diferenca entre servir uma galeria e
   * derrubar o processo.
   */
  app.get('/properties/:propertyId/media/:mediaId', guard, async (request, reply) => {
    const { mediaId } = parseOrThrow(mediaParams, request.params);
    const url = await service.ownMediaUrl(actorOf(request), mediaId);
    return reply.redirect(url, 302);
  });

  /**
   * Foto vista na busca da rede.
   *
   * Unico jeito de um parceiro ver a foto de outro. A chave do bucket nunca
   * chega ao cliente -- ele recebe uma URL assinada de vida curta, sem nome
   * de arquivo original, sem caminho que identifique o dono e sem EXIF
   * dentro do binario (ver lib/image.ts).
   */
  app.get(
    '/network/listings/:listingId/media/:mediaId',
    {
      preHandler: app.requireTenant,
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { listingId, mediaId } = parseOrThrow(networkParams, request.params);
      const url = await service.networkMediaUrl(listingId, mediaId);
      return reply.redirect(url, 302);
    },
  );
}
