import type { z } from 'zod';
import { validationFailed } from './errors.js';

/**
 * Valida com zod ou lanca 422 com erro por campo.
 *
 * Primeira mensagem por caminho: se um campo falha em duas regras, mostrar as
 * duas de uma vez nao ajuda quem esta preenchendo o formulario.
 */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || 'body';
    fields[key] ??= issue.message;
  }
  throw validationFailed(fields);
}
