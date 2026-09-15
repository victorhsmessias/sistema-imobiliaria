import {
  and,
  asc,
  cities,
  count,
  desc,
  eq,
  isNull,
  neighborhoods,
  properties,
  propertyMedia,
  sql,
  type Tx,
} from '@imob/db';

/**
 * Carteira do proprio parceiro.
 *
 * Todas as funcoes recebem a transacao criada por withTenant(): o RLS ja
 * filtrou por tenant antes de qualquer linha ser lida. Nenhuma delas recebe
 * tenantId como parametro de filtro -- se recebesse, o dia em que alguem
 * esquecesse de passar seria o dia do vazamento. Aqui esquecer significa
 * "nao abriu withTenant", e ai a consulta simplesmente volta vazia.
 */

const propertyColumns = {
  id: properties.id,
  referenceCode: properties.referenceCode,
  title: properties.title,
  description: properties.description,
  purpose: properties.purpose,
  type: properties.type,
  status: properties.status,
  cityId: properties.cityId,
  cityName: cities.name,
  cityUf: cities.uf,
  neighborhoodId: properties.neighborhoodId,
  neighborhoodName: neighborhoods.name,
  neighborhoodSlug: neighborhoods.slug,
  street: properties.street,
  streetNumber: properties.streetNumber,
  complement: properties.complement,
  zip: properties.zip,
  latitude: properties.latitude,
  longitude: properties.longitude,
  bedrooms: properties.bedrooms,
  suites: properties.suites,
  bathrooms: properties.bathrooms,
  parkingSpots: properties.parkingSpots,
  areaTotal: properties.areaTotal,
  areaBuilt: properties.areaBuilt,
  salePriceCents: properties.salePriceCents,
  rentPriceCents: properties.rentPriceCents,
  condoFeeCents: properties.condoFeeCents,
  iptuCents: properties.iptuCents,
  currency: properties.currency,
  acceptsExchange: properties.acceptsExchange,
  isExclusive: properties.isExclusive,
  publishedToNetwork: properties.publishedToNetwork,
  createdAt: properties.createdAt,
  updatedAt: properties.updatedAt,
};

/** Forma da linha, derivada da propria consulta -- nao ha o que manter em sincronia. */
export type PropertyRow = NonNullable<Awaited<ReturnType<typeof findById>>>;
export type PropertyMediaRow = Awaited<ReturnType<typeof findMedia>>[number];

function baseQuery(tx: Tx) {
  return tx
    .select(propertyColumns)
    .from(properties)
    .innerJoin(cities, eq(cities.id, properties.cityId))
    .innerJoin(neighborhoods, eq(neighborhoods.id, properties.neighborhoodId));
}

export interface ListOptions {
  status?: string;
  search?: string;
  limit: number;
  offset: number;
}

export async function listOwn(tx: Tx, options: ListOptions) {
  const conditions = [isNull(properties.deletedAt)];
  if (options.status) {
    conditions.push(eq(properties.status, options.status as 'draft'));
  }
  if (options.search && options.search.trim() !== '') {
    const term = `%${options.search.trim()}%`;
    conditions.push(
      sql`(unaccent(${properties.title}) ILIKE unaccent(${term})
           OR ${properties.referenceCode} ILIKE ${term})`,
    );
  }

  const where = and(...conditions);

  const [rows, totalRows] = await Promise.all([
    baseQuery(tx)
      .where(where)
      .orderBy(desc(properties.updatedAt), desc(properties.id))
      .limit(options.limit)
      .offset(options.offset),
    tx.select({ value: count() }).from(properties).where(where),
  ]);

  return { rows, total: Number(totalRows[0]?.value ?? 0) };
}

export async function findById(tx: Tx, id: string) {
  const rows = await baseQuery(tx)
    .where(and(eq(properties.id, id), isNull(properties.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findMedia(tx: Tx, propertyId: string) {
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

export async function insertProperty(
  tx: Tx,
  values: typeof properties.$inferInsert,
): Promise<{ id: string }> {
  const rows = await tx.insert(properties).values(values).returning({ id: properties.id });
  const row = rows[0];
  if (!row) throw new Error('insert de imovel nao devolveu id');
  return row;
}

export async function updateProperty(
  tx: Tx,
  id: string,
  values: Partial<typeof properties.$inferInsert>,
): Promise<number> {
  const result = await tx
    .update(properties)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(properties.id, id), isNull(properties.deletedAt)));
  return result.rowCount ?? 0;
}

/**
 * Exclusao logica.
 *
 * Imovel apagado de verdade levaria junto o historico de solicitacoes de
 * conexao que apontam para ele -- exatamente o que a auditoria da Fase 1
 * precisa preservar. E deletedAt tira o imovel da rede na mesma hora, porque
 * a view network_listings filtra por ele.
 */
export async function softDelete(tx: Tx, id: string): Promise<number> {
  const result = await tx
    .update(properties)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(properties.id, id), isNull(properties.deletedAt)));
  return result.rowCount ?? 0;
}
