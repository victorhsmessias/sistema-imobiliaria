import './load-env.js';
import { hash, type Algorithm } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';
import { createMigratorDb } from './client.js';
import {
  cities,
  neighborhoodAliases,
  neighborhoods,
  properties,
  propertyMedia,
  tenants,
  users,
} from './schema/index.js';
import { slugify } from './slug.js';
import { withTenant } from './tenant.js';

/**
 * Dados de demonstracao da Fase 0.
 *
 * Tres parceiros, carteiras distintas, uma cidade com bairros e aliases reais.
 * A senha de todos os usuarios e "demo1234" -- dados de teste, nunca vao para
 * um ambiente exposto.
 */

const DEMO_PASSWORD = 'demo1234';

// Argon2id. O pacote declara Algorithm como `declare const enum`, e
// isolatedModules proibe ler o valor em tempo de compilacao -- dai o literal.
// O mapeamento e publico e estavel: Argon2d = 0, Argon2i = 1, Argon2id = 2.
// A escolha e verificada em runtime logo abaixo, no prefixo do hash gerado.
const ARGON2ID = 2 as Algorithm;

// OWASP Password Storage Cheat Sheet para Argon2id: 19 MiB, t=2, p=1.
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Gera o hash e confirma que saiu mesmo em Argon2id, e nao em outra variante. */
async function hashPassword(plain: string): Promise<string> {
  const digest = await hash(plain, ARGON2_OPTIONS);
  if (!digest.startsWith('$argon2id$')) {
    throw new Error(
      `Esperado Argon2id, obtido "${digest.slice(0, digest.indexOf('$', 1) + 1)}". ` +
        'Verifique a constante ARGON2ID contra o enum Algorithm do @node-rs/argon2.',
    );
  }
  return digest;
}

