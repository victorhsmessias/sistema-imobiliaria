import type { NextRequest } from 'next/server';

/**
 * BFF: o navegador so fala com o Next, e o Next repassa para a API.
 *
 * Tres motivos para existir, e nenhum deles e conveniencia:
 *
 * 1. Cookie de sessao no dominio do site. A API emite o cookie; aqui ele e
 *    reescrito sem `Domain` (fica preso ao host do site) e com o path do
 *    refresh ajustado de `/auth` para `/api/auth`. Sem o ajuste de path, o
 *    navegador nunca mandaria o refresh token para `/api/auth/refresh`, e a
 *    sessao cairia a cada 15 minutos.
 *
 * 2. A API nao fica exposta. Em producao ela so e alcancavel pela rede
 *    interna do EasyPanel; o unico caminho publico ate ela e este arquivo,
 *    e ele so repassa os prefixos listados abaixo.
 *
 * 3. O IP do cliente chega a API. O X-Forwarded-For e repassado sem
 *    acrescimo, e a API confia em exatamente um salto (este). Sem isso,
 *    todos os usuarios chegariam com o IP do servidor Next e dividiriam o
 *    mesmo rate limit de login -- oito tentativas erradas de um corretor
 *    bloqueariam a rede inteira.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const API_BASE = process.env.API_INTERNAL_URL ?? 'http://localhost:3333';

/** Nao e um proxy aberto: so estes prefixos chegam a API. */
const ALLOWED_PREFIXES = new Set(['auth', 'catalog', 'properties', 'network', 'imports']);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
]);

function rewriteSetCookie(cookie: string): string {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part))
    .map((part) => (/^path=\/auth\b/i.test(part) ? part.replace(/^path=\/auth/i, 'Path=/api/auth') : part))
    .join('; ');
}

async function proxy(request: NextRequest): Promise<Response> {
  const subpath = request.nextUrl.pathname.replace(/^\/api\/?/, '');
  const prefix = subpath.split('/')[0] ?? '';

  if (!ALLOWED_PREFIXES.has(prefix)) {
    return Response.json({ code: 'not_found', message: 'Rota inexistente.' }, { status: 404 });
  }

  const target = new URL(`/${subpath}${request.nextUrl.search}`, API_BASE);

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Fotos respondem 302 para a URL assinada do storage. O navegador tem
      // que seguir o redirect sozinho: se o Next seguisse, os bytes passariam
      // por esta maquina -- e a VPS nao e CDN.
      redirect: 'manual',
      cache: 'no-store',
      // Obrigatorio para repassar corpo em streaming (upload de foto).
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch {
    return Response.json(
      { code: 'upstream_unavailable', message: 'Servidor indisponível. Tente novamente em instantes.' },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    // content-encoding cai porque o fetch ja descomprimiu o corpo; repassar o
    // cabecalho faria o navegador tentar descomprimir de novo.
    if (name === 'set-cookie' || name === 'content-encoding' || HOP_BY_HOP.has(name)) return;
    responseHeaders.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', rewriteSetCookie(cookie));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
