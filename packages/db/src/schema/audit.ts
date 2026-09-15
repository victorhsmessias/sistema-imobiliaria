import { sql } from 'drizzle-orm';
import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { inet } from './custom-types.js';

/**
 * Trilha de auditoria. Append-only: a policy de RLS permite INSERT e SELECT
 * do proprio tenant, mas nao UPDATE nem DELETE (ver sql/10_security.sql).
 *
 * Na Fase 1 esta tabela sustenta o requisito de auditoria de solicitacoes e
 * aprovacoes de conexao. Ja nasce na Fase 0 para que o historico de um
 * parceiro comece no dia um, e nao no dia do go-live.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey(),
    /** Null para eventos de plataforma sem tenant associado. */
    tenantId: uuid(),
    actorUserId: uuid(),
    /** Ex.: 'property.created', 'connection.requested', 'auth.login_failed'. */
    action: text().notNull(),
    entityType: text(),
    entityId: uuid(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ip: inet(),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_tenant_idx').on(t.tenantId, t.createdAt),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_action_idx').on(t.action, t.createdAt),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
