import type { Metadata } from 'next';
import { EditProperty } from '@/components/property/EditProperty';

export const metadata: Metadata = { title: 'Editar imóvel' };

export default async function EditarImovelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ novo?: string }>;
}) {
  const { id } = await params;
  const { novo } = await searchParams;
  return <EditProperty id={id} created={novo === '1'} />;
}
