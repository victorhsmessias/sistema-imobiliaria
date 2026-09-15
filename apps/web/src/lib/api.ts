export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Uma unica renovacao de sessao por vez.
 *
 * O refresh token e de uso unico: a API o invalida no instante em que o
 * consome. Se a tela de busca disparar tres requests e as tres voltarem 401
 * juntas, tres renovacoes paralelas fariam a segunda e a terceira serem
 * tratadas como reuso de token roubado -- e a sessao cairia. Compartilhar a
 * mesma promessa faz as tres esperarem uma unica renovacao.
 */
let refreshing: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export function safeNextPath(raw: string | null | undefined): string {
  // Evita redirect aberto: so caminhos internos, nunca "//outro-site.com".
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/busca';
  return raw;
}

function goToLogin(): void {
  if (typeof window === 'undefined') return;
  const next = window.location.pathname + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

interface Options extends RequestInit {
  /** Interno: evita renovar a sessao em loop. */
  retried?: boolean;
}

export async function apiFetch<T>(path: string, options: Options = {}): Promise<T> {
  const { retried, ...init } = options;
  const isForm = init.body instanceof FormData;

  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (response.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      return apiFetch<T>(path, { ...options, retried: true });
    }
    goToLogin();
    throw new ApiError(401, 'unauthenticated', 'Sua sessão expirou. Entre novamente.');
  }

  if (!response.ok) {
    let body: { code?: string; message?: string; fields?: Record<string, string> } = {};
    try {
      body = await response.json();
    } catch {
      // corpo vazio ou nao-JSON: segue com a mensagem generica abaixo
    }
    throw new ApiError(
      response.status,
      body.code ?? 'error',
      body.message ?? 'Não foi possível concluir a operação.',
      body.fields,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
