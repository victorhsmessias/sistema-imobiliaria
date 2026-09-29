import type { Metadata } from 'next';
import { ConversationView } from '@/components/connections/ConversationView';

export const metadata: Metadata = { title: 'Conversa' };

export default async function ConversaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConversationView id={id} />;
}
