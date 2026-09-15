'use client';

import type { PropertyDto } from '@imob/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { apiFetch, ApiError } from '@/lib/api';
import { STATUS_BADGE, STATUS_LABELS, TYPE_LABELS } from '@/lib/labels';
import { MediaManager } from './MediaManager';
import { PropertyForm } from './PropertyForm';
import styles from './property.module.css';

export function EditProperty({ id, created }: { id: string; created: boolean }) {
  const [property, setProperty] = useState<PropertyDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ property: PropertyDto }>(`/properties/${id}`)
      .then(({ property: loaded }) => setProperty(loaded))
      .catch((reason: unknown) => {
        setError(
          reason instanceof ApiError && reason.status === 404
            ? 'Imóvel não encontrado na sua carteira.'
            : 'Não foi possível carregar o imóvel.',
        );
      });
  }, [id]);

  const visible = property ? property.status === 'active' && property.publishedToNetwork : false;

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <Link href="/carteira" className={styles.back}>
          <Icon name="chevronLeft" />
          Minha carteira
        </Link>

        {!error && !property && (
          <div role="status" aria-label="Carregando imóvel">
            <span className="skeleton" style={{ width: 'min(520px, 90%)', height: 30 }} />
            <span className="skeleton" style={{ width: 240, height: 16, marginTop: 12 }} />
          </div>
        )}

        {property && (
          <>
            <h1 className="page-title">{property.title}</h1>
            <div className={styles.headMeta}>
              <span className={STATUS_BADGE[property.status]}>{STATUS_LABELS[property.status]}</span>
              <span className={visible ? 'badge badge-info' : 'badge badge-outline'}>
                {visible ? 'Visível na rede' : 'Fora da rede'}
              </span>
              <span>{TYPE_LABELS[property.type]}</span>
              {property.referenceCode && <span className={styles.code}>{property.referenceCode}</span>}
            </div>
          </>
        )}
      </header>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {property && (
        <>
          {created && (
            <p className="notice" role="status">
              <Icon name="check" />
              Imóvel cadastrado. Agora adicione as fotos.
            </p>
          )}
          <PropertyForm
            initial={property}
            onSaved={setProperty}
            media={<MediaManager propertyId={property.id} />}
          />
        </>
      )}
    </div>
  );
}
