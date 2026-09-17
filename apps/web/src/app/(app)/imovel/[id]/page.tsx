import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ListingDetail } from '@/components/listing/ListingDetail';

export const metadata: Metadata = { title: 'Imóvel na rede' };

export default async function ImovelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <ListingDetail id={id} />
    </Suspense>
  );
}
