import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

/**
 * Storage S3-compativel: MinIO em dev, Cloudflare R2 em producao.
 *
 * O mesmo protocolo dos dois lados e deliberado -- o que roda em localhost e o
 * que vai rodar na VPS sao o mesmo codigo, sem caminho alternativo que so e
 * exercitado em producao.
 */
const client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

/**
 * Gera uma chave OPACA para o arquivo.
 *
 * Nada na chave diz de quem e o imovel: nem tenant, nem nome de imobiliaria,
 * nem o nome original do arquivo. Dois UUIDs e a extensao.
 *
 * Isso importa porque a chave vira parte da URL assinada que o solicitante
 * recebe no resultado de busca. Uma chave como
 * "alfa-imoveis/2026/foto-fachada-alfa.webp" entregaria o dono no proprio
 * endereco da imagem, com todos os outros campos perfeitamente anonimizados.
 */
export function buildStorageKey(extension = 'webp'): string {
  return `media/${randomUUID()}/${randomUUID()}.${extension}`;
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Sem metadata de origem: o proprio objeto no bucket nao deve carregar
      // pistas do dono, nem para quem tenha acesso ao storage.
      CacheControl: 'private, max-age=300',
    }),
  );
}

/** URL assinada de leitura, de vida curta (env.S3_SIGNED_URL_TTL). */
export async function signedReadUrl(key: string): Promise<string> {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), {
    expiresIn: env.S3_SIGNED_URL_TTL,
  });
}

export async function deleteObject(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

export { client as s3Client };
