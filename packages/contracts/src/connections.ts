import { z } from 'zod';
import { propertyPurpose, propertyType } from './property.js';

/**
 * Conexao entre dois parceiros sobre um imovel da rede.
 *
 * O dono do imovel decide cada pedido. A plataforma nao aprova conexao a
 * conexao -- ela credencia quem entra, arbitra e pode suspender.
 *
 * Cada parte ve da outra so a marca: contato de pessoa nunca atravessa, e a
 * negociacao segue por mensagens dentro da plataforma. Quem pede aparece para
 * o dono ja no pedido; o dono aparece para quem pediu so depois do aceite.
 * Endereco exato nao e revelado em nenhum momento.
 */

export const connectionStatus = z.enum([
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'revoked',
]);
export type ConnectionStatus = z.infer<typeof connectionStatus>;

export const connectionEventType = z.enum([
  'requested',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'revoked',
  'disclosed',
]);
export type ConnectionEventType = z.infer<typeof connectionEventType>;

export const createConnectionInput = z.object({
  listingId: z.string().uuid(),
  /** Recado de quem pede. Chega ao dono junto com o pedido. */
  message: z
    .string()
    .trim()
    .max(500)
    .optional()
    .nullable()
    .transform((value) => (value === '' ? null : (value ?? null))),
});
export type CreateConnectionInput = z.infer<typeof createConnectionInput>;

export const decideConnectionInput = z.object({
  /** Motivo da recusa. Opcional, mas é o que evita o parceiro ficar no escuro. */
  note: z
    .string()
    .trim()
    .max(300)
    .optional()
    .nullable()
    .transform((value) => (value === '' ? null : (value ?? null))),
});
export type DecideConnectionInput = z.infer<typeof decideConnectionInput>;

export const revokeConnectionInput = z.object({
  /** Motivo da revogação. Obrigatório e auditável. */
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500),
});
export type RevokeConnectionInput = z.infer<typeof revokeConnectionInput>;

export const sendMessageInput = z.object({
  /** Texto livre. Contato digitado e mascarado no servidor antes de gravar. */
  body: z.string().trim().min(1).max(2000),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const messageListQuery = z.object({
  /** Traz so as mensagens posteriores a esta. Sem ele, as 200 mais recentes. */
  after: z.string().uuid().optional(),
});
export type MessageListQuery = z.infer<typeof messageListQuery>;

export const connectionListQuery = z.object({
  /** `received`: pedidos sobre os meus imoveis. `sent`: os que eu fiz. */
  role: z.enum(['received', 'sent']).default('received'),
  status: connectionStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** O imovel da conexao: os mesmos campos que a busca ja mostra, nada além. */
export const connectionListing = z.object({
  listingId: z.string().uuid(),
  type: propertyType,
  purpose: propertyPurpose,
  neighborhoodName: z.string(),
  cityName: z.string(),
  cityUf: z.string(),
  bedrooms: z.number().int(),
  suites: z.number().int(),
  bathrooms: z.number().int(),
  parkingSpots: z.number().int(),
  areaBuilt: z.number().nullable(),
  areaTotal: z.number().nullable(),
  salePriceCents: z.number().int().nullable(),
  rentPriceCents: z.number().int().nullable(),
});
export type ConnectionListing = z.infer<typeof connectionListing>;

/** Uma das partes: so a marca. Contato de pessoa nunca atravessa. */
export const connectionParty = z.object({
  partnerName: z.string(),
});
export type ConnectionParty = z.infer<typeof connectionParty>;

export const connectionDto = z.object({
  id: z.string().uuid(),
  status: connectionStatus,
  /** Ponto de vista de quem chamou a API. */
  role: z.enum(['requester', 'owner']),
  message: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),

  listing: connectionListing,

  /**
   * A outra parte, so pela marca. Para o dono, desde o pedido; para quem
   * pediu, so em `approved` e `revoked`. A regra vive no banco, em
   * `connection_requester()` e `connection_disclosure()`.
   */
  counterpart: connectionParty.optional(),
});
export type ConnectionDto = z.infer<typeof connectionDto>;

/**
 * Evento da trilha.
 *
 * `actor` diz de que lado veio a ação, nunca quem é: mostrar o nome de quem
 * recusou revelaria o dono justamente no caso em que ele disse não.
 */
export const connectionEventDto = z.object({
  id: z.string().uuid(),
  type: connectionEventType,
  actor: z.enum(['you', 'other', 'platform']),
  createdAt: z.string().datetime(),
});
export type ConnectionEventDto = z.infer<typeof connectionEventDto>;

/**
 * Mensagem da conversa.
 *
 * `author` diz de que lado veio, nunca quem escreveu: nome de pessoa e
 * contato, e contato nao atravessa. A tela mostra a marca da outra parte.
 */
export const connectionMessageDto = z.object({
  id: z.string().uuid(),
  body: z.string(),
  author: z.enum(['you', 'other']),
  createdAt: z.string().datetime(),
});
export type ConnectionMessageDto = z.infer<typeof connectionMessageDto>;
