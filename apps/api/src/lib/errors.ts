import { ERROR_CODES, type ErrorCode } from '@imob/contracts';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthenticated = (msg = 'Sessão inválida ou expirada.') =>
  new AppError(401, ERROR_CODES.UNAUTHENTICATED, msg);

export const invalidCredentials = () =>
  // Mensagem unica de proposito: distinguir "e-mail nao existe" de "senha
  // errada" entrega a lista de parceiros da rede a quem tentar adivinhar.
  new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, 'E-mail ou senha incorretos.');

export const forbidden = (msg = 'Sem permissão para esta operação.') =>
  new AppError(403, ERROR_CODES.FORBIDDEN, msg);

/**
 * 404, nunca 403, para recurso de outro parceiro.
 *
 * Responder 403 confirmaria que o imovel existe, o que ja e informacao: com
 * uma sequencia de ids um parceiro mapearia o tamanho da carteira alheia.
 */
export const notFound = (msg = 'Não encontrado.') =>
  new AppError(404, ERROR_CODES.NOT_FOUND, msg);

export const validationFailed = (fields: Record<string, string>) =>
  new AppError(422, ERROR_CODES.VALIDATION, 'Dados inválidos.', fields);
