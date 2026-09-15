import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// .env vive na raiz do monorepo (ver src/load-env.ts).
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });

// drizzle-kit sempre fala com o banco como app_migrator: ele cria e altera
// tabelas. O runtime da aplicacao usa outra credencial (ver src/client.ts).
const url = process.env.DATABASE_URL_MIGRATOR;
if (!url) {
  throw new Error('DATABASE_URL_MIGRATOR ausente. Copie .env.example para .env na raiz do repo.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
