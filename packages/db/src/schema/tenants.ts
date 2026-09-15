import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantStatusEnum } from './enums.js';

/**
 * Parceiro da rede: imobiliaria ou corretor autonomo.
 *
 * ATENCAO: legalName, displayName e slug sao identificadores do parceiro.
 * Nenhum deles pode aparecer em resultado de busca cross-tenant. A view
 * network_listings nao referencia esta tabela justamente por isso.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    /** Razao social / nome legal. Interno. */
    legalName: text().notNull(),
    /** Marca comercial exibida ao proprio parceiro e apos conexao aprovada. */
    displayName: text().notNull(),
    slug: text().notNull(),
    status: tenantStatusEnum().notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tenants_slug_key').on(t.slug)],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
