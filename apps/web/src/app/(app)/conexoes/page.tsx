import type { Metadata } from 'next';
import { ConnectionsView } from '@/components/connections/ConnectionsView';

export const metadata: Metadata = { title: 'Conexões' };

export default function ConexoesPage() {
  return <ConnectionsView />;
}
