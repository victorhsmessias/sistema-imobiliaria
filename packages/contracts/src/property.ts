import { z } from 'zod';
import { neighborhoodDto } from './catalog.js';

export const propertyType = z.enum([
  'apartamento',
  'casa',
  'casa_condominio',
  'terreno',
  'sala_comercial',
  'galpao',
  'loja',
  'sitio_chacara',
  'outro',
]);
export type PropertyType = z.infer<typeof propertyType>;

export const propertyPurpose = z.enum(['sale', 'rent', 'sale_rent']);
export type PropertyPurpose = z.infer<typeof propertyPurpose>;

export const propertyStatus = z.enum(['draft', 'active', 'reserved', 'sold_rented', 'archived']);
export type PropertyStatus = z.infer<typeof propertyStatus>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : (v ?? null)));

const nonNegativeInt = z.number().int().min(0);
const money = z.number().int().min(0).max(100_000_000_00).nullable().optional();

/**
 * Entrada de cadastro de imovel.
 *
 * Repare no que NAO esta aqui: cityId.
 *
 * A cidade e derivada do bairro no servidor. Aceita-la do cliente permitiria
 * gravar um bairro de Londrina carimbado com outra cidade -- e o filtro por
 * cidade passaria a devolver resultado errado sem nenhum erro, que e o modo de
 * falha que mais custa caro neste produto.
 */
const propertyFields = z.object({
    title: z.string().trim().min(3, 'Título muito curto.').max(200),
    description: optionalText(5000),
    referenceCode: optionalText(60),

    purpose: propertyPurpose.default('sale'),
    type: propertyType,
    status: propertyStatus.default('draft'),

    neighborhoodId: z.string().uuid('Escolha o bairro.'),

    street: optionalText(200),
    streetNumber: optionalText(20),
    complement: optionalText(120),
    zip: optionalText(12),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),

    bedrooms: nonNegativeInt.max(30).default(0),
    suites: nonNegativeInt.max(30).default(0),
    bathrooms: nonNegativeInt.max(30).default(0),
    parkingSpots: nonNegativeInt.max(50).default(0),

    areaTotal: z.number().positive().max(9_999_999).nullable().optional(),
    areaBuilt: z.number().positive().max(9_999_999).nullable().optional(),

    /** Venda e aluguel separados: um anuncio "venda e aluguel" guarda os dois. */
    salePriceCents: money,
    /** Aluguel mensal. */
    rentPriceCents: money,
    /** Condominio mensal. */
    condoFeeCents: money,
    /** IPTU anual. */
    iptuCents: money,

  acceptsExchange: z.boolean().default(false),
  isExclusive: z.boolean().default(false),
  publishedToNetwork: z.boolean().default(true),
});

// As regras cruzadas ficam fora do objeto base para que `partial()` continue
// possivel: `.refine()` devolve um ZodEffects, que nao tem `.partial()`.
const suitesWithinBedrooms = (v: { suites?: number; bedrooms?: number }): boolean =>
  v.suites === undefined || v.bedrooms === undefined || v.suites <= v.bedrooms;

const builtWithinTotal = (v: { areaBuilt?: number | null; areaTotal?: number | null }): boolean =>
  !v.areaBuilt || !v.areaTotal || v.areaBuilt <= v.areaTotal;

// Um valor de aluguel num imovel so a venda apareceria na busca de aluguel
// como um anuncio que nao existe. So da para conferir quando a finalidade vem
// junto; no PATCH sem finalidade, vale a que ja esta gravada.
const noRentOnSaleOnly = (v: { purpose?: PropertyPurpose; rentPriceCents?: number | null }): boolean =>
  v.purpose !== 'sale' || v.rentPriceCents == null;

const noSaleOnRentOnly = (v: { purpose?: PropertyPurpose; salePriceCents?: number | null }): boolean =>
  v.purpose !== 'rent' || v.salePriceCents == null;

export const createPropertyInput = propertyFields
  .refine(suitesWithinBedrooms, {
    message: 'Suítes não podem passar do número de quartos.',
    path: ['suites'],
  })
  .refine(builtWithinTotal, {
    message: 'A área construída não pode ser maior que a área total.',
    path: ['areaBuilt'],
  })
  .refine(noRentOnSaleOnly, {
    message: 'Imóvel só à venda não tem valor de aluguel.',
    path: ['rentPriceCents'],
  })
  .refine(noSaleOnRentOnly, {
    message: 'Imóvel só para aluguel não tem valor de venda.',
    path: ['salePriceCents'],
  });
export type CreatePropertyInput = z.infer<typeof createPropertyInput>;

/** Atualizacao parcial. Mesmas regras, todos os campos opcionais. */
export const updatePropertyInput = propertyFields
  .partial()
  .refine(suitesWithinBedrooms, {
    message: 'Suítes não podem passar do número de quartos.',
    path: ['suites'],
  })
  .refine(builtWithinTotal, {
    message: 'A área construída não pode ser maior que a área total.',
    path: ['areaBuilt'],
  })
  .refine(noRentOnSaleOnly, {
    message: 'Imóvel só à venda não tem valor de aluguel.',
    path: ['rentPriceCents'],
  })
  .refine(noSaleOnRentOnly, {
    message: 'Imóvel só para aluguel não tem valor de venda.',
    path: ['salePriceCents'],
  });
export type UpdatePropertyInput = z.infer<typeof updatePropertyInput>;

export const propertyMediaDto = z.object({
  id: z.string().uuid(),
  kind: z.enum(['photo', 'floor_plan', 'video', 'tour']),
  position: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Null enquanto a midia nao passou pelo strip de EXIF; nao aparece na rede. */
  sanitizedAt: z.string().datetime().nullable(),
});
export type PropertyMediaDto = z.infer<typeof propertyMediaDto>;

/** Visao COMPLETA do imovel: so o proprio dono recebe isto. */
export const propertyDto = z.object({
  id: z.string().uuid(),
  referenceCode: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  purpose: propertyPurpose,
  type: propertyType,
  status: propertyStatus,

  city: z.object({ id: z.string().uuid(), name: z.string(), uf: z.string() }),
  neighborhood: neighborhoodDto,

  street: z.string().nullable(),
  streetNumber: z.string().nullable(),
  complement: z.string().nullable(),
  zip: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),

  bedrooms: z.number().int(),
  suites: z.number().int(),
  bathrooms: z.number().int(),
  parkingSpots: z.number().int(),
  areaTotal: z.number().nullable(),
  areaBuilt: z.number().nullable(),

  salePriceCents: z.number().int().nullable(),
  rentPriceCents: z.number().int().nullable(),
  condoFeeCents: z.number().int().nullable(),
  iptuCents: z.number().int().nullable(),
  currency: z.string(),

  acceptsExchange: z.boolean(),
  isExclusive: z.boolean(),
  publishedToNetwork: z.boolean(),

  media: z.array(propertyMediaDto),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PropertyDto = z.infer<typeof propertyDto>;

/** Item de lista da propria carteira. */
export const propertyListItem = propertyDto.pick({
  id: true,
  referenceCode: true,
  title: true,
  purpose: true,
  type: true,
  status: true,
  bedrooms: true,
  bathrooms: true,
  parkingSpots: true,
  areaBuilt: true,
  salePriceCents: true,
  rentPriceCents: true,
  publishedToNetwork: true,
  updatedAt: true,
}).extend({
  neighborhood: z.object({ id: z.string().uuid(), name: z.string() }),
});
export type PropertyListItem = z.infer<typeof propertyListItem>;
