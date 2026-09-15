import type { ImportJobStatus, PropertyType } from '@imob/contracts';
import {
  and,
  asc,
  cities,
  desc,
  eq,
  getDb,
  gt,
  importItems,
  importJobs,
  importSources,
  inArray,
  isNull,
  properties,
  propertyMedia,
  propertyTypeMappings,
  slugify,
  sql,
  type Tx,
} from '@imob/db';

/**
 * Importacao de carteira.
 *
 * Funcoes com `tx` rodam dentro de withTenant(): as tres tabelas de importacao
 * tem FORCE ROW LEVEL SECURITY, entao o banco ja filtrou por tenant. As que
 * usam getDb() leem vocabulario global (cidades, traducao de tipo).
 */

export async function loadPropertyTypeMappings(): Promise<Map<string, PropertyType>> {
  const rows = await getDb()
    .select({ key: propertyTypeMappings.sourceKey, type: propertyTypeMappings.type })
    .from(propertyTypeMappings);
  return new Map(rows.map((row) => [row.key, row.type]));
}

/** Cidade do catalogo por UF e nome. Aceita "Londrina", "LONDRINA" e "Londrina - PR". */
export async function findCity(uf: string, name: string): Promise<{ id: string; slug: string } | null> {
  const bare = name.replace(/\s*[-/]\s*[a-z]{2}\s*$/i, '');
  const candidates = [...new Set([slugify(name), slugify(bare)])].filter((c) => c !== '');
  if (candidates.length === 0) return null;

  const rows = await getDb()
    .select({ id: cities.id, slug: cities.slug })
    .from(cities)
    .where(
      and(
        eq(cities.uf, uf.toUpperCase()),
        sql`${cities.slug} = ANY(${sql.param(candidates)}::text[])`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// -- Fontes ------------------------------------------------------------------

export async function insertSource(tx: Tx, values: typeof importSources.$inferInsert) {
  const rows = await tx.insert(importSources).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insert de fonte de importacao nao devolveu linha');
  return row;
}

export async function listSources(tx: Tx) {
  return tx.select().from(importSources).orderBy(desc(importSources.createdAt));
}

export async function findSource(tx: Tx, id: string) {
  const rows = await tx.select().from(importSources).where(eq(importSources.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function touchSource(tx: Tx, id: string): Promise<void> {
  await tx
    .update(importSources)
    .set({ lastRunAt: new Date(), updatedAt: new Date() })
    .where(eq(importSources.id, id));
}

// -- Execucoes -----------------------------------------------------------------

const ACTIVE_STATUSES: ImportJobStatus[] = ['queued', 'running'];

/**
 * Ja existe execucao em andamento para esta fonte?
 *
 * Duas execucoes simultaneas do mesmo feed disputariam o mesmo anuncio e uma
 * delas bateria na unicidade (tenant, fonte, ListingID). Execucao "rodando" ha
 * mais de uma hora e tratada como abandonada (processo que caiu no meio).
 */
export async function hasActiveJob(tx: Tx, sourceId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(
      and(
        eq(importJobs.sourceId, sourceId),
        inArray(importJobs.status, ACTIVE_STATUSES),
        gt(importJobs.createdAt, sql`now() - interval '1 hour'`),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function insertJob(tx: Tx, values: typeof importJobs.$inferInsert) {
  const rows = await tx.insert(importJobs).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insert de execucao de importacao nao devolveu linha');
  return row;
}

export async function findJob(tx: Tx, id: string) {
  const rows = await tx.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateJob(tx: Tx, id: string, values: Partial<typeof importJobs.$inferInsert>) {
  const rows = await tx.update(importJobs).set(values).where(eq(importJobs.id, id)).returning();
  const row = rows[0];
  if (!row) throw new Error('execucao de importacao nao encontrada');
  return row;
}

export async function insertItem(tx: Tx, values: typeof importItems.$inferInsert): Promise<void> {
  await tx.insert(importItems).values(values);
}

export async function listItems(tx: Tx, jobId: string, status?: (typeof importItems.$inferSelect)['status']) {
  return tx
    .select()
    .from(importItems)
    .where(status ? and(eq(importItems.jobId, jobId), eq(importItems.status, status)) : eq(importItems.jobId, jobId))
    .orderBy(asc(importItems.createdAt));
}

// -- Imoveis e fotos da fonte --------------------------------------------------

/** Inclui imovel excluido: o feed nao pode ressuscitar o que o parceiro apagou. */
export async function findImportedProperty(tx: Tx, externalSource: string, externalId: string) {
  const rows = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.externalSource, externalSource), eq(properties.externalId, externalId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listImportedProperties(tx: Tx, externalSource: string) {
  return tx
    .select({ id: properties.id, externalId: properties.externalId, status: properties.status })
    .from(properties)
    .where(and(eq(properties.externalSource, externalSource), isNull(properties.deletedAt)));
}

export async function listMediaForSync(tx: Tx, propertyId: string) {
  return tx
    .select({
      id: propertyMedia.id,
      sourceUrlHash: propertyMedia.sourceUrlHash,
      storageKey: propertyMedia.storageKey,
      position: propertyMedia.position,
    })
    .from(propertyMedia)
    .where(eq(propertyMedia.propertyId, propertyId))
    .orderBy(asc(propertyMedia.position), asc(propertyMedia.createdAt));
}
