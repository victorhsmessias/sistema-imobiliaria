import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import * as repo from './repository.js';

const cityParams = z.object({ cityId: z.string().uuid() });
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
}
