import type { ConnectionStatus } from '@imob/contracts';
import {
  and,
  asc,
  connectionEvents,
  connectionMessageReads,
  connectionMessages,
  connectionRequests,
  count,
  desc,
  eq,
  getDb,
  sql,
  type Tx,
} from '@imob/db';

/**
 * Conexoes.
 *
 * As linhas pertencem a DUAS pontas, e as policies de connection_requests ja
 * filtram por isso (ver sql/10_security.sql). O que este repositorio nunca faz
 * e ler tenants ou users de outro parceiro direto: isso passa pelas funcoes
 * SECURITY DEFINER, onde a regra de revelacao esta escrita.
 */

/** Dono do anuncio, para carimbar a solicitacao. NUNCA devolver ao cliente. */
export async function ownerOfListing(listingId: string): Promise<string | null> {
  const { rows } = await getDb().execute(
    sql`SELECT network_listing_owner(${listingId}::uuid) AS owner_tenant_id`,
  );
  const row = rows[0] as { owner_tenant_id: string | null } | undefined;
  return row?.owner_tenant_id ?? null;
}

export async function insertRequest(tx: Tx, values: typeof connectionRequests.$inferInsert) {
  const rows = await tx.insert(connectionRequests).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insert de conexao nao devolveu linha');
  return row;
}

