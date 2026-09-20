import type {
  ConnectionDto,
  ConnectionEventDto,
  ConnectionListing,
  ConnectionParty,
  ConnectionStatus,
  CreateConnectionInput,
  DecideConnectionInput,
} from '@imob/contracts';
import { withTenant, type ConnectionEvent, type ConnectionRequest, type Tx } from '@imob/db';
import { forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import type { ActorContext } from '../properties/service.js';
import * as repo from './repository.js';

/**
 * Fluxo de conexao.
 *
 * O DONO do imovel decide cada pedido; a plataforma nao aprova conexao a
 * conexao (credencia quem entra, arbitra e pode suspender). Modelo escolhido
 * a partir da pesquisa de mercado: e o que tem precedente (Homer, ImovelPro,
 * Casafari Connect) e o que menos trava a liquidez da rede.
 *
 * O que cada lado enxerga:
 *  - o dono ve quem pediu desde o pedido (pedir e se identificar);
 *  - quem pediu so ve o dono depois do aceite, e nunca o endereco.
 * As duas regras estao nas funcoes SECURITY DEFINER, nao aqui: o service
 * apenas escolhe quais campos mostrar dentro do que o banco liberou.
 */

/** Prazo do pedido pendente. Sem prazo, a caixa do dono vira cemiterio. */
const TTL_DAYS = 7;

const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

function toListing(row: repo.ListingRow): ConnectionListing {
  return {
    listingId: row.listing_id,
    type: row.type as ConnectionListing['type'],
    purpose: row.purpose as ConnectionListing['purpose'],
    neighborhoodName: row.neighborhood_name,
    cityName: row.city_name,
    cityUf: row.city_uf,
    bedrooms: row.bedrooms,
    suites: row.suites,
    bathrooms: row.bathrooms,
    parkingSpots: row.parking_spots,
    areaBuilt: num(row.area_built),
    areaTotal: num(row.area_total),
    salePriceCents: num(row.sale_price_cents),
    rentPriceCents: num(row.rent_price_cents),
  };
}

/**
 * Aplica o nivel de disclosure.
 *
 * `partner` mostra so a marca; `partner_contact` mostra tambem o corretor.
 * Cortar aqui, e nao na consulta, mantem um lugar unico para a politica.
 */
function toParty(row: repo.PartyRow, level: 'partner' | 'partner_contact'): ConnectionParty {
  if (level === 'partner') {
    return { partnerName: row.partner_name, brokerName: null, brokerPhone: null, brokerEmail: null };
  }
  return {
    partnerName: row.partner_name,
    brokerName: row.broker_name,
    brokerPhone: row.broker_phone,
    brokerEmail: row.broker_email,
  };
}

function toEventDto(event: ConnectionEvent, actorTenantId: string): ConnectionEventDto {
  return {
    id: event.id,
    type: event.type,
    actor:
      event.actorTenantId === null
        ? 'platform'
        : event.actorTenantId === actorTenantId
          ? 'you'
          : 'other',
    createdAt: event.createdAt.toISOString(),
  };
}

async function hydrate(
  tx: Tx,
  row: ConnectionRequest,
  actor: ActorContext,
  listing: repo.ListingRow,
): Promise<ConnectionDto> {
  const role = row.ownerTenantId === actor.tenantId ? 'owner' : 'requester';

  const dto: ConnectionDto = {
    id: row.id,
    status: row.status,
    disclosureLevel: row.disclosureLevel,
    role,
    message: row.message,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    listing: toListing(listing),
  };

  if (role === 'owner') {
    const requester = await repo.requesterOf(tx, row.id);
    if (requester) dto.requester = toParty(requester, 'partner_contact');
    return dto;
  }

  // Solicitante: a funcao so devolve linha se a conexao estiver aprovada.
  const disclosure = await repo.disclosureOf(tx, row.id);
  if (disclosure) dto.disclosure = toParty(disclosure, row.disclosureLevel);
  return dto;
}

async function loadListing(tx: Tx, requestId: string): Promise<repo.ListingRow> {
  const listings = await repo.listingsOf(tx, [requestId]);
  const listing = listings.get(requestId);
  if (!listing) throw notFound('Conexão não encontrada.');
  return listing;
}

/** Marca como expirado o que venceu e registra o evento sem ator. */
async function sweepExpired(tx: Tx): Promise<void> {
  for (const id of await repo.expireStale(tx)) {
    await repo.insertEvent(tx, { connectionRequestId: id, type: 'expired' });
  }
}

export async function request(
  actor: ActorContext,
  input: CreateConnectionInput,
): Promise<ConnectionDto> {
  // Resolve o dono por funcao SECURITY DEFINER: quem pede nao enxerga
  // tenant_id em lugar nenhum, e continua sem enxergar -- o valor so carimba
  // a linha.
  const ownerTenantId = await repo.ownerOfListing(input.listingId);
  if (!ownerTenantId) throw notFound('Imóvel não encontrado na rede.');
  if (ownerTenantId === actor.tenantId) {
    throw validationFailed({ listingId: 'Este imóvel já é da sua carteira.' });
  }

  return withTenant(actor.tenantId, async (tx) => {
    await sweepExpired(tx);

    if (await repo.findPending(tx, input.listingId, actor.tenantId)) {
      throw validationFailed({ listingId: 'Você já tem um pedido pendente para este imóvel.' });
    }

    const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
    const row = await repo.insertRequest(tx, {
      propertyId: input.listingId,
      requesterTenantId: actor.tenantId,
      requesterUserId: actor.userId,
      ownerTenantId,
      message: input.message,
      expiresAt,
    });

    await repo.insertEvent(tx, {
      connectionRequestId: row.id,
      type: 'requested',
      actorTenantId: actor.tenantId,
      actorUserId: actor.userId,
    });
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'connection.requested',
      entityType: 'connection_request',
      entityId: row.id,
      metadata: { listingId: input.listingId },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });

    return hydrate(tx, row, actor, await loadListing(tx, row.id));
  });
}

