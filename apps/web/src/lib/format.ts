const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});

const brlCents = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** Valor completo, sem abreviar: corretor negocia centavo por centavo de "mil". */
export function formatPrice(cents: number | null, purpose?: string): string {
  if (cents === null) return 'Sob consulta';
  const value = brl.format(cents / 100);
  return purpose === 'rent' ? `${value}/mês` : value;
}

export function formatMoney(cents: number | null): string | null {
  return cents === null ? null : brlCents.format(cents / 100);
}

export function formatArea(m2: number | null): string | null {
  return m2 === null ? null : `${integer.format(m2)} m²`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

/**
 * Converte o que o corretor digita em centavos.
 *
 * Aceita "580000", "580.000", "R$ 580.000" e "1.234,56". Devolve null para
 * campo vazio e NaN para lixo -- quem chama decide como avisar.
 */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.replace(/[R$\s]/g, '');
  if (cleaned === '') return null;

  const normalized = cleaned.includes(',')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/\./g, '');

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  return Math.round(Number(normalized) * 100);
}

export function centsToInput(cents: number | null): string {
  if (cents === null) return '';
  const reais = cents / 100;
  return reais.toLocaleString('pt-BR', {
    minimumFractionDigits: Number.isInteger(reais) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** "92,5" -> 92.5. null para vazio, NaN para lixo. */
export function parseDecimal(input: string): number | null {
  const cleaned = input.trim().replace(/\./g, '').replace(',', '.');
  if (cleaned === '') return null;
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

export function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}
