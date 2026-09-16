import type {
  ConnectionStatus,
  PropertyPurpose,
  PropertyStatus,
  PropertyType,
} from '@imob/contracts';

export const TYPE_LABELS: Record<PropertyType, string> = {
  apartamento: 'Apartamento',
  casa: 'Casa',
  casa_condominio: 'Casa em condomínio',
  terreno: 'Terreno',
  sala_comercial: 'Sala comercial',
  galpao: 'Galpão',
  loja: 'Loja',
  sitio_chacara: 'Sítio ou chácara',
  outro: 'Outro',
};

/** Tipos oferecidos como filtro na busca, na ordem em que corretor procura. */
export const SEARCH_TYPES: PropertyType[] = [
  'apartamento',
  'casa',
  'casa_condominio',
  'terreno',
  'sala_comercial',
  'loja',
  'galpao',
  'sitio_chacara',
];

export const PURPOSE_LABELS: Record<PropertyPurpose, string> = {
  sale: 'Venda',
  rent: 'Aluguel',
  sale_rent: 'Venda e aluguel',
};

export const STATUS_LABELS: Record<PropertyStatus, string> = {
  draft: 'Rascunho',
  active: 'Ativo',
  reserved: 'Reservado',
  sold_rented: 'Vendido ou alugado',
  archived: 'Arquivado',
};

/** Classe do selo de cada status: verde so para o que esta de fato no ar. */
export const STATUS_BADGE: Record<PropertyStatus, string> = {
  draft: 'badge',
  active: 'badge badge-ok',
  reserved: 'badge badge-warn',
  sold_rented: 'badge badge-info',
  archived: 'badge badge-outline',
};

export const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  pending: 'Aguardando resposta',
  approved: 'Aprovada',
  rejected: 'Recusada',
  cancelled: 'Cancelada',
  expired: 'Expirada',
  revoked: 'Revogada',
};

/** Verde só para a conexão que de fato abriu o contato. */
export const CONNECTION_BADGE: Record<ConnectionStatus, string> = {
  pending: 'badge badge-warn',
  approved: 'badge badge-ok',
  rejected: 'badge badge-outline',
  cancelled: 'badge badge-outline',
  expired: 'badge badge-outline',
  revoked: 'badge badge-outline',
};

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
