import type { ConnectionStatus } from '@imob/contracts';
import {
  and,
  connectionEvents,
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

export async function hasDisclosureEvent(tx: Tx, connectionRequestId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: connectionEvents.id })
    .from(connectionEvents)
    .where(
      and(
        eq(connectionEvents.connectionRequestId, connectionRequestId),
        eq(connectionEvents.type, 'disclosed'),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
  broker_name: string | null;
  broker_phone: string | null;
  broker_email: string | null;
}

/** Quem pediu, para o dono. Devolve vazio se quem pergunta nao e o dono. */
export async function requesterOf(tx: Tx, requestId: string): Promise<PartyRow | null> {
  const { rows } = await tx.execute(sql`SELECT * FROM connection_requester(${requestId}::uuid)`);
  return (rows[0] as PartyRow | undefined) ?? null;
}

/**
 * Dados do dono, para quem pediu.
 *
 * Devolve vazio se a conexao nao esta aprovada ou se quem pergunta nao e o
 * solicitante -- a regra vive na funcao, no banco.
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

/** Revoga uma conexao aprovada. Retorna o resultado: was_approved indica se foi revogada agora. */
export async function revokeApproved(
  requestId: string,
  reason: string,
): Promise<{
  id: string;
  status: ConnectionStatus;
  ownerTenantId: string;
  requesterTenantId: string;
  wasApproved: boolean;
} | null> {
  const { rows } = await getDb().execute(
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
