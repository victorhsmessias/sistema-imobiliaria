'use client';

import type { NetworkListingDetail } from '@imob/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { apiFetch, ApiError } from '@/lib/api';
import { formatArea, formatDate, formatMoney, formatPrice } from '@/lib/format';
import { CONNECTION_BADGE, CONNECTION_LABELS, PURPOSE_LABELS, TYPE_LABELS } from '@/lib/labels';
import styles from './listing.module.css';

type Media = NetworkListingDetail['media'][number];

/**
 * Video e tour ficam de fora da galeria: o endpoint de midia entrega bytes que
 * uma <img> nao sabe desenhar. Planta e foto, e entra.
 */
const IMAGE_KINDS = new Set<Media['kind']>(['photo', 'floor_plan']);

const mediaUrl = (listingId: string, mediaId: string) =>
  `/api/network/listings/${listingId}/media/${mediaId}`;

/* ---------- Galeria ---------- */

function Gallery({ listingId, media }: { listingId: string; media: Media[] }) {
  const [index, setIndex] = useState(0);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [retry, setRetry] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);
  // Mover o foco junto com a seta so faz sentido se ele ja estava nas
  // miniaturas; quem navega pelo palco perderia o lugar.
  const takeFocus = useRef(false);

  useEffect(() => {
    const thumb = stripRef.current?.querySelectorAll('button')[index];
    thumb?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (takeFocus.current) {
      takeFocus.current = false;
      thumb?.focus();
    }
  }, [index]);

  const current = media[index];
  if (!current) return null;

  const total = media.length;
  const isBroken = broken.has(current.id);

  function go(next: number, fromStrip: boolean) {
    takeFocus.current = fromStrip;
    setIndex((next + total) % total);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (total < 2) return;

    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = index - 1;
    else if (event.key === 'ArrowRight') next = index + 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = total - 1;
    if (next === null) return;

    event.preventDefault();
    const inStrip = stripRef.current?.contains(document.activeElement) ?? false;
    go(next, inStrip);
  }

  return (
    <div className={styles.gallery} onKeyDown={handleKeyDown}>
      <div
        className={styles.stage}
        tabIndex={0}
        role="group"
        aria-roledescription="galeria de fotos"
        aria-label={`Foto ${index + 1} de ${total}. Use as setas para trocar.`}
      >
        {isBroken ? (
          <div className={styles.stageFallback}>
            <Icon name="image" size={28} />
            <p>Foto indisponível</p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setBroken((value) => {
                  const next = new Set(value);
                  next.delete(current.id);
                  return next;
                });
                setRetry((value) => value + 1);
              }}
            >
              Tentar de novo
            </button>
          </div>
        ) : (
          <img
            // O endereco assinado vence; remontar a <img> refaz o pedido.
            key={`${current.id}-${retry}`}
            src={mediaUrl(listingId, current.id)}
            alt={`Foto ${index + 1} do imóvel`}
            onError={() => setBroken((value) => new Set(value).add(current.id))}
          />
        )}

        {current.kind === 'floor_plan' && !isBroken && (
          <span className={styles.stageTag}>Planta</span>
        )}

        {total > 1 && (
          <>
            <button
              type="button"
              className={`${styles.navBtn} ${styles.prev}`}
              aria-label="Foto anterior"
              onClick={() => go(index - 1, false)}
            >
              <Icon name="chevronLeft" />
            </button>
            <button
              type="button"
              className={`${styles.navBtn} ${styles.next}`}
              aria-label="Próxima foto"
              onClick={() => go(index + 1, false)}
            >
              <Icon name="chevronRight" />
            </button>
            <span className={`num ${styles.counter}`}>
              {index + 1}/{total}
            </span>
          </>
        )}
      </div>

      <p className="visually-hidden" role="status">
        Foto {index + 1} de {total}
      </p>

      {total > 1 && (
        <div className={styles.strip} ref={stripRef} role="group" aria-label="Miniaturas das fotos">
          {media.map((item, position) => (
            <button
              key={item.id}
              type="button"
              className={styles.thumb}
              aria-current={position === index}
              aria-label={`${item.kind === 'floor_plan' ? 'Planta' : 'Foto'} ${position + 1}`}
              tabIndex={position === index ? 0 : -1}
              onClick={() => go(position, true)}
            >
              {broken.has(item.id) ? (
                <span className={styles.thumbFallback} aria-hidden="true">
                  <Icon name="image" size={16} />
                </span>
              ) : (
                <img
                  src={mediaUrl(listingId, item.id)}
                  alt=""
                  loading="lazy"
                  onError={() => setBroken((value) => new Set(value).add(item.id))}
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Tela ---------- */

type Phase = 'loading' | 'ready' | 'gone' | 'error';

export function ListingDetail({ id }: { id: string }) {
  const searchParams = useSearchParams();
  const [listing, setListing] = useState<NetworkListingDetail | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [reload, setReload] = useState(0);

  // A busca guarda os filtros na URL. Carregar essa mesma query de volta
  // devolve o corretor a lista exata de onde ele saiu, e nao ao zero.
  const fromSearch = searchParams.get('busca');
  const backHref = fromSearch ? `/busca?${fromSearch}` : '/busca';

  useEffect(() => {
    const controller = new AbortController();
    setPhase('loading');

    apiFetch<{ listing: NetworkListingDetail }>(`/network/listings/${id}`, {
      signal: controller.signal,
    })
      .then(({ listing: loaded }) => {
        setListing(loaded);
        setPhase('ready');
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        // Fora da rede e inexistente respondem igual, de proposito: a API nao
        // confirma nem nega que o imovel existe na carteira de alguem.
        if (reason instanceof ApiError && reason.status === 404) {
          setPhase('gone');
          return;
        }
        setLoadError(
          reason instanceof ApiError ? reason.message : 'Não foi possível carregar o imóvel.',
        );
        setPhase('error');
      });

    return () => controller.abort();
  }, [id, reload]);

  async function requestConnection() {
    if (!listing) return;
    setRequesting(true);
    setActionError(null);
    try {
      const { connection } = await apiFetch<{ connection: { id: string; status: 'pending' } }>(
        '/connections',
        { method: 'POST', body: JSON.stringify({ listingId: listing.listingId }) },
      );
      setListing({ ...listing, connection });
    } catch (reason) {
      setActionError(
        reason instanceof ApiError ? reason.message : 'Não foi possível pedir conexão agora.',
      );
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <Link href={backHref} className={styles.back}>
        <Icon name="chevronLeft" />
        Voltar para a busca
      </Link>

      {phase === 'loading' && <DetailSkeleton />}

      {phase === 'gone' && (
        <div className={styles.state}>
          <Icon name="network" size={32} />
          <p className="section-title">Este imóvel saiu da rede</p>
          <p className="hint">
            Quem anunciava pode tê-lo vendido, alugado ou arquivado. Quando isso acontece, ele deixa
            de aparecer na busca.
          </p>
          <Link href={backHref} className="btn">
            Voltar para a busca
          </Link>
        </div>
      )}

      {phase === 'error' && (
        <div className={styles.state}>
          <p className="alert" role="alert">
            {loadError}
          </p>
          <button type="button" className="btn" onClick={() => setReload((value) => value + 1)}>
            Tentar de novo
          </button>
        </div>
      )}

      {phase === 'ready' && listing && (
        <Loaded
          listing={listing}
          requesting={requesting}
          actionError={actionError}
          onRequestConnection={() => void requestConnection()}
        />
      )}
    </div>
  );
}

interface LoadedProps {
  listing: NetworkListingDetail;
  requesting: boolean;
  actionError: string | null;
  onRequestConnection: () => void;
}

function Loaded({ listing, requesting, actionError, onRequestConnection }: LoadedProps) {
  const photos = listing.media.filter((item) => IMAGE_KINDS.has(item.kind));

  // Numero em cima, rotulo embaixo: o mesmo idioma da lista de busca, para o
  // corretor ler a ficha sem reaprender a tela.
  const facts: Array<{ value: string; label: string }> = [];
  if (listing.bedrooms > 0)
    facts.push({
      value: String(listing.bedrooms),
      label: listing.bedrooms === 1 ? 'quarto' : 'quartos',
    });
  if (listing.suites > 0)
    facts.push({ value: String(listing.suites), label: listing.suites === 1 ? 'suíte' : 'suítes' });
  if (listing.bathrooms > 0)
    facts.push({
      value: String(listing.bathrooms),
      label: listing.bathrooms === 1 ? 'banheiro' : 'banheiros',
    });
  if (listing.parkingSpots > 0)
    facts.push({
      value: String(listing.parkingSpots),
      label: listing.parkingSpots === 1 ? 'vaga' : 'vagas',
    });

  const areaBuilt = formatArea(listing.areaBuilt);
  if (areaBuilt) facts.push({ value: areaBuilt, label: 'área construída' });
  const areaTotal = formatArea(listing.areaTotal);
  if (areaTotal) facts.push({ value: areaTotal, label: 'área do terreno' });

  // Venda e aluguel sao colunas distintas, e um imovel pode ter as duas. Na
  // ficha aberta nenhuma das duas manda na outra: as duas aparecem inteiras.
  const prices: Array<{ label: string; value: string }> = [];
  if (listing.purpose === 'sale' || listing.purpose === 'sale_rent') {
    prices.push({ label: 'Venda', value: formatPrice(listing.salePriceCents, 'sale') });
  }
  if (listing.purpose === 'rent' || listing.purpose === 'sale_rent') {
    prices.push({ label: 'Aluguel', value: formatPrice(listing.rentPriceCents, 'rent') });
  }

  const condo = formatMoney(listing.condoFeeCents);
  const iptu = formatMoney(listing.iptuCents);
  const status = listing.connection?.status;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={`page-title ${styles.title}`}>
          {listing.neighborhood.name}
          <span className={styles.city}>
            {listing.city.name}/{listing.city.uf}
          </span>
        </h1>
        <div className={styles.headMeta}>
          <span className={styles.type}>{TYPE_LABELS[listing.type]}</span>
          <span className={styles.purpose}>{PURPOSE_LABELS[listing.purpose]}</span>
          {listing.isOwn && <span className="badge badge-info">Seu imóvel</span>}
          {listing.acceptsExchange && <span className="badge badge-outline">Aceita permuta</span>}
        </div>
      </header>

      <section className={styles.gallerySlot} aria-label="Fotos do imóvel">
        {photos.length > 0 ? (
          <Gallery listingId={listing.listingId} media={photos} />
        ) : (
          <div className={styles.noPhotos}>
            <Icon name="image" size={28} />
            <p className="section-title">Este anúncio não tem fotos</p>
            <p className="hint">Os dados abaixo são o que a rede mostra sobre o imóvel.</p>
          </div>
        )}
      </section>

      <section className={styles.facts} aria-label="Ficha do imóvel">
        {facts.length > 0 ? (
          <ul className={styles.factGrid}>
            {facts.map((fact) => (
              <li key={fact.label}>
                <span className={`num ${styles.factValue}`}>{fact.value}</span>
                <span className={styles.factLabel}>{fact.label}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Quem anuncia não detalhou cômodos nem áreas.</p>
        )}
      </section>

      <aside className={styles.rail} aria-label="Valores e conexão">
        <div className={styles.prices}>
          {prices.map((price) => (
            <div key={price.label} className={styles.priceItem}>
              <span className={`num ${styles.priceValue}`}>{price.value}</span>
              <span className={styles.priceLabel}>{price.label}</span>
            </div>
          ))}
        </div>

        {(condo || iptu) && (
          <dl className={styles.fees}>
            {condo && (
              <div>
                <dt>Condomínio mensal</dt>
                <dd className="num">{condo}</dd>
              </div>
            )}
            {iptu && (
              <div>
                <dt>IPTU anual</dt>
                <dd className="num">{iptu}</dd>
              </div>
            )}
          </dl>
        )}

        {/* A conexao e o unico caminho ate o dono: o anuncio e anonimo ate ela. */}
        <div className={styles.action}>
          {listing.isOwn ? (
            <p className="hint">
              Este imóvel é da sua carteira. Os outros parceiros o veem sem saber que é seu.
            </p>
          ) : (
            <>
              {listing.connection === null && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={requesting}
                    onClick={onRequestConnection}
                  >
                    {requesting ? 'Enviando…' : 'Pedir conexão'}
                  </button>
                  <p className="hint">
                    A rede não mostra quem anuncia. Quem recebe o pedido decide, e o contato aparece
                    em Conexões depois do aceite.
                  </p>
                </>
              )}

              {status === 'pending' && (
                <>
                  <span className={CONNECTION_BADGE.pending}>{CONNECTION_LABELS.pending}</span>
                  <p className="hint">
                    O pedido está com quem anuncia. Acompanhe em <Link href="/conexoes">Conexões</Link>.
                  </p>
                </>
              )}

              {status === 'approved' && (
                <>
                  <span className={CONNECTION_BADGE.approved}>{CONNECTION_LABELS.approved}</span>
                  <Link href="/conexoes" className="btn">
                    Ver contato
                  </Link>
                </>
              )}

              {status !== undefined && status !== 'pending' && status !== 'approved' && (
                <>
                  <span className={CONNECTION_BADGE[status]}>{CONNECTION_LABELS[status]}</span>
                  <button
                    type="button"
                    className="btn"
                    disabled={requesting}
                    onClick={onRequestConnection}
                  >
                    {requesting ? 'Enviando…' : 'Pedir de novo'}
                  </button>
                </>
              )}

              {actionError && (
                <p className="alert" role="alert">
                  {actionError}
                </p>
              )}
            </>
          )}
        </div>
      </aside>

      <footer className={styles.foot}>
        <span className="num">Na rede desde {formatDate(listing.createdAt)}</span>
        <span className="num">Atualizado em {formatDate(listing.updatedAt)}</span>
      </footer>
    </div>
  );
}

/** Blocos no formato da ficha, para a tela nao saltar quando o imovel chega. */
function DetailSkeleton() {
  return (
    <div className={styles.page} aria-hidden="true">
      <div className={styles.head}>
        <span className="skeleton" style={{ width: 'min(380px, 80%)', height: 30 }} />
        <span className="skeleton" style={{ width: 200, height: 14, marginTop: 10 }} />
      </div>
      <div className={styles.gallerySlot}>
        <span className={`skeleton ${styles.stageSkeleton}`} />
      </div>
      <div className={styles.facts}>
        <span className="skeleton" style={{ width: '100%', height: 84 }} />
      </div>
      <div className={styles.rail}>
        <div className={styles.prices}>
          <span className="skeleton" style={{ width: 160, height: 26 }} />
          <span className="skeleton" style={{ width: 70, height: 13, marginTop: 8 }} />
        </div>
        <div className={styles.action}>
          <span className="skeleton" style={{ width: '100%', height: 38 }} />
        </div>
      </div>
    </div>
  );
}
