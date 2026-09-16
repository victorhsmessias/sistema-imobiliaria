'use client';

import type {
  ImportItemDto,
  ImportItemStatus,
  ImportJobDto,
  ImportSourceDto,
} from '@imob/contracts';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Icon } from '@/components/Icon';
import { NeighborhoodPicker } from '@/components/search/NeighborhoodPicker';
import { useSession } from '@/components/SessionProvider';
import { apiFetch, ApiError } from '@/lib/api';
import { useCatalog } from '@/lib/catalog';
import styles from './imports.module.css';

/**
 * Importação de carteira por XML VrSync.
 *
 * A tela existe para o parceiro fazer sozinho o que hoje só a API faz: cadastrar
 * o feed, simular, ver o que mudaria e resolver os bairros que o catálogo não
 * reconheceu. Simular é o padrão — gravar exige um segundo clique.
 */

const STATUS_LABELS: Record<ImportItemStatus, string> = {
  created: 'Criados',
  updated: 'Atualizados',
  unchanged: 'Sem mudança',
  archived: 'Arquivados',
  skipped: 'Ignorados',
  needs_curation: 'Precisam de curadoria',
  failed: 'Com erro',
};

const STAT_ORDER: Array<{ key: keyof ImportJobDto['stats']; label: string }> = [
  { key: 'listings', label: 'Anúncios no feed' },
  { key: 'created', label: 'Criados' },
  { key: 'updated', label: 'Atualizados' },
  { key: 'unchanged', label: 'Sem mudança' },
  { key: 'archived', label: 'Arquivados' },
  { key: 'needsCuration', label: 'Curadoria' },
  { key: 'failed', label: 'Com erro' },
  { key: 'photosDownloaded', label: 'Fotos baixadas' },
  { key: 'photosReused', label: 'Fotos reaproveitadas' },
  { key: 'photosFailed', label: 'Fotos com falha' },
];

/** O bairro e a zona como vieram no XML, para orientar a curadoria. */
function fromFeed(raw: unknown): { neighborhood: string | null; zone: string | null; city: string | null } {
  const location =
    typeof raw === 'object' && raw !== null
      ? ((raw as Record<string, unknown>).location as Record<string, unknown> | undefined)
      : undefined;
  const text = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null) {
      const inner = (value as Record<string, unknown>)['#text'];
      return typeof inner === 'string' ? inner : null;
    }
    return null;
  };
  return {
    neighborhood: text(location?.neighborhood),
    zone: text(location?.zone),
    city: text(location?.city),
  };
}

