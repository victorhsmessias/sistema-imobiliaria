import { NextResponse, type NextRequest } from 'next/server';

/**
 * Porteiro das telas autenticadas.
 *
 * Confere apenas a PRESENCA do cookie de acesso, nao a validade. Quem decide
 * se a sessao vale e a API, a cada request. Isto aqui so evita desenhar uma
 * tela vazia antes de mandar para o login.
 *
 * Sem o cookie de acesso (browser reaberto, por exemplo), o usuario vai para
 * /login -- e a tela de login tenta renovar a sessao em silencio com o
 * refresh token antes de pedir senha.
 */
export function middleware(request: NextRequest) {
  if (request.cookies.has('imob_at')) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Toda rota atras de sessao entra aqui. Faltando no matcher, a casca chega a
  // ser desenhada antes de o SessionProvider mandar para o login -- que e
  // exatamente o que este arquivo existe para evitar.
  matcher: [
    '/busca/:path*',
    '/carteira/:path*',
    '/imovel/:path*',
    '/conexoes/:path*',
    '/importacao/:path*',
  ],
};
