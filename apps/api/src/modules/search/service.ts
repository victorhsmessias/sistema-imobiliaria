import type {
  ConnectionStatus,
  NetworkListing,
  NetworkListingDetail,
  SearchFilters,
  SearchResult,
} from '@imob/contracts';
import { inArray, isNull, and, properties, withTenant } from '@imob/db';
import { notFound } from '../../lib/errors.js';
import * as connectionsRepo from '../connections/repository.js';
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
interface OwnContext {
  own: Set<string>;
  connections: Map<string, { id: string; status: ConnectionStatus }>;
}

/**
 * O que o parceiro que busca ja sabe sobre cada anuncio da pagina: quais sao
 * dele e em quais ele ja pediu conexao.
 *
 * Nenhum dos dois revela o dono dos demais: o proprio parceiro e a fonte das
 * duas informacoes.
 */
async function ownContext(tenantId: string, listingIds: string[]): Promise<OwnContext> {
  if (listingIds.length === 0) return { own: new Set(), connections: new Map() };

  return withTenant(tenantId, async (tx) => {
    const [rows, connections] = await Promise.all([
      tx
        .select({ id: properties.id })
        .from(properties)
        .where(and(inArray(properties.id, listingIds), isNull(properties.deletedAt))),
      connectionsRepo.statusByListing(tx, tenantId, listingIds),
    ]);

    return { own: new Set(rows.map((r) => r.id)), connections };
  });
}

function toListing(
  row: repo.NetworkRow,
  isOwn: boolean,
  connection: { id: string; status: ConnectionStatus } | null,
): NetworkListing {
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
    connection,
    // Ja vem em ISO-8601 UTC, formatado pelo SQL (ver repository.ts).
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Um anuncio aberto, com a galeria.
 *
 * Mesma origem da lista (a view network_listings) e mesmos campos: abrir o
 * imovel nao revela nada a mais sobre quem anuncia. As fotos vem como ids
 * opacos; os bytes saem por /network/listings/:id/media/:mediaId.
 */
export async function getListing(
  tenantId: string,
  listingId: string,
): Promise<NetworkListingDetail> {
  const row = await repo.findById(listingId);
  // Fora da rede (rascunho, arquivado, retido ou excluido) e indistinguivel
  // de inexistente -- de proposito.
  if (!row) throw notFound('Imóvel não encontrado na rede.');

  const [context, media] = await Promise.all([
    ownContext(tenantId, [listingId]),
    repo.listMedia(listingId),
  ]);

  return {
    ...toListing(row, context.own.has(listingId), context.connections.get(listingId) ?? null),
    media: media.map((item) => ({
      id: item.media_id,
      kind: item.kind as NetworkListingDetail['media'][number]['kind'],
      position: item.position,
      width: item.width,
      height: item.height,
    })),
  };
}

export async function search(tenantId: string, filters: SearchFilters): Promise<SearchResult> {
  const rows = await repo.search(filters);

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  const context = await ownContext(
    tenantId,
    page.map((r) => r.listing_id),
  );

  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? repo.encodeCursor({ v: last.sort_value, id: last.listing_id })
      : null;

  return {
    items: page.map((row) =>
      toListing(row, context.own.has(row.listing_id), context.connections.get(row.listing_id) ?? null),
    ),
    nextCursor,
  };
}
