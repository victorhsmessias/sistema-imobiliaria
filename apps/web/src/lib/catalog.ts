'use client';

import type { CityDto, NeighborhoodDto } from '@imob/contracts';
import { useEffect, useState } from 'react';
import { apiFetch } from './api';

export interface Catalog {
  city: CityDto;
  neighborhoods: NeighborhoodDto[];
}

/**
 * Catalogo carregado uma vez por sessao de navegador.
 *
 * Muda raramente (so via curadoria por CSV) e e usado pela busca e pelo
 * cadastro. Uma promessa compartilhada evita buscar tres vezes ao navegar.
 */
let cached: Promise<Catalog> | null = null;

async function loadCatalog(): Promise<Catalog> {
  const { cities } = await apiFetch<{ cities: CityDto[] }>('/catalog/cities');
  const city = cities[0];
  if (!city) throw new Error('Nenhuma cidade cadastrada no catálogo.');

  const { neighborhoods } = await apiFetch<{ neighborhoods: NeighborhoodDto[] }>(
    `/catalog/cities/${city.id}/neighborhoods`,
  );

  return { city, neighborhoods };
}

export function useCatalog(): { catalog: Catalog | null; error: string | null } {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    cached ??= loadCatalog();
    cached
      .then((value) => active && setCatalog(value))
      .catch((reason: unknown) => {
        cached = null;
        if (active) setError(reason instanceof Error ? reason.message : 'Falha ao carregar bairros.');
      });
    return () => {
      active = false;
    };
  }, []);

  return { catalog, error };
}
