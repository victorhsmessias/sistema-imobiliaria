import { sql } from 'drizzle-orm';
import { char, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Catalogo geografico. GLOBAL: nao tem tenantId, nao tem RLS.
 * Leitura liberada a todos os parceiros; escrita restrita a platform_admin
 * na camada de aplicacao.
 *
 * Este catalogo e o diferencial do produto. O filtro por bairro so funciona
 * porque existe um vocabulario controlado por tras dele -- ver aliases abaixo.
 */
export const cities = pgTable(
  'cities',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    uf: char({ length: 2 }).notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('cities_uf_slug_key').on(t.uf, t.slug)],
);

/**
 * Bairro: a unidade de localizacao da rede, e a mais fina que atravessa a
 * fronteira entre parceiros.
 *
 * Nao existe agrupamento por zona. Zona e um recorte coloquial, sem valor
 * padronizado: no VrSync <Zone> e opcional e texto livre, e a maioria dos
 * feeds nem preenche. Um filtro por ela devolveria menos imoveis sem erro --
 * o mesmo modo de falha que os aliases abaixo existem para evitar.
 */
export const neighborhoods = pgTable(
  'neighborhoods',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    cityId: uuid()
      .notNull()
      .references(() => cities.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    slug: text().notNull(),
  },
  (t) => [uniqueIndex('neighborhoods_city_slug_key').on(t.cityId, t.slug)],
);

/**
 * Grafias alternativas que apontam para o mesmo bairro.
 *
 * Sem esta tabela, a importacao XML cria "Jd. America", "Jardim America" e
 * "JARDIM AMERICA" como tres bairros distintos, e a busca por bairro -- que e
 * a razao de existir da plataforma -- passa a devolver resultado incompleto
 * SEM ERRO NENHUM. E o tipo de bug que so aparece quando um parceiro reclama
 * que o imovel dele "sumiu".
 *
 * source registra a origem do alias: 'manual' | 'import:<parceiro>' | 'seed'.
 */
export const neighborhoodAliases = pgTable(
  'neighborhood_aliases',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    cityId: uuid()
      .notNull()
      .references(() => cities.id, { onDelete: 'cascade' }),
    neighborhoodId: uuid()
      .notNull()
      .references(() => neighborhoods.id, { onDelete: 'cascade' }),
    aliasSlug: text().notNull(),
    source: text().notNull().default('manual'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('neighborhood_aliases_city_alias_key').on(t.cityId, t.aliasSlug),
    index('neighborhood_aliases_neighborhood_idx').on(t.neighborhoodId),
  ],
);

export type City = typeof cities.$inferSelect;
export type Neighborhood = typeof neighborhoods.$inferSelect;
export type NeighborhoodAlias = typeof neighborhoodAliases.$inferSelect;
