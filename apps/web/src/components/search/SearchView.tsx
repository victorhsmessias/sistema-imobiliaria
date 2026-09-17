'use client';

import type { NetworkListing, SearchResult } from '@imob/contracts';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { apiFetch, ApiError } from '@/lib/api';
import { useCatalog } from '@/lib/catalog';
import { parseDecimal, parseMoneyToCents } from '@/lib/format';
import { SEARCH_TYPES, TYPE_LABELS, plural } from '@/lib/labels';
import { ListingRow, ListingRowSkeleton } from './ListingRow';
import { NeighborhoodPicker } from './NeighborhoodPicker';
import styles from './search.module.css';

type Purpose = 'sale' | 'rent' | 'any';
type Sort = 'recent' | 'price_asc' | 'price_desc';

interface Filters {
  neighborhoodIds: string[];
  purpose: Purpose;
  types: string[];
  bedroomsMin: number | null;
  areaMin: string;
  priceMin: string;
  priceMax: string;
  sort: Sort;
}

const DEFAULT_FILTERS: Filters = {
  neighborhoodIds: [],
  purpose: 'sale',
  types: [],
  bedroomsMin: null,
  areaMin: '',
  priceMin: '',
  priceMax: '',
  sort: 'recent',
};

// Parametros da URL em portugues: e o endereco que um corretor copia e manda.
const PURPOSE_PARAM: Record<Purpose, string> = { sale: 'venda', rent: 'aluguel', any: 'ambas' };
const SORT_PARAM: Record<Sort, string> = {
  recent: 'recentes',
  price_asc: 'menor-valor',
  price_desc: 'maior-valor',
};
const PURPOSE_LABEL: Record<Purpose, string> = { sale: 'Venda', rent: 'Aluguel', any: 'Ambas' };

function fromParam<T extends string>(map: Record<T, string>, value: string | null, fallback: T): T {
  const entry = (Object.entries(map) as Array<[T, string]>).find(([, param]) => param === value);
  return entry ? entry[0] : fallback;
}

function readFilters(params: URLSearchParams): Filters {
  const list = (key: string) => (params.get(key) ?? '').split(',').filter(Boolean);
  const purpose = fromParam<Purpose>(PURPOSE_PARAM, params.get('finalidade'), 'sale');
  const bedrooms = Number(params.get('quartos'));
  return {
    neighborhoodIds: list('bairros'),
    purpose,
    types: list('tipos'),
    bedroomsMin: Number.isInteger(bedrooms) && bedrooms > 0 ? bedrooms : null,
    areaMin: params.get('area') ?? '',
    priceMin: params.get('de') ?? '',
    priceMax: params.get('ate') ?? '',
    sort: purpose === 'any' ? 'recent' : fromParam<Sort>(SORT_PARAM, params.get('ordem'), 'recent'),
  };
}

function toUrl(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.neighborhoodIds.length) params.set('bairros', filters.neighborhoodIds.join(','));
  if (filters.purpose !== 'sale') params.set('finalidade', PURPOSE_PARAM[filters.purpose]);
  if (filters.types.length) params.set('tipos', filters.types.join(','));
  if (filters.bedroomsMin !== null) params.set('quartos', String(filters.bedroomsMin));
  if (filters.areaMin) params.set('area', filters.areaMin);
  if (filters.priceMin) params.set('de', filters.priceMin);
  if (filters.priceMax) params.set('ate', filters.priceMax);
  if (filters.sort !== 'recent') params.set('ordem', SORT_PARAM[filters.sort]);
  return params.toString();
}

type InvalidField = 'areaMin' | 'priceMin' | 'priceMax';

