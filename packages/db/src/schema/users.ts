import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, inet } from './custom-types.js';
import { userRoleEnum, userStatusEnum } from './enums.js';
import { tenants } from './tenants.js';

/**
 * Usuario de um parceiro. tenantId nulo apenas para platform_admin.
 *
 * Sem cadastro publico: usuarios sao criados por um admin do parceiro ou
 * pela CLI de plataforma. Nao existe rota de signup.
 */
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid().references(() => tenants.id, { onDelete: 'restrict' }),
    email: citext().notNull(),
    passwordHash: text().notNull(),
    name: text().notNull(),
    /** Telefone de contato do corretor. Dado pessoal (LGPD) e identificador. */
    phone: text(),
    role: userRoleEnum().notNull().default('partner_agent'),
    status: userStatusEnum().notNull().default('active'),
    /**
     * Incrementado para invalidar todos os access tokens ja emitidos
     * (desligamento de corretor, suspeita de vazamento de credencial).
     * O JWT carrega o valor; divergiu, o token morre.
     */
    tokenVersion: integer().notNull().default(0),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    index('users_tenant_idx').on(t.tenantId, t.status),
  ],
);

/**
 * Refresh tokens. Guardamos apenas o hash SHA-256 do token: um dump do banco
 * nao permite personificar ninguem.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    userAgent: text(),
    ip: inet(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_key').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
