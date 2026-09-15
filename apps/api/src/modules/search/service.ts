import type { NetworkListing, SearchFilters, SearchResult } from '@imob/contracts';
import { inArray, isNull, and, properties, withTenant } from '@imob/db';
import * as repo from './repository.js';

const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

/**
 * Marca, dentro do resultado agregado, quais imoveis sao do proprio parceiro.
 *
 * Roda dentro de withTenant, entao o RLS so devolve os ids que realmente
 * pertencem a ele. Nao ha vazamento: o parceiro ja sabe o que e dele, e saber
 * que os outros NAO sao dele nao diz de quem sao.
 */
async function ownIdsAmong(tenantId: string, listingIds: string[]): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set();

  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: properties.id })
      .from(properties)
      .where(and(inArray(properties.id, listingIds), isNull(properties.deletedAt))),
  );

  return new Set(rows.map((r) => r.id));
}

function toListing(row: repo.NetworkRow, isOwn: boolean): NetworkListing {
  return {
    listingId: row.listing_id,
    type: row.type as NetworkListing['type'],
    purpose: row.purpose as NetworkListing['purpose'],
    city: { id: row.city_id, name: row.city_name, uf: row.city_uf },
    neighborhood: { id: row.neighborhood_id, name: row.neighborhood_name },
    bedrooms: row.bedrooms,
    suites: row.suites,
    bathrooms: row.bathrooms,
    parkingSpots: row.parking_spots,
    areaTotal: num(row.area_total),
    areaBuilt: num(row.area_built),
    salePriceCents: num(row.sale_price_cents),
    rentPriceCents: num(row.rent_price_cents),
    condoFeeCents: num(row.condo_fee_cents),
    iptuCents: num(row.iptu_cents),
    currency: row.currency,
    acceptsExchange: row.accepts_exchange,
    photoCount: Number(row.photo_count),
    coverMediaId: row.cover_media_id,
    isOwn,
    // Ja vem em ISO-8601 UTC, formatado pelo SQL (ver repository.ts).
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function search(tenantId: string, filters: SearchFilters): Promise<SearchResult> {
  const rows = await repo.search(filters);

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  const own = await ownIdsAmong(
    tenantId,
    page.map((r) => r.listing_id),
  );

  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? repo.encodeCursor({ v: last.sort_value, id: last.listing_id })
      : null;

  return {
    items: page.map((row) => toListing(row, own.has(row.listing_id))),
    nextCursor,
  };
}
