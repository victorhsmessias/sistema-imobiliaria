import { z } from 'zod';

/**
 * Importacao de carteira via XML VrSync.
 *
 * Tudo aqui e visao do PROPRIO parceiro: fonte, execucoes e o relatorio por
 * anuncio. Nada disto atravessa a fronteira de tenant.
 */

export const importSourceInput = z.object({
  name: z.string().trim().min(2, 'Dê um nome ao feed.').max(120),
  feedUrl: z
    .string()
    .trim()
    .max(2000)
    .url('Informe a URL completa do feed.')
    .refine((value) => /^https?:\/\//i.test(value), 'O feed precisa ser http ou https.')
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  publishToNetwork: z.boolean().default(true),
});
export type ImportSourceInput = z.infer<typeof importSourceInput>;

export const importSourceDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  format: z.literal('vrsync'),
  feedUrl: z.string().nullable(),
  publishToNetwork: z.boolean(),
  active: z.boolean(),
  lastRunAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ImportSourceDto = z.infer<typeof importSourceDto>;

export const importJobStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type ImportJobStatus = z.infer<typeof importJobStatus>;

export const importItemStatus = z.enum([
  'created',
  'updated',
  'unchanged',
  'archived',
  'skipped',
  'needs_curation',
  'failed',
]);
export type ImportItemStatus = z.infer<typeof importItemStatus>;

export const importStats = z.object({
  listings: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  archived: z.number().int(),
  skipped: z.number().int(),
  needsCuration: z.number().int(),
  failed: z.number().int(),
  photosDownloaded: z.number().int(),
  photosReused: z.number().int(),
  photosFailed: z.number().int(),
  photosRemoved: z.number().int(),
});
export type ImportStats = z.infer<typeof importStats>;

export const importJobDto = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  status: importJobStatus,
  dryRun: z.boolean(),
  stats: importStats.partial(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ImportJobDto = z.infer<typeof importJobDto>;

export const importItemDto = z.object({
  id: z.string().uuid(),
  externalId: z.string().nullable(),
  propertyId: z.string().uuid().nullable(),
  status: importItemStatus,
  changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  /**
   * O <Listing> original, so para item que precisa de curadoria ou falhou --
   * e o que permite ao curador ver como o bairro veio escrito (e o <Zone>,
   * quando a cidade tem bairros homonimos).
   */
  rawPayload: z.unknown().optional(),
});
export type ImportItemDto = z.infer<typeof importItemDto>;

/** Dry-run e o padrao: gravar exige pedir explicitamente. */
export const runImportQuery = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});
