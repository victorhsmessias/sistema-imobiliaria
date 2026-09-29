import type { ConnectionListing } from '@imob/contracts';
import { formatPrice } from '@/lib/format';

/** Preco do imovel da conexao, como a lista e a conversa mostram. */
export function connectionPrice(listing: ConnectionListing): string {
  const { purpose, salePriceCents, rentPriceCents } = listing;
  if (purpose === 'rent') return formatPrice(rentPriceCents, 'rent');
  const sale = formatPrice(salePriceCents, 'sale');
  return purpose === 'sale_rent' ? `${sale} ou ${formatPrice(rentPriceCents, 'rent')}` : sale;
}
