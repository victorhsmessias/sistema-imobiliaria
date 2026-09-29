'use client';

import type { ConnectionDto } from '@imob/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { BrandMark } from './BrandMark';
import { Icon } from './Icon';
import { useSession } from './SessionProvider';
import styles from './AppShell.module.css';

const NAV: Array<{ href: string; label: string; adminOnly?: boolean }> = [
  { href: '/busca', label: 'Buscar na rede' },
  { href: '/conexoes', label: 'Conexões' },
  { href: '/carteira', label: 'Minha carteira' },
  // Importar reescreve a carteira inteira: é operação de administrador.
  { href: '/importacao', label: 'Importação', adminOnly: true },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

/**
 * Total de mensagens nao lidas, somado das duas caixas.
 *
 * Recalcula a cada troca de pagina, sem rota nova: a lista ja traz
 * unreadCount. Sessao sem parceiro (admin da plataforma) nao tem conexao e
 * nao chama nada -- chamaria so para receber 401.
 */
function useUnreadConnections(enabled: boolean, pathname: string): number {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    Promise.all(
      (['received', 'sent'] as const).map((role) =>
        apiFetch<{ items: ConnectionDto[] }>(`/connections?role=${role}&limit=100`),
      ),
    )
      .then((lists) => {
        if (alive) setUnread(lists.flatMap((list) => list.items).reduce((sum, item) => sum + item.unreadCount, 0));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, pathname]);

  return unread;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useSession();
  const partner = user.tenant?.displayName ?? 'Plataforma';
  const unread = useUnreadConnections(Boolean(user.tenant), pathname);

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link href="/busca" className={styles.brand}>
          <BrandMark size={24} />
          <span className={styles.brandName}>Rede de parceria</span>
          <span className={styles.city}>Londrina</span>
        </Link>

        <nav className={styles.nav} aria-label="Principal">
          {NAV.filter((item) => !item.adminOnly || user.role === 'partner_admin').map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={styles.navLink}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
                {item.href === '/conexoes' && unread > 0 && (
                  <span className={styles.navCount} aria-label={`${unread} mensagens não lidas`}>
                    {unread}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className={styles.account}>
          <div className={styles.who}>
            <span className={styles.partner}>{partner}</span>
            <span className={styles.person}>{user.name}</span>
          </div>
          <span className={styles.avatar} aria-hidden="true">
            {initials(user.name)}
          </span>
          <button
            type="button"
            className={styles.logout}
            onClick={() => void logout()}
            aria-label="Sair"
            title="Sair"
          >
            <Icon name="logout" />
          </button>
        </div>
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  );
}
