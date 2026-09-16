import { createAliasInput } from '@imob/contracts';
import { neighborhoodSlugCandidates, withTenant } from '@imob/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { tenantOf } from '../../plugins/auth.js';
import { recordAudit } from '../audit/service.js';
import * as repo from './repository.js';

const cityParams = z.object({ cityId: z.string().uuid() });
const neighborhoodParams = z.object({ neighborhoodId: z.string().uuid() });
const neighborhoodQuery = z.object({ q: z.string().max(120).optional() });
const resolveQuery = z.object({ name: z.string().min(1).max(120) });

function toDto(row: repo.NeighborhoodRow) {
  return {
    id: row.id,
    cityId: row.cityId,
    name: row.name,
    slug: row.slug,
  };
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // O catalogo e vocabulario compartilhado, mas continua atras de sessao: a
  // rede e fechada e a lista de bairros atendidos ja e informacao de negocio.
  app.get('/catalog/cities', { preHandler: app.authenticate }, async () => ({
    cities: await repo.listCities(),
  }));

  app.get(
    '/catalog/cities/:cityId/neighborhoods',
    { preHandler: app.authenticate },
    async (request) => {
      const { cityId } = parseOrThrow(cityParams, request.params);
      const { q } = parseOrThrow(neighborhoodQuery, request.query);
      const rows = await repo.listNeighborhoods(cityId, q);
      return { neighborhoods: rows.map(toDto) };
    },
  );

  /**
   * Resolve um nome livre para o bairro do catalogo.
   *
   * Usado pelo cadastro manual e, na Fase 1, pela importacao XML. Devolve 404
   * quando nao reconhece -- e o sinal de que falta um alias, nao de que o
   * bairro nao existe.
   */
  app.get(
    '/catalog/cities/:cityId/neighborhoods/resolve',
    { preHandler: app.authenticate },
    async (request) => {
      const { cityId } = parseOrThrow(cityParams, request.params);
      const { name } = parseOrThrow(resolveQuery, request.query);

      const match = await repo.resolveNeighborhood(cityId, name);
      if (!match) {
        throw notFound(`Bairro "${name}" não reconhecido nesta cidade.`);
      }

      return {
        neighborhood: toDto(match.neighborhood),
        matchedBy: match.matchedBy,
        matchedSlug: match.matchedSlug,
      };
    },
  );

  /**
   * Curadoria: liga a grafia que veio no feed a um bairro do catalogo.
   *
   * Restrito ao administrador do parceiro porque o catalogo e compartilhado:
   * um alias errado tira imoveis do resultado de busca de todo mundo. A
   * funcao no banco so ACRESCENTA grafia -- nao cria bairro nem toma alias
   * de outro.
   */
  app.post(
    '/catalog/neighborhoods/:neighborhoodId/aliases',
    { preHandler: app.requireTenant },
    async (request: FastifyRequest, reply) => {
      if (request.auth?.role !== 'partner_admin') {
        throw forbidden('Só o administrador do parceiro pode cadastrar grafias de bairro.');
      }

      const { neighborhoodId } = parseOrThrow(neighborhoodParams, request.params);
      const { alias } = parseOrThrow(createAliasInput, request.body);

      // Mesma normalizacao da importacao: o alias so serve se for o slug que
      // resolveNeighborhood() vai procurar.
      const [aliasSlug] = neighborhoodSlugCandidates(alias);
      if (!aliasSlug) throw validationFailed({ alias: 'Grafia inválida.' });

      // Dentro de withTenant: a funcao no banco carimba a origem do alias com
      // o tenant da sessao, e a auditoria fica atomica com a escrita.
      const tenantId = tenantOf(request);
      const result = await withTenant(tenantId, async (tx) => {
        const added = await repo.addAlias(tx, neighborhoodId, aliasSlug);
        if (!added || added.conflictWith) return added;

        await recordAudit(tx, {
          tenantId,
          actorUserId: request.auth!.userId,
          action: 'catalog.alias_created',
          entityType: 'neighborhood',
          entityId: neighborhoodId,
          metadata: { aliasSlug, created: added.created },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        return added;
      });

      if (!result) throw notFound('Bairro não encontrado no catálogo.');
      if (result.conflictWith) {
        throw validationFailed({
          alias: `A grafia "${aliasSlug}" já aponta para o bairro "${result.conflictWith}".`,
        });
      }

      return reply
        .code(result.created ? 201 : 200)
        .send({ alias: { neighborhoodId, aliasSlug, created: result.created } });
    },
  );
}
