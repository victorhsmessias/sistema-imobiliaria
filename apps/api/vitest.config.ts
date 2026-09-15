import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Um log por request afoga a saida da suite; o que importa e o resultado
    // das assercoes. Para depurar um teste, rode com LOG_LEVEL=debug.
    env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
    // Fala com Postgres real e compartilha o estado do seed entre arquivos.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
  },
});
