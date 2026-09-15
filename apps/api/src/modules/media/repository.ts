import { and, asc, eq, getDb, isNull, properties, propertyMedia, sql, type Tx } from '@imob/db';

/**
 * Midia da carteira do proprio parceiro.
 *
 * Como properties e property_media tem FORCE ROW LEVEL SECURITY, tudo aqui
 * roda dentro de withTenant() e o banco ja filtrou por tenant antes de
 * qualquer linha ser lida ou escrita.
 */

export async function propertyExists(tx: Tx, propertyId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), isNull(properties.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

export async function nextPosition(tx: Tx, propertyId: string): Promise<number> {
  const rows = await tx
    .select({ max: sql<number | null>`max(${propertyMedia.position})` })
    .from(propertyMedia)
    .where(eq(propertyMedia.propertyId, propertyId));
  return (rows[0]?.max ?? -1) + 1;
}

export async function insertMedia(
  tx: Tx,
  values: typeof propertyMedia.$inferInsert,
): Promise<{ id: string }> {
  const rows = await tx.insert(propertyMedia).values(values).returning({ id: propertyMedia.id });
  const row = rows[0];
  if (!row) throw new Error('insert de midia nao devolveu id');
  return row;
}

export async function listByProperty(tx: Tx, propertyId: string) {
  return tx
    .select({
      id: propertyMedia.id,
      kind: propertyMedia.kind,
      position: propertyMedia.position,
      width: propertyMedia.width,
      height: propertyMedia.height,
      sanitizedAt: propertyMedia.sanitizedAt,
    })
    .from(propertyMedia)
    .where(eq(propertyMedia.propertyId, propertyId))
    .orderBy(asc(propertyMedia.position));
}

export async function findOwnMedia(tx: Tx, mediaId: string) {
  const rows = await tx
    .select({
      id: propertyMedia.id,
      propertyId: propertyMedia.propertyId,
      storageKey: propertyMedia.storageKey,
    })
    .from(propertyMedia)
    .where(eq(propertyMedia.id, mediaId))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteMedia(tx: Tx, mediaId: string): Promise<number> {
  const result = await tx.delete(propertyMedia).where(eq(propertyMedia.id, mediaId));
  return result.rowCount ?? 0;
}

export async function setPosition(tx: Tx, mediaId: string, position: number): Promise<void> {
  await tx.update(propertyMedia).set({ position }).where(eq(propertyMedia.id, mediaId));
}

/**
 * Resolve a chave de storage de uma midia visivel na rede.
 *
 * Passa pela funcao network_media_storage_key(), que revalida no banco que a
 * midia esta sanitizada e que o imovel esta ativo e publicado. Nao le
 * property_media direto: essa tabela esta sob RLS e, mais importante, tem a
 * coluna tenant_id em cada linha.
 *
 * O listingId nao e decorativo -- conferimos que a midia pertence mesmo
 * aquele anuncio, senao o id do anuncio na URL nao significaria nada.
 */
export async function networkMediaStorageKey(
  listingId: string,
  mediaId: string,
): Promise<string | null> {
  const { rows } = await getDb().execute(sql`
    SELECT network_media_storage_key(m.media_id) AS storage_key
      FROM network_listing_media m
     WHERE m.media_id = ${mediaId}::uuid
       AND m.listing_id = ${listingId}::uuid
  `);

  const row = rows[0] as { storage_key: string | null } | undefined;
  return row?.storage_key ?? null;
}
