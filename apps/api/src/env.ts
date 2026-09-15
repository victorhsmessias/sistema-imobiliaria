import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

// .env unico, na raiz do monorepo.
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  /** Saltos de proxy confiaveis a frente da API (ver app.ts). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  API_PORT: z.coerce.number().int().positive().default(3333),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  // 32 bytes e o minimo para HS256 nao ser o elo fraco da cadeia.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de ao menos 32 caracteres'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // Storage S3-compativel: MinIO em dev, Cloudflare R2 em producao.
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Validade das URLs assinadas servidas em resultado de busca.
   *
   * Curta de proposito: a URL nao carrega identificacao do dono, mas e um
   * ponteiro direto para o arquivo. Cinco minutos bastam para a pagina
   * carregar e nao sobrevivem a um link colado num grupo de WhatsApp.
   */
  S3_SIGNED_URL_TTL: z.coerce.number().int().min(60).max(3600).default(300),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Configuracao invalida:\n${details}`);
}

export const env = parsed.data;

// Um segredo de exemplo em producao e a falha que ninguem percebe ate ser
// explorada: todo mundo que ja leu o repositorio consegue forjar sessao.
if (env.NODE_ENV === 'production') {
  if (env.JWT_SECRET.includes('troque-isto')) {
    throw new Error('JWT_SECRET ainda e o valor de exemplo do .env.example.');
  }
  if (!env.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE deve ser true em producao (cookie de sessao sem TLS).');
  }
}
