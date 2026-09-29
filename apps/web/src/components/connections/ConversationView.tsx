'use client';

import type { ConnectionDto, ConnectionEventDto, ConnectionMessageDto } from '@imob/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { formatArea } from '@/lib/format';
import { CONNECTION_BADGE, CONNECTION_LABELS, TYPE_LABELS, plural } from '@/lib/labels';
import { connectionPrice } from './price';
import styles from './conversation.module.css';

/** Nao e chat em tempo real: 15 s bastam para combinar visita e proposta. */
const POLL_MS = 15_000;

interface Detail {
  connection: ConnectionDto;
  events: ConnectionEventDto[];
}

interface MessagesResponse {
  items: ConnectionMessageDto[];
  hasMore: boolean;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Ordem da conversa. O servidor desempata por id; aqui o mesmo criterio. */
function byTime(a: ConnectionMessageDto, b: ConnectionMessageDto): number {
  return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);
}

export function ConversationView({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [messages, setMessages] = useState<ConnectionMessageDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [maskedNotice, setMaskedNotice] = useState(false);
  const lastId = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const markRead = useCallback(() => {
    void apiFetch<void>(`/connections/${id}/read`, { method: 'POST' }).catch(() => undefined);
  }, [id]);

  /**
   * Junta mensagens novas sem duplicar nem desordenar: a atualizacao
   * periodica e o envio podem trazer a mesma mensagem ao mesmo tempo.
   */
  const merge = useCallback((incoming: ConnectionMessageDto[]) => {
    if (incoming.length === 0) return;
    setMessages((current) => {
      const known = new Set(current.map((m) => m.id));
      const merged = [...current, ...incoming.filter((m) => !known.has(m.id))].sort(byTime);
      lastId.current = merged[merged.length - 1]?.id ?? null;
      return merged;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [loaded, first] = await Promise.all([
          apiFetch<Detail>(`/connections/${id}`),
          apiFetch<MessagesResponse>(`/connections/${id}/messages`),
        ]);
        if (!alive) return;
        setDetail(loaded);
        merge(first.items);
        markRead();
      } catch (reason) {
        if (alive) setError(reason instanceof ApiError ? reason.message : 'Não foi possível abrir a conexão.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, merge, markRead]);

  const loadNew = useCallback(async () => {
    const query = lastId.current ? `?after=${lastId.current}` : '';
    try {
      const { items } = await apiFetch<MessagesResponse>(`/connections/${id}/messages${query}`);
      if (items.length > 0) {
        merge(items);
        markRead();
      }
    } catch {
      // A proxima volta tenta de novo; nao vale interromper quem esta lendo.
    }
  }, [id, merge, markRead]);

  // Atualizacao periodica, so com a aba visivel.
  useEffect(() => {
    if (detail === null) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void loadNew();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [detail, loadNew]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  // FormEvent (botao) ou KeyboardEvent (Ctrl+Enter): os dois sao SyntheticEvent.
  async function send(event: React.SyntheticEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await apiFetch<{ message: ConnectionMessageDto; masked: boolean }>(
        `/connections/${id}/messages`,
        { method: 'POST', body: JSON.stringify({ body }) },
      );
      merge([result.message]);
      setMaskedNotice(result.masked);
      setDraft('');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível enviar agora.');
    } finally {
      setSending(false);
    }
  }

  if (detail === null) {
    return (
      <div className={styles.page}>
        <Link href="/conexoes" className={styles.back}>
          ← Conexões
        </Link>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : (
          <p className="hint">Carregando…</p>
        )}
      </div>
    );
  }

  const { connection } = detail;
  const { listing } = connection;
  const other = connection.counterpart?.partnerName ?? 'Parceiro da rede';
  const hasConversation = connection.status === 'approved' || connection.status === 'revoked';

  return (
    <div className={styles.page}>
      <Link href="/conexoes" className={styles.back}>
        ← Conexões
      </Link>

      <header className={styles.head}>
        <div className={styles.title}>
          <h1 className="page-title">{listing.neighborhoodName}</h1>
          <p className={styles.specs}>
            {TYPE_LABELS[listing.type]}
            {listing.bedrooms > 0 && ` · ${plural(listing.bedrooms, 'quarto', 'quartos')}`}
            {listing.areaBuilt !== null && ` · ${formatArea(listing.areaBuilt)}`}
            {' · '}
            <strong className="num">{connectionPrice(listing)}</strong>
          </p>
          <p className={styles.with}>
            {connection.role === 'owner' ? 'Pedido de ' : 'Imóvel de '}
            <strong>{other}</strong>
          </p>
        </div>
        <span className={CONNECTION_BADGE[connection.status]}>{CONNECTION_LABELS[connection.status]}</span>
      </header>

      {connection.status === 'pending' && (
        <p className="hint">A conversa abre quando quem anuncia aprovar o pedido.</p>
      )}
      {!hasConversation && connection.status !== 'pending' && (
        <p className="hint">Esta conexão foi encerrada sem conversa.</p>
      )}

      {hasConversation && (
        <section className={styles.thread} aria-label="Conversa">
          <ol className={styles.messages}>
            {connection.message && (
              <li className={connection.role === 'requester' ? styles.mine : styles.theirs}>
                <p className={styles.bubble}>{connection.message}</p>
                <span className={styles.meta}>Recado do pedido · {formatTime(connection.createdAt)}</span>
              </li>
            )}
            {messages.map((message) => (
              <li key={message.id} className={message.author === 'you' ? styles.mine : styles.theirs}>
                <p className={styles.bubble}>{message.body}</p>
                <span className={styles.meta}>
                  {message.author === 'you' ? 'Você' : other} · {formatTime(message.createdAt)}
                </span>
              </li>
            ))}
          </ol>
          {messages.length === 0 && !connection.message && (
            <p className="hint">Nenhuma mensagem ainda. Combine visita e proposta por aqui.</p>
          )}
          <div ref={endRef} />
        </section>
      )}

      {connection.status === 'revoked' && (
        <p className={styles.notice}>
          Conexão revogada pela plataforma. A conversa fica disponível só para leitura.
        </p>
      )}

      {maskedNotice && (
        <p className={styles.notice} role="status">
          Removemos telefone, e-mail ou link da sua mensagem. Combine tudo por aqui.
        </p>
      )}

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {connection.status === 'approved' && (
        <form className={styles.composer} onSubmit={(event) => void send(event)}>
          <textarea
            className="input"
            aria-label="Mensagem"
            maxLength={2000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void send(event);
            }}
            placeholder={`Escreva para ${other}…`}
          />
          <button type="submit" className="btn btn-primary" disabled={sending || draft.trim() === ''}>
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </form>
      )}
    </div>
  );
}
