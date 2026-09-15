import { importItemStatus, importSourceInput, runImportQuery } from '@imob/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, validationFailed } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { tenantOf } from '../../plugins/auth.js';
import type { ActorContext } from '../properties/service.js';
import * as service from './service.js';
import { decodeXml } from './vrsync-parser.js';

const idParams = z.object({ id: z.string().uuid() });
const itemsQuery = z.object({ status: importItemStatus.optional() });

/** Mesmo teto do download por URL. */
const FEED_UPLOAD_LIMIT = 50 * 1024 * 1024;

function actorOf(request: FastifyRequest): ActorContext {
  return {
    tenantId: tenantOf(request),
    userId: request.auth!.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/**
 * A importacao cria, altera e arquiva a carteira inteira do parceiro de uma
 * vez. Nao e operacao de corretor: e do administrador do parceiro.
 */
async function requirePartnerAdmin(request: FastifyRequest): Promise<void> {
  if (request.auth?.role !== 'partner_admin') {
    throw forbidden('Só o administrador do parceiro pode importar carteira.');
  }
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  // O XML chega como bytes, e nao como texto: o encoding vem do prolog do
  // documento, e decodificar um ISO-8859-1 como UTF-8 estragaria os acentos.
  // Parser registrado so dentro deste plugin.
  app.addContentTypeParser(
    ['application/xml', 'text/xml'],
    { parseAs: 'buffer', bodyLimit: FEED_UPLOAD_LIMIT },
    (_request, body, done) => done(null, body),
  );

  const guard = { preHandler: [app.requireTenant, requirePartnerAdmin] };

  app.post('/imports/sources', guard, async (request, reply) => {
    const input = parseOrThrow(importSourceInput, request.body);
    const source = await service.createSource(actorOf(request), input);
    return reply.code(201).send({ source });
  });

  app.get('/imports/sources', guard, async (request) => ({
    sources: await service.listSources(actorOf(request)),
  }));

  /** Executa a partir da URL cadastrada. Dry-run e o padrao. */
  app.post('/imports/sources/:id/jobs', guard, async (request, reply) => {
    const { id } = parseOrThrow(idParams, request.params);
    const { dryRun } = parseOrThrow(runImportQuery, request.query);
    const { job, done } = await service.startJob(actorOf(request), id, { dryRun });
    void done.catch((error: unknown) => request.log.error({ err: error, jobId: job.id }, 'importacao falhou'));
    return reply.code(202).send({ job });
  });

  /** Executa a partir de um arquivo XML enviado no corpo. Dry-run e o padrao. */
  app.post('/imports/sources/:id/upload', guard, async (request, reply) => {
    const { id } = parseOrThrow(idParams, request.params);
    const { dryRun } = parseOrThrow(runImportQuery, request.query);
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      throw validationFailed({ body: 'Envie o XML no corpo, com Content-Type application/xml.' });
    }
    const { job, done } = await service.startJob(actorOf(request), id, {
      dryRun,
      xml: decodeXml(request.body),
    });
    void done.catch((error: unknown) => request.log.error({ err: error, jobId: job.id }, 'importacao falhou'));
    return reply.code(202).send({ job });
  });

  app.get('/imports/jobs/:id', guard, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return { job: await service.getJob(actorOf(request), id) };
  });

  app.get('/imports/jobs/:id/items', guard, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    const { status } = parseOrThrow(itemsQuery, request.query);
    return { items: await service.listItems(actorOf(request), id, status) };
  });
}
