import type { PropertyPurpose } from '@imob/contracts';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Parser de feed XML VrSync (padrao Grupo OLX / ZAP+ / VivaReal).
 *
 * Referencia: developers.grupozap.com/feeds/vrsync. Estrutura:
 *   <ListingDataFeed><Header/><Listings><Listing>
 *     ListingID, Title, TransactionType, Media/Item, Details, Location, ContactInfo
 *
 * PURO: recebe o XML e devolve dados normalizados, sem banco nem rede. Quem
 * resolve bairro, tipo e fotos e o service.
 *
 * Tolerancias -- cada sistema de gestao gera o XML um pouco diferente, e o
 * parser aceita as variacoes em vez de recusar a carteira inteira:
 *  - com ou sem namespace; tags em qualquer caixa; CDATA ou texto puro;
 *  - numeros com ponto ou virgula ("860000", "860.000,00", "R$ 4.500");
 *  - campos de <Details> soltos direto no <Listing>;
 *  - <Iptu period="Monthly|Yearly"> ou o antigo <YearlyTax>;
 *  - <RentalPrice period="Yearly|Quarterly"> convertido para mensal;
 *  - <Item> sem atributo medium tratado como imagem.
 * Toda tolerancia aplicada que altera valor vira aviso no relatorio.
 *
 * <Zone> NAO e lido para os dados normalizados. Ele continua no payload bruto
 * (`raw`), que o service guarda para a curadoria de bairros homonimos.
 */

export class FeedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedFormatError';
  }
}

export interface ParsedMedia {
  url: string;
  caption: string | null;
  primary: boolean;
}

export interface NormalizedLocation {
  countryAbbr: string | null;
  stateAbbr: string | null;
  city: string | null;
  neighborhood: string | null;
  street: string | null;
  streetNumber: string | null;
  complement: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface NormalizedListing {
  externalId: string;
  title: string | null;
  description: string | null;
  purpose: PropertyPurpose;
  propertyTypeRaw: string | null;
  usageTypeRaw: string | null;
  salePriceCents: number | null;
  /** Mensal. */
  rentPriceCents: number | null;
  /** Mensal. */
  condoFeeCents: number | null;
  /** Anual. */
  iptuCents: number | null;
  areaBuilt: number | null;
  areaTotal: number | null;
  bedrooms: number;
  suites: number;
  bathrooms: number;
  parkingSpots: number;
  location: NormalizedLocation;
  /** So imagens, na ordem do feed, com a principal primeiro e sem repeticao. */
  media: ParsedMedia[];
}

export interface ParsedListing {
  index: number;
  externalId: string;
  data: NormalizedListing;
  warnings: string[];
  raw: unknown;
}

export interface RejectedListing {
  index: number;
  externalId: string | null;
  errors: string[];
  raw: unknown;
}

export interface ParsedFeed {
  listings: ParsedListing[];
  rejected: RejectedListing[];
}

const MAX_IMAGES = 50;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;

// Tags que se repetem. Forcar array evita o caso classico de feed com um
// unico anuncio virando objeto em vez de lista.
const ARRAY_TAGS = new Set(['listing', 'item', 'feature', 'warranty']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  // Numeros ficam como texto: a conversao e nossa, tolerante a virgula.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
  transformTagName: (name) => name.toLowerCase(),
  transformAttributeName: (name) => name.toLowerCase(),
  isArray: (name, _jpath, _isLeaf, isAttribute) => !isAttribute && ARRAY_TAGS.has(name.toLowerCase()),
});

type XmlNode = Record<string, unknown>;

const isNode = (value: unknown): value is XmlNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function child(node: unknown, ...names: string[]): unknown {
  if (Array.isArray(node)) return child(node[0], ...names);
  if (!isNode(node)) return undefined;
  for (const name of names) {
    if (node[name] !== undefined) return node[name];
  }
  return undefined;
}

function textOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return textOf(value[0]);
  if (isNode(value)) return textOf(value['#text']);
  const text = String(value).trim();
  return text === '' ? null : text;
}

function attrOf(value: unknown, name: string): string | null {
  if (Array.isArray(value)) return attrOf(value[0], name);
  if (!isNode(value)) return null;
  const raw = value[`@_${name}`];
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  return text === '' ? null : text;
}

const fold = (value: string): string =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '');

/**
 * Numero escrito por humano ou por sistema: "860000", "860000.00",
 * "860.000,00", "860,000.00", "R$ 4.500", "92,5".
 *
 * Com os dois separadores, o ultimo e o decimal. Com um so, grupos de tres
 * digitos ("860.000", "1,234,567") sao milhar; o resto e decimal ("92,5").
 * Devolve null para vazio, negativo ou lixo.
 */
