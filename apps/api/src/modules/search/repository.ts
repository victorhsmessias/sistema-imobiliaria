import type { SearchFilters } from '@imob/contracts';
import { getDb, sql, type SQL } from '@imob/db';

/**
 * Busca na base agregada da rede.
 *
 * Le APENAS de network_listings e network_listing_media. Nunca de properties.
 *
 * Isso nao e estilo: as views tem allow-list explicita de colunas e dono com
 * BYPASSRLS; a tabela properties tem o dono do imovel em cada linha. Uma
 * consulta cross-tenant contra properties devolveria tudo o que a view existe
 * para esconder -- e, por causa do RLS, provavelmente devolveria zero linhas
 * antes disso, o que ao menos falha barulhento.
 */

export interface NetworkRow {
  listing_id: string;
  type: string;
  purpose: string;
  city_id: string;
  city_name: string;
  city_uf: string;
  neighborhood_id: string;
  neighborhood_name: string;
  bedrooms: number;
  suites: number;
  bathrooms: number;
  parking_spots: number;
  area_total: string | null;
  area_built: string | null;
  sale_price_cents: string | number | null;
  rent_price_cents: string | number | null;
  condo_fee_cents: string | number | null;
  iptu_cents: string | number | null;
  currency: string;
  accepts_exchange: boolean;
  /** Ja em ISO-8601 UTC: formatado no SQL, nao pelo driver (ver abaixo). */
  created_at: string;
  updated_at: string;
  photo_count: string | number;
  cover_media_id: string | null;
  sort_value: string | number;
}

export interface Cursor {
  /** Valor da coluna de ordenacao na ultima linha da pagina anterior. */
  v: string | number;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'v' in parsed &&
      'id' in parsed &&
      typeof (parsed as Cursor).id === 'string'
    ) {
      return parsed as Cursor;
    }
    return null;
  } catch {
    // Cursor corrompido volta como primeira pagina. Melhor do que 500 numa
    // URL que alguem colou errado.
    return null;
  }
}

/**
 * Expressao de ordenacao por modo.
 *
 * Preco nulo (imovel "sob consulta") precisa de posicao definida, senao a
 * paginacao por keyset pula ou repete linhas. coalesce com sentinela resolve:
 * nulos sempre no fim, nos dois sentidos.
 */
const BIGINT_MAX = sql.raw('9223372036854775807');

interface SortSpec {
  value: SQL;
  direction: 'ASC' | 'DESC';
  /**
   * Cast aplicado ao valor do cursor.
   *
   * O cursor viaja como JSON, entao volta como string mesmo quando a coluna e
   * numerica ou timestamp. Sem o cast explicito o Postgres compara texto com
   * timestamptz e a paginacao ou erra ou ordena errado.
   */
  cursorCast: SQL;
}

/**
 * Coluna de valor da finalidade buscada.
 *
 * O contrato ja exige a finalidade para ordenar ou filtrar por valor, entao
 * "sem finalidade" nunca chega aqui junto com um filtro de preco.
 */
function priceColumn(purpose: SearchFilters['purpose']): SQL {
  return purpose === 'rent' ? sql`l.rent_price_cents` : sql`l.sale_price_cents`;
}

function sortExpression(sort: SearchFilters['sort'], purpose: SearchFilters['purpose']): SortSpec {
  const price = priceColumn(purpose);
  switch (sort) {
    case 'price_asc':
      return {
        value: sql`coalesce(${price}, ${BIGINT_MAX})`,
        direction: 'ASC',
        cursorCast: sql.raw('::bigint'),
      };
    case 'price_desc':
      return {
        value: sql`coalesce(${price}, -1)`,
        direction: 'DESC',
        cursorCast: sql.raw('::bigint'),
      };
    case 'recent':
    default:
      return {
        value: sql`l.updated_at`,
        direction: 'DESC',
        cursorCast: sql.raw('::timestamptz'),
      };
  }
}

function buildFilters(filters: SearchFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.cityId) conditions.push(sql`l.city_id = ${filters.cityId}::uuid`);

  // O filtro que motivou o produto: bairro.
  //
  // sql.param() e obrigatorio para arrays. No template do drizzle, um array
  // solto e desenrolado em placeholders separados -- `ANY(($1)::uuid[])` com
  // $1 escalar -- e a consulta quebra. sql.param() liga o array inteiro como
  // um unico parametro, que e o que ANY() espera.
  if (filters.neighborhoodIds?.length) {
    conditions.push(sql`l.neighborhood_id = ANY(${sql.param(filters.neighborhoodIds)}::uuid[])`);
  }

  if (filters.types?.length) {
    conditions.push(sql`l.type::text = ANY(${sql.param(filters.types)}::text[])`);
  }
  if (filters.purpose) {
    // "Venda" inclui o anuncio de venda e aluguel; "aluguel" tambem.
    const purposes = filters.purpose === 'sale' ? ['sale', 'sale_rent'] : ['rent', 'sale_rent'];
    conditions.push(sql`l.purpose::text = ANY(${sql.param(purposes)}::text[])`);
  }

  if (filters.bedroomsMin !== undefined) conditions.push(sql`l.bedrooms >= ${filters.bedroomsMin}`);
  if (filters.bathroomsMin !== undefined) {
    conditions.push(sql`l.bathrooms >= ${filters.bathroomsMin}`);
  }
  if (filters.parkingMin !== undefined) {
    conditions.push(sql`l.parking_spots >= ${filters.parkingMin}`);
  }

  if (filters.areaBuiltMin !== undefined) {
    conditions.push(sql`l.area_built >= ${filters.areaBuiltMin}`);
  }
  if (filters.areaTotalMin !== undefined) {
    conditions.push(sql`l.area_total >= ${filters.areaTotalMin}`);
  }

  const price = priceColumn(filters.purpose);
  if (filters.priceMin !== undefined) conditions.push(sql`${price} >= ${filters.priceMin}`);
  if (filters.priceMax !== undefined) conditions.push(sql`${price} <= ${filters.priceMax}`);

  return conditions;
}

