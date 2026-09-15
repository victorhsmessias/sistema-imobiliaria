import { z } from 'zod';

export const cityDto = z.object({
  id: z.string().uuid(),
  uf: z.string().length(2),
  name: z.string(),
  slug: z.string(),
});
export type CityDto = z.infer<typeof cityDto>;

export const neighborhoodDto = z.object({
  id: z.string().uuid(),
  cityId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});
export type NeighborhoodDto = z.infer<typeof neighborhoodDto>;

/**
 * Resolucao de um nome livre de bairro para o bairro do catalogo.
 *
 * Usado pelo cadastro manual (autocompletar) e, na Fase 1, pela importacao
 * XML. `matchedBy` diz se bateu no nome canonico ou num alias -- util para
 * revisar a qualidade do catalogo depois de uma importacao grande.
 */
export const neighborhoodMatch = z.object({
  neighborhood: neighborhoodDto,
  matchedBy: z.enum(['slug', 'alias']),
  matchedSlug: z.string(),
});
export type NeighborhoodMatch = z.infer<typeof neighborhoodMatch>;
