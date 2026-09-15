import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { mediaKindEnum } from './enums.js';
import { properties } from './properties.js';
import { tenants } from './tenants.js';

/**
 * Midia de um imovel.
 *
 * tenantId e redundante (da para chegar nele via propertyId) mas e obrigatorio:
 * a policy de RLS precisa decidir olhando so para a linha, sem join.
 *
 * storageKey e uma chave OPACA gerada por nos (media/<uuid>/<uuid>.webp).
 * Nunca o caminho original. Na importacao XML isso e critico: um feed traz
 * https://imobiliariafulano.com.br/fotos/123.jpg, e servir essa URL no
 * resultado de busca entrega o dono do imovel no HTML, com todos os outros
 * campos perfeitamente anonimizados. A foto tem que ser baixada e
 * re-hospedada -- nao e otimizacao de performance, e requisito do produto.
 */
export const propertyMedia = pgTable(
  'property_media',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    /** Chave opaca no bucket. Nunca exposta ao cliente; servida via URL assinada. */
    storageKey: text().notNull(),
    kind: mediaKindEnum().notNull().default('photo'),
    position: integer().notNull().default(0),
    width: integer(),
    height: integer(),
    byteSize: integer(),
    contentType: text(),

    /**
     * Null = ainda nao passou pelo pipeline (resize + webp + strip de EXIF).
     * Midia com sanitizedAt nulo NUNCA pode ser servida na busca: o EXIF
     * original carrega GPS, autor, copyright e software da imobiliaria.
     */
    sanitizedAt: timestamp({ withTimezone: true }),

    /** [ID] Nome do arquivo enviado pelo corretor. Interno, para suporte. */
    originalFilename: text(),

    /**
     * [ID] URL de origem da foto no feed XML (<Media><Item medium="image">).
     *
     * Existe para a sincronizacao, nunca para servir: a URL aponta para o
     * dominio da imobiliaria. Nula para foto enviada pela tela.
     */
    sourceUrl: text(),
    /** sha256 da URL de origem: identifica a foto entre execucoes sem baixar de novo. */
    sourceUrlHash: text(),
    /** sha256 dos bytes baixados, antes do reencode. */
    contentSha256: text(),
    /** [ID] Legenda do feed. Costuma trazer o nome da imobiliaria. */
    caption: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('property_media_property_idx').on(t.propertyId, t.position),
    index('property_media_tenant_idx').on(t.tenantId),
    uniqueIndex('property_media_storage_key_key').on(t.storageKey),
    index('property_media_source_idx').on(t.propertyId, t.sourceUrlHash),
  ],
);

export type PropertyMedia = typeof propertyMedia.$inferSelect;
export type NewPropertyMedia = typeof propertyMedia.$inferInsert;
