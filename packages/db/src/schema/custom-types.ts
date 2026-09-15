import { customType } from 'drizzle-orm/pg-core';

/**
 * citext: texto com comparacao case-insensitive. Usado em e-mail para que
 * "Joao@Imob.com" e "joao@imob.com" sejam o mesmo login e colidam no unique.
 * A extensao e criada em sql/00_bootstrap_roles.sql.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/** inet nativo do Postgres, para logs de auditoria. */
export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'inet';
  },
});
