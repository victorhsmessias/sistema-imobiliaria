import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@imob/contracts'],

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
