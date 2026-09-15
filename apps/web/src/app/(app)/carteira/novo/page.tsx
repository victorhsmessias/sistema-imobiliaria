import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { PropertyForm } from '@/components/property/PropertyForm';
import styles from '@/components/property/property.module.css';

export const metadata: Metadata = { title: 'Cadastrar imóvel' };

export default function NovoImovelPage() {
  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <Link href="/carteira" className={styles.back}>
          <Icon name="chevronLeft" />
          Minha carteira
        </Link>
        <h1 className="page-title">Cadastrar imóvel</h1>
        <p className="lead">
          Preencha o que a rede vê e o que fica só com você. As fotos entram depois de salvar.
        </p>
      </header>
      <PropertyForm />
    </div>
  );
}
