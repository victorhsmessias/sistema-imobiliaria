import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { connectionEventTypeEnum, connectionStatusEnum, disclosureLevelEnum } from './enums.js';
import { properties } from './properties.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Conexao entre dois parceiros sobre um imovel da rede.
 *
 * E o fluxo que da sentido a anonimizacao: na busca o solicitante ve o imovel
 * sem saber de quem e; para negociar, ele pede conexao, e o DONO decide.
 *
 * ---------------------------------------------------------------------------
 * ASSIMETRIA DELIBERADA
 *
 * Quem pede aparece para o dono ja na solicitacao -- ele precisa saber quem
 * esta pedindo para decidir, e pedir e um ato de consentimento. O dono so
 * aparece para o solicitante DEPOIS de aprovar.
 *
 * Endereco exato nao e revelado em nenhum nivel de disclosure.
 * ---------------------------------------------------------------------------
 *
 * Esta e a primeira tabela do sistema em que UMA LINHA PERTENCE A DOIS
 * TENANTS. As policies comparam as duas pontas (ver sql/10_security.sql), em
 * vez do `tenant_id` unico das outras tabelas.
 */
export const connectionRequests = pgTable(
  'connection_requests',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),

    /** Quem pediu. */
    requesterTenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    requesterUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Dono do imovel no momento do pedido; denormalizado para a policy decidir sem join. */
    ownerTenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),

    status: connectionStatusEnum().notNull().default('pending'),
    disclosureLevel: disclosureLevelEnum().notNull().default('partner_contact'),

    /** Recado de quem pede. Visivel so para as duas pontas. */
    message: text(),
    /** Motivo da recusa, escrito pelo dono. */
    decisionNote: text(),

    decidedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp({ withTimezone: true }),
    /** Pedido pendente tem prazo: sem isso a caixa do dono vira um cemiterio. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Um pedido pendente por imovel e parceiro. Recusado ou expirado pode ser
    // pedido de novo -- o imovel pode ter mudado de situacao.
    uniqueIndex('connection_requests_pending_key')
      .on(t.propertyId, t.requesterTenantId)
      .where(sql`status = 'pending'`),
    index('connection_requests_owner_idx').on(t.ownerTenantId, t.status, t.createdAt),
    index('connection_requests_requester_idx').on(t.requesterTenantId, t.status, t.createdAt),
  ],
);

/**
 * Trilha fina de cada transicao. Append-only: sem UPDATE nem DELETE.
 *
 * `audit_log` continua sendo a trilha por tenant; esta aqui e a historia da
 * conexao vista pelas duas pontas, e e o que sustenta uma disputa de comissao.
 */
export const connectionEvents = pgTable(
  'connection_events',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    connectionRequestId: uuid()
      .notNull()
      .references(() => connectionRequests.id, { onDelete: 'cascade' }),

    type: connectionEventTypeEnum().notNull(),
    /** Quem agiu. Nulo quando foi a expiracao automatica. */
    actorTenantId: uuid().references(() => tenants.id, { onDelete: 'set null' }),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),

    metadata: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('connection_events_request_idx').on(t.connectionRequestId, t.createdAt)],
);

export type ConnectionRequest = typeof connectionRequests.$inferSelect;
export type NewConnectionRequest = typeof connectionRequests.$inferInsert;
export type ConnectionEvent = typeof connectionEvents.$inferSelect;
