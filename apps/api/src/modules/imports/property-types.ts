import type { PropertyType } from '@imob/contracts';
import { slugify } from '@imob/db';

/**
 * Traducao do PropertyType do feed para o tipo da plataforma.
 *
 * O VrSync escreve "Residential / Apartment"; sistemas legados escrevem
 * "Apartamento", "Residencial - Apartamento" ou so "apartment". As chaves sao
 * tentadas da mais especifica para a mais generica, contra a tabela
 * property_type_mappings:
 *
 *   "Residential / Apartment" -> residential-apartment, apartment
 */
export function propertyTypeKeys(raw: string | null): string[] {
  if (!raw) return [];
  const full = slugify(raw);
  const withoutUsage = full.replace(/^(residential|commercial|residencial|comercial)-/, '');
  const lastSegment = slugify(raw.split(/[/|>]/).at(-1) ?? '');
  return [...new Set([full, withoutUsage, lastSegment])].filter((key) => key !== '');
}

export interface ResolvedPropertyType {
  type: PropertyType;
  /** Null quando nada casou e o tipo caiu em "outro". */
  matchedKey: string | null;
}

export function resolvePropertyType(
  raw: string | null,
  mappings: ReadonlyMap<string, PropertyType>,
): ResolvedPropertyType {
  for (const key of propertyTypeKeys(raw)) {
    const type = mappings.get(key);
    if (type) return { type, matchedKey: key };
  }
  return { type: 'outro', matchedKey: null };
}
