'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useSession();
  const partner = user.tenant?.displayName ?? 'Plataforma';

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
