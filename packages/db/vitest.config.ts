import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Os testes falam com um Postgres real. RLS nao e mockavel: o que estamos
    // verificando E o comportamento do banco. Rodar em serie evita que um
    // arquivo trunque tabela enquanto outro le.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
  },
});
