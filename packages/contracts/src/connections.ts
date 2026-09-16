import { z } from 'zod';
import { propertyPurpose, propertyType } from './property.js';

/**
 * Conexao entre dois parceiros sobre um imovel da rede.
 *
 * O dono do imovel decide cada pedido. A plataforma nao aprova conexao a
 * conexao -- ela credencia quem entra, arbitra e pode suspender.
 *
 * Assimetria: quem pede aparece para o dono já na solicitacao; o dono so
 * aparece para quem pediu depois do aceite. Endereco exato nao e revelado em
 * nenhum momento.
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

export const disclosureLevel = z.enum(['partner', 'partner_contact']);
export type DisclosureLevel = z.infer<typeof disclosureLevel>;

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

/** Uma das partes. Os campos de contato dependem do nivel de disclosure. */
export const connectionParty = z.object({
  partnerName: z.string(),
  brokerName: z.string().nullable(),
  brokerPhone: z.string().nullable(),
  brokerEmail: z.string().nullable(),
});
export type ConnectionParty = z.infer<typeof connectionParty>;

export const connectionDto = z.object({
  id: z.string().uuid(),
  status: connectionStatus,
  disclosureLevel,
  /** Ponto de vista de quem chamou a API. */
  role: z.enum(['requester', 'owner']),
  message: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),

  listing: connectionListing,

  /** Só para o dono: quem está pedindo, desde o pedido. */
  requester: connectionParty.optional(),
  /**
   * Só para quem pediu, e só depois de aprovado. Ausente em qualquer outro
   * estado -- e a ausência é garantida no banco, por `connection_disclosure()`.
   */
  disclosure: connectionParty.optional(),
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
