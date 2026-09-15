import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { cities, neighborhoods } from './catalog.js';
import { propertyPurposeEnum, propertyStatusEnum, propertyTypeEnum } from './enums.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Imovel da carteira de um parceiro.
 *
 * ---------------------------------------------------------------------------
 * CAMPOS MARCADOS COM [ID] SAO IDENTIFICADORES DO DONO.
 * Eles nunca podem atravessar a fronteira de tenant. A lista canonica vive em
 * src/sensitive-fields.ts e e verificada pela suite de anonimizacao.
 *
 * Tres deles merecem explicacao, porque o motivo nao e obvio:
 *
 *  - street/number/zip/lat/lng: com o endereco exato, o solicitante acha o
 *    anuncio original em qualquer portal publico em segundos e ve a marca do
 *    dono. Expor endereco derrota a anonimizacao inteira, mesmo com todos os
 *    outros campos limpos.
 *
 *  - title/description: texto livre onde corretor escreve "falar com Joao,
 *    11 9xxxx-xxxx" e o nome da imobiliaria. Por isso ficam FORA da view
 *    network_listings na Fase 0, e so entram na Fase 1 ja redigidos.
 *
 *  - referenceCode: o codigo interno costuma embutir a sigla do parceiro
 *    ("ABC-1234") e e pesquisavel no Google.
 * ---------------------------------------------------------------------------
 */
export const properties = pgTable(
  'properties',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    /** [ID] Codigo interno do parceiro. */
    referenceCode: text(),
    /** [ID] Texto livre do corretor. */
    title: text().notNull(),
    /** [ID] Texto livre do corretor. */
    description: text(),

    purpose: propertyPurposeEnum().notNull().default('sale'),
    type: propertyTypeEnum().notNull(),
    status: propertyStatusEnum().notNull().default('draft'),

    cityId: uuid()
      .notNull()
      .references(() => cities.id, { onDelete: 'restrict' }),
    neighborhoodId: uuid()
      .notNull()
      .references(() => neighborhoods.id, { onDelete: 'restrict' }),

    /** [ID] */ street: text(),
    /** [ID] */ streetNumber: text(),
    /** [ID] */ complement: text(),
    /** [ID] */ zip: text(),
    /** [ID] */ latitude: numeric({ precision: 10, scale: 7 }),
    /** [ID] */ longitude: numeric({ precision: 10, scale: 7 }),

    bedrooms: smallint().notNull().default(0),
    suites: smallint().notNull().default(0),
    bathrooms: smallint().notNull().default(0),
    parkingSpots: smallint().notNull().default(0),

    areaTotal: numeric({ precision: 10, scale: 2 }),
    areaBuilt: numeric({ precision: 10, scale: 2 }),

    /**
     * Centavos. Nunca float: 0.1 + 0.2 nao pode virar discussao com corretor.
     *
     * Venda e aluguel em colunas separadas.
     *
     * Um anuncio VrSync "Sale/Rent" traz ListPrice E RentalPrice. Com uma
     * coluna so, um dos dois se perdia na importacao -- e a ordenacao por
     * valor misturava "R$ 5.250/mes" com "R$ 617.000".
     */
    salePriceCents: bigint({ mode: 'number' }),
    /** Aluguel mensal. */
    rentPriceCents: bigint({ mode: 'number' }),
    /** Condominio mensal. */
    condoFeeCents: bigint({ mode: 'number' }),
    /** IPTU ANUAL. O VrSync aceita mensal ou anual; a importacao normaliza para anual. */
    iptuCents: bigint({ mode: 'number' }),
    currency: text().notNull().default('BRL'),

    acceptsExchange: boolean().notNull().default(false),
    isExclusive: boolean().notNull().default(false),

    /** Parceiro pode manter um imovel na carteira sem expor a rede. */
    publishedToNetwork: boolean().notNull().default(true),

    /** [ID] Origem da importacao XML (Fase 1) -- o nome do feed entrega o dono. */
    externalSource: text(),
    externalId: text(),

    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('properties_tenant_idx').on(t.tenantId, t.status),

    // Indice que sustenta a busca da rede: parcial, cobre so o que e visivel.
    index('properties_network_idx')
      .on(t.neighborhoodId, t.type, t.salePriceCents)
      .where(sql`deleted_at IS NULL AND status = 'active' AND published_to_network`),

    index('properties_network_rent_idx')
      .on(t.neighborhoodId, t.type, t.rentPriceCents)
      .where(sql`deleted_at IS NULL AND status = 'active' AND published_to_network`),

    index('properties_filters_idx').on(t.type, t.bedrooms),

    // Dedup da importacao XML: o mesmo anuncio nao pode entrar duas vezes.
    uniqueIndex('properties_external_key')
      .on(t.tenantId, t.externalSource, t.externalId)
      .where(sql`external_id IS NOT NULL`),
  ],
);

export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;
