function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Variavel de ambiente ${name} ausente. Copie .env.example para .env na raiz do repo.`,
    );
  }
  return value;
}

/** Credencial de runtime: app_user, sujeito a RLS. */
export function appDatabaseUrl(): string {
  return required('DATABASE_URL');
}

/** Credencial de migration: app_migrator, dono das tabelas. Nunca no runtime da API. */
export function migratorDatabaseUrl(): string {
  return required('DATABASE_URL_MIGRATOR');
}
