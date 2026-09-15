import {
  and,
  asc,
  cities,
  eq,
  getDb,
  neighborhoodAliases,
  neighborhoods,
  neighborhoodSlugCandidates,
  sql,
} from '@imob/db';

/**
 * Catalogo geografico.
 *
 * Sem tenant e sem RLS: e vocabulario compartilhado por toda a rede. Escrita
 * so por admin de plataforma, via migration ou CLI -- app_user tem apenas
 * SELECT (ver sql/10_security.sql).
 */

export async function listCities() {
  return getDb().select().from(cities).orderBy(asc(cities.uf), asc(cities.name));
}

export interface NeighborhoodRow {
  id: string;
  cityId: string;
  name: string;
  slug: string;
}

const neighborhoodColumns = {
  id: neighborhoods.id,
  cityId: neighborhoods.cityId,
  name: neighborhoods.name,
  slug: neighborhoods.slug,
};

export async function listNeighborhoods(cityId: string, search?: string) {
  const base = getDb().select(neighborhoodColumns).from(neighborhoods);

  if (!search || search.trim() === '') {
    return base.where(eq(neighborhoods.cityId, cityId)).orderBy(asc(neighborhoods.name));
  }

  // unaccent nos dois lados: quem digita "sao" tem que achar "São", e quem
  // digita "Higienópolis" tem que achar o registro gravado sem acento.
  const term = `%${search.trim()}%`;
  return base
    .where(
      and(
        eq(neighborhoods.cityId, cityId),
        sql`unaccent(${neighborhoods.name}) ILIKE unaccent(${term})`,
      ),
    )
    .orderBy(asc(neighborhoods.name));
}

export interface ResolvedNeighborhood {
  neighborhood: NeighborhoodRow;
  matchedBy: 'slug' | 'alias';
  matchedSlug: string;
}

/**
 * Resolve um nome livre de bairro para o bairro do catalogo.
 *
 * Tenta os slugs candidatos em ordem -- primeiro a grafia como veio, depois
 * com as abreviacoes expandidas ("jd" -> "jardim") -- primeiro contra o nome
 * canonico, depois contra os aliases.
 *
 * E a funcao que faz o filtro por bairro funcionar quando a base vem de
 * fontes diferentes. A importacao XML chama esta funcao para cada imovel; sem
 * ela, "Jd. Higienopolis" e "Jardim Higienópolis" viram dois bairros e metade
 * dos imoveis some do resultado sem nenhum erro.
 */
export async function resolveNeighborhood(
  cityId: string,
  rawName: string,
): Promise<ResolvedNeighborhood | null> {
  const candidates = neighborhoodSlugCandidates(rawName);
  if (candidates.length === 0) return null;

  const db = getDb();

  const direct = await db
    .select(neighborhoodColumns)
    .from(neighborhoods)
    .where(
      and(
        eq(neighborhoods.cityId, cityId),
        sql`${neighborhoods.slug} = ANY(${sql.param(candidates)}::text[])`,
      ),
    )
    .limit(1);

  const hit = direct[0];
  if (hit) return { neighborhood: hit, matchedBy: 'slug', matchedSlug: hit.slug };

  const viaAlias = await db
    .select({ ...neighborhoodColumns, aliasSlug: neighborhoodAliases.aliasSlug })
    .from(neighborhoodAliases)
    .innerJoin(neighborhoods, eq(neighborhoods.id, neighborhoodAliases.neighborhoodId))
    .where(
      and(
        eq(neighborhoodAliases.cityId, cityId),
        sql`${neighborhoodAliases.aliasSlug} = ANY(${sql.param(candidates)}::text[])`,
      ),
    )
    .limit(1);

  const aliasHit = viaAlias[0];
  if (!aliasHit) return null;

  const { aliasSlug, ...neighborhood } = aliasHit;
  return { neighborhood, matchedBy: 'alias', matchedSlug: aliasSlug };
}

/** Busca um bairro por id. Usado para derivar a cidade no cadastro. */
export async function findNeighborhoodById(id: string): Promise<NeighborhoodRow | null> {
  const rows = await getDb()
    .select(neighborhoodColumns)
    .from(neighborhoods)
    .where(eq(neighborhoods.id, id))
    .limit(1);

  return rows[0] ?? null;
}
