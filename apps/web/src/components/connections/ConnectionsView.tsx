'use client';

import type { ConnectionDto } from '@imob/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { apiFetch, ApiError } from '@/lib/api';
import { formatArea } from '@/lib/format';
import { CONNECTION_BADGE, CONNECTION_LABELS, TYPE_LABELS, plural } from '@/lib/labels';
import { connectionPrice } from './price';
import styles from './connections.module.css';

type Role = 'received' | 'sent';

interface ListResponse {
  items: ConnectionDto[];
  total: number;
}

const ROLE_LABEL: Record<Role, string> = {
  received: 'Pedidos recebidos',
  sent: 'Pedidos que fiz',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

/** Quanto falta para o pedido vencer. Pendente sem prazo visível pressiona ninguém. */
function remaining(iso: string): string {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return 'vence hoje';
  return `vence em ${plural(days, 'dia', 'dias')}`;
}

export function ConnectionsView() {
  const [role, setRole] = useState<Role>('received');
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiFetch<ListResponse>(`/connections?role=${role}&limit=50`));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível carregar as conexões.');
    }
  }, [role]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: 'approve' | 'reject' | 'cancel', body?: unknown) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/connections/${id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
      setRejecting(null);
      setNote('');
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível concluir agora.');
    } finally {
      setBusyId(null);
    }
  }

  const items = data?.items ?? [];

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className="page-title">Conexões</h1>
        <p className="lead">
          Quem anuncia decide cada pedido. Depois do aceite, a conversa acontece aqui.
        </p>
      </header>

      <div className="segmented">
        {(['received', 'sent'] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="role"
              checked={role === value}
              onChange={() => {
                setData(null);
                setRole(value);
              }}
            />
            <span>{ROLE_LABEL[value]}</span>
          </label>
        ))}
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {data === null && <p className="hint">Carregando…</p>}

      {data !== null && items.length === 0 && (
        <div className={styles.empty}>
          <Icon name="network" size={32} />
          <p className="section-title">
            {role === 'received' ? 'Nenhum pedido recebido' : 'Você ainda não pediu conexão'}
          </p>
          <p className="hint">
            {role === 'received'
              ? 'Quando um parceiro pedir conexão com um imóvel seu, ele aparece aqui.'
              : 'Na busca da rede, use "Pedir conexão" no imóvel que interessar.'}
          </p>
        </div>
      )}

      <ul className={styles.list}>
        {items.map((connection) => {
          const { listing } = connection;
          const busy = busyId === connection.id;
          // Aprovada conversa; revogada guarda a conversa so para leitura.
          const hasConversation = connection.status === 'approved' || connection.status === 'revoked';

          return (
            <li key={connection.id} className={styles.card}>
              <div className={styles.cardHead}>
                <div>
                  {hasConversation ? (
                    <Link href={`/conexoes/${connection.id}`} className={styles.place}>
                      {listing.neighborhoodName}
                    </Link>
                  ) : (
                    <span className={styles.place}>{listing.neighborhoodName}</span>
                  )}
                  <span className={styles.city}>
                    {listing.cityName}/{listing.cityUf}
                  </span>
                </div>
                <div className={styles.badges}>
                  {connection.unreadCount > 0 && (
                    <span className="badge badge-info">
                      {plural(connection.unreadCount, 'nova', 'novas')}
                    </span>
                  )}
                  <span className={CONNECTION_BADGE[connection.status]}>
                    {CONNECTION_LABELS[connection.status]}
                  </span>
                </div>
              </div>

              <p className={styles.specs}>
                {TYPE_LABELS[listing.type]}
                {listing.bedrooms > 0 && ` · ${plural(listing.bedrooms, 'quarto', 'quartos')}`}
                {listing.areaBuilt !== null && ` · ${formatArea(listing.areaBuilt)}`}
                {` · `}
                <strong className="num">{connectionPrice(listing)}</strong>
              </p>

              {connection.message && <p className={styles.message}>“{connection.message}”</p>}
              {connection.decisionNote && (
                <p className={styles.message}>
                  <strong>Resposta:</strong> {connection.decisionNote}
                </p>
              )}

              {/* A outra parte, so pela marca: contato nunca atravessa. */}
              {connection.counterpart && (
                <p className={styles.counterpart}>
                  <span className={styles.counterpartLabel}>
                    {connection.role === 'owner' ? 'Quem pediu' : 'Quem anuncia'}
                  </span>
                  {connection.counterpart.partnerName}
                </p>
              )}

              <div className={styles.foot}>
                <span className="hint">
                  {formatDate(connection.createdAt)}
                  {connection.status === 'pending' && ` · ${remaining(connection.expiresAt)}`}
                </span>

                {connection.status === 'pending' && connection.role === 'owner' && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => void act(connection.id, 'approve')}
                    >
                      Aprovar
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm"
                      disabled={busy}
                      onClick={() => setRejecting(rejecting === connection.id ? null : connection.id)}
                    >
                      Recusar
                    </button>
                  </div>
                )}

                {connection.status === 'pending' && connection.role === 'requester' && (
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    disabled={busy}
                    onClick={() => void act(connection.id, 'cancel')}
                  >
                    Cancelar pedido
                  </button>
                )}

                {hasConversation && (
                  <Link href={`/conexoes/${connection.id}`} className="btn btn-sm">
                    {connection.status === 'approved' ? 'Abrir conversa' : 'Ver conversa'}
                  </Link>
                )}
              </div>

              {rejecting === connection.id && (
                <div className={styles.rejectBox}>
                  <label htmlFor={`note-${connection.id}`}>Motivo (opcional)</label>
                  <textarea
                    id={`note-${connection.id}`}
                    className="input"
                    maxLength={300}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Ex.: imóvel já está em negociação."
                  />
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy}
                      onClick={() => void act(connection.id, 'reject', { note })}
                    >
                      Confirmar recusa
                    </button>
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => setRejecting(null)}>
                      Voltar
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
