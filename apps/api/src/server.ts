import { closeDb } from '@imob/db';
import { buildApp } from './app.js';
import { env } from './env.js';

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'encerrando');
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'falha ao encerrar');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((error: unknown) => {
  console.error('[api] falha ao iniciar:', error);
  process.exit(1);
});
