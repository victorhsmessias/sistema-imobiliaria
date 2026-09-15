import { auditLog, type Tx } from '@imob/db';

export interface AuditEntry {
  tenantId: string;
  actorUserId?: string | null;
  /** Ex.: 'property.created', 'connection.requested'. Verbo no passado. */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Grava um evento na trilha de auditoria.
 *
 * Recebe a transacao, e nao abre a propria, de proposito: o registro tem que
 * ser atomico com a mudanca que descreve. Uma trilha que grava "imovel
 * criado" quando a criacao deu rollback e pior do que nao ter trilha.
 *
 * A tabela e append-only no banco: app_user nao tem UPDATE nem DELETE nela.
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
  });
}
