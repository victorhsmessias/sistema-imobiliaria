import type { Metadata } from 'next';
import { ImportsView } from '@/components/imports/ImportsView';

export const metadata: Metadata = { title: 'Importação' };

export default function ImportacaoPage() {
  return <ImportsView />;
}
