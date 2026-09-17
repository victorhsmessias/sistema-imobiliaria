import { z } from 'zod';
import { connectionStatus } from './connections.js';
import { propertyPurpose, propertyType } from './property.js';

/**
 * Finalidade como filtro: venda ou aluguel.
 *
 * "Venda" devolve os anuncios so de venda E os de venda e aluguel; idem para
 * "aluguel". Um apartamento anunciado nos dois modos esta a venda -- deixa-lo
 * fora da busca de venda seria esconder imovel disponivel.
 */
export const searchPurpose = z.enum(['sale', 'rent']);
export type SearchPurpose = z.infer<typeof searchPurpose>;

/**
 * Aceita tanto `?types=casa&types=apartamento` quanto `?types=casa,apartamento`.
 * Navegador e cliente HTTP escrevem query string de jeitos diferentes; a API
 * nao deveria se importar com qual deles chegou.
 */
const csvArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const raw = Array.isArray(value) ? value : [value];
    return raw
      .flatMap((v) => (typeof v === 'string' ? v.split(',') : [v]))
      .map((v) => (typeof v === 'string' ? v.trim() : v))
      .filter((v) => v !== '');
  }, z.array(item).optional());

const coercedInt = z.coerce.number().int();

export const searchSort = z.enum(['recent', 'price_asc', 'price_desc']);
export type SearchSort = z.infer<typeof searchSort>;

/**
 * Filtros da busca na rede.
 *
 * Bairro e o filtro de localizacao, e o unico: nao ha agrupamento por zona.
 * Opcional no preenchimento, mas e o que motivou o produto.
 */
const searchFiltersBase = z.object({
  cityId: z.string().uuid().optional(),
  neighborhoodIds: csvArray(z.string().uuid()),

  types: csvArray(propertyType),
  purpose: searchPurpose.optional(),

  bedroomsMin: coercedInt.min(0).max(30).optional(),
  bathroomsMin: coercedInt.min(0).max(30).optional(),
  parkingMin: coercedInt.min(0).max(50).optional(),

  /** m2 construidos, minimo. */
  areaBuiltMin: z.coerce.number().min(0).max(9_999_999).optional(),
  /** m2 totais, minimo -- o que importa para terreno. */
  areaTotalMin: z.coerce.number().min(0).max(9_999_999).optional(),

  /** Faixa de valor em centavos. */
  priceMin: coercedInt.min(0).optional(),
  priceMax: coercedInt.min(0).optional(),

  sort: searchSort.default('recent'),
  /** Cursor opaco de paginacao; devolvido em `nextCursor`. */
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Ordenar ou filtrar por valor sem separar venda de aluguel nao faz sentido.
 *
 * Venda e aluguel vivem em colunas distintas (sale_price_cents e
 * rent_price_cents), e a finalidade e o que diz qual delas comparar. Sem ela,
 * "de R$ 3.000 a R$ 600.000" pegaria aluguel e venda misturados, e a ordenacao
 * poria um aluguel "mais barato" no topo de uma lista de vendas. Nao e um
 * resultado ruim: e um resultado errado.
 *
 * Ordenar por `recent` continua livre -- misturar finalidades ali e so uma
 * lista cronologica, nao uma comparacao.
 */
export const searchFilters = searchFiltersBase
  .refine((f) => f.sort === 'recent' || f.purpose !== undefined, {
    message: 'Para ordenar por valor, informe a finalidade: venda ou aluguel.',
    path: ['purpose'],
  })
  .refine(
    (f) => (f.priceMin === undefined && f.priceMax === undefined) || f.purpose !== undefined,
    {
      message: 'Para filtrar por valor, informe a finalidade: venda ou aluguel.',
      path: ['purpose'],
    },
  );
export type SearchFilters = z.infer<typeof searchFilters>;

/**
 * Item de resultado da busca na rede.
 *
 * Este e o objeto mais sensivel do sistema: e o unico ponto em que um parceiro
 * ve dado de outro. Nao ha, e nao pode haver, nenhum campo que identifique o
 * dono -- nem nome, nem contato, nem marca, nem endereco, nem codigo interno.
 *
 * O que garante isso nao e este arquivo: e a view network_listings, com
 * allow-list explicita de colunas, e a suite que serializa a resposta HTTP
 * inteira procurando identificadores conhecidos dentro dela.
 */
export const networkListing = z.object({
  listingId: z.string().uuid(),
  type: propertyType,
  purpose: propertyPurpose,

  city: z.object({ id: z.string().uuid(), name: z.string(), uf: z.string() }),
  neighborhood: z.object({ id: z.string().uuid(), name: z.string() }),

  bedrooms: z.number().int(),
  suites: z.number().int(),
  bathrooms: z.number().int(),
  parkingSpots: z.number().int(),

  areaTotal: z.number().nullable(),
  areaBuilt: z.number().nullable(),

  salePriceCents: z.number().int().nullable(),
  /** Aluguel mensal. */
  rentPriceCents: z.number().int().nullable(),
  condoFeeCents: z.number().int().nullable(),
  /** IPTU anual. */
  iptuCents: z.number().int().nullable(),
  currency: z.string(),
  acceptsExchange: z.boolean(),

  photoCount: z.number().int(),
  /**
   * Primeira foto sanitizada do anuncio. E um id opaco de midia -- nao diz
   * nada sobre o dono; os bytes saem por /network/listings/:id/media/:mediaId
   * como URL assinada de vida curta.
   */
  coverMediaId: z.string().uuid().nullable(),

  /**
   * Marca os imoveis da propria carteira dentro do resultado agregado.
   *
   * Nao vaza nada: o parceiro ja sabe o que e dele. Saber que os demais NAO
   * sao dele tambem nao diz de quem sao.
   */
  isOwn: z.boolean(),

  /**
   * Situacao do pedido de conexao DESTE parceiro com este anuncio.
   *
   * Null quando nunca pediu. Não diz nada sobre o dono: é o próprio histórico
   * de quem está buscando.
   */
  connection: z
    .object({ id: z.string().uuid(), status: connectionStatus })
    .nullable(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type NetworkListing = z.infer<typeof networkListing>;

/**
 * Uma foto do anuncio, como a rede a enxerga.
 *
 * `id` e um ponteiro opaco: os bytes saem por
 * GET /network/listings/:id/media/:mediaId, como URL assinada de vida curta.
 * Nao ha nome de arquivo, chave de bucket nem URL de origem -- qualquer um
 * dos tres entregaria o dono (ver docs/anonimizacao.md).
 */
export const networkMedia = z.object({
  id: z.string().uuid(),
  kind: z.enum(['photo', 'floor_plan', 'video', 'tour']),
  position: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});
export type NetworkMedia = z.infer<typeof networkMedia>;

/**
 * O anuncio aberto: os MESMOS campos da lista, mais a galeria.
 *
 * Abrir um imovel nao revela nada a mais sobre quem anuncia. Se um campo novo
 * so faz sentido "na tela de detalhe", ele provavelmente identifica o dono.
 */
export const networkListingDetail = networkListing.extend({
  media: z.array(networkMedia),
});
export type NetworkListingDetail = z.infer<typeof networkListingDetail>;

export const searchResult = z.object({
  items: z.array(networkListing),
  /** Null quando nao ha mais paginas. */
  nextCursor: z.string().nullable(),
});
export type SearchResult = z.infer<typeof searchResult>;
