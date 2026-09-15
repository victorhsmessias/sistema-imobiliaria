'use client';

import type { PropertyListItem, PropertyStatus } from '@imob/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { apiFetch, ApiError } from '@/lib/api';
import { formatDate, formatPrice } from '@/lib/format';
import { STATUS_BADGE, STATUS_LABELS, TYPE_LABELS, plural } from '@/lib/labels';
import styles from './property.module.css';

const PAGE_SIZE = 30;

interface ListResponse {
  items: PropertyListItem[];
  total: number;
}

export function PortfolioView() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<PropertyStatus | ''>('');
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const hasFilter = search.trim() !== '' || status !== '';

  function buildQuery(offset: number): string {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (status) params.set('status', status);
    if (search.trim()) params.set('q', search.trim());
    return params.toString();
  }

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setError(null);
      try {
        const response = await apiFetch<ListResponse>(`/properties?${buildQuery(0)}`, {
          signal: controller.signal,
        });
        setData(response);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof ApiError ? reason.message : 'Não foi possível carregar a carteira.');
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // buildQuery le search e status, que ja estao nas dependencias.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status]);

  async function loadMore() {
    if (!data) return;
    setLoadingMore(true);
    try {
      const response = await apiFetch<ListResponse>(`/properties?${buildQuery(data.items.length)}`);
      setData({ items: [...data.items, ...response.items], total: response.total });
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível carregar mais.');
    } finally {
      setLoadingMore(false);
    }
  }

  const empty = data !== null && data.items.length === 0;

  return (
    <div className={styles.portfolio}>
      <header className={styles.portfolioHead}>
        <div className={styles.titleBlock}>
          <h1 className="page-title">Minha carteira</h1>
          <p className="lead">
            Só imóveis ativos e publicados aparecem na busca dos parceiros.
          </p>
        </div>
        <Link href="/carteira/novo" className="btn btn-primary">
          <Icon name="plus" />
          Cadastrar imóvel
        </Link>
      </header>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className={styles.tableCard}>
        <div className={styles.toolbar}>
          <div className={styles.searchBox}>
            <Icon name="search" />
            <label htmlFor="portfolio-search" className="visually-hidden">
              Buscar na carteira
            </label>
            <input
              id="portfolio-search"
              className="input"
              type="search"
              placeholder="Buscar por título ou código interno"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <label htmlFor="portfolio-status" className="visually-hidden">
            Status
          </label>
          <select
            id="portfolio-status"
            className={`input ${styles.statusSelect}`}
            value={status}
            onChange={(event) => setStatus(event.target.value as PropertyStatus | '')}
          >
            <option value="">Todos os status</option>
            {(Object.keys(STATUS_LABELS) as PropertyStatus[]).map((key) => (
              <option key={key} value={key}>
                {STATUS_LABELS[key]}
              </option>
            ))}
          </select>
          <span className={`num ${styles.toolbarCount}`} role="status">
            {data === null
              ? 'Carregando…'
              : hasFilter
                ? plural(data.total, 'imóvel encontrado', 'imóveis encontrados')
                : plural(data.total, 'imóvel cadastrado', 'imóveis cadastrados')}
          </span>
        </div>

        {empty && !hasFilter && (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              <Icon name="plus" size={20} />
            </span>
            <p className="section-title">Nenhum imóvel na sua carteira ainda</p>
            <p className="hint">Cadastre o primeiro para ele aparecer na busca dos parceiros.</p>
            <Link href="/carteira/novo" className="btn btn-primary">
              Cadastrar imóvel
            </Link>
          </div>
        )}

        {empty && hasFilter && (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              <Icon name="search" size={20} />
            </span>
            <p className="section-title">Nenhum imóvel encontrado com esse filtro</p>
            <p className="hint">Confira a grafia do código ou escolha outro status.</p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setSearch('');
                setStatus('');
              }}
            >
              Limpar filtro
            </button>
          </div>
        )}

        {(data === null || data.items.length > 0) && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Imóvel</th>
                  <th scope="col">Bairro</th>
                  <th scope="col" className={styles.right}>
                    Valor
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Na rede</th>
                  <th scope="col" className={`${styles.hideSmall} ${styles.right}`}>
                    Atualizado
                  </th>
                </tr>
              </thead>
              <tbody aria-busy={data === null}>
                {data === null &&
                  Array.from({ length: 6 }, (_, index) => (
                    <tr key={index} aria-hidden="true">
                      <td>
                        <span className="skeleton" style={{ width: 260, height: 14 }} />
                        <span className="skeleton" style={{ width: 120, height: 11, marginTop: 6 }} />
                      </td>
                      <td>
                        <span className="skeleton" style={{ width: 130, height: 14 }} />
                      </td>
                      <td>
                        <span className="skeleton" style={{ width: 90, height: 14, marginLeft: 'auto' }} />
                      </td>
                      <td>
                        <span className="skeleton" style={{ width: 56, height: 18 }} />
                      </td>
                      <td>
                        <span className="skeleton" style={{ width: 64, height: 14 }} />
                      </td>
                      <td className={styles.hideSmall}>
                        <span className="skeleton" style={{ width: 52, height: 14, marginLeft: 'auto' }} />
                      </td>
                    </tr>
                  ))}

                {data?.items.map((item) => {
                  const visible = item.status === 'active' && item.publishedToNetwork;
                  return (
                    <tr key={item.id}>
                      <td className={styles.titleCell}>
                        <Link href={`/carteira/${item.id}`} className={styles.titleLink} title={item.title}>
                          {item.title}
                        </Link>
                        <span className={styles.subline}>
                          {TYPE_LABELS[item.type]}
                          {item.referenceCode && <span className={styles.code}>{item.referenceCode}</span>}
                        </span>
                      </td>
                      <td>{item.neighborhood.name}</td>
                      <td className={`num ${styles.right} ${styles.priceCell}`}>
                        {item.purpose === 'rent'
                          ? formatPrice(item.rentPriceCents, 'rent')
                          : formatPrice(item.salePriceCents, 'sale')}
                      </td>
                      <td>
                        <span className={STATUS_BADGE[item.status]}>{STATUS_LABELS[item.status]}</span>
                      </td>
                      <td>
                        <span className={`${styles.net} ${visible ? styles.netOn : styles.netOff}`}>
                          <Icon name={visible ? 'network' : 'lock'} size={14} />
                          {visible ? 'Visível' : 'Fora da rede'}
                        </span>
                      </td>
                      <td className={`num ${styles.hideSmall} ${styles.muted} ${styles.right}`}>
                        {formatDate(item.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data && data.items.length > 0 && (
          <div className={styles.cardFoot}>
            <p className="hint num">
              Mostrando {data.items.length} de {data.total}
            </p>
            {data.items.length < data.total && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? 'Carregando…' : 'Mostrar mais imóveis'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