function toApiQuery(filters: Filters, cityId: string) {
  const params = new URLSearchParams({ cityId, sort: filters.sort, limit: '20' });
  const invalid: Partial<Record<InvalidField, string>> = {};

  if (filters.neighborhoodIds.length > 0) {
    params.set('neighborhoodIds', filters.neighborhoodIds.join(','));
  }

  if (filters.purpose !== 'any') params.set('purpose', filters.purpose);
  if (filters.types.length > 0) params.set('types', filters.types.join(','));
  if (filters.bedroomsMin !== null) params.set('bedroomsMin', String(filters.bedroomsMin));

  const area = parseDecimal(filters.areaMin);
  if (area !== null) {
    if (Number.isNaN(area)) invalid.areaMin = 'Use só números, como 80.';
    else params.set('areaBuiltMin', String(area));
  }

  // Venda e aluguel tem valores em colunas distintas: sem finalidade, a API
  // recusa faixa de valor, e a tela nem manda.
  const min = filters.purpose === 'any' ? null : parseMoneyToCents(filters.priceMin);
  const max = filters.purpose === 'any' ? null : parseMoneyToCents(filters.priceMax);
  if (min !== null) {
    if (Number.isNaN(min)) invalid.priceMin = 'Use só números, como 450.000.';
    else params.set('priceMin', String(min));
  }
  if (max !== null) {
    if (Number.isNaN(max)) invalid.priceMax = 'Use só números, como 900.000.';
    else if (min !== null && !Number.isNaN(min) && max < min) {
      invalid.priceMax = 'O valor máximo está abaixo do mínimo.';
    } else params.set('priceMax', String(max));
  }

  return { query: params.toString(), invalid };
}

