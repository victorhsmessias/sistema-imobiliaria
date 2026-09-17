import { searchFilters } from '@imob/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '../../lib/validate.js';
import { tenantOf } from '../../plugins/auth.js';
import * as service from './service.js';

const idParams = z.object({ id: z.string().uuid() });

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Busca na base agregada da rede.
   *
   * Esta e a unica rota em que um parceiro ve dado de outro. A resposta nao
   * contem, e nao pode conter, nenhum identificador do dono.
   *
   * Rate limit proprio: a busca e barata por request, mas varrer a rede
   * inteira pagina a pagina para montar um retrato da carteira dos
   * concorrentes nao e o uso pretendido.
   */
  app.get(
    '/network/search',
    {
      preHandler: app.requireTenant,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => {
      const filters = parseOrThrow(searchFilters, request.query);
      return service.search(tenantOf(request), filters);
    },
  );

  /**
   * Um anuncio da rede, com a galeria.
   *
   * Le a mesma view da busca. Anuncio fora da rede responde 404 -- e nao 403,
   * que ja confirmaria que ele existe.
   */
  app.get(
    '/network/listings/:id',
    {
      preHandler: app.requireTenant,
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { id } = parseOrThrow(idParams, request.params);
      return { listing: await service.getListing(tenantOf(request), id) };
    },
  );
}