/**
 * Colunas do anuncio, compartilhadas pela lista e pelo detalhe.
 *
 * Uma lista so: a busca e o detalhe precisam expor exatamente o mesmo
 * conjunto, e duas copias divergiriam no dia em que alguem adicionasse um
 * campo em apenas uma delas.
 */
const LISTING_COLUMNS = sql`
  l.listing_id,
  l.type::text        AS type,
  l.purpose::text     AS purpose,
  l.city_id,
  c.name              AS city_name,
  c.uf                AS city_uf,
  l.neighborhood_id,
  n.name              AS neighborhood_name,
  l.bedrooms, l.suites, l.bathrooms, l.parking_spots,
  l.area_total, l.area_built,
  l.sale_price_cents, l.rent_price_cents, l.condo_fee_cents, l.iptu_cents, l.currency,
  l.accepts_exchange,
  -- Formatado aqui, e nao no Node: em execute() cru o driver devolve o
  -- timestamp como string do Postgres ("2026-09-12 21:00:00.12+00"), que
  -- nao e ISO-8601 e nao satisfaz o contrato. to_char torna o formato
  -- explicito e independente de parser do driver.
  to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(l.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
  (SELECT count(*) FROM network_listing_media m WHERE m.listing_id = l.listing_id)
                      AS photo_count,
  -- Sai da view network_listing_media, que ja exige sanitized_at: a capa
  -- nunca e uma foto que ainda carrega EXIF.
  (SELECT m.media_id FROM network_listing_media m
    WHERE m.listing_id = l.listing_id
    ORDER BY m.position, m.media_id LIMIT 1)
                      AS cover_media_id
`;

const LISTING_FROM = sql`
  FROM network_listings l
  JOIN cities c        ON c.id = l.city_id
  JOIN neighborhoods n ON n.id = l.neighborhood_id
`;

/**
 * Um anuncio pelo id, para a tela de detalhe.
 *
 * Le a MESMA view da busca: um anuncio fora da rede (rascunho, arquivado,
 * retido pelo parceiro ou excluido) simplesmente nao existe aqui, e a rota
 * responde 404 -- nao 403, que ja confirmaria a existencia.
 */
export async function findById(listingId: string): Promise<NetworkRow | null> {
  const { rows } = await getDb().execute(sql`
    SELECT ${LISTING_COLUMNS}, l.updated_at AS sort_value
    ${LISTING_FROM}
    WHERE l.listing_id = ${listingId}::uuid
    LIMIT 1
  `);
  return (rows[0] as unknown as NetworkRow | undefined) ?? null;
}

export interface NetworkMediaRow {
  media_id: string;
  kind: string;
  position: number;
  width: number | null;
  height: number | null;
}

/** Galeria do anuncio. So midia sanitizada -- a view ja exige sanitized_at. */
export async function listMedia(listingId: string): Promise<NetworkMediaRow[]> {
  const { rows } = await getDb().execute(sql`
    SELECT m.media_id, m.kind::text AS kind, m.position, m.width, m.height
      FROM network_listing_media m
     WHERE m.listing_id = ${listingId}::uuid
     ORDER BY m.position, m.media_id
  `);
  return rows as unknown as NetworkMediaRow[];
}

export async function search(filters: SearchFilters): Promise<NetworkRow[]> {
  const conditions = buildFilters(filters);
  const { value: sortValue, direction, cursorCast } = sortExpression(filters.sort, filters.purpose);

  /**
   * Paginacao por keyset, e nao OFFSET.
   *
   * Com OFFSET, um imovel cadastrado entre a pagina 1 e a 2 empurra a lista e
   * faz um resultado aparecer duas vezes (ou sumir). Comparando a tupla
   * (valor de ordenacao, id) contra a ultima linha vista, a pagina seguinte e
   * sempre exata, e o custo nao cresce com a profundidade.
   *
   * O id entra na tupla como desempate: sem ele, imoveis com o mesmo preco
   * teriam ordem indefinida entre paginas.
   */
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  if (cursor) {
    const comparator = direction === 'ASC' ? sql.raw('>') : sql.raw('<');
    conditions.push(
      sql`(${sortValue}, l.listing_id) ${comparator} (${cursor.v}${cursorCast}, ${cursor.id}::uuid)`,
    );
  }

  const where =
    conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  const order = sql.raw(direction);

  // limit + 1: a linha extra so serve para saber se existe proxima pagina.
  const query = sql`
    SELECT ${LISTING_COLUMNS}, ${sortValue} AS sort_value
    ${LISTING_FROM}
    ${where}
    ORDER BY ${sortValue} ${order}, l.listing_id ${order}
    LIMIT ${filters.limit + 1}
  `;

  const { rows } = await getDb().execute(query);
  return rows as unknown as NetworkRow[];
}
