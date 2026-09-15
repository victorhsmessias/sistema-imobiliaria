import { randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';

// Argon2id. O pacote declara Algorithm como `declare const enum`, que
// isolatedModules proibe ler em tempo de compilacao -- dai o literal.
// Mapeamento publico e estavel: Argon2d = 0, Argon2i = 1, Argon2id = 2.
const ARGON2ID = 2 as Algorithm;

/**
 * OWASP Password Storage Cheat Sheet para Argon2id: 19 MiB, t=2, p=1.
 *
 * Estes parametros precisam bater com os de packages/db/src/seed.ts, senao os
 * usuarios de demonstracao nao conseguem entrar. Ao mudar um, mude o outro.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain);
  } catch {
    // Hash corrompido ou em formato desconhecido. Para o chamador e o mesmo
    // que senha errada -- nunca uma excecao que vire 500 no login.
    return false;
  }
}

/**
 * Hash de referencia para equalizar o tempo de resposta quando o e-mail nao
 * existe.
 *
 * Sem isso, "usuario inexistente" responde em ~1 ms e "senha errada" em ~50 ms.
 * A diferenca e medivel de fora e permite descobrir quais e-mails pertencem a
 * parceiros da rede -- num produto cujo valor e justamente esconder quem esta
 * na rede.
 *
 * E gerado no boot a partir de uma senha aleatoria, e nao escrito a mao: um
 * literal invalido faria o verify falhar no parse em microssegundos, sem
 * gastar o tempo que ele existe para gastar. O bug seria invisivel.
 */
let dummyHash: Promise<string> | null = null;

export function referenceHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHash;
}
