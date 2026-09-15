import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SearchView } from '@/components/search/SearchView';

export const metadata: Metadata = { title: 'Buscar na rede' };

export default function BuscaPage() {
  return (
    <Suspense fallback={null}>
      <SearchView />
    </Suspense>
  );
}
