import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  importFormatEnum,
  importItemStatusEnum,
  importJobStatusEnum,
  propertyTypeEnum,
} from './enums.js';
import { properties } from './properties.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Importacao em massa de carteira via XML VrSync.
 *
 * As tres tabelas de importacao tem tenant_id e FORCE ROW LEVEL SECURITY (ver
 * sql/10_security.sql). O motivo e o mesmo de properties: tudo aqui identifica
 * o dono -- a URL do feed e o dominio da imobiliaria, e o payload bruto traz
 * ContactInfo, endereco e as URLs originais das fotos.
 */

/** Um feed configurado por um parceiro. */
export const importSources = pgTable(
  'import_sources',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    /** [ID] Rotulo interno ("Feed do Jetimob"). */
    name: text().notNull(),
    format: importFormatEnum().notNull().default('vrsync'),
    /** [ID] URL publica do feed. Nula quando o parceiro so envia arquivo. */
    feedUrl: text(),

    /**
     * Vale so para imovel CRIADO pela importacao. Numa atualizacao o feed nao
     * sobrescreve a decisao que o parceiro tomou depois na plataforma.
     */
    publishToNetwork: boolean().notNull().default(true),
    active: boolean().notNull().default(true),

    lastRunAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('import_sources_tenant_idx').on(t.tenantId)],
);

/** Uma execucao de importacao, com dry-run ou gravando. */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    sourceId: uuid()
      .notNull()
      .references(() => importSources.id, { onDelete: 'cascade' }),

    status: importJobStatusEnum().notNull().default('queued'),
    /** Dry-run: le, resolve e compara, mas nao grava imovel nem baixa foto. */
    dryRun: boolean().notNull(),
    /** Contadores por status de item e de fotos. */
    stats: jsonb().notNull().default({}),
    /** Mensagem legivel da falha do job inteiro (feed fora do ar, XML invalido). */
    error: text(),

    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('import_jobs_source_idx').on(t.sourceId, t.createdAt)],
);

/** Resultado por anuncio do feed: a trilha e o relatorio de diff da importacao. */
export const importItems = pgTable(
  'import_items',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    jobId: uuid()
      .notNull()
      .references(() => importJobs.id, { onDelete: 'cascade' }),

    /** [ID] ListingID do feed -- o codigo interno do parceiro. */
    externalId: text(),
    propertyId: uuid().references(() => properties.id, { onDelete: 'set null' }),
    status: importItemStatusEnum().notNull(),

    /** Campo -> { from, to }. Vazio para created/unchanged. */
    changes: jsonb().notNull().default({}),
    warnings: jsonb().notNull().default([]),
    errors: jsonb().notNull().default([]),

    /**
     * [ID] O <Listing> como veio no XML, convertido para JSON.
     *
     * E aqui, e so aqui, que <Zone> fica guardado: serve de pista na curadoria
     * quando uma cidade tem dois bairros de mesmo nome. Zona nao vira coluna,
     * filtro nem elemento de tela.
     */
    rawPayload: jsonb().notNull(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('import_items_job_idx').on(t.jobId, t.status)],
);

/**
 * Traducao do PropertyType do feed para o tipo da plataforma.
 *
 * GLOBAL, como o catalogo geografico: sem tenant, leitura para todos, escrita
 * so por migration ou admin. A chave e o slug do valor ("residential-apartment")
 * ou so do ultimo segmento ("apartment") -- ver modules/imports/property-types.ts.
 *
 * Tabela, e nao constante no codigo, pelo mesmo motivo dos aliases de bairro:
 * cada sistema de gestao escreve o tipo do seu jeito, e acrescentar uma grafia
 * nova nao deveria exigir deploy.
 */
export const propertyTypeMappings = pgTable(
  'property_type_mappings',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    sourceKey: text().notNull(),
    type: propertyTypeEnum().notNull(),
    source: text().notNull().default('manual'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('property_type_mappings_source_key_key').on(t.sourceKey)],
);

export type ImportSource = typeof importSources.$inferSelect;
export type ImportJob = typeof importJobs.$inferSelect;
export type ImportItem = typeof importItems.$inferSelect;
export type PropertyTypeMapping = typeof propertyTypeMappings.$inferSelect;