export async function list(
  actor: ActorContext,
  options: { role: 'received' | 'sent'; status?: ConnectionStatus; limit: number; offset: number },
): Promise<{ items: ConnectionDto[]; total: number }> {
  return withTenant(actor.tenantId, async (tx) => {
    await sweepExpired(tx);

    const { rows, total } = await repo.list(tx, { ...options, tenantId: actor.tenantId });
    const listings = await repo.listingsOf(
      tx,
      rows.map((row) => row.id),
    );

    const items: ConnectionDto[] = [];
    for (const row of rows) {
      const listing = listings.get(row.id);
      if (listing) items.push(await hydrate(tx, row, actor, listing));
    }
    return { items, total };
  });
}

export async function getById(
  actor: ActorContext,
  id: string,
): Promise<{ connection: ConnectionDto; events: ConnectionEventDto[] }> {
  return withTenant(actor.tenantId, async (tx) => {
    await sweepExpired(tx);

    const row = await repo.findById(tx, id);
    // O RLS ja devolve zero linhas para quem nao e parte: 404, nunca 403.
    if (!row) throw notFound('Conexão não encontrada.');

    const connection = await hydrate(tx, row, actor, await loadListing(tx, row.id));

    // Primeira vez que o solicitante abre os dados revelados vira evento: e o
    // registro que sustenta uma disputa de comissao depois.
    if (connection.disclosure && !(await repo.hasDisclosureEvent(tx, row.id))) {
      await repo.insertEvent(tx, {
        connectionRequestId: row.id,
        type: 'disclosed',
        actorTenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
    }

    const events = await repo.listEvents(tx, row.id);
    return { connection, events: events.map((event) => toEventDto(event, actor.tenantId)) };
  });
}

type Decision = 'approved' | 'rejected' | 'cancelled';

async function transition(
  actor: ActorContext,
  id: string,
  decision: Decision,
  note: string | null,
): Promise<ConnectionDto> {
  return withTenant(actor.tenantId, async (tx) => {
    await sweepExpired(tx);

    const row = await repo.findById(tx, id);
    if (!row) throw notFound('Conexão não encontrada.');

    const isOwner = row.ownerTenantId === actor.tenantId;
    if (decision === 'cancelled' && isOwner) {
      throw forbidden('Só quem pediu pode cancelar. Para negar, recuse o pedido.');
    }
    if (decision !== 'cancelled' && !isOwner) {
      throw forbidden('Só o dono do imóvel decide o pedido.');
    }
    if (row.status !== 'pending') {
      throw validationFailed({ status: `Este pedido já está como "${row.status}".` });
    }

    const updated = await repo.updateRequest(tx, id, {
      status: decision,
      decisionNote: note,
      ...(decision === 'cancelled'
        ? {}
        : { decidedByUserId: actor.userId, decidedAt: new Date() }),
    });
    if (!updated) throw notFound('Conexão não encontrada.');

    await repo.insertEvent(tx, {
      connectionRequestId: id,
      type: decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'cancelled',
      actorTenantId: actor.tenantId,
      actorUserId: actor.userId,
    });
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: `connection.${decision}`,
      entityType: 'connection_request',
      entityId: id,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });

    return hydrate(tx, updated, actor, await loadListing(tx, id));
  });
}

export const approve = (actor: ActorContext, id: string, input: DecideConnectionInput) =>
  transition(actor, id, 'approved', input.note);

export const reject = (actor: ActorContext, id: string, input: DecideConnectionInput) =>
  transition(actor, id, 'rejected', input.note);

export const cancel = (actor: ActorContext, id: string) => transition(actor, id, 'cancelled', null);

/**
 * Revoga uma conexao aprovada. Operacao administrativa: a plataforma pode
 * revogar uma conexao de um parceiro suspenso ou por abuso.
 *
 * A revogacao e idempotente: revogar uma conexao ja revogada retorna sem erro.
 */
export async function revoke(
  actor: ActorContext,
  id: string,
  reason: string,
): Promise<ConnectionDto> {
  // Faz a revogacao via funcao SECURITY DEFINER.
  const result = await repo.revokeApproved(id, reason);
  if (!result) throw notFound('Conexão não encontrada.');

  const { wasApproved, status, ownerTenantId } = result;

  return withTenant(ownerTenantId, async (tx) => {
    const row = await repo.findById(tx, id);
    if (!row) throw notFound('Conexão não encontrada.');

    // Se nao estava approved, valida: so approved pode ser revogada.
    if (!wasApproved && status !== 'revoked') {
      throw validationFailed({ status: `Esta conexão não pode ser revogada (status: "${status}").` });
    }

    // Se foi revogada agora (wasApproved = true), registra o evento e auditoria.
    if (wasApproved) {
      await repo.insertEvent(tx, {
        connectionRequestId: id,
        type: 'revoked',
        metadata: { reason },
      });
      await recordAudit(tx, {
        tenantId: ownerTenantId,
        actorUserId: actor.userId,
        action: 'connection.revoked_by_platform',
        entityType: 'connection_request',
        entityId: id,
        metadata: { reason },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }

    return hydrate(tx, row, actor, await loadListing(tx, id));
  });
}