export function ImportsView() {
  const { user } = useSession();
  const { catalog } = useCatalog();

  const [sources, setSources] = useState<ImportSourceDto[] | null>(null);
  const [job, setJob] = useState<ImportJobDto | null>(null);
  const [items, setItems] = useState<ImportItemDto[]>([]);
  const [filter, setFilter] = useState<ImportItemStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [curating, setCurating] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingSourceId, setPendingSourceId] = useState<string | null>(null);

  const isAdmin = user.role === 'partner_admin';

  const loadSources = useCallback(async () => {
    try {
      const { sources } = await apiFetch<{ sources: ImportSourceDto[] }>('/imports/sources');
      setSources(sources);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível carregar os feeds.');
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void loadSources();
  }, [isAdmin, loadSources]);

  const loadItems = useCallback(async (jobId: string, status: ImportItemStatus | '') => {
    const query = status ? `?status=${status}` : '';
    const { items } = await apiFetch<{ items: ImportItemDto[] }>(`/imports/jobs/${jobId}/items${query}`);
    setItems(items);
  }, []);

  /** Acompanha a execução até o fim: ela roda fora do ciclo da requisição. */
  const follow = useCallback(
    async (jobId: string) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const { job } = await apiFetch<{ job: ImportJobDto }>(`/imports/jobs/${jobId}`);
        setJob(job);
        if (job.status === 'succeeded' || job.status === 'failed') {
          await loadItems(jobId, '');
          setFilter('');
          return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    },
    [loadItems],
  );

  async function createSource(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/imports/sources', {
        method: 'POST',
        body: JSON.stringify({ name, feedUrl: feedUrl.trim() === '' ? null : feedUrl.trim() }),
      });
      setName('');
      setFeedUrl('');
      setNotice('Feed cadastrado.');
      await loadSources();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível cadastrar o feed.');
    } finally {
      setBusy(false);
    }
  }

  async function runFromUrl(sourceId: string, dryRun: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setItems([]);
    try {
      const { job } = await apiFetch<{ job: ImportJobDto }>(
        `/imports/sources/${sourceId}/jobs?dryRun=${dryRun}`,
        { method: 'POST' },
      );
      setJob(job);
      await follow(job.id);
      await loadSources();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível iniciar a importação.');
    } finally {
      setBusy(false);
    }
  }

  async function runFromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !pendingSourceId) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    setItems([]);
    try {
      // Os bytes vão crus: o encoding vem no prolog do XML, e converter para
      // texto aqui estragaria acento de arquivo ISO-8859-1.
      const { job } = await apiFetch<{ job: ImportJobDto }>(
        `/imports/sources/${pendingSourceId}/upload?dryRun=true`,
        { method: 'POST', body: file, headers: { 'Content-Type': 'application/xml' } },
      );
      setJob(job);
      await follow(job.id);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível ler o arquivo.');
    } finally {
      setPendingSourceId(null);
      setBusy(false);
    }
  }

  async function changeFilter(status: ImportItemStatus | '') {
    if (!job) return;
    setFilter(status);
    try {
      await loadItems(job.id, status);
    } catch {
      setError('Não foi possível carregar os itens.');
    }
  }

  /** Curadoria: liga a grafia do feed ao bairro escolhido. */
  async function createAlias(item: ImportItemDto) {
    const neighborhoodId = curating[item.id];
    const grafia = fromFeed(item.rawPayload).neighborhood;
    if (!neighborhoodId || !grafia) return;

    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/catalog/neighborhoods/${neighborhoodId}/aliases`, {
        method: 'POST',
        body: JSON.stringify({ alias: grafia }),
      });
      setNotice(`"${grafia}" ligado ao bairro. Rode a importação de novo para aplicar.`);
      setCurating((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível criar a grafia.');
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    return (
      <div className={styles.page}>
        <h1 className="page-title">Importação</h1>
        <p className="alert" role="alert">
          A importação de carteira é feita pelo administrador da sua imobiliária.
        </p>
      </div>
    );
  }

  const running = job?.status === 'queued' || job?.status === 'running';

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className="page-title">Importação de carteira</h1>
        <p className="lead">
          Arquivo ou link no padrão XML VrSync (ZAP, VivaReal, OLX). As fotos vêm no próprio
          arquivo e são re-hospedadas sem metadados.
        </p>
      </header>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className={styles.notice}>{notice}</p>}

      <section className={styles.card}>
        <h2 className="section-title">Feeds</h2>

        <ul className={styles.sources}>
          {(sources ?? []).map((source) => (
            <li key={source.id} className={styles.source}>
              <div>
                <strong>{source.name}</strong>
                <span className="hint">
                  {source.feedUrl ?? 'Sem URL: envie o arquivo XML'}
                  {source.lastRunAt && ` · última execução em ${new Date(source.lastRunAt).toLocaleDateString('pt-BR')}`}
                </span>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setPendingSourceId(source.id);
                    fileInput.current?.click();
                  }}
                >
                  Simular com arquivo
                </button>
                {source.feedUrl && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void runFromUrl(source.id, true)}
                    >
                      Simular pela URL
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => void runFromUrl(source.id, false)}
                    >
                      Importar de verdade
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
          {sources !== null && sources.length === 0 && (
            <li className="hint">Nenhum feed cadastrado ainda.</li>
          )}
        </ul>

        <input
          ref={fileInput}
          type="file"
          accept=".xml,application/xml,text/xml"
          hidden
          onChange={(event) => void runFromFile(event)}
        />

        <form className={styles.newSource} onSubmit={(event) => void createSource(event)}>
          <div className="field">
            <label htmlFor="source-name">Nome do feed</label>
            <input
              id="source-name"
              className="input"
              required
              maxLength={120}
              placeholder="Ex.: Feed do nosso CRM"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="source-url">URL (opcional)</label>
            <input
              id="source-url"
              className="input"
              type="url"
              placeholder="https://…/vrsync.xml"
              value={feedUrl}
              onChange={(event) => setFeedUrl(event.target.value)}
            />
          </div>
          <button type="submit" className="btn" disabled={busy || name.trim() === ''}>
            Cadastrar feed
          </button>
        </form>
      </section>

      {job && (
        <section className={styles.card}>
          <div className={styles.jobHead}>
            <h2 className="section-title">
              {job.dryRun ? 'Simulação' : 'Importação'}
              {running && ' em andamento…'}
            </h2>
            <span className={job.status === 'failed' ? 'badge badge-warn' : 'badge badge-ok'}>
              {job.status === 'failed' ? 'Falhou' : running ? 'Rodando' : 'Concluída'}
            </span>
          </div>

          {job.error && (
            <p className="alert" role="alert">
              {job.error}
            </p>
          )}

          {job.dryRun && !running && job.status === 'succeeded' && (
            <p className="hint">
              Nada foi gravado. Confira o resultado e use “Importar de verdade” quando estiver certo.
            </p>
          )}

          <dl className={styles.stats}>
            {STAT_ORDER.filter(({ key }) => (job.stats[key] ?? 0) > 0).map(({ key, label }) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd className="num">{job.stats[key]}</dd>
              </div>
            ))}
          </dl>

          {items.length > 0 && (
            <>
              <div className={styles.filters}>
                <button
                  type="button"
                  className="toggle-chip"
                  aria-pressed={filter === ''}
                  onClick={() => void changeFilter('')}
                >
                  Todos
                </button>
                {(Object.keys(STATUS_LABELS) as ImportItemStatus[]).map((status) => (
                  <button
                    key={status}
                    type="button"
                    className="toggle-chip"
                    aria-pressed={filter === status}
                    onClick={() => void changeFilter(status)}
                  >
                    {STATUS_LABELS[status]}
                  </button>
                ))}
              </div>

              <ul className={styles.items}>
                {items.map((item) => {
                  const feed = fromFeed(item.rawPayload);
                  const changes = Object.entries(item.changes);

                  return (
                    <li key={item.id} className={styles.item}>
                      <div className={styles.itemHead}>
                        <strong className="num">{item.externalId ?? 'sem ListingID'}</strong>
                        <span className="badge badge-outline">{STATUS_LABELS[item.status]}</span>
                      </div>

                      {changes.length > 0 && (
                        <ul className={styles.changes}>
                          {changes.map(([field, change]) => (
                            <li key={field}>
                              <span className={styles.field}>{field}</span>
                              <span className={styles.from}>{String(change.from ?? '—')}</span>
                              <Icon name="check" size={12} />
                              <span>{String(change.to ?? '—')}</span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {item.errors.map((message) => (
                        <p key={message} className={styles.itemError}>
                          {message}
                        </p>
                      ))}
                      {item.warnings.map((message) => (
                        <p key={message} className="hint">
                          {message}
                        </p>
                      ))}

                      {/* Curadoria: o feed trouxe um bairro que o catálogo não conhece. */}
                      {item.status === 'needs_curation' && feed.neighborhood && catalog && (
                        <div className={styles.curation}>
                          <p className={styles.curationHead}>
                            No feed: <strong>{feed.neighborhood}</strong>
                            {feed.city && ` · ${feed.city}`}
                            {feed.zone && ` · zona informada: ${feed.zone}`}
                          </p>
                          <p className="hint">
                            Escolha o bairro do catálogo que corresponde a essa grafia.
                          </p>
                          <NeighborhoodPicker
                            inputId={`curadoria-${item.id}`}
                            neighborhoods={catalog.neighborhoods}
                            selectedIds={curating[item.id] ? [curating[item.id]!] : []}
                            onChange={(ids) =>
                              setCurating((current) => ({ ...current, [item.id]: ids[0] ?? '' }))
                            }
                            single
                          />
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={busy || !curating[item.id]}
                            onClick={() => void createAlias(item)}
                          >
                            Ligar grafia ao bairro
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