/** PRNG deterministico: rodar o seed duas vezes gera a mesma carteira. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)] as T;

const between = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

// ---------------------------------------------------------------------------
// Catalogo: Londrina / PR
//
// Os aliases sao o ponto do exercicio. Cada um e uma grafia que realmente
// aparece em XML de imobiliaria e que, sem esta tabela, criaria um bairro
// duplicado e tiraria imoveis do resultado de busca.
//
// Os NOMES dos bairros sao os correntes em Londrina. Nao ha agrupamento por
// zona: a localizacao da rede e o bairro, e so ele.
// ---------------------------------------------------------------------------
const CITY = { uf: 'PR', name: 'Londrina' };

const NEIGHBORHOOD_DEFS: ReadonlyArray<{
  name: string;
  aliases: readonly string[];
}> = [
  { name: 'Centro', aliases: ['centro-londrina', 'centro-ldn'] },
  { name: 'Gleba Palhano', aliases: ['palhano', 'gl-palhano', 'gleba-do-palhano'] },
  { name: 'Jardim Higienópolis', aliases: ['higienopolis', 'jd-higienopolis'] },
  { name: 'Jardim Bela Suíça', aliases: ['bela-suica', 'jd-bela-suica'] },
  { name: 'Jardim Igapó', aliases: ['igapo', 'jd-igapo', 'lago-igapo'] },
  { name: 'Jardim Bandeirantes', aliases: ['bandeirantes', 'jd-bandeirantes'] },
  { name: 'Jardim Los Angeles', aliases: ['los-angeles', 'jd-los-angeles'] },
  { name: 'Jardim Morumbi', aliases: ['morumbi', 'jd-morumbi'] },
  { name: 'Jardim Maria Celina', aliases: ['maria-celina', 'jd-maria-celina'] },
  { name: 'Jardim Shangri-lá', aliases: ['shangri-la', 'shangrila', 'jd-shangri-la'] },
  { name: 'Jardim Petrópolis', aliases: ['petropolis', 'jd-petropolis'] },
  { name: 'Jardim Tarobá', aliases: ['taroba', 'jd-taroba'] },
  { name: 'Jardim Columbia', aliases: ['columbia', 'jd-columbia', 'colombia'] },
  { name: 'Vila Ipiranga', aliases: ['ipiranga', 'v-ipiranga', 'vl-ipiranga'] },
  { name: 'Vila Casoni', aliases: ['casoni', 'v-casoni', 'vl-casoni'] },
  { name: 'Cinco Conjuntos', aliases: ['5-conjuntos', 'cinco-cjs', 'cj-cinco-conjuntos'] },
  { name: 'Conjunto Vivi Xavier', aliases: ['vivi-xavier', 'cj-vivi-xavier'] },
  { name: 'Jardim Alvorada', aliases: ['alvorada', 'jd-alvorada'] },
  { name: 'Jardim Interlagos', aliases: ['interlagos', 'jd-interlagos'] },
  { name: 'Jardim Presidente', aliases: ['presidente', 'jd-presidente'] },
  { name: 'Heimtal', aliases: ['heimtal-londrina', 'distrito-heimtal'] },
  { name: 'Parque Guanabara', aliases: ['guanabara', 'pq-guanabara'] },
  { name: 'Jardim Terra Bonita', aliases: ['terra-bonita', 'jd-terra-bonita'] },
  { name: 'Jardim Vale dos Tucanos', aliases: ['vale-dos-tucanos', 'jd-vale-dos-tucanos'] },
  { name: 'Vila Nova', aliases: ['v-nova', 'vl-nova'] },
];

// ---------------------------------------------------------------------------
// Parceiros
// ---------------------------------------------------------------------------
const TENANT_DEFS = [
  {
    legalName: 'Alfa Negócios Imobiliários Ltda',
    displayName: 'Alfa Imóveis',
    slug: 'alfa-imoveis',
    propertyCount: 24,
    rngSeed: 101,
    users: [
      { email: 'admin@alfa.test', name: 'Renata Alves', role: 'partner_admin' as const },
      { email: 'corretor@alfa.test', name: 'Bruno Tavares', role: 'partner_agent' as const },
    ],
  },
  {
    legalName: 'Beta Participações e Imóveis SA',
    displayName: 'Beta Imóveis',
    slug: 'beta-imoveis',
    propertyCount: 21,
    rngSeed: 202,
    users: [
      { email: 'admin@beta.test', name: 'Paulo Menezes', role: 'partner_admin' as const },
      { email: 'corretor@beta.test', name: 'Camila Rocha', role: 'partner_agent' as const },
    ],
  },
  {
    legalName: 'Carlos Dias Corretor de Imóveis ME',
    displayName: 'Carlos Dias Imóveis',
    slug: 'carlos-dias',
    propertyCount: 15,
    rngSeed: 303,
    users: [{ email: 'carlos@cdias.test', name: 'Carlos Dias', role: 'partner_admin' as const }],
  },
] as const;

const PROPERTY_TYPES = [
  'apartamento',
  'apartamento',
  'apartamento',
  'casa',
  'casa_condominio',
  'sala_comercial',
  'terreno',
  'loja',
] as const;

// Vias reais de Londrina, para que o endereco interno do imovel pareca
// plausivel na tela do dono. Nunca aparece em resultado de busca.
const STREETS = [
  'Avenida Higienópolis',
  'Avenida Maringá',
  'Avenida Juscelino Kubitschek',
  'Rua Senador Souza Naves',
  'Avenida Duque de Caxias',
  'Avenida Saul Elkind',
  'Avenida Madre Leônia Milito',
  'Avenida Ayrton Senna da Silva',
  'Rua Belém',
  'Rua Goiás',
  'Rua Pará',
];

/**
 * Area construida por numero de quartos.
 *
 * Sortear quartos e area de forma independente produz apartamento de 1 quarto
 * com 223 m2. Isso custa duas coisas: a demo perde credibilidade na primeira
 * tela diante de um corretor, e o filtro "3 quartos, minimo 80 m2" -- que e
 * justamente o que estamos demonstrando -- devolve resultado sem sentido.
 */
const BUILT_AREA_BY_BEDROOMS: Record<number, readonly [number, number]> = {
  1: [32, 55],
  2: [50, 85],
  3: [75, 135],
  4: [120, 260],
};

/** Bairros de Londrina por faixa de valor, para o R$/m2 sair plausivel. */
const PREMIUM_NEIGHBORHOODS = new Set([
  'Gleba Palhano',
  'Jardim Higienópolis',
  'Jardim Bela Suíça',
  'Jardim Igapó',
]);

const POPULAR_NEIGHBORHOODS = new Set([
  'Cinco Conjuntos',
  'Conjunto Vivi Xavier',
  'Jardim Alvorada',
  'Jardim Interlagos',
  'Jardim Presidente',
  'Heimtal',
  'Vila Nova',
  'Jardim Maria Celina',
  'Jardim Los Angeles',
]);

/** R$/m2 construido. Ordem de grandeza de Londrina, nao de capital. */
const PRICE_PER_M2: Record<string, readonly [number, number]> = {
  premium: [7000, 11000],
  medio: [4500, 7000],
  popular: [3000, 4800],
};

function priceTier(neighborhoodName: string): string {
  if (PREMIUM_NEIGHBORHOODS.has(neighborhoodName)) return 'premium';
  if (POPULAR_NEIGHBORHOODS.has(neighborhoodName)) return 'popular';
  return 'medio';
}

