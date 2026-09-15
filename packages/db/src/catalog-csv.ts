/**
 * Ida e volta do catalogo geografico em CSV.
 *
 * O catalogo nao vem de API externa: e curado a mao, e e o que faz o filtro
 * por bairro funcionar. Sem um caminho de edicao, a unica forma de corrigir o
 * nome de um bairro ou acrescentar uma grafia alternativa seria mexer no seed
 * e recriar a base -- inviavel depois que houver imovel real cadastrado.
 *
 * Com CSV, um corretor de Londrina revisa a lista numa planilha e devolve o
 * arquivo. Nenhuma ferramenta nova, nenhum acesso ao banco.
 *
 * Colunas extras sao ignoradas: uma planilha antiga, ainda com a coluna
 * "zona", continua sendo aceita -- so a coluna deixa de significar algo.
 */

export interface CatalogRow {
  bairro: string;
  slug: string;
  /** Grafias alternativas separadas por "|". */
  aliases: string;
}

export const CSV_HEADER = ['bairro', 'slug', 'aliases'] as const;

function escapeField(value: string): string {
  // Aspas, virgula e quebra de linha exigem o campo entre aspas (RFC 4180).
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(rows: CatalogRow[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const row of rows) {
    lines.push(CSV_HEADER.map((key) => escapeField(row[key])).join(','));
  }
  // BOM: sem ele o Excel em pt-BR abre "Higienópolis" como "HigienÃ³polis".
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * Parser RFC 4180 minimo -- o suficiente para o que planilha gera:
 * campos entre aspas, aspas duplicadas dentro do campo, CRLF ou LF.
 */
export function parseCsv(input: string): CatalogRow[] {
  const text = input.replace(/^﻿/, '');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const header = records.shift();
  if (!header) throw new Error('CSV vazio.');

  const normalized = header.map((h) => h.trim().toLowerCase());
  for (const expected of CSV_HEADER) {
    if (!normalized.includes(expected)) {
      throw new Error(
        `Coluna "${expected}" ausente. Cabecalho esperado: ${CSV_HEADER.join(', ')}`,
      );
    }
  }

  const index = Object.fromEntries(
    CSV_HEADER.map((key) => [key, normalized.indexOf(key)]),
  ) as Record<(typeof CSV_HEADER)[number], number>;

  return records
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => ({
      bairro: (r[index.bairro] ?? '').trim(),
      slug: (r[index.slug] ?? '').trim(),
      aliases: (r[index.aliases] ?? '').trim(),
    }));
}

export function splitAliases(value: string): string[] {
  return value
    .split('|')
    .map((a) => a.trim())
    .filter((a) => a !== '');
}
