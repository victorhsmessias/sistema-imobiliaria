import { z } from 'zod';

export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido.'),
  password: z.string().min(1, 'Informe a senha.'),
});
export type LoginInput = z.infer<typeof loginInput>;

export const userRole = z.enum(['partner_admin', 'partner_agent', 'platform_admin']);
export type UserRole = z.infer<typeof userRole>;

/**
 * O que a sessao devolve ao front.
 *
 * Traz o tenant do PROPRIO usuario -- ele ja sabe para quem trabalha, entao
 * nao ha nada a esconder aqui. O cuidado com tenant e nos resultados de busca,
 * que vem de outro contrato (search.ts) e de outra origem no banco
 * (network_listings, que nao tem coluna de tenant).
 */
export const sessionUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  role: userRole,
  tenant: z
    .object({
      id: z.string().uuid(),
      displayName: z.string(),
      slug: z.string(),
    })
    .nullable(),
});
export type SessionUser = z.infer<typeof sessionUser>;
