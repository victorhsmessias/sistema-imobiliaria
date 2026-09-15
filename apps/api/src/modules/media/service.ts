import type { PropertyMediaDto } from '@imob/contracts';
import { withTenant } from '@imob/db';
import { notFound, validationFailed } from '../../lib/errors.js';
import { processPropertyImage } from '../../lib/image.js';
import { buildStorageKey, deleteObject, putObject, signedReadUrl } from '../../lib/storage.js';
import { recordAudit } from '../audit/service.js';
import type { ActorContext } from '../properties/service.js';
import * as repo from './repository.js';

function toDto(row: Awaited<ReturnType<typeof repo.listByProperty>>[number]): PropertyMediaDto {
  return {
    id: row.id,
    kind: row.kind,
    position: row.position,
    width: row.width,
    height: row.height,
    sanitizedAt: row.sanitizedAt?.toISOString() ?? null,
  };
}

export async function upload(
  actor: ActorContext,
  propertyId: string,
  input: { buffer: Buffer; originalFilename: string | null },
): Promise<PropertyMediaDto> {
  // Processa ANTES de tocar no banco: se o arquivo nao presta, nada foi
  // gravado nem enviado ao bucket.
  const image = await processPropertyImage(input.buffer);
  const storageKey = buildStorageKey('webp');

  await putObject(storageKey, image.buffer, image.contentType);

  try {
    return await withTenant(actor.tenantId, async (tx) => {
      if (!(await repo.propertyExists(tx, propertyId))) {
        throw notFound('Imóvel não encontrado.');
      }

      const position = await repo.nextPosition(tx, propertyId);

      const { id } = await repo.insertMedia(tx, {
        tenantId: actor.tenantId,
        propertyId,
        storageKey,
        kind: 'photo',
        position,
        width: image.width,
        height: image.height,
        byteSize: image.byteSize,
        contentType: image.contentType,
        originalFilename: input.originalFilename,
        // Marcado agora porque a sanitizacao ja aconteceu, de forma sincrona,
        // em processPropertyImage(). Se um dia o processamento virar fila,
        // este campo passa a ser preenchido pelo worker -- e ate la a foto
        // nao aparece na rede, que e exatamente o comportamento desejado.
        sanitizedAt: new Date(),
      });

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'media.uploaded',
        entityType: 'property_media',
        entityId: id,
        metadata: { propertyId, width: image.width, height: image.height },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });

      const all = await repo.listByProperty(tx, propertyId);
      const created = all.find((m) => m.id === id);
      if (!created) throw new Error('midia recem-criada nao encontrada');
      return toDto(created);
    });
  } catch (error) {
    // O objeto ja subiu; se o banco recusou, ele viraria lixo permanente no
    // bucket sem nenhuma linha apontando para ele.
    await deleteObject(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function list(actor: ActorContext, propertyId: string): Promise<PropertyMediaDto[]> {
  return withTenant(actor.tenantId, async (tx) => {
    if (!(await repo.propertyExists(tx, propertyId))) {
      throw notFound('Imóvel não encontrado.');
    }
    const rows = await repo.listByProperty(tx, propertyId);
    return rows.map(toDto);
  });
}

export async function remove(actor: ActorContext, mediaId: string): Promise<void> {
  const storageKey = await withTenant(actor.tenantId, async (tx) => {
    const media = await repo.findOwnMedia(tx, mediaId);
    if (!media) throw notFound('Mídia não encontrada.');

    await repo.deleteMedia(tx, mediaId);
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'media.deleted',
      entityType: 'property_media',
      entityId: mediaId,
      metadata: { propertyId: media.propertyId },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });

    return media.storageKey;
  });

  // Depois do commit: um objeto orfao no bucket e desperdicio, mas uma linha
  // apontando para um objeto que ja nao existe e foto quebrada na tela.
  await deleteObject(storageKey).catch(() => undefined);
}

export async function reorder(
  actor: ActorContext,
  propertyId: string,
  orderedIds: string[],
): Promise<PropertyMediaDto[]> {
  return withTenant(actor.tenantId, async (tx) => {
    if (!(await repo.propertyExists(tx, propertyId))) {
      throw notFound('Imóvel não encontrado.');
    }

    const current = await repo.listByProperty(tx, propertyId);
    const currentIds = new Set(current.map((m) => m.id));

    if (orderedIds.length !== current.length || orderedIds.some((id) => !currentIds.has(id))) {
      throw validationFailed({
        order: 'A ordem precisa incluir todas as fotos deste imóvel, sem repetir.',
      });
    }

    for (const [index, id] of orderedIds.entries()) {
      await repo.setPosition(tx, id, index);
    }

    const updated = await repo.listByProperty(tx, propertyId);
    return updated.map(toDto);
  });
}

/** URL assinada para a propria carteira. */
export async function ownMediaUrl(actor: ActorContext, mediaId: string): Promise<string> {
  const storageKey = await withTenant(actor.tenantId, async (tx) => {
    const media = await repo.findOwnMedia(tx, mediaId);
    if (!media) throw notFound('Mídia não encontrada.');
    return media.storageKey;
  });

  return signedReadUrl(storageKey);
}

/**
 * URL assinada para uma foto vista na busca da rede.
 *
 * A chave de storage nunca chega ao cliente: ela e resolvida aqui e trocada
 * por uma URL assinada de vida curta. O cliente recebe um ponteiro temporario
 * para bytes, e nada que diga de quem e o imovel.
 */
export async function networkMediaUrl(listingId: string, mediaId: string): Promise<string> {
  const storageKey = await repo.networkMediaStorageKey(listingId, mediaId);
  // Midia nao sanitizada, imovel fora da rede ou id de outro anuncio caem
  // todos aqui, com a mesma resposta: nao existe.
  if (!storageKey) throw notFound('Foto não encontrada.');
  return signedReadUrl(storageKey);
}
