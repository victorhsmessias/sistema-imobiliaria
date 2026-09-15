import { searchFilters } from '@imob/contracts';
import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '../../lib/validate.js';
import { tenantOf } from '../../plugins/auth.js';
import * as service from './service.js';

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
}
