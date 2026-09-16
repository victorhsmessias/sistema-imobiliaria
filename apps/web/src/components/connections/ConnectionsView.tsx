'use client';

import type { ConnectionDto } from '@imob/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { apiFetch, ApiError } from '@/lib/api';
import { formatArea, formatPrice } from '@/lib/format';
import { CONNECTION_BADGE, CONNECTION_LABELS, TYPE_LABELS, plural } from '@/lib/labels';
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

function price(connection: ConnectionDto): string {
  const { purpose, salePriceCents, rentPriceCents } = connection.listing;
  if (purpose === 'rent') return formatPrice(rentPriceCents, 'rent');
  const sale = formatPrice(salePriceCents, 'sale');
  return purpose === 'sale_rent' ? `${sale} ou ${formatPrice(rentPriceCents, 'rent')}` : sale;
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
          Quem anuncia decide cada pedido. O contato só aparece depois do aceite.
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

          return (
            <li key={connection.id} className={styles.card}>
              <div className={styles.cardHead}>
                <div>
                  <span className={styles.place}>{listing.neighborhoodName}</span>
                  <span className={styles.city}>
                    {listing.cityName}/{listing.cityUf}
                  </span>
                </div>
                <span className={CONNECTION_BADGE[connection.status]}>
                  {CONNECTION_LABELS[connection.status]}
                </span>
              </div>

              <p className={styles.specs}>
                {TYPE_LABELS[listing.type]}
                {listing.bedrooms > 0 && ` · ${plural(listing.bedrooms, 'quarto', 'quartos')}`}
                {listing.areaBuilt !== null && ` · ${formatArea(listing.areaBuilt)}`}
                {` · `}
                <strong className="num">{price(connection)}</strong>
              </p>

              {connection.message && <p className={styles.message}>“{connection.message}”</p>}
              {connection.decisionNote && (
                <p className={styles.message}>
                  <strong>Resposta:</strong> {connection.decisionNote}
                </p>
              )}

              {/* Dono: quem está pedindo, desde o pedido. */}
              {connection.requester && (
                <dl className={styles.party}>
                  <div>
                    <dt>Parceiro</dt>
                    <dd>{connection.requester.partnerName}</dd>
                  </div>
                  {connection.requester.brokerName && (
                    <div>
                      <dt>Corretor</dt>
                      <dd>{connection.requester.brokerName}</dd>
                    </div>
                  )}
                  {connection.requester.brokerPhone && (
                    <div>
                      <dt>Telefone</dt>
                      <dd className="num">{connection.requester.brokerPhone}</dd>
                    </div>
                  )}
                  {connection.requester.brokerEmail && (
                    <div>
                      <dt>E-mail</dt>
                      <dd>{connection.requester.brokerEmail}</dd>
                    </div>
                  )}
                </dl>
              )}

              {/* Solicitante: só existe depois do aceite. */}
              {connection.disclosure && (
                <dl className={`${styles.party} ${styles.revealed}`}>
                  <div>
                    <dt>Imobiliária</dt>
                    <dd>{connection.disclosure.partnerName}</dd>
                  </div>
                  {connection.disclosure.brokerName && (
                    <div>
                      <dt>Corretor</dt>
                      <dd>{connection.disclosure.brokerName}</dd>
                    </div>
                  )}
                  {connection.disclosure.brokerPhone && (
                    <div>
                      <dt>Telefone</dt>
                      <dd className="num">{connection.disclosure.brokerPhone}</dd>
                    </div>
                  )}
                  {connection.disclosure.brokerEmail && (
                    <div>
                      <dt>E-mail</dt>
                      <dd>{connection.disclosure.brokerEmail}</dd>
                    </div>
                  )}
                </dl>
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
