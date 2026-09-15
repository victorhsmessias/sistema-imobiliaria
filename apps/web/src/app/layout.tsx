import type { Metadata, Viewport } from 'next';
import { Archivo } from 'next/font/google';
import './globals.css';

// Fonte variavel com o eixo de largura: e ele que diferencia titulo de dado.
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  display: 'swap',
  variable: '--font-archivo',
});

export const metadata: Metadata = {
  title: {
    default: 'Rede de parceria',
    template: '%s | Rede de parceria',
  },
  description: 'Rede fechada de imobiliárias e corretores parceiros de Londrina.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#1b4f4a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={archivo.variable}>
      <body>{children}</body>
    </html>
  );
}