export async function findById(tx: Tx, id: string) {
  const rows = await tx
    .select()
    .from(connectionRequests)
    .where(eq(connectionRequests.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPending(tx: Tx, propertyId: string, requesterTenantId: string) {
  const rows = await tx
    .select({ id: connectionRequests.id })
    .from(connectionRequests)
    .where(
      and(
        eq(connectionRequests.propertyId, propertyId),
        eq(connectionRequests.requesterTenantId, requesterTenantId),
        eq(connectionRequests.status, 'pending'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface ListOptions {
  tenantId: string;
  role: 'received' | 'sent';
  status?: ConnectionStatus;
  limit: number;
  offset: number;
}

export async function list(tx: Tx, options: ListOptions) {
  const side =
    options.role === 'received'
      ? eq(connectionRequests.ownerTenantId, options.tenantId)
      : eq(connectionRequests.requesterTenantId, options.tenantId);
  const where = options.status ? and(side, eq(connectionRequests.status, options.status)) : side;

  const [rows, totalRows] = await Promise.all([
    tx
      .select()
      .from(connectionRequests)
      .where(where)
      .orderBy(desc(connectionRequests.createdAt), desc(connectionRequests.id))
      .limit(options.limit)
      .offset(options.offset),
    tx.select({ value: count() }).from(connectionRequests).where(where),
  ]);

  return { rows, total: Number(totalRows[0]?.value ?? 0) };
}

export async function updateRequest(
  tx: Tx,
  id: string,
  values: Partial<typeof connectionRequests.$inferInsert>,
) {
  const rows = await tx
    .update(connectionRequests)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(connectionRequests.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Fecha os pedidos cujo prazo acabou.
 *
 * Roda na leitura, e nao num cron: o volume e pequeno e assim o estado que o
 * parceiro ve nunca e um "pendente" que na verdade expirou ontem. Quando a
 * fila entrar (F1 #2), vira job.
 */
export async function expireStale(tx: Tx): Promise<string[]> {
  const rows = await tx
    .update(connectionRequests)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(connectionRequests.status, 'pending'),
        sql`${connectionRequests.expiresAt} < now()`,
      ),
    )
    .returning({ id: connectionRequests.id });
  return rows.map((r) => r.id);
}

export async function insertEvent(tx: Tx, values: typeof connectionEvents.$inferInsert) {
  await tx.insert(connectionEvents).values(values);
}

export async function listEvents(tx: Tx, connectionRequestId: string) {
  return tx
    .select()
    .from(connectionEvents)
    .where(eq(connectionEvents.connectionRequestId, connectionRequestId))
    .orderBy(connectionEvents.createdAt);
}

export interface ListingRow {
  listing_id: string;
  type: string;
  purpose: string;
  neighborhood_name: string;
  city_name: string;
  city_uf: string;
  bedrooms: number;
  suites: number;
  bathrooms: number;
  parking_spots: number;
  area_built: string | null;
  area_total: string | null;
  sale_price_cents: string | number | null;
  rent_price_cents: string | number | null;
}

/** Imovel de varias conexoes numa consulta so, via LATERAL sobre a funcao. */
export async function listingsOf(tx: Tx, requestIds: string[]): Promise<Map<string, ListingRow>> {
  if (requestIds.length === 0) return new Map();

  const { rows } = await tx.execute(sql`
    SELECT r.id AS request_id, l.*
      FROM connection_requests r
      JOIN LATERAL connection_listing(r.id) l ON true
     WHERE r.id = ANY(${sql.param(requestIds)}::uuid[])
  `);

  return new Map(
    (rows as unknown as Array<ListingRow & { request_id: string }>).map((row) => [row.request_id, row]),
  );
}

export interface PartyRow {
  partner_name: string;
}

/** Marca de quem pediu, para o dono. Vazio se quem pergunta nao e o dono. */
export async function requesterOf(tx: Tx, requestId: string): Promise<PartyRow | null> {
  const { rows } = await tx.execute(sql`SELECT * FROM connection_requester(${requestId}::uuid)`);
  return (rows[0] as PartyRow | undefined) ?? null;
}

/**
 * Marca do dono, para quem pediu.
 *
 * Vazio se a conexao nao esta aprovada nem revogada, ou se quem pergunta nao
 * e o solicitante -- a regra vive na funcao, no banco.
 */
export async function disclosureOf(tx: Tx, requestId: string): Promise<PartyRow | null> {
  const { rows } = await tx.execute(sql`SELECT * FROM connection_disclosure(${requestId}::uuid)`);
  return (rows[0] as PartyRow | undefined) ?? null;
}

/** Situacao dos pedidos DESTE parceiro para uma lista de anuncios (busca). */
export async function statusByListing(
  tx: Tx,
  tenantId: string,
  listingIds: string[],
): Promise<Map<string, { id: string; status: ConnectionStatus }>> {
  if (listingIds.length === 0) return new Map();

  const { rows } = await tx.execute(sql`
    SELECT DISTINCT ON (property_id) property_id, id, status::text AS status
      FROM connection_requests
     WHERE property_id = ANY(${sql.param(listingIds)}::uuid[])
       AND requester_tenant_id = ${tenantId}::uuid
     ORDER BY property_id, created_at DESC
  `);

  return new Map(
    (rows as unknown as Array<{ property_id: string; id: string; status: ConnectionStatus }>).map(
      (row) => [row.property_id, { id: row.id, status: row.status }],
    ),
  );
}

/**
 * Revoga uma conexao aprovada. `was_approved` indica se foi revogada agora.
 *
 * Recebe a transacao de quem chama: o evento e a auditoria precisam entrar na
 * mesma transacao, senao uma falha entre os dois deixa a conexao revogada sem
 * trilha -- e a nova tentativa, idempotente, nunca mais grava o evento.
 */
export async function revokeApproved(
  tx: Tx,
  requestId: string,
  reason: string,
): Promise<{
  id: string;
  status: ConnectionStatus;
  ownerTenantId: string;
  requesterTenantId: string;
  wasApproved: boolean;
} | null> {
  const { rows } = await tx.execute(
    sql`SELECT id, status, owner_tenant_id, requester_tenant_id, was_approved FROM connection_revoke_by_platform(${requestId}::uuid, ${reason})`,
  );
  const row = rows[0] as
    | { id: string; status: string; owner_tenant_id: string; requester_tenant_id: string; was_approved: boolean }
    | undefined;
  return row
    ? {
        id: row.id,
        status: row.status as ConnectionStatus,
        ownerTenantId: row.owner_tenant_id,
        requesterTenantId: row.requester_tenant_id,
        wasApproved: row.was_approved,
      }
    : null;
}

/**
 * Colunas da conversa que a aplicacao pode ler.
 *
 * `body_original` fica de fora de proposito: o app_user nao tem SELECT nela
 * (grant por coluna em sql/10_security.sql). Um `select()` sem esta lista
 * pediria todas as colunas e morreria com permission denied.
 */
const messageColumns = {
  id: connectionMessages.id,
  senderTenantId: connectionMessages.senderTenantId,
  body: connectionMessages.body,
  createdAt: connectionMessages.createdAt,
};

export interface MessageRow {
  id: string;
  senderTenantId: string;
  body: string;
  createdAt: Date;
}

export async function insertMessage(
  tx: Tx,
  values: {
    connectionRequestId: string;
    senderTenantId: string;
    senderUserId: string;
    body: string;
    bodyOriginal: string | null;
  },
): Promise<MessageRow> {
  const rows = await tx.insert(connectionMessages).values(values).returning(messageColumns);
  const row = rows[0];
  if (!row) throw new Error('insert de mensagem nao devolveu linha');
  return row;
}

/** A mensagem, se ela for DESTA conexao. Serve de cursor para `after`. */
export async function findMessage(
  tx: Tx,
  connectionRequestId: string,
  messageId: string,
): Promise<MessageRow | null> {
  const rows = await tx
    .select(messageColumns)
    .from(connectionMessages)
    .where(
      and(
        eq(connectionMessages.id, messageId),
        eq(connectionMessages.connectionRequestId, connectionRequestId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** As mais recentes primeiro. Quem chama inverte para a ordem da conversa. */
export async function latestMessages(tx: Tx, connectionRequestId: string, limit: number): Promise<MessageRow[]> {
  return tx
    .select(messageColumns)
    .from(connectionMessages)
    .where(eq(connectionMessages.connectionRequestId, connectionRequestId))
    .orderBy(desc(connectionMessages.createdAt), desc(connectionMessages.id))
    .limit(limit);
}

/**
 * As posteriores ao cursor, em ordem crescente.
 *
 * A comparacao le o cursor NO BANCO: created_at tem microssegundos e o Date
 * do JS so milissegundos. Comparar com o valor que passou pelo JS devolveria
 * a propria mensagem do cursor em toda atualizacao.
 */
export async function messagesAfter(
  tx: Tx,
  connectionRequestId: string,
  afterId: string,
  limit: number,
): Promise<MessageRow[]> {
  return tx
    .select(messageColumns)
    .from(connectionMessages)
    .where(
      and(
        eq(connectionMessages.connectionRequestId, connectionRequestId),
        sql`(${connectionMessages.createdAt}, ${connectionMessages.id}) >
            (SELECT c.created_at, c.id FROM connection_messages c WHERE c.id = ${afterId}::uuid)`,
      ),
    )
    .orderBy(asc(connectionMessages.createdAt), asc(connectionMessages.id))
    .limit(limit);
}

/** Marca a conversa como lida ate agora, pelo lado deste parceiro. */
export async function markRead(tx: Tx, connectionRequestId: string, tenantId: string): Promise<void> {
  await tx
    .insert(connectionMessageReads)
    .values({ connectionRequestId, tenantId, lastReadAt: sql`now()` })
    .onConflictDoUpdate({
      target: [connectionMessageReads.connectionRequestId, connectionMessageReads.tenantId],
      set: { lastReadAt: sql`now()` },
    });
}

/**
 * Nao lidas por conexao, numa consulta so para a lista inteira.
 *
 * Conta so o que veio da OUTRA parte, depois da ultima leitura deste lado.
 * Sem linha de leitura, tudo o que a outra parte mandou conta.
 */
export async function unreadCounts(
  tx: Tx,
  tenantId: string,
  requestIds: string[],
): Promise<Map<string, number>> {
  if (requestIds.length === 0) return new Map();

  const { rows } = await tx.execute(sql`
    SELECT m.connection_request_id AS id, count(*)::int AS unread
      FROM connection_messages m
      LEFT JOIN connection_message_reads r
        ON r.connection_request_id = m.connection_request_id
       AND r.tenant_id = ${tenantId}::uuid
     WHERE m.connection_request_id = ANY(${sql.param(requestIds)}::uuid[])
       AND m.sender_tenant_id <> ${tenantId}::uuid
       AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
     GROUP BY m.connection_request_id
  `);

  return new Map((rows as unknown as Array<{ id: string; unread: number }>).map((row) => [row.id, row.unread]));
}