export function SearchView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { catalog, error: catalogError } = useCatalog();

  const [filters, setFilters] = useState<Filters>(() =>
    readFilters(new URLSearchParams(searchParams.toString())),
  );
  const [items, setItems] = useState<NetworkListing[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [requestingId, setRequestingId] = useState<string | null>(null);

  const update = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  const urlQuery = useMemo(() => toUrl(filters), [filters]);
  useEffect(() => {
    // replaceState, e nao router.replace: mudar filtro nao deve refazer a
    // renderizacao do servidor nem empilhar historico a cada tecla.
    window.history.replaceState(null, '', urlQuery ? `${pathname}?${urlQuery}` : pathname);
  }, [urlQuery, pathname]);

  const apiQuery = useMemo(
    () => (catalog ? toApiQuery(filters, catalog.city.id) : null),
    [filters, catalog],
  );
  const invalid = apiQuery?.invalid ?? {};
  const hasInvalid = Object.keys(invalid).length > 0;
  const queryString = apiQuery?.query ?? null;

  useEffect(() => {
    if (!queryString || hasInvalid) return;

    // Cada mudanca de filtro cancela a busca anterior. Sem isso, uma resposta
    // lenta de um filtro velho poderia chegar depois e sobrescrever a lista.
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      const startedAt = performance.now();
      try {
        const result = await apiFetch<SearchResult>(`/network/search?${queryString}`, {
          signal: controller.signal,
        });
        setItems(result.items);
        setCursor(result.nextCursor);
        setElapsedMs(Math.round(performance.now() - startedAt));
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof ApiError ? reason.message : 'Não foi possível buscar agora.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [queryString, hasInvalid]);

  async function loadMore() {
    if (!cursor || !queryString) return;
    setLoadingMore(true);
    try {
      const result = await apiFetch<SearchResult>(
        `/network/search?${queryString}&cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((current) => [...current, ...result.items]);
      setCursor(result.nextCursor);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível carregar mais.');
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Pede conexao sem sair da busca.
   *
   * A lista e atualizada no lugar: recarregar a pagina inteira faria o
   * corretor perder a posicao no resultado.
   */
  async function requestConnection(listingId: string) {
    setRequestingId(listingId);
    setError(null);
    try {
      const { connection } = await apiFetch<{ connection: { id: string; status: 'pending' } }>(
        '/connections',
        { method: 'POST', body: JSON.stringify({ listingId }) },
      );
      setItems((current) =>
        current.map((item) =>
          item.listingId === listingId
            ? { ...item, connection: { id: connection.id, status: connection.status } }
            : item,
        ),
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível pedir conexão agora.');
    } finally {
      setRequestingId(null);
    }
  }

  function setPurpose(purpose: Purpose) {
    setFilters((current) => ({
      ...current,
      purpose,
      // Aluguel e venda dividem a mesma coluna de valor: ordenar os dois
      // juntos por preco poria um aluguel acima de uma venda.
      sort: purpose === 'any' ? 'recent' : current.sort,
    }));
  }

  function toggleType(type: string) {
    setFilters((current) => ({
      ...current,
      types: current.types.includes(type)
        ? current.types.filter((t) => t !== type)
        : [...current.types, type],
    }));
  }

  const activeCount = [
    filters.neighborhoodIds.length > 0,
    filters.purpose !== 'sale',
    filters.types.length > 0,
    filters.bedroomsMin !== null,
    filters.areaMin !== '',
    filters.priceMin !== '' || filters.priceMax !== '',
  ].filter(Boolean).length;

  const neighborhoodHint =
    filters.neighborhoodIds.length > 0
      ? 'A busca fica restrita aos bairros escolhidos.'
      : 'Digite parte do nome, com ou sem acento. Sem bairro, a busca cobre a cidade inteira.';

  const firstLoad = loading && items.length === 0 && !error && !hasInvalid;

  return (
    <div className={styles.layout}>
      <aside className={styles.filters} aria-label="Filtros da busca">
        <div className={styles.filtersHead}>
          <h2 className={`section-title ${styles.filtersTitle}`}>
            Filtros
            {activeCount > 0 && <span className={`num ${styles.count}`}>{activeCount}</span>}
          </h2>
          {activeCount > 0 && (
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => setFilters(DEFAULT_FILTERS)}
            >
              Limpar filtros
            </button>
          )}
        </div>

        <button
          type="button"
          className={`btn ${styles.filtersToggle}`}
          aria-expanded={filtersOpen}
          aria-controls="search-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <Icon name="sliders" />
          {filtersOpen ? 'Fechar filtros' : activeCount > 0 ? `Filtros (${activeCount})` : 'Filtros'}
        </button>

        <form
          id="search-filters"
          className={`${styles.filterBody} ${filtersOpen ? styles.open : ''}`}
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="field">
            <label htmlFor="bairro-input">Bairro</label>
            {catalog ? (
              <NeighborhoodPicker
                inputId="bairro-input"
                neighborhoods={catalog.neighborhoods}
                selectedIds={filters.neighborhoodIds}
                onChange={(neighborhoodIds) => update({ neighborhoodIds })}
                describedBy="bairro-hint"
              />
            ) : (
              <input id="bairro-input" className="input" disabled placeholder="Carregando bairros…" />
            )}
            <p id="bairro-hint" className="hint">
              {neighborhoodHint}
            </p>
          </div>

          <fieldset className={styles.group}>
            <legend className="field-label">Finalidade</legend>
            <div className="segmented">
              {(['sale', 'rent', 'any'] as const).map((purpose) => (
                <label key={purpose}>
                  <input
                    type="radio"
                    name="purpose"
                    checked={filters.purpose === purpose}
                    onChange={() => setPurpose(purpose)}
                  />
                  <span>{PURPOSE_LABEL[purpose]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.group}>
            <legend className="field-label">Tipo</legend>
            <div className={styles.chips}>
              {SEARCH_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="toggle-chip"
                  aria-pressed={filters.types.includes(type)}
                  onClick={() => toggleType(type)}
                >
                  {TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.group}>
            <legend className="field-label">Quartos</legend>
            <div className="segmented">
              {[null, 1, 2, 3, 4].map((count) => (
                <label key={String(count)}>
                  <input
                    type="radio"
                    name="bedrooms"
                    checked={filters.bedroomsMin === count}
                    onChange={() => update({ bedroomsMin: count })}
                  />
                  <span className="num">{count === null ? 'Qualquer' : `${count}+`}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor="area-min">Área construída mínima</label>
            <div className={styles.affix}>
              <input
                id="area-min"
                className="input num"
                inputMode="decimal"
                placeholder="Qualquer"
                value={filters.areaMin}
                onChange={(event) => update({ areaMin: event.target.value })}
                aria-invalid={invalid.areaMin ? true : undefined}
                aria-describedby={invalid.areaMin ? 'area-min-error' : undefined}
              />
              <span aria-hidden="true">m²</span>
            </div>
            {invalid.areaMin && (
              <p id="area-min-error" className="error-text">
                {invalid.areaMin}
              </p>
            )}
          </div>

          <fieldset className={styles.group}>
            <legend className="field-label">
              {filters.purpose === 'rent'
                ? 'Aluguel por mês'
                : filters.purpose === 'sale'
                  ? 'Valor de venda'
                  : 'Valor'}
            </legend>
            <div className={styles.range}>
              <div className={styles.affix}>
                <span aria-hidden="true">R$</span>
                <input
                  id="price-min"
                  className="input num"
                  inputMode="numeric"
                  placeholder="Mínimo"
                  aria-label="Valor mínimo"
                  disabled={filters.purpose === 'any'}
                  value={filters.priceMin}
                  onChange={(event) => update({ priceMin: event.target.value })}
                  aria-invalid={invalid.priceMin ? true : undefined}
                />
              </div>
              <div className={styles.affix}>
                <span aria-hidden="true">R$</span>
                <input
                  id="price-max"
                  className="input num"
                  inputMode="numeric"
                  placeholder="Máximo"
                  aria-label="Valor máximo"
                  disabled={filters.purpose === 'any'}
                  value={filters.priceMax}
                  onChange={(event) => update({ priceMax: event.target.value })}
                  aria-invalid={invalid.priceMax ? true : undefined}
                />
              </div>
            </div>
            {filters.purpose === 'any' && (
              <p className="hint">Escolha venda ou aluguel para filtrar por valor.</p>
            )}
            {(invalid.priceMin || invalid.priceMax) && (
              <p className="error-text" role="alert">
                {invalid.priceMin ?? invalid.priceMax}
              </p>
            )}
          </fieldset>
        </form>
      </aside>

      <section className={styles.results} aria-labelledby="results-title">
        <header className={styles.resultsHead}>
          <h1 id="results-title" className="page-title">
            Imóveis na rede
          </h1>
          <p className="lead">Carteira de todos os parceiros, sem identificar quem anuncia.</p>
        </header>

        <div className={styles.toolbar}>
          <p className={styles.status} role="status" aria-live="polite">
            {firstLoad ? (
              'Buscando imóveis…'
            ) : items.length > 0 ? (
              <>
                <span>
                  <strong className="num">{items.length}</strong>{' '}
                  {items.length === 1 ? 'imóvel' : 'imóveis'}
                  {cursor ? ', e há mais na rede' : ''}
                </span>
                {elapsedMs !== null && !loading && (
                  <span className={`num ${styles.elapsed}`}>em {elapsedMs} ms</span>
                )}
              </>
            ) : null}
          </p>

          <div className={styles.sort}>
            <label htmlFor="sort">Ordenar por</label>
            <select
              id="sort"
              className="input"
              value={filters.sort}
              onChange={(event) => update({ sort: event.target.value as Sort })}
              aria-describedby={filters.purpose === 'any' ? 'sort-hint' : undefined}
            >
              <option value="recent">Mais recentes</option>
              <option value="price_asc" disabled={filters.purpose === 'any'}>
                Menor valor
              </option>
              <option value="price_desc" disabled={filters.purpose === 'any'}>
                Maior valor
              </option>
            </select>
          </div>
          {filters.purpose === 'any' && (
            <p id="sort-hint" className={`hint ${styles.sortHint}`}>
              Escolha venda ou aluguel para ordenar por valor.
            </p>
          )}
        </div>

        {catalogError && (
          <p className="alert" role="alert">
            {catalogError}
          </p>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        {firstLoad && (
          <ul className={styles.list}>
            {Array.from({ length: 5 }, (_, index) => (
              <ListingRowSkeleton key={index} />
            ))}
          </ul>
        )}

        {!loading && !error && items.length === 0 && (
          <div className={styles.empty}>
            <Icon name="search" size={40} />
            <p className="section-title">Nenhum imóvel na rede com esses filtros</p>
            <p className="hint">Tente incluir bairros vizinhos ou ampliar a faixa de valor.</p>
            {activeCount > 0 && (
              <button type="button" className="btn" onClick={() => setFilters(DEFAULT_FILTERS)}>
                Limpar filtros
              </button>
            )}
          </div>
        )}

        {items.length > 0 && (
          <ul className={`${styles.list} ${loading ? styles.stale : ''}`} aria-busy={loading}>
            {items.map((listing) => (
              <ListingRow
                key={listing.listingId}
                listing={listing}
                pricePurpose={filters.purpose === 'any' ? undefined : filters.purpose}
                searchQuery={urlQuery}
                onRequestConnection={(id) => void requestConnection(id)}
                requesting={requestingId === listing.listingId}
              />
            ))}
          </ul>
        )}

        {cursor && !loading && (
          <button
            type="button"
            className={`btn ${styles.more}`}
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? 'Carregando…' : 'Mostrar mais imóveis'}
          </button>
        )}
        {!cursor && !loading && items.length > 0 && (
          <p className={`hint ${styles.more}`}>
            {plural(items.length, 'imóvel', 'imóveis')} com esses filtros. Fim da lista.
          </p>
        )}
      </section>
    </div>
  );
}
