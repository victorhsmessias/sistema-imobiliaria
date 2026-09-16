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
/**
 * Grafia alternativa criada pela curadoria da importacao.
 *
 * O catalogo e vocabulario compartilhado da rede, entao isto e restrito ao
 * administrador do parceiro e so ACRESCENTA grafia a um bairro existente.
 */
export const createAliasInput = z.object({
  alias: z.string().trim().min(2, 'Informe a grafia que veio no feed.').max(120),
});
export type CreateAliasInput = z.infer<typeof createAliasInput>;

export const aliasDto = z.object({
  neighborhoodId: z.string().uuid(),
  aliasSlug: z.string(),
  /** false quando o alias já existia para este mesmo bairro. */
  created: z.boolean(),
});
export type AliasDto = z.infer<typeof aliasDto>;

export const neighborhoodMatch = z.object({
  neighborhood: neighborhoodDto,
  matchedBy: z.enum(['slug', 'alias']),
  matchedSlug: z.string(),
});
export type NeighborhoodMatch = z.infer<typeof neighborhoodMatch>;
