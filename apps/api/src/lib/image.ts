import sharp from 'sharp';
import { AppError } from './errors.js';
import { ERROR_CODES } from '@imob/contracts';

/** Maior lado da imagem servida. Acima disso nao agrega nada num anuncio. */
const MAX_DIMENSION = 1920;
const WEBP_QUALITY = 82;

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  contentType: 'image/webp';
  byteSize: number;
}

const ACCEPTED = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif', 'heif', 'tiff']);

/**
 * Normaliza e SANITIZA uma foto enviada pelo parceiro.
 *
 * O ponto central nao e o resize: e o que sai fora.
 *
 * Uma foto de imovel tirada no celular carrega EXIF com coordenada GPS exata
 * do imovel, modelo do aparelho, data, e muitas vezes campos Artist e
 * Copyright preenchidos com o nome da imobiliaria. Servir esse arquivo no
 * resultado de busca entrega o dono e o endereco com todos os campos do JSON
 * perfeitamente anonimizados -- o vazamento vai dentro do binario.
 *
 * O sharp descarta todos os metadados por padrao ao reencodar; o que NAO
 * pode acontecer e alguem acrescentar `.withMetadata()` aqui. A suite tem um
 * teste que le o EXIF da saida justamente para impedir isso.
 *
 * Reencodar para WebP tambem normaliza o formato: um unico tipo de arquivo
 * servido, sem PNG de 12 MB nem HEIC que metade dos navegadores nao abre.
 */
export async function processPropertyImage(input: Buffer): Promise<ProcessedImage> {
  let pipeline: sharp.Sharp;
  let metadata: sharp.Metadata;

  try {
    pipeline = sharp(input, { failOn: 'error' });
    metadata = await pipeline.metadata();
  } catch {
    throw new AppError(422, ERROR_CODES.VALIDATION, 'O arquivo não é uma imagem válida.');
  }

  if (!metadata.format || !ACCEPTED.has(metadata.format)) {
    throw new AppError(
      422,
      ERROR_CODES.VALIDATION,
      `Formato "${metadata.format ?? 'desconhecido'}" não suportado. Envie JPEG, PNG, WebP ou HEIC.`,
    );
  }

  const output = await pipeline
    // rotate() sem argumento aplica a orientacao do EXIF e depois a descarta.
    // Sem isso, remover o EXIF deixaria fotos de celular deitadas.
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: output.data,
    width: output.info.width,
    height: output.info.height,
    contentType: 'image/webp',
    byteSize: output.data.byteLength,
  };
}

/** Lê os metadados de um buffer. Usado pelos testes para provar que o EXIF sumiu. */
export async function readMetadata(buffer: Buffer): Promise<sharp.Metadata> {
  return sharp(buffer).metadata();
}
