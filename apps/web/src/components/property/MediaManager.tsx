'use client';

import type { PropertyMediaDto } from '@imob/contracts';
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { Icon } from '@/components/Icon';
import { apiFetch, ApiError } from '@/lib/api';
import { plural } from '@/lib/labels';
import styles from './property.module.css';

export function MediaManager({ propertyId }: { propertyId: string }) {
  const [media, setMedia] = useState<PropertyMediaDto[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const response = await apiFetch<{ media: PropertyMediaDto[] }>(`/properties/${propertyId}/media`);
    setMedia(response.media);
  }, [propertyId]);

  useEffect(() => {
    load().catch(() => setError('Não foi possível carregar as fotos.'));
  }, [load]);

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    setBusy(true);
    setError(null);
    const failures: string[] = [];

    // Uma por vez: fotos de celular pesam, e a VPS processa cada uma (resize,
    // WebP, remocao de metadados) antes de responder.
    for (const [index, file] of files.entries()) {
      setStatus(`Enviando ${index + 1} de ${files.length}…`);
      const body = new FormData();
      body.append('file', file);
      try {
        await apiFetch(`/properties/${propertyId}/media`, { method: 'POST', body });
      } catch (reason) {
        failures.push(`${file.name}: ${reason instanceof ApiError ? reason.message : 'falha no envio'}`);
      }
    }

    await load().catch(() => undefined);
    const sent = files.length - failures.length;
    setStatus(sent > 0 ? `${plural(sent, 'foto adicionada', 'fotos adicionadas')}.` : null);
    if (failures.length > 0) setError(failures.join(' '));
    setBusy(false);
  }

  async function move(index: number, delta: -1 | 1) {
    if (!media) return;
    const target = index + delta;
    if (target < 0 || target >= media.length) return;

    const order = media.map((item) => item.id);
    [order[index], order[target]] = [order[target]!, order[index]!];

    setBusy(true);
    try {
      const response = await apiFetch<{ media: PropertyMediaDto[] }>(
        `/properties/${propertyId}/media/order`,
        { method: 'PATCH', body: JSON.stringify({ order }) },
      );
      setMedia(response.media);
      setStatus(target === 0 ? 'Nova foto de capa definida.' : 'Ordem das fotos atualizada.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível reordenar.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: PropertyMediaDto, index: number) {
    if (!window.confirm(`Remover a foto ${index + 1}?`)) return;
    setBusy(true);
    try {
      await apiFetch(`/properties/${propertyId}/media/${item.id}`, { method: 'DELETE' });
      await load();
      setStatus('Foto removida.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível remover a foto.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="s-fotos" className={styles.section}>
      <header className={styles.sectionHead}>
        <h2 className="section-title">
          Fotos
          {media && media.length > 0 && (
            <span className="hint num" style={{ fontWeight: 500, marginLeft: 8 }}>
              {media.length}
            </span>
          )}
        </h2>
        <span className={styles.visNetwork}>
          <Icon name="network" size={14} />
          Aparece na busca da rede
        </span>
      </header>

      <div className={styles.sectionBody}>
        <div className={styles.mediaIntro}>
          <p className="hint">
            Antes de ir para a rede, cada foto é convertida e perde GPS, autor e dados da câmera. A
            primeira foto é a capa na busca.
          </p>
          <p className="hint">Evite fotos com a marca da imobiliária: a marca identifica quem anuncia.</p>
        </div>

        <div className={`${styles.dropzone} ${busy ? styles.dropBusy : ''}`}>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            multiple
            disabled={busy}
            aria-label="Adicionar fotos"
            onChange={(event) => void handleFiles(event)}
          />
          <span className={styles.dropIcon} aria-hidden="true">
            <Icon name="upload" />
          </span>
          <span className={styles.dropText} aria-hidden="true">
            <strong>Adicionar fotos</strong>
            <span>Arraste as fotos para cá ou clique para escolher. JPG, PNG, WebP ou HEIC.</span>
          </span>
          {status && (
            <span role="status" className={styles.dropStatus}>
              {status}
            </span>
          )}
        </div>

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        {media && media.length === 0 && (
          <p className={styles.noMedia}>Nenhuma foto ainda. Imóveis com foto chamam mais atenção na busca.</p>
        )}

        {media && media.length > 0 && (
          <ul className={styles.mediaGrid}>
            {media.map((item, index) => (
              <li key={item.id} className={styles.mediaItem}>
                <div className={styles.frame}>
                  {broken.has(item.id) ? (
                    <span className={styles.missing}>
                      <Icon name="image" size={20} />
                      Arquivo não encontrado
                    </span>
                  ) : (
                    <img
                      src={`/api/properties/${propertyId}/media/${item.id}`}
                      alt={`Foto ${index + 1}`}
                      loading="lazy"
                      onError={() => setBroken((current) => new Set(current).add(item.id))}
                    />
                  )}
                  {index === 0 && <span className={styles.cover}>Capa</span>}
                </div>

                {!item.sanitizedAt && <p className={styles.pending}>Em processamento, ainda fora da rede.</p>}

                <div className={styles.mediaActions}>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    aria-label={`Mover foto ${index + 1} para antes`}
                    title="Mover para antes"
                    disabled={busy || index === 0}
                    onClick={() => void move(index, -1)}
                  >
                    <Icon name="chevronLeft" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    aria-label={`Mover foto ${index + 1} para depois`}
                    title="Mover para depois"
                    disabled={busy || index === media.length - 1}
                    onClick={() => void move(index, 1)}
                  >
                    <Icon name="chevronRight" />
                  </button>
                  <button
                    type="button"
                    className={`btn btn-quiet ${styles.removeMedia}`}
                    disabled={busy}
                    onClick={() => void remove(item, index)}
                  >
                    Remover
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
