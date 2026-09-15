'use client';

import type { NetworkListing } from '@imob/contracts';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { formatArea, formatMoney, formatPrice } from '@/lib/format';
import { PURPOSE_LABELS, TYPE_LABELS, plural } from '@/lib/labels';
import styles from './search.module.css';

interface Props {
  listing: NetworkListing;
  /** Finalidade buscada: decide qual valor fica em destaque num anuncio de venda e aluguel. */
  pricePurpose?: 'sale' | 'rent';
}

interface Spec {
  value: string;
  label: string;
}

/**
 * Um anuncio da rede.
 *
 * Tudo o que esta aqui veio da view network_listings. Nao ha nome de
 * imobiliaria, contato, titulo, descricao nem endereco -- e nao ha como
 * mostrar, porque a API nao entrega. O bairro e o endereco possivel.
 */
export function ListingRow({ listing, pricePurpose }: Props) {
  const [photoFailed, setPhotoFailed] = useState(false);

  // Numero em cima, unidade embaixo: o corretor compara coluna com coluna
  // descendo a lista, sem ler frase por frase.
  const specs: Spec[] = [];
  if (listing.bedrooms > 0) specs.push({ value: String(listing.bedrooms), label: listing.bedrooms === 1 ? 'quarto' : 'quartos' });
  if (listing.suites > 0) specs.push({ value: String(listing.suites), label: listing.suites === 1 ? 'suíte' : 'suítes' });
  if (listing.bathrooms > 0) specs.push({ value: String(listing.bathrooms), label: listing.bathrooms === 1 ? 'banheiro' : 'banheiros' });
  if (listing.parkingSpots > 0) specs.push({ value: String(listing.parkingSpots), label: listing.parkingSpots === 1 ? 'vaga' : 'vagas' });
  if (listing.areaBuilt !== null) specs.push({ value: formatArea(listing.areaBuilt)!, label: 'construídos' });
  else if (listing.areaTotal !== null) specs.push({ value: formatArea(listing.areaTotal)!, label: 'de terreno' });

  // Venda e aluguel: o valor em destaque e o da finalidade buscada; o outro
  // aparece embaixo. Nenhum dos dois se perde.
  const mainPurpose = listing.purpose === 'sale_rent' ? (pricePurpose ?? 'sale') : listing.purpose;
  const otherPurpose = listing.purpose === 'sale_rent' ? (mainPurpose === 'sale' ? 'rent' : 'sale') : null;
  const centsFor = (purpose: 'sale' | 'rent') =>
    purpose === 'rent' ? listing.rentPriceCents : listing.salePriceCents;

  const condo = formatMoney(listing.condoFeeCents);
  const iptu = formatMoney(listing.iptuCents);

  const photoUrl = listing.coverMediaId
    ? `/api/network/listings/${listing.listingId}/media/${listing.coverMediaId}`
    : null;
  const showPhoto = photoUrl !== null && !photoFailed;

  return (
    <li className={styles.row}>
      <div className={styles.thumb}>
        {showPhoto ? (
          <img src={photoUrl} alt="" loading="lazy" onError={() => setPhotoFailed(true)} />
        ) : (
          <span className={styles.noPhoto}>
            <Icon name="image" size={24} />
            <span>{photoUrl ? 'Foto indisponível' : 'Sem foto'}</span>
          </span>
        )}
        {listing.photoCount > 1 && showPhoto && (
          <span className={`num ${styles.photoCount}`}>{listing.photoCount} fotos</span>
        )}
      </div>

      <div className={styles.rowBody}>
        <div className={styles.place}>
          <span className={styles.neighborhood}>{listing.neighborhood.name}</span>
          <span className={styles.cityTag}>
            {listing.city.name}/{listing.city.uf}
          </span>
        </div>

        <p className={styles.type}>{TYPE_LABELS[listing.type]}</p>

        {specs.length > 0 && (
          <ul className={styles.specs}>
            {specs.map((spec) => (
              <li key={spec.label}>
                <span className={`num ${styles.specValue}`}>{spec.value}</span>
                <span className={styles.specLabel}>{spec.label}</span>
              </li>
            ))}
          </ul>
        )}

        <div className={styles.meta}>
          {listing.isOwn && <span className="badge badge-info">Seu imóvel</span>}
          {listing.acceptsExchange && <span className="badge badge-outline">Aceita permuta</span>}
          {(!showPhoto || listing.photoCount <= 1) && (
            <span className="num">
              {listing.photoCount > 0 ? plural(listing.photoCount, 'foto', 'fotos') : 'Sem fotos'}
            </span>
          )}
        </div>
      </div>

      <div className={styles.price}>
        <span className={`num ${styles.priceValue}`}>
          {formatPrice(centsFor(mainPurpose), mainPurpose)}
        </span>
        <span className={styles.purpose}>{PURPOSE_LABELS[listing.purpose]}</span>
        {otherPurpose && (
          <span className={`num ${styles.priceAlso}`}>
            ou {formatPrice(centsFor(otherPurpose), otherPurpose)}
          </span>
        )}
        {(condo || iptu) && (
          <dl className={`num ${styles.fees}`}>
            {condo && (
              <div>
                <dt>Condomínio</dt>
                <dd>{condo}</dd>
              </div>
            )}
            {iptu && (
              <div>
                <dt>IPTU/ano</dt>
                <dd>{iptu}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </li>
  );
}

/** Linha fantasma no formato de um anuncio, enquanto a primeira busca responde. */
export function ListingRowSkeleton() {
  return (
    <li className={styles.row} aria-hidden="true">
      <div className={`skeleton ${styles.thumb}`} />
      <div className={styles.rowBody}>
        <span className="skeleton" style={{ width: '40%', height: 18 }} />
        <span className="skeleton" style={{ width: '22%', height: 12, marginTop: 4 }} />
        <span className="skeleton" style={{ width: '58%', height: 30, marginTop: 10 }} />
      </div>
      <div className={styles.price}>
        <span className="skeleton" style={{ width: 110, height: 20 }} />
        <span className="skeleton" style={{ width: 48, height: 12, marginTop: 6 }} />
      </div>
    </li>
  );
}
