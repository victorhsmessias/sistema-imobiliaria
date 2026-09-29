import type {
  ConnectionDto,
  ConnectionEventDto,
  ConnectionListing,
  ConnectionMessageDto,
  ConnectionStatus,
  CreateConnectionInput,
  DecideConnectionInput,
  MessageListQuery,
  SendMessageInput,
} from '@imob/contracts';
import { withLateTenant, withTenant, type ConnectionEvent, type ConnectionRequest, type Tx } from '@imob/db';
import { maskContacts } from '../../lib/contact-filter.js';
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
 * O que cada lado enxerga da outra parte: so a marca. O dono ve quem pediu
 * desde o pedido; quem pediu ve o dono so depois do aceite. Contato de pessoa
 * nunca atravessa -- a negociacao segue pelas mensagens da conexao.
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
  unreadCount: number,
): Promise<ConnectionDto> {
  const role = row.ownerTenantId === actor.tenantId ? 'owner' : 'requester';

  const dto: ConnectionDto = {
    id: row.id,
    status: row.status,
    role,
    message: row.message,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    listing: toListing(listing),
    unreadCount,
  };

  // A funcao do banco decide se a marca aparece: para o dono, sempre; para
  // quem pediu, so em approved/revoked. Aqui so se copia o que ela liberou.
  const party =
    role === 'owner' ? await repo.requesterOf(tx, row.id) : await repo.disclosureOf(tx, row.id);
  if (party) dto.counterpart = { partnerName: party.partner_name };

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

    // O recado e texto livre para o dono: contato digitado nao atravessa.
    const recado = input.message === null ? null : maskContacts(input.message);

    const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
    const row = await repo.insertRequest(tx, {
      propertyId: input.listingId,
      requesterTenantId: actor.tenantId,
      requesterUserId: actor.userId,
      ownerTenantId,
      message: recado?.text ?? null,
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

    if (recado?.masked) {
      // Recado nao tem coluna de original: ele fica na auditoria de quem
      // escreveu, que o outro lado nao le.
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'connection.message_masked',
        entityType: 'connection_request',
        entityId: row.id,
        metadata: { field: 'message', original: input.message },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }

    return hydrate(tx, row, actor, await loadListing(tx, row.id), 0);
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
    const unread = await repo.unreadCounts(tx, actor.tenantId, rows.map((row) => row.id));

    const items: ConnectionDto[] = [];
    for (const row of rows) {
      const listing = listings.get(row.id);
      if (listing) items.push(await hydrate(tx, row, actor, listing, unread.get(row.id) ?? 0));
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

    const unread = await repo.unreadCounts(tx, actor.tenantId, [row.id]);
    const connection = await hydrate(tx, row, actor, await loadListing(tx, row.id), unread.get(row.id) ?? 0);
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

    // A nota vai para a outra parte: contato digitado nao atravessa.
    const filtered = note === null ? null : maskContacts(note);

    const updated = await repo.updateRequest(tx, id, {
      status: decision,
      decisionNote: filtered?.text ?? null,
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

    if (filtered?.masked) {
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'connection.message_masked',
        entityType: 'connection_request',
        entityId: id,
        metadata: { field: 'decision_note', original: note },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }

    return hydrate(tx, updated, actor, await loadListing(tx, id), 0);
  });
}

export const approve = (actor: ActorContext, id: string, input: DecideConnectionInput) =>
  transition(actor, id, 'approved', input.note);

export const reject = (actor: ActorContext, id: string, input: DecideConnectionInput) =>
  transition(actor, id, 'rejected', input.note);

export const cancel = (actor: ActorContext, id: string) => transition(actor, id, 'cancelled', null);

/** Quem age em nome da plataforma: platform_admin nao tem tenant. */
export type PlatformActor = Omit<ActorContext, 'tenantId'>;

/**
 * Revoga uma conexao aprovada. Operacao administrativa: a plataforma pode
 * revogar uma conexao de um parceiro suspenso ou por abuso.
 *
 * A revogacao e idempotente: revogar uma conexao ja revogada retorna sem erro.
 *
 * Tudo numa transacao so: a funcao SECURITY DEFINER muda o status e devolve o
 * dono; so entao a transacao assume o tenant do dono para gravar evento e
 * auditoria. Se qualquer passo falhar, o status volta a `approved`.
 */
export async function revoke(
  actor: PlatformActor,
  id: string,
  reason: string,
): Promise<ConnectionDto> {
  return withLateTenant(async (tx, enterTenant) => {
    const result = await repo.revokeApproved(tx, id, reason);
    if (!result) throw notFound('Conexão não encontrada.');

    const { wasApproved, status, ownerTenantId } = result;
    if (!wasApproved && status !== 'revoked') {
      throw validationFailed({ status: `Esta conexão não pode ser revogada (status: "${status}").` });
    }

    await enterTenant(ownerTenantId);
    const row = await repo.findById(tx, id);
    if (!row) throw notFound('Conexão não encontrada.');

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

    // A resposta sai na visao do dono: e a unica que nao revela nada alem do
    // que a plataforma ja sabe (o solicitante aparece para o dono desde o pedido).
    const ownerView: ActorContext = { ...actor, tenantId: ownerTenantId };
    const unread = await repo.unreadCounts(tx, ownerTenantId, [id]);
    return hydrate(tx, row, ownerView, await loadListing(tx, id), unread.get(id) ?? 0);
  });
}

/**
 * Mensagens por pagina. Conversa de conexao e curta; carregar as anteriores
 * fica para quando alguem precisar (hasMore ja avisa).
 */
const MESSAGE_PAGE = 200;

function toMessageDto(row: repo.MessageRow, actorTenantId: string): ConnectionMessageDto {
  return {
    id: row.id,
    body: row.body,
    author: row.senderTenantId === actorTenantId ? 'you' : 'other',
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Conversa da conexao. Sem `after`, as 200 mais recentes; com `after`, as
 * posteriores a essa mensagem (a atualizacao periodica da tela).
 */
export async function listMessages(
  actor: ActorContext,
  id: string,
  query: MessageListQuery,
): Promise<{ items: ConnectionMessageDto[]; hasMore: boolean }> {
  return withTenant(actor.tenantId, async (tx) => {
    // O RLS ja devolve zero linhas para quem nao e parte: 404, nunca 403.
    if (!(await repo.findById(tx, id))) throw notFound('Conexão não encontrada.');

    let page: repo.MessageRow[];
    let hasMore: boolean;
    if (query.after) {
      if (!(await repo.findMessage(tx, id, query.after))) throw notFound('Mensagem não encontrada.');
      const rows = await repo.messagesAfter(tx, id, query.after, MESSAGE_PAGE + 1);
      hasMore = rows.length > MESSAGE_PAGE;
      page = rows.slice(0, MESSAGE_PAGE);
    } else {
      const rows = await repo.latestMessages(tx, id, MESSAGE_PAGE + 1);
      hasMore = rows.length > MESSAGE_PAGE;
      page = rows.slice(0, MESSAGE_PAGE).reverse();
    }

    return { items: page.map((row) => toMessageDto(row, actor.tenantId)), hasMore };
  });
}

/**
 * Envia uma mensagem. So em conexao aprovada: revogada fica so leitura.
 *
 * O contato digitado e mascarado antes de gravar. O original fica em
 * body_original, que a aplicacao nao consegue ler; a auditoria registra que
 * a mascara agiu, para a plataforma achar reincidencia.
 */
export async function sendMessage(
  actor: ActorContext,
  id: string,
  input: SendMessageInput,
): Promise<{ message: ConnectionMessageDto; masked: boolean }> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await repo.findById(tx, id);
    if (!row) throw notFound('Conexão não encontrada.');
    if (row.status !== 'approved') {
      throw validationFailed({ status: 'A conversa só existe em conexão aprovada.' });
    }

    const filtered = maskContacts(input.body);
    const message = await repo.insertMessage(tx, {
      connectionRequestId: id,
      senderTenantId: actor.tenantId,
      senderUserId: actor.userId,
      body: filtered.text,
      bodyOriginal: filtered.masked ? input.body : null,
    });

    if (filtered.masked) {
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'connection.message_masked',
        entityType: 'connection_request',
        entityId: id,
        metadata: { field: 'body', messageId: message.id },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }

    return { message: toMessageDto(message, actor.tenantId), masked: filtered.masked };
  });
}

/** Marca a conversa como lida ate agora, pelo lado de quem chamou. */
export async function markRead(actor: ActorContext, id: string): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    if (!(await repo.findById(tx, id))) throw notFound('Conexão não encontrada.');
    await repo.markRead(tx, id, actor.tenantId);
  });
}
