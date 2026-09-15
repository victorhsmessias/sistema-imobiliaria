'use client';

import type { SessionUser } from '@imob/contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { BrandMark } from '@/components/BrandMark';
import { Icon, type IconName } from '@/components/Icon';
import { apiFetch, ApiError, refreshSession, safeNextPath } from '@/lib/api';
import styles from './login.module.css';

// O que o parceiro ganha e o que ele nao arrisca: as tres garantias do produto.
const FACTS: Array<{ icon: IconName; title: string; text: string }> = [
  {
    icon: 'search',
    title: 'Busca por bairro',
    text: 'A carteira de todos os parceiros num só lugar.',
  },
  {
    icon: 'lock',
    title: 'Quem anuncia não aparece',
    text: 'Nome, contato e endereço nunca saem da sua carteira.',
  },
  {
    icon: 'image',
    title: 'Fotos limpas',
    text: 'Sem GPS, autor nem dados da câmera.',
  },
];

export function LoginView() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Navegador reaberto: o cookie de acesso sumiu, mas o refresh token (30 dias)
  // continua valido. Tenta renovar em silencio antes de pedir senha.
  useEffect(() => {
    let active = true;
    refreshSession().then((ok) => {
      if (ok && active) router.replace(next);
    });
    return () => {
      active = false;
    };
  }, [next, router]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await apiFetch<{ user: SessionUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      router.replace(next);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível entrar agora.');
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <aside className={styles.stage}>
        <div className={styles.brand}>
          <BrandMark size={28} />
          <span className={styles.brandName}>Rede de parceria</span>
          <span className={styles.city}>Londrina</span>
        </div>

        <div className={styles.stageBody}>
          <div className={styles.pitch}>
            <p className={styles.headline}>A carteira de toda a rede, sem revelar quem anuncia.</p>
            <ul className={styles.facts}>
              {FACTS.map((fact) => (
                <li key={fact.title}>
                  <span className={styles.factIcon}>
                    <Icon name={fact.icon} />
                  </span>
                  <span>
                    <strong>{fact.title}</strong>
                    <span>{fact.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>

      <section className={styles.formSide}>
        <div className={styles.mobileBrand}>
          <BrandMark size={26} />
          <span className={styles.brandName}>Rede de parceria</span>
        </div>

        <div className={styles.formWrap}>
          <div className={styles.heading}>
            <h1 className="page-title">Entrar</h1>
            <p className="lead">Acesso restrito a imobiliárias e corretores parceiros.</p>
          </div>

          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}

            <div className="field">
              <label htmlFor="email">E-mail</label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="username"
                inputMode="email"
                placeholder="voce@imobiliaria.com.br"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="password">Senha</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Entrando…' : 'Entrar'}
            </button>
          </form>

          <p className={`hint ${styles.help}`}>Sem acesso? Fale com o administrador da rede.</p>
        </div>
      </section>
    </div>
  );
}
