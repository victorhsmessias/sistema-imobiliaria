import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/**
 * Carrega o .env da RAIZ do monorepo, nao o do cwd.
 *
 * Um unico .env para todos os pacotes. Duplicar credencial de banco entre
 * apps/api/.env e packages/db/.env e como os dois saem de sincronia e alguem
 * acaba rodando a API com a credencial de migration.
 *
 * Import com efeito colateral: `import './load-env.js'` antes de qualquer
 * modulo que leia process.env.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
config({ path: join(repoRoot, '.env') });

export { repoRoot };
