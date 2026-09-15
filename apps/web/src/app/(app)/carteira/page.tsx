import type { Metadata } from 'next';
import { PortfolioView } from '@/components/property/PortfolioView';

export const metadata: Metadata = { title: 'Minha carteira' };

export default function CarteiraPage() {
  return <PortfolioView />;
}
