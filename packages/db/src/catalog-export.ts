import { repoRoot } from './load-env.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { createMigratorDb } from './client.js';
import { toCsv, type CatalogRow } from './catalog-csv.js';
import { cities, neighborhoodAliases, neighborhoods } from './schema/index.js';

/**
 * Exporta o catalogo de uma cidade para CSV, pronto para revisao em planilha.
 *
 *   pnpm catalog:export PR Londrina [arquivo.csv]
 */
async function main(): Promise<void> {
  const [uf = 'PR', cityName = 'Londrina', outArg] = process.argv.slice(2);
  // Caminho relativo resolve contra a raiz do monorepo, e nao contra o cwd do
  // pacote: quem roda `pnpm catalog:export` esta na raiz e espera o arquivo la.
  const outPath = resolve(repoRoot, outArg ?? `docs/catalogo-${cityName.toLowerCase()}.csv`);

  const { db, pool } = createMigratorDb();
  try {
    const city = await db
      .select()
      .from(cities)
      .where(sql`${cities.uf} = ${uf.toUpperCase()} AND unaccent(${cities.name}) ILIKE unaccent(${cityName})`)
      .limit(1);

    const found = city[0];
    if (!found) throw new Error(`Cidade ${cityName}/${uf} nao encontrada no catalogo.`);

    const rows = await db
      .select({
        bairro: neighborhoods.name,
        slug: neighborhoods.slug,
        aliases: sql<string>`coalesce(string_agg(${neighborhoodAliases.aliasSlug}, '|' ORDER BY ${neighborhoodAliases.aliasSlug}), '')`,
      })
      .from(neighborhoods)
      .leftJoin(neighborhoodAliases, eq(neighborhoodAliases.neighborhoodId, neighborhoods.id))
      .where(eq(neighborhoods.cityId, found.id))
      .groupBy(neighborhoods.id, neighborhoods.name, neighborhoods.slug)
      .orderBy(asc(neighborhoods.name));

    const csv = toCsv(
      rows.map(
        (r): CatalogRow => ({
          bairro: r.bairro,
          slug: r.slug,
          aliases: r.aliases,
        }),
      ),
    );

    await writeFile(outPath, csv, 'utf8');
    console.log(`[catalog] ${rows.length} bairros de ${found.name}/${found.uf}`);
    console.log(`[catalog] ${outPath}`);
    console.log('');
    console.log('Revise nomes e aliases e devolva o arquivo. Depois:');
    console.log(`  pnpm catalog:import ${outPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[catalog] export falhou:', error instanceof Error ? error.message : error);
  process.exit(1);
});
