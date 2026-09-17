import { closeDb } from '@imob/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadFixture, loginAs, withOracle, type SeedFixture } from './helpers.js';

const ALFA = 'admin@alfa.test';

interface Listing {
  listingId: string;
  isOwn: boolean;
  purpose: string;
  salePriceCents: number | null;
  rentPriceCents: number | null;
  bedrooms: number;
  type: string;
  neighborhood: { id: string; name: string };
}

describe('busca na rede', () => {
  let app: FastifyInstance;
  let fixture: SeedFixture;
  let cookies: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp({ rateLimit: false });
    await app.ready();
    fixture = await loadFixture();
    cookies = (await loginAs(app, ALFA)).cookies;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  async function search(query = ''): Promise<{ statusCode: number; items: Listing[]; raw: string; nextCursor: string | null }> {
    const response = await app.inject({
      method: 'GET',
      url: `/network/search${query ? `?${query}` : ''}`,
      cookies,
    });
    // Nao mascare falha como lista vazia: um 500 aqui virava "0 resultados" e
    // as assercoes de filtro passavam a testar nada. Se a rota falhou, o teste
    // tem que ver o erro.
    if (response.statusCode >= 500) {
      throw new Error(`busca falhou (${response.statusCode}): ${response.body.slice(0, 300)}`);
    }
    const body = response.statusCode === 200 ? response.json() : { items: [], nextCursor: null };
    return {
      statusCode: response.statusCode,
      items: body.items,
      nextCursor: body.nextCursor,
      raw: response.body,
    };
  }

  it('exige sessao', async () => {
    const response = await app.inject({ method: 'GET', url: '/network/search' });
    expect(response.statusCode).toBe(401);
  });

  it('devolve resultados da base agregada de todos os parceiros', async () => {
    const { statusCode, items } = await search('limit=50');
    expect(statusCode).toBe(200);
    expect(items.length).toBeGreaterThan(0);

    // Resultado agregado de verdade: ha imoveis de terceiros, nao so os proprios.
    expect(items.some((i) => !i.isOwn)).toBe(true);
  });

  // =========================================================================
  // O gate. Mesma abordagem da suite do banco, agora sobre a resposta HTTP:
  // serializa tudo e procura qualquer identificador conhecido la dentro, em
  // vez de conferir campo a campo o que alguem lembrou de esconder.
  // =========================================================================
  it('NENHUM identificador de parceiro aparece na resposta HTTP', async () => {
    const { raw, items } = await search('limit=50');
    expect(items.length).toBeGreaterThan(0);

    const forbidden: Array<{ value: string; label: string }> = [];
    for (const tenant of fixture.tenants) {
      forbidden.push({ value: tenant.id, label: `tenant_id de ${tenant.slug}` });
      forbidden.push({ value: tenant.legalName, label: `razao social de ${tenant.slug}` });
      forbidden.push({ value: tenant.displayName, label: `marca de ${tenant.slug}` });
      forbidden.push({ value: tenant.slug, label: `slug de ${tenant.slug}` });
      for (const email of tenant.emails) forbidden.push({ value: email, label: 'e-mail' });
      for (const name of tenant.names) forbidden.push({ value: name, label: 'nome de corretor' });
      for (const phone of tenant.phones) forbidden.push({ value: phone, label: 'telefone' });
    }

    // Guarda contra fixture degenerada: strings curtas tornariam a busca por
    // substring sem sentido, e o teste ficaria verde ao parar de testar.
    expect(forbidden.length).toBeGreaterThan(10);
    for (const item of forbidden) {
      expect(item.value.length, `identificador curto demais: ${item.label}`).toBeGreaterThan(3);
    }

    const leaked = forbidden.filter((f) => raw.includes(f.value));
    expect(leaked.map((l) => `${l.label}: "${l.value}"`)).toEqual([]);
  });

  it('nao devolve texto livre, endereco nem codigo interno dos imoveis', async () => {
    const { raw } = await search('limit=50');

    const sensitive = await withOracle(async (client) => {
      const { rows } = await client.query<Record<string, string | null>>(`
        SELECT title, description, street, reference_code, zip
          FROM properties WHERE deleted_at IS NULL LIMIT 200
      `);
      return rows;
    });

    const leaked: string[] = [];
    for (const row of sensitive) {
      for (const [field, value] of Object.entries(row)) {
        if (typeof value === 'string' && value.length > 6 && raw.includes(value)) {
          leaked.push(`${field}: "${value.slice(0, 60)}"`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it('a string "tenant" nao aparece em lugar nenhum da resposta', async () => {
    const { raw } = await search('limit=10');
    expect(raw).not.toContain('tenant');
    expect(raw).not.toContain('storage_key');
    expect(raw).not.toContain('media/');
  });

  it('so lista imoveis ativos e publicados na rede', async () => {
    const { items } = await search('limit=50');
    const visiveis = new Set(items.map((i) => i.listingId));

    const retidos = await withOracle(async (client) => {
      const { rows } = await client.query<{ id: string }>(`
        SELECT id FROM properties
         WHERE deleted_at IS NOT NULL
            OR status <> 'active'
            OR NOT published_to_network
      `);
      return rows.map((r: { id: string }) => r.id);
    });

    expect(retidos.length).toBeGreaterThan(0);
    expect(retidos.filter((id: string) => visiveis.has(id))).toEqual([]);
  });

  describe('filtros', () => {
    it('filtra por bairro -- o filtro que motivou o produto', async () => {
      // O alvo sai do proprio resultado, e nao do catalogo: nem todo bairro
      // cadastrado tem imovel publicado, e um alvo vazio faria o teste falhar
      // por falta de dado em vez de por defeito no filtro.
      const { items: todos } = await search('limit=50');
      const alvo = todos[0]!.neighborhood;

      const { items } = await search(`neighborhoodIds=${alvo.id}&limit=50`);

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.neighborhood.id === alvo.id)).toBe(true);

      // E o filtro realmente restringe: nao devolveu a rede inteira.
      expect(items.length).toBeLessThan(todos.length);
    });

    it('nao existe agrupamento por zona: nem filtro, nem campo na resposta', async () => {
      // Bairro e a unica localizacao da rede. Um `zoneIds` vindo de link
      // antigo e ignorado -- nao restringe nada e nao da erro.
      const { items: todos, raw } = await search('limit=50');
      const legado = await search('zoneIds=00000000-0000-0000-0000-000000000000&limit=50');

      expect(legado.statusCode).toBe(200);
      expect(legado.items.map((i) => i.listingId)).toEqual(todos.map((i) => i.listingId));
      expect(raw).not.toMatch(/"zone/i);
    });

    it('filtra por quartos minimos', async () => {
      const { items } = await search('bedroomsMin=3&limit=50');
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.bedrooms >= 3)).toBe(true);
    });

    it('filtra por faixa de valor de venda', async () => {
      const min = 30_000_000;
      const max = 80_000_000;
      const { items } = await search(`purpose=sale&priceMin=${min}&priceMax=${max}&limit=50`);

      expect(items.length).toBeGreaterThan(0);
      expect(
        items.every((i) => i.salePriceCents !== null && i.salePriceCents >= min && i.salePriceCents <= max),
      ).toBe(true);
    });

    it('filtra aluguel pelo valor de aluguel, nunca pelo de venda', async () => {
      const min = 100_000;
      const max = 500_000;
      const { items } = await search(`purpose=rent&priceMin=${min}&priceMax=${max}&limit=50`);

      expect(items.length).toBeGreaterThan(0);
      expect(
        items.every((i) => i.rentPriceCents !== null && i.rentPriceCents >= min && i.rentPriceCents <= max),
      ).toBe(true);
    });

    it('recusa faixa de valor sem finalidade', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/network/search?priceMin=100000&limit=5',
        cookies,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().fields).toHaveProperty('purpose');
    });

    it('anuncio de venda e aluguel aparece nas duas finalidades, com os dois valores', async () => {
      const venda = await search('purpose=sale&limit=50');
      const aluguel = await search('purpose=rent&limit=50');

      expect(venda.items.every((i) => i.purpose === 'sale' || i.purpose === 'sale_rent')).toBe(true);
      expect(aluguel.items.every((i) => i.purpose === 'rent' || i.purpose === 'sale_rent')).toBe(true);

      const ambos = await withOracle(async (client) => {
        const { rows } = await client.query<{ listing_id: string }>(
          `SELECT listing_id FROM network_listings WHERE purpose = 'sale_rent'`,
        );
        return rows.map((r) => r.listing_id);
      });
      expect(ambos.length, 'o seed deveria ter anuncio de venda e aluguel na rede').toBeGreaterThan(0);

      const idsVenda = new Set(venda.items.map((i) => i.listingId));
      const idsAluguel = new Set(aluguel.items.map((i) => i.listingId));
      for (const id of ambos) {
        expect(idsVenda.has(id), `${id} fora da busca de venda`).toBe(true);
        expect(idsAluguel.has(id), `${id} fora da busca de aluguel`).toBe(true);
      }

      const exemplo = venda.items.find((i) => i.purpose === 'sale_rent')!;
      expect(exemplo.salePriceCents).not.toBeNull();
      expect(exemplo.rentPriceCents).not.toBeNull();
    });

    it('aceita tipos como lista separada por virgula', async () => {
      const { items } = await search('types=apartamento,casa&limit=50');
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => ['apartamento', 'casa'].includes(i.type))).toBe(true);
    });

    it('combina filtros de forma coerente', async () => {
      const { items } = await search('types=apartamento&bedroomsMin=2&areaBuiltMin=50&limit=50');
      expect(items.every((i) => i.type === 'apartamento' && i.bedrooms >= 2)).toBe(true);
    });
  });

  describe('anuncio aberto', () => {
    it('devolve o mesmo anuncio da lista, agora com a galeria', async () => {
      const { items } = await search('limit=50');
      const alvo = items.find((i) => !i.isOwn)!;

      const response = await app.inject({
        method: 'GET',
        url: `/network/listings/${alvo.listingId}`,
        cookies,
      });
      expect(response.statusCode).toBe(200);

      const listing = response.json().listing;
      expect(listing.listingId).toBe(alvo.listingId);
      expect(listing.neighborhood.id).toBe(alvo.neighborhood.id);
      expect(listing.isOwn).toBe(false);
      expect(Array.isArray(listing.media)).toBe(true);

      // A galeria bate com a contagem da lista, e cada foto e um id opaco.
      expect(listing.media.length).toBe(listing.photoCount);
      for (const media of listing.media) {
        expect(media.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(Object.keys(media).sort()).toEqual(['height', 'id', 'kind', 'position', 'width']);
      }
    });

    it('abrir o anuncio NAO revela nada a mais do dono', async () => {
      const { items } = await search('limit=50');
      const alvo = items.find((i) => !i.isOwn)!;

      const response = await app.inject({
        method: 'GET',
        url: `/network/listings/${alvo.listingId}`,
        cookies,
      });

      const forbidden: string[] = [];
      for (const tenant of fixture.tenants) {
        forbidden.push(tenant.id, tenant.legalName, tenant.displayName, tenant.slug);
        forbidden.push(...tenant.emails, ...tenant.names, ...tenant.phones);
      }
      expect(forbidden.filter((valor) => response.body.includes(valor))).toEqual([]);
      expect(response.body).not.toContain('tenant');
      expect(response.body).not.toContain('storage_key');
      expect(response.body).not.toContain('media/');

      // Nem texto livre, nem endereco.
      const sensiveis = await withOracle(async (client) => {
        const { rows } = await client.query<Record<string, string | null>>(
          `SELECT title, description, street, reference_code FROM properties WHERE id = $1`,
          [alvo.listingId],
        );
        return rows[0]!;
      });
      for (const [campo, valor] of Object.entries(sensiveis)) {
        if (typeof valor === 'string' && valor.length > 6) {
          expect(response.body.includes(valor), `${campo} vazou no detalhe`).toBe(false);
        }
      }
    });

    it('imovel fora da rede responde 404, como se nao existisse', async () => {
      const retido = await withOracle(async (client) => {
        const { rows } = await client.query<{ id: string }>(`
          SELECT id FROM properties
           WHERE deleted_at IS NOT NULL OR status <> 'active' OR NOT published_to_network
           LIMIT 1
        `);
        return rows[0]!.id;
      });

      for (const id of [retido, '11111111-1111-1111-1111-111111111111']) {
        const response = await app.inject({
          method: 'GET',
          url: `/network/listings/${id}`,
          cookies,
        });
        expect(response.statusCode, id).toBe(404);
      }
    });

    it('exige sessao', async () => {
      const { items } = await search('limit=5');
      const response = await app.inject({
        method: 'GET',
        url: `/network/listings/${items[0]!.listingId}`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('paginacao por keyset', () => {
    it('percorre todas as paginas sem repetir nem pular resultado', async () => {
      // Com OFFSET, um imovel cadastrado entre duas paginas empurraria a lista
      // e faria um resultado aparecer duas vezes ou sumir. Este teste existe
      // para que trocar keyset por OFFSET quebre o build.
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const query: string = `limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await search(query);
        expect(page.statusCode).toBe(200);
        seen.push(...page.items.map((i) => i.listingId));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 30);

      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(seen.length);

      const total = await withOracle(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM network_listings',
        );
        return Number(rows[0]!.count);
      });
      expect(seen.length).toBe(total);
    });

    it('ordena por preco crescente de forma estavel entre paginas', async () => {
      const first = await search('sort=price_asc&purpose=sale&limit=5');
      const second = await search(
        `sort=price_asc&purpose=sale&limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`,
      );

      const prices = [...first.items, ...second.items].map((i) => i.salePriceCents ?? Infinity);
      const sorted = [...prices].sort((a, b) => a - b);
      expect(prices).toEqual(sorted);

      const ids = [...first.items, ...second.items].map((i) => i.listingId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('recusa ordenar por preco sem separar venda de aluguel', async () => {
      // Venda e aluguel vivem em colunas distintas, e e a finalidade que diz
      // qual comparar. Sem ela, a ordenacao poria "R$ 5.250/mes" acima de
      // "R$ 617.000 a venda" -- nao e resultado ruim, e resultado errado.
      const response = await app.inject({
        method: 'GET',
        url: '/network/search?sort=price_asc&limit=5',
        cookies,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().fields).toHaveProperty('purpose');

      // Com a finalidade, funciona.
      const ok = await search('sort=price_asc&purpose=sale&limit=5');
      expect(ok.statusCode).toBe(200);
      expect(ok.items.length).toBeGreaterThan(0);
    });

    it('trata cursor invalido como primeira pagina, sem quebrar', async () => {
      const { statusCode, items } = await search('cursor=lixo-que-nao-decodifica&limit=5');
      expect(statusCode).toBe(200);
      expect(items.length).toBeGreaterThan(0);
    });
  });

  describe('marcacao dos proprios imoveis', () => {
    it('marca isOwn corretamente, sem revelar o dono dos demais', async () => {
      const { items } = await search('limit=50');

      const ownIds = await withOracle(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT p.id FROM properties p
             JOIN tenants t ON t.id = p.tenant_id
            WHERE t.slug = 'alfa-imoveis' AND p.deleted_at IS NULL`,
        );
        return new Set(rows.map((r: { id: string }) => r.id));
      });

      for (const item of items) {
        expect(item.isOwn, `isOwn errado em ${item.listingId}`).toBe(ownIds.has(item.listingId));
      }
      expect(items.some((i) => i.isOwn)).toBe(true);
      expect(items.some((i) => !i.isOwn)).toBe(true);
    });
  });
});
