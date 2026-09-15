import { z } from 'zod';

/**
 * Formato unico de erro da API.
 *
 * `code` e estavel e destinado a codigo; `message` e para humanos e pode mudar.
 * O front nunca deve ramificar por texto de mensagem.
 */
export const apiError = z.object({
  code: z.string(),
  message: z.string(),
  /** Erros por campo, quando a falha e de validacao. */
  fields: z.record(z.string(), z.string()).optional(),
});
export type ApiError = z.infer<typeof apiError>;

export const ERROR_CODES = {
  VALIDATION: 'validation_error',
  INVALID_CREDENTIALS: 'invalid_credentials',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  INTERNAL: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