export function parseDecimalBR(raw: string | null): number | null {
  if (raw === null) return null;
  let text = raw.replace(/[^\d.,-]/g, '');
  if (text === '' || text.includes('-')) return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    text = text.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    text = /^\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  } else if (lastDot !== -1 && /^\d{1,3}(\.\d{3})+$/.test(text)) {
    text = text.replace(/\./g, '');
  }

  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Valor monetario em centavos. Zero vira null: no feed, 0 e "sob consulta". */
export function parseMoneyCents(raw: string | null): number | null {
  const value = parseDecimalBR(raw);
  if (value === null || value <= 0) return null;
  return Math.round(value * 100);
}

function parseCoordinate(raw: string | null, limit: number): number | null {
  if (raw === null) return null;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) && Math.abs(value) <= limit && value !== 0 ? value : null;
}

const PURPOSES: Record<string, PropertyPurpose> = {
  forsale: 'sale',
  sale: 'sale',
  venda: 'sale',
  forrent: 'rent',
  rent: 'rent',
  aluguel: 'rent',
  locacao: 'rent',
  'sale/rent': 'sale_rent',
  'forsale/rent': 'sale_rent',
  'forsale/forrent': 'sale_rent',
  salerent: 'sale_rent',
  'venda/aluguel': 'sale_rent',
  'venda/locacao': 'sale_rent',
};

type Normalized =
  | { ok: true; externalId: string; data: NormalizedListing; warnings: string[] }
  | { ok: false; externalId: string | null; errors: string[] };

