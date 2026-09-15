import { repoRoot } from './load-env.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createMigratorDb, type Database } from './client.js';
import { parseCsv, splitAliases } from './catalog-csv.js';
import { cities, neighborhoodAliases, neighborhoods } from './schema/index.js';
import { slugify } from './slug.js';

/**
 * Aplica um CSV revisado de volta ao catalogo.
 *
 *   pnpm catalog:import catalogo-londrina.csv           # mostra o que mudaria
 *   pnpm catalog:import catalogo-londrina.csv --apply   # grava
 *
 * Dry-run por padrao, de proposito: o catalogo e a espinha do filtro por
 * bairro, e uma planilha editada a mao merece ser conferida antes de virar
 * escrita no banco. O relatorio mostra bairro por bairro o que muda.
 *
 * A operacao e aditiva e idempotente: cria bairro que faltar, corrige o nome
 * de quem mudou, acrescenta aliases novos. Nunca apaga bairro -- um
 * bairro removido da planilha por engano levaria junto os imoveis que apontam
 * para ele.
 */

interface Change {
  bairro: string;
  descricao: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const fileArg = args.find((a) => !a.startsWith('--'));
  if (!fileArg) {
    throw new Error('Informe o arquivo: pnpm catalog:import <arquivo.csv> [--apply]');
  }

  const path = resolve(repoRoot, fileArg);
  const rows = parseCsv(await readFile(path, 'utf8'));
  if (rows.length === 0) throw new Error('CSV sem linhas de dados.');

  const { db, pool } = createMigratorDb();
  try {
    const city = await resolveCity(db);
    const changes: Change[] = [];

    for (const row of rows) {
      if (row.bairro === '') continue;

      const slug = row.slug !== '' ? row.slug : slugify(row.bairro);

      const existing = await db
        .select({ id: neighborhoods.id, name: neighborhoods.name })
        .from(neighborhoods)
        .where(and(eq(neighborhoods.cityId, city.id), eq(neighborhoods.slug, slug)))
        .limit(1);

      const current = existing[0];
      let neighborhoodId: string;

      if (!current) {
        changes.push({ bairro: row.bairro, descricao: 'bairro novo' });
        if (!apply) continue; // sem id no dry-run, nao da para comparar aliases

        const inserted = await db
          .insert(neighborhoods)
          .values({ cityId: city.id, name: row.bairro, slug })
          .returning({ id: neighborhoods.id });
        neighborhoodId = inserted[0]!.id;
      } else {
        neighborhoodId = current.id;

        if (current.name !== row.bairro) {
          changes.push({
            bairro: row.bairro,
            descricao: `nome: "${current.name}" -> "${row.bairro}"`,
          });
          if (apply) {
            await db
              .update(neighborhoods)
              .set({ name: row.bairro })
              .where(eq(neighborhoods.id, neighborhoodId));
          }
        }
      }

      await syncAliases(
        db,
        city.id,
        neighborhoodId,
        row.bairro,
        splitAliases(row.aliases),
        apply,
        changes,
      );
    }

    report(changes, apply, path);
  } finally {
    await pool.end();
  }
}

async function resolveCity(db: Database) {
  const rows = await db.select().from(cities).limit(2);
  if (rows.length === 0) throw new Error('Nenhuma cidade no catalogo. Rode o seed primeiro.');
  if (rows.length > 1) {
    throw new Error('Mais de uma cidade no catalogo: informe a cidade no export/import.');
  }
  return rows[0]!;
}

async function syncAliases(
  db: Database,
  cityId: string,
  neighborhoodId: string,
  bairro: string,
  aliases: string[],
  apply: boolean,
  changes: Change[],
): Promise<void> {
  if (aliases.length === 0) return;

  const existing = await db
    .select({ aliasSlug: neighborhoodAliases.aliasSlug })
    .from(neighborhoodAliases)
    .where(eq(neighborhoodAliases.neighborhoodId, neighborhoodId));

  const known = new Set(existing.map((a) => a.aliasSlug));

  for (const raw of aliases) {
    const alias = slugify(raw);
    if (alias === '' || known.has(alias)) continue;

    changes.push({ bairro, descricao: `alias novo: ${alias}` });
    if (apply) {
      // Alias e unico por cidade. Se ja apontar para outro bairro, ignoramos em
      // vez de sequestrar: conflito assim merece decisao humana, nao um UPDATE
      // silencioso que tiraria imoveis do resultado de busca do outro bairro.
      await db
        .insert(neighborhoodAliases)
        .values({ cityId, neighborhoodId, aliasSlug: alias, source: 'csv' })
        .onConflictDoNothing();
    }
  }
}

function report(changes: Change[], apply: boolean, path: string): void {
  console.log(`[catalog] ${path}`);
  console.log('');

  if (changes.length === 0) {
    console.log('[catalog] nada a mudar: o catalogo ja bate com a planilha.');
    return;
  }

  for (const change of changes) {
    console.log(`  ${change.bairro.padEnd(28)} ${change.descricao}`);
  }

  console.log('');
  console.log(`[catalog] ${changes.length} mudanca(s)`);
  console.log(
    apply
      ? '[catalog] aplicadas.'
      : '[catalog] DRY-RUN -- nada foi gravado. Para aplicar, repita com --apply',
  );
}

main().catch((error: unknown) => {
  console.error('[catalog] import falhou:', error instanceof Error ? error.message : error);
  process.exit(1);
});