async function main(): Promise<void> {
  const { db, pool } = createMigratorDb();

  try {
    console.log('[seed] limpando dados existentes...');
    // TRUNCATE e operacao de tabela, nao de linha: nao passa por RLS.
    await pool.query(`
      TRUNCATE TABLE import_items, import_jobs, import_sources,
                     property_media, properties, audit_log, refresh_tokens, users,
                     neighborhood_aliases, neighborhoods, cities, tenants
      RESTART IDENTITY CASCADE
    `);

    // -- Catalogo ------------------------------------------------------------
    console.log('[seed] catalogo geografico...');
    const [city] = await db
      .insert(cities)
      .values({ uf: CITY.uf, name: CITY.name, slug: slugify(CITY.name) })
      .returning();
    if (!city) throw new Error('falha ao criar cidade');

    const neighborhoodRows = await db
      .insert(neighborhoods)
      .values(
        NEIGHBORHOOD_DEFS.map((n) => ({
          cityId: city.id,
          name: n.name,
          slug: slugify(n.name),
        })),
      )
      .returning();
    const neighborhoodByName = new Map(neighborhoodRows.map((n) => [n.name, n]));

    const aliasValues = NEIGHBORHOOD_DEFS.flatMap((n) => {
      const row = neighborhoodByName.get(n.name);
      if (!row) return [];
      return n.aliases.map((alias) => ({
        cityId: city.id,
        neighborhoodId: row.id,
        aliasSlug: alias,
        source: 'seed',
      }));
    });
    await db.insert(neighborhoodAliases).values(aliasValues);
    console.log(
      `[seed]   ${neighborhoodRows.length} bairros, ${aliasValues.length} aliases`,
    );

    // -- Parceiros e usuarios ------------------------------------------------
    console.log('[seed] parceiros e usuarios...');
    const passwordHash = await hashPassword(DEMO_PASSWORD);

    let totalProperties = 0;
    let totalMedia = 0;

    for (const def of TENANT_DEFS) {
      const [tenant] = await db
        .insert(tenants)
        .values({
          legalName: def.legalName,
          displayName: def.displayName,
          slug: def.slug,
          status: 'active',
        })
        .returning();
      if (!tenant) throw new Error(`falha ao criar tenant ${def.slug}`);

      const userRows = await db
        .insert(users)
        .values(
          def.users.map((u, i) => ({
            tenantId: tenant.id,
            email: u.email,
            passwordHash,
            name: u.name,
            phone: `43 9${String(80000000 + def.rngSeed * 1000 + i).slice(0, 8)}`,
            role: u.role,
            status: 'active' as const,
          })),
        )
        .returning();

      const owner = userRows[0];
      if (!owner) throw new Error(`tenant ${def.slug} sem usuario`);

      // ---------------------------------------------------------------------
      // Imoveis: dentro de withTenant.
      //
      // properties tem FORCE ROW LEVEL SECURITY, entao nem o dono da tabela
      // escapa da policy. Se este bloco rodasse fora de withTenant, o INSERT
      // seria recusado pelo WITH CHECK. Ou seja: o seed so passa se o RLS
      // estiver correto -- ele e o primeiro teste da suite.
      // ---------------------------------------------------------------------
      const rng = makeRng(def.rngSeed);

      await withTenant(
        tenant.id,
        async (tx) => {
          for (let i = 0; i < def.propertyCount; i++) {
            const nb = pick(rng, neighborhoodRows);
            const type = pick(rng, PROPERTY_TYPES);

            // Quartos primeiro, area derivada deles, preco derivado da area e
            // do bairro. Nessa ordem os filtros da busca fazem sentido juntos.
            let bedrooms = 0;
            let areaBuilt: number | null = null;
            let areaTotal: number | null = null;

            if (type === 'terreno') {
              areaTotal = between(rng, 200, 900);
            } else if (type === 'loja' || type === 'sala_comercial') {
              areaBuilt = between(rng, 28, 220);
              areaTotal = areaBuilt;
            } else {
              bedrooms = between(rng, 1, 4);
              const [minArea, maxArea] = BUILT_AREA_BY_BEDROOMS[bedrooms] ?? [50, 90];
              areaBuilt = between(rng, minArea, maxArea);
              // Casa tem terreno maior que a area construida; apartamento nao.
              areaTotal =
                type === 'casa' || type === 'casa_condominio'
                  ? areaBuilt + between(rng, 40, 180)
                  : areaBuilt;
            }

            const [ppMin, ppMax] = PRICE_PER_M2[priceTier(nb.name)] ?? [4500, 7000];
            const pricePerM2 = between(rng, ppMin, ppMax);
            // Terreno vale bem menos por m2 do que area construida.
            const valuedArea = areaBuilt ?? areaTotal ?? 60;
            const landFactor = type === 'terreno' ? 0.45 : 1;
            const saleValue = Math.round((valuedArea * pricePerM2 * landFactor) / 1000) * 1000;

            // Um em cada dez anuncios fica a venda E para alugar: e o caso que
            // obriga valor de venda e de aluguel em colunas separadas.
            const roll = rng();
            const purpose =
              roll < 0.65 ? ('sale' as const) : roll < 0.9 ? ('rent' as const) : ('sale_rent' as const);
            // Aluguel residencial gira em torno de 0,4% do valor de venda ao mes.
            const rentCents = Math.round((saleValue * 0.004) / 50) * 50 * 100;

            const [property] = await tx
              .insert(properties)
              .values({
                tenantId: tenant.id,
                referenceCode: `${def.slug.slice(0, 3).toUpperCase()}-${1000 + i}`,
                title: `${type === 'apartamento' ? 'Apartamento' : 'Imóvel'} em ${nb.name} - ${def.displayName}`,
                description:
                  `Excelente oportunidade em ${nb.name}. Falar com ${owner.name}, ` +
                  `${def.displayName}, telefone ${owner.phone}.`,
                purpose,
                type,
                status: rng() < 0.88 ? 'active' : 'draft',
                cityId: city.id,
                neighborhoodId: nb.id,
                street: pick(rng, STREETS),
                streetNumber: String(between(rng, 10, 2400)),
                // CEP de Londrina: faixa 86000-000 a 86099-999.
                zip: `860${String(between(rng, 10, 99))}-${String(between(rng, 100, 999))}`,
                // Centro de Londrina, com dispersao de poucos quilometros.
                latitude: (-23.3103 + (rng() - 0.5) * 0.12).toFixed(7),
                longitude: (-51.1628 + (rng() - 0.5) * 0.12).toFixed(7),
                bedrooms,
                suites: bedrooms > 1 ? between(rng, 0, Math.min(2, bedrooms - 1)) : 0,
                bathrooms: type === 'terreno' ? 0 : Math.max(1, bedrooms),
                parkingSpots: type === 'terreno' ? 0 : between(rng, 0, 3),
                areaTotal: areaTotal === null ? null : String(areaTotal),
                areaBuilt: areaBuilt === null ? null : String(areaBuilt),
                salePriceCents: purpose === 'rent' ? null : saleValue * 100,
                rentPriceCents: purpose === 'sale' ? null : rentCents,
                // Condominio so existe onde ha condominio.
                condoFeeCents:
                  type === 'apartamento' || type === 'casa_condominio'
                    ? between(rng, 250, 1400) * 100
                    : null,
                // IPTU anual, perto de 0,6% do valor venal.
                iptuCents: Math.round((saleValue * 0.006) / 10) * 10 * 100,
                acceptsExchange: rng() < 0.18,
                isExclusive: rng() < 0.3,
                // Um em cada dez fica fora da rede: o parceiro pode reter imovel.
                publishedToNetwork: rng() >= 0.1,
                createdBy: owner.id,
              })
              .returning();
            if (!property) throw new Error('falha ao criar imovel');
            totalProperties++;

            const photoCount = between(rng, 3, 7);
            const mediaValues = Array.from({ length: photoCount }, (_, k) => ({
              tenantId: tenant.id,
              propertyId: property.id,
              // Chave opaca, como a do upload real (buildStorageKey na API). Ela
              // vai parar na URL assinada da busca: com o slug do parceiro no
              // nome do arquivo, o dono vazaria pelo endereco da foto.
              // Os bytes sao gerados depois, por `pnpm --filter @imob/api seed:media`.
              storageKey: `media/${crypto.randomUUID()}/${crypto.randomUUID()}.webp`,
              kind: 'photo' as const,
              position: k,
              width: 1600,
              height: 1067,
              contentType: 'image/webp',
              originalFilename: `${def.displayName} - foto ${k + 1}.jpg`,
              // Uma foto de cada imovel fica pendente de sanitizacao, para que
              // a suite comprove que midia nao sanitizada nao aparece na rede.
              sanitizedAt: k === photoCount - 1 ? null : new Date(),
            }));
            await tx.insert(propertyMedia).values(mediaValues);
            totalMedia += mediaValues.length;
          }
        },
        db,
      );

      console.log(`[seed]   ${def.displayName}: ${def.propertyCount} imoveis, ${userRows.length} usuarios`);
    }

    const networkCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM network_listings',
    );

    console.log('');
    console.log('[seed] resumo');
    console.log(`[seed]   parceiros .............. ${TENANT_DEFS.length}`);
    console.log(`[seed]   imoveis ................ ${totalProperties}`);
    console.log(`[seed]   midias ................. ${totalMedia}`);
    console.log(`[seed]   visiveis na rede ....... ${networkCount.rows[0]?.count}`);
    console.log('');
    console.log(`[seed] login de demo: admin@alfa.test / ${DEMO_PASSWORD}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] falhou:', error);
  process.exit(1);
});