function normalizeListing(raw: unknown): Normalized {
  const warnings: string[] = [];
  const errors: string[] = [];

  const externalId = textOf(child(raw, 'listingid'));
  if (!externalId) errors.push('ListingID ausente.');
  else if (externalId.length > 100) errors.push('ListingID com mais de 100 caracteres.');

  const details = child(raw, 'details');
  // Alguns sistemas soltam os campos de <Details> direto no <Listing>.
  const field = (...names: string[]): unknown => child(details, ...names) ?? child(raw, ...names);

  const money = (label: string, node: unknown): number | null => {
    const text = textOf(node);
    const cents = parseMoneyCents(text);
    if (text !== null && cents === null && parseDecimalBR(text) === null) {
      warnings.push(`${label} ilegível ("${text}") ignorado.`);
    }
    return cents;
  };

  // -- Valores ------------------------------------------------------------
  let salePriceCents = money('ListPrice', field('listprice'));

  const rentNode = field('rentalprice');
  let rentPriceCents = money('RentalPrice', rentNode);
  const rentPeriod = attrOf(rentNode, 'period')?.toLowerCase() ?? 'monthly';
  if (rentPriceCents !== null) {
    if (rentPeriod === 'yearly') {
      rentPriceCents = Math.round(rentPriceCents / 12);
      warnings.push('RentalPrice anual convertido para mensal.');
    } else if (rentPeriod === 'quarterly') {
      rentPriceCents = Math.round(rentPriceCents / 3);
      warnings.push('RentalPrice trimestral convertido para mensal.');
    } else if (rentPeriod === 'daily' || rentPeriod === 'weekly') {
      rentPriceCents = null;
      warnings.push(`Aluguel por temporada (period="${rentPeriod}") não é importado.`);
    } else if (rentPeriod !== 'monthly') {
      warnings.push(`Período de aluguel desconhecido ("${rentPeriod}"); valor tratado como mensal.`);
    }
  }

  const condoFeeCents = money('PropertyAdministrationFee', field('propertyadministrationfee'));

  const iptuNode = field('iptu');
  let iptuCents = money('Iptu', iptuNode);
  if (iptuCents !== null && attrOf(iptuNode, 'period')?.toLowerCase() === 'monthly') {
    iptuCents *= 12;
  }
  iptuCents ??= money('YearlyTax', field('yearlytax'));

  // -- Finalidade ---------------------------------------------------------
  const transactionRaw = textOf(child(raw, 'transactiontype') ?? field('transactiontype'));
  let purpose: PropertyPurpose | undefined = transactionRaw ? PURPOSES[fold(transactionRaw)] : undefined;

  if (!purpose) {
    purpose =
      salePriceCents !== null && rentPriceCents !== null
        ? 'sale_rent'
        : rentPriceCents !== null
          ? 'rent'
          : salePriceCents !== null
            ? 'sale'
            : undefined;
    if (purpose) {
      warnings.push(
        transactionRaw
          ? `TransactionType desconhecido ("${transactionRaw}"); finalidade deduzida dos valores.`
          : 'TransactionType ausente; finalidade deduzida dos valores.',
      );
    } else {
      errors.push('TransactionType ausente ou desconhecido, e sem valores para deduzir a finalidade.');
    }
  }

  if (purpose === 'sale' && rentPriceCents !== null) {
    warnings.push('RentalPrice ignorado: o anúncio é só de venda.');
    rentPriceCents = null;
  }
  if (purpose === 'rent' && salePriceCents !== null) {
    warnings.push('ListPrice ignorado: o anúncio é só de aluguel.');
    salePriceCents = null;
  }

  // -- Areas e contagens ----------------------------------------------------
  const area = (label: string, ...names: string[]): number | null => {
    const node = field(...names);
    const text = textOf(node);
    if (text === null) return null;
    const unit = attrOf(node, 'unit');
    if (unit && !/square|m2|m²|metro/i.test(unit)) {
      warnings.push(`${label} em unidade "${unit}" ignorada.`);
      return null;
    }
    const value = parseDecimalBR(text);
    if (value === null || value <= 0) {
      warnings.push(`${label} ilegível ("${text}") ignorada.`);
      return null;
    }
    return Math.round(value * 100) / 100;
  };

  const areaBuilt = area('LivingArea', 'livingarea', 'usablearea');
  const areaTotal = area('LotArea', 'lotarea', 'totalarea');

  const count = (label: string, max: number, ...names: string[]): number => {
    const text = textOf(field(...names));
    if (text === null) return 0;
    const value = parseDecimalBR(text);
    if (value === null) {
      warnings.push(`${label} ilegível ("${text}"); considerado 0.`);
      return 0;
    }
    const whole = Math.trunc(value);
    if (whole > max) {
      warnings.push(`${label} = ${whole} acima do limite (${max}); limitado.`);
      return max;
    }
    return whole;
  };

  const bedrooms = count('Bedrooms', 30, 'bedrooms');
  let suites = count('Suites', 30, 'suites');
  const bathrooms = count('Bathrooms', 30, 'bathrooms');
  const parkingSpots = count('Garage', 50, 'garage', 'parkingspaces');

  if (suites > bedrooms) {
    warnings.push(`Suites (${suites}) acima de Bedrooms (${bedrooms}); limitado ao número de quartos.`);
    suites = bedrooms;
  }

  // -- Textos (sensiveis; nunca vao para a rede) ----------------------------
  const clip = (label: string, text: string | null, max: number): string | null => {
    if (text === null || text.length <= max) return text;
    warnings.push(`${label} com mais de ${max} caracteres; cortado.`);
    return text.slice(0, max);
  };
  const title = clip('Title', textOf(child(raw, 'title')), MAX_TITLE);
  const description = clip('Description', textOf(field('description')), MAX_DESCRIPTION);

  // -- Localizacao ---------------------------------------------------------
  const loc = child(raw, 'location');
  const stateNode = child(loc, 'state');
  const stateText = textOf(stateNode);
  const stateAbbr =
    attrOf(stateNode, 'abbreviation')?.toUpperCase() ??
    (stateText && /^[a-z]{2}$/i.test(stateText) ? stateText.toUpperCase() : null);

  const postalRaw = textOf(child(loc, 'postalcode'));
  const postalDigits = postalRaw?.replace(/\D/g, '') ?? '';
  let postalCode: string | null = null;
  if (postalDigits.length === 8) {
    postalCode = `${postalDigits.slice(0, 5)}-${postalDigits.slice(5)}`;
  } else if (postalRaw) {
    warnings.push(`PostalCode inválido ("${postalRaw}") ignorado.`);
  }

  const latRaw = textOf(child(loc, 'latitude'));
  const lngRaw = textOf(child(loc, 'longitude'));
  const latitude = parseCoordinate(latRaw, 90);
  const longitude = parseCoordinate(lngRaw, 180);
  if ((latRaw && latitude === null) || (lngRaw && longitude === null)) {
    warnings.push('Coordenadas inválidas ignoradas.');
  }

  const location: NormalizedLocation = {
    countryAbbr: attrOf(child(loc, 'country'), 'abbreviation')?.toUpperCase() ?? null,
    stateAbbr,
    city: textOf(child(loc, 'city')),
    neighborhood: textOf(child(loc, 'neighborhood')),
    street: textOf(child(loc, 'address')),
    streetNumber: textOf(child(loc, 'streetnumber')),
    complement: textOf(child(loc, 'complement')),
    postalCode,
    latitude: latitude !== null && longitude !== null ? latitude : null,
    longitude: latitude !== null && longitude !== null ? longitude : null,
  };

  // -- Midia ------------------------------------------------------------------
  const itemsNode = child(child(raw, 'media'), 'item');
  const items = Array.isArray(itemsNode) ? itemsNode : itemsNode === undefined ? [] : [itemsNode];

  const media: ParsedMedia[] = [];
  const seen = new Set<string>();
  let videos = 0;
  let invalidUrls = 0;
  for (const item of items) {
    const url = textOf(item);
    if (!url) continue;
    const medium = attrOf(item, 'medium')?.toLowerCase() ?? 'image';
    if (medium !== 'image') {
      if (medium === 'video') videos++;
      else warnings.push(`Mídia do tipo "${medium}" ignorada.`);
      continue;
    }
    if (!/^https?:\/\/\S+$/i.test(url)) {
      invalidUrls++;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    media.push({
      url,
      caption: attrOf(item, 'caption'),
      primary: attrOf(item, 'primary')?.toLowerCase() === 'true',
    });
  }

  // Principal primeiro; as demais mantem a ordem do feed.
  const primaries = media.filter((m) => m.primary);
  if (primaries.length > 1) warnings.push('Mais de uma foto marcada como principal; vale a primeira.');
  const primaryIndex = media.findIndex((m) => m.primary);
  if (primaryIndex > 0) media.unshift(...media.splice(primaryIndex, 1));
  media.forEach((m, i) => (m.primary = i === 0 && primaryIndex !== -1));

  if (videos > 0) {
    warnings.push(`${videos} vídeo(s) ignorado(s): o link do vídeo identifica o canal da imobiliária.`);
  }
  if (invalidUrls > 0) warnings.push(`${invalidUrls} foto(s) com URL inválida ignorada(s).`);
  if (media.length > MAX_IMAGES) {
    warnings.push(`${media.length} fotos no anúncio; só as ${MAX_IMAGES} primeiras são importadas.`);
    media.length = MAX_IMAGES;
  }

  if (errors.length > 0 || !externalId || !purpose) {
    return { ok: false, externalId, errors };
  }

  return {
    ok: true,
    externalId,
    warnings,
    data: {
      externalId,
      title,
      description,
      purpose,
      propertyTypeRaw: textOf(field('propertytype')),
      usageTypeRaw: textOf(field('usagetype')),
      salePriceCents,
      rentPriceCents,
      condoFeeCents,
      iptuCents,
      areaBuilt,
      areaTotal,
      bedrooms,
      suites,
      bathrooms,
      parkingSpots,
      location,
      media,
    },
  };
}

/**
 * Bytes do feed -> texto, respeitando o encoding declarado no prolog.
 *
 * Sistema antigo ainda gera ISO-8859-1. Ler esse arquivo como UTF-8 troca
 * "Higienópolis" por "Higien�polis" -- e o bairro deixa de casar com o catalogo.
 */
export function decodeXml(bytes: Buffer): string {
  const head = bytes.subarray(0, 200).toString('latin1');
  const encoding = /encoding\s*=\s*["']([\w.-]+)["']/i.exec(head)?.[1]?.toLowerCase();
  if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      // Encoding desconhecido: segue como UTF-8, e o validador reclama se nao for.
    }
  }
  return bytes.toString('utf8').replace(/^﻿/, '');
}

