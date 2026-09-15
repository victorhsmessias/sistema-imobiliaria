import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { asc, createMigratorDb, eq, properties, propertyMedia, tenants, withTenant } from '@imob/db';
import { env } from '../env.js';
import { buildStorageKey, putObject, s3Client } from '../lib/storage.js';
import { renderDemoPhoto } from './demo-photos.js';

/**
 * Fotos de demonstracao no storage.
 *
 * O seed cria as linhas de property_media, mas nao gera bytes: ele roda no
 * pacote do banco, sem sharp nem cliente S3. Sem este passo cada foto do seed
 * aponta para um objeto que nao existe, e a tela mostra "Arquivo nao
 * encontrado".
 *
 * Idempotente: midia cujo objeto ja esta no bucket e pulada, entao rodar de
 * novo nao reenvia nada e nao toca em foto enviada por um parceiro.
 *
 * Tambem troca chave nao opaca por media/<uuid>/<uuid>.webp. As chaves antigas
 * do seed levavam o slug da imobiliaria ("alfa-imoveis-0-0.webp"), e a chave
 * aparece na URL assinada que o navegador recebe na busca: o dono vazaria pelo
 * endereco da foto (ver buildStorageKey).
 *
 * Conecta como app_migrator, mas le e grava dentro de withTenant, parceiro por
 * parceiro: property_media tem FORCE ROW LEVEL SECURITY, igual ao seed.
 */

const OPAQUE_KEY = /^media\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/i;

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw error;
  }
}

interface MediaUpdate {
  id: string;
  storageKey: string;
  width: number;
  height: number;
  byteSize: number;
}

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('seed:media grava fotos ficticias e nao roda em producao.');
  }

  const { db, pool } = createMigratorDb();
  let uploaded = 0;
  let rekeyed = 0;
  let skipped = 0;

  try {
    // tenants tem RLS habilitado, mas nao forcado: app_migrator e o dono e le todos.
    const tenantRows = await db
      .select({ id: tenants.id, name: tenants.displayName })
      .from(tenants)
      .orderBy(asc(tenants.displayName));

    for (const tenant of tenantRows) {
      const rows = await withTenant(
        tenant.id,
        (tx) =>
          tx
            .select({
              id: propertyMedia.id,
              storageKey: propertyMedia.storageKey,
              position: propertyMedia.position,
              propertyId: propertyMedia.propertyId,
              type: properties.type,
            })
            .from(propertyMedia)
            .innerJoin(properties, eq(properties.id, propertyMedia.propertyId))
            .orderBy(asc(propertyMedia.propertyId), asc(propertyMedia.position)),
        db,
      );

      // Envio fora da transacao: gerar e subir centenas de imagens nao deve
      // segurar uma transacao aberta no banco.
      const updates: MediaUpdate[] = [];
      for (const row of rows) {
        const opaque = OPAQUE_KEY.test(row.storageKey);
        if (opaque && (await objectExists(row.storageKey))) {
          skipped++;
          continue;
        }

        const photo = await renderDemoPhoto({
          propertyId: row.propertyId,
          type: row.type,
          position: row.position,
        });
        const storageKey = opaque ? row.storageKey : buildStorageKey('webp');
        await putObject(storageKey, photo.buffer, 'image/webp');

        updates.push({
          id: row.id,
          storageKey,
          width: photo.width,
          height: photo.height,
          byteSize: photo.byteSize,
        });
        uploaded++;
        if (!opaque) rekeyed++;
      }

      if (updates.length > 0) {
        await withTenant(
          tenant.id,
          async (tx) => {
            for (const update of updates) {
              await tx
                .update(propertyMedia)
                .set({
                  storageKey: update.storageKey,
                  width: update.width,
                  height: update.height,
                  byteSize: update.byteSize,
                  contentType: 'image/webp',
                })
                .where(eq(propertyMedia.id, update.id));
            }
          },
          db,
        );
      }

      console.log(`[seed:media]   ${tenant.name}: ${updates.length} enviadas, ${rows.length - updates.length} ja existiam`);
    }

    console.log('');
    console.log('[seed:media] resumo');
    console.log(`[seed:media]   fotos enviadas ......... ${uploaded}`);
    console.log(`[seed:media]   chaves trocadas ........ ${rekeyed}`);
    console.log(`[seed:media]   ja no storage .......... ${skipped}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[seed:media] falhou:', error);
  process.exit(1);
});
