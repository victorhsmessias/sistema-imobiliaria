import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@imob/contracts'],

  /**
   * Imagem de producao enxuta: o `standalone` empacota so o que o app usa,
   * em vez de carregar o node_modules inteiro do monorepo.
   *
   * outputFileTracingRoot aponta para a raiz do workspace -- sem isso o Next
   * rastreia a partir de apps/web e deixa de fora os pacotes internos
   * (@imob/contracts), e o container sobe e quebra na primeira pagina.
   */
  output: 'standalone',
  outputFileTracingRoot: join(here, '..', '..'),

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // same-origin: quando o navegador carrega a foto direto do storage
          // (URL assinada), o Referer nao leva junto o endereco da tela --
          // "/carteira/<id-do-imovel>" nao tem por que chegar ao bucket.
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