export function parseVrSyncFeed(xml: string): ParsedFeed {
  // Sem DTD. VrSync nao usa, e entidade declarada no DOCTYPE e o caminho de
  // "billion laughs" (expansao exponencial) e de XXE em parsers que resolvem
  // entidade externa. Recusar e mais simples do que confiar no limite.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new FeedFormatError('XML com DOCTYPE ou ENTITY não é aceito.');
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new FeedFormatError(
      `XML malformado na linha ${validation.err.line}: ${validation.err.msg}`,
    );
  }

  const doc = parser.parse(xml) as XmlNode;

  if (child(doc, 'carga') !== undefined) {
    throw new FeedFormatError(
      'Este arquivo está no formato XML ZAP antigo, desligado pelo Grupo OLX em outubro de 2024. ' +
        'Exporte a carteira no padrão VrSync.',
    );
  }

  const root = child(doc, 'listingdatafeed') ?? doc;
  const listingsNode = child(root, 'listings');
  if (listingsNode === undefined) {
    throw new FeedFormatError('Não é um feed VrSync: elemento <Listings> ausente.');
  }

  const nodes = child(listingsNode, 'listing');
  const list = Array.isArray(nodes) ? nodes : nodes === undefined ? [] : [nodes];

  const listings: ParsedListing[] = [];
  const rejected: RejectedListing[] = [];
  const ids = new Set<string>();

  list.forEach((raw, index) => {
    const result = normalizeListing(raw);
    if (!result.ok) {
      rejected.push({ index, externalId: result.externalId, errors: result.errors, raw });
      return;
    }
    if (ids.has(result.externalId)) {
      rejected.push({
        index,
        externalId: result.externalId,
        errors: ['ListingID repetido no feed; só a primeira ocorrência é importada.'],
        raw,
      });
      return;
    }
    ids.add(result.externalId);
    listings.push({
      index,
      externalId: result.externalId,
      data: result.data,
      warnings: result.warnings,
      raw,
    });
  });

  return { listings, rejected };
}
