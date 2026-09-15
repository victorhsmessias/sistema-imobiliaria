/**
 * Normalizacao de nomes de bairro.
 *
 * Este arquivo e pequeno e parece trivial, mas e o que faz o filtro por bairro
 * funcionar. Em XML de imobiliaria o mesmo bairro chega como "Jardim America",
 * "Jd. America", "JD AMERICA" e "Jardim América". Sem normalizar, viram quatro
 * bairros, e a busca devolve um quarto dos imoveis -- sem erro nenhum.
 */

/** "Jardim América" -> "jardim-america" */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    // Escapes explicitos em vez dos caracteres combinantes literais: eles sao
    // invisiveis no editor e qualquer normalizacao do arquivo os corromperia.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Abreviacoes correntes em cadastro imobiliario brasileiro.
 * A chave e o token ja normalizado (sem acento, minusculo, sem ponto).
 */
const ABBREVIATIONS: Record<string, string> = {
  jd: 'jardim',
  jard: 'jardim',
  v: 'vila',
  vl: 'vila',
  pq: 'parque',
  pque: 'parque',
  st: 'setor',
  res: 'residencial',
  resid: 'residencial',
  cj: 'conjunto',
  cjto: 'conjunto',
  ch: 'chacara',
  sto: 'santo',
  sta: 'santa',
  s: 'sao',
  pr: 'presidente',
  gov: 'governador',
  eng: 'engenheiro',
  dr: 'doutor',
  pc: 'praca',
  al: 'alto',
  nsa: 'nossa',
  sra: 'senhora',
};

/**
 * Gera os slugs candidatos de um nome de bairro, do mais especifico ao mais
 * generico. Quem consome tenta cada um contra neighborhoods.slug e depois
 * contra neighborhood_aliases.alias_slug.
 *
 * "Jd. America" -> ["jd-america", "jardim-america"]
 */
export function neighborhoodSlugCandidates(input: string): string[] {
  const base = slugify(input);
  if (base === '') return [];

  const expanded = base
    .split('-')
    .map((token) => ABBREVIATIONS[token] ?? token)
    .join('-');

  // Muita base traz "Bairro Jardim America" ou "Jardim America - Zona Sul".
  const withoutPrefix = expanded.replace(/^(bairro|b)-/, '');

  const candidates = [base, expanded, withoutPrefix];
  return [...new Set(candidates)].filter((c) => c !== '');
}
