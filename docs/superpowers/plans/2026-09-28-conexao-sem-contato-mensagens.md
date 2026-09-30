# Conexão sem contato, com conversa pelo sistema — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nenhum contato de pessoa (corretor, telefone, e-mail) atravessa entre as partes de uma conexão; aprovada a conexão, as duas imobiliárias conversam por mensagens dentro do sistema, com contato digitado mascarado e contador de não lidas.

**Architecture:** O corte do contato acontece no banco: as funções `connection_requester()` e `connection_disclosure()` passam a devolver só `partner_name`. A conversa é uma tabela append-only `connection_messages` com RLS das duas pontas e grant por coluna que esconde `body_original` do `app_user`; as não lidas vêm de `connection_message_reads`, uma linha por imobiliária. A API ganha três rotas de mensagem e um filtro puro `maskContacts`; o front ganha `/conexoes/[id]` com atualização a cada 15 s.

**Tech Stack:** Postgres 16 (RLS, SECURITY DEFINER), drizzle-orm 0.44 / drizzle-kit 0.31, Fastify, zod, Vitest, Next.js (App Router), React.

**Spec:** [`docs/superpowers/specs/2026-09-28-conexao-sem-contato-mensagens-design.md`](../specs/2026-09-28-conexao-sem-contato-mensagens-design.md)

## Global Constraints

- Trabalhar na branch `feat/conexao-mensagens`. **Nunca** fazer push, merge, deploy nem migration em produção sem aprovação explícita do usuário.
- Antes de qualquer `migrate`, `seed` ou suíte de teste, o `.env` da raiz precisa apontar para o ambiente local: `DATABASE_URL*` em `localhost:5434` e `S3_ENDPOINT=http://localhost:9000` (MinIO). Com o R2, os testes de mídia apagam arquivos no bucket real.
- `apps/web` roda como `next start -p 3100`. **Nunca** rodar `next dev`. Para ver mudança: avisar o usuário, parar o 3100, apagar `apps/web/.next`, `pnpm --filter @imob/web build`, subir `next start -p 3100` de novo.
- Depois de todo `drizzle-kit generate`, ler o SQL gerado antes de rodar `migrate`.
- Nenhum `select()` sem lista de colunas em `connection_messages`: o `app_user` não tem `SELECT` em `body_original`, e a consulta morre com `permission denied`.
- Texto da máscara, exato: `[contato removido]`.
- Mensagem: a API aceita 1–2000 caracteres depois do `trim`; o check do banco é `char_length` 1–8000 (a máscara pode alongar o texto).
- Página de mensagens: 200. Atualização da tela: 15 s, só com a aba visível. Limite de envio: 30 por minuto.
- Nomes do contrato: `counterpart: { partnerName }`, `unreadCount`, `ConnectionMessageDto = { id, body, author: 'you' | 'other', createdAt }`.
- Comentários de código em português sem acento (como o resto do repositório); textos da interface com acento.

## Review Focus

1. **Cursor `after` com precisão de microssegundo.** O `created_at` do Postgres tem µs e o `Date` do JS tem ms; comparar com o valor vindo do JS devolveria de novo a própria mensagem do cursor. A comparação tem que ser feita no SQL, contra a linha do cursor. Teste na Task 4: "after nao repete a mensagem do cursor".
2. **Texto que cresce com a máscara.** 2000 caracteres de `@abcd` viram mais de 2000 depois da máscara; isso não pode virar 500. Teste na Task 4: "texto que cresce com a mascara continua aceito".
3. **Quebra de linha, acento e emoji.** A mensagem tem que voltar idêntica (menos a máscara); só-espaços é 422. Teste na Task 4: "preserva quebra de linha, acento e emoji; so-espacos e 422".
4. **Admin da plataforma nas rotas de conversa.** Não tem tenant: tem que receber erro, nunca a conversa. Teste na Task 4: "admin da plataforma nao le a conversa".
5. **Envio e atualização periódica ao mesmo tempo.** A tela não pode duplicar nem desordenar mensagens. Coberto pelo código da Task 7 (deduplicação por `id` e ordenação por `createdAt`) e verificado à mão no passo 6 da Task 9.

---

## Mapa de arquivos

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `apps/api/src/lib/contact-filter.ts` (novo) | `maskContacts`: função pura que mascara contato em texto | 1 |
| `apps/api/test/contact-filter.test.ts` (novo) | tabela de casos do filtro | 1 |
| `packages/db/sql/10_security.sql` | funções só com a marca; RLS e grants das tabelas novas | 2, 3 |
| `packages/db/src/sensitive-fields.ts` | `COUNTERPART_FIELDS` no lugar de `DISCLOSURE_FIELDS` | 2 |
| `packages/contracts/src/connections.ts` | `counterpart`, `unreadCount`, contratos de mensagem | 2, 4, 5 |
| `apps/api/src/modules/connections/{repository,service,routes}.ts` | marca, mensagens, não lidas, máscara no recado e na nota | 2, 4, 5, 6 |
| `apps/api/test/connections.test.ts` | contrato novo, conversa, não lidas, varredura de vazamento | 2, 4, 5, 6 |
| `packages/db/src/schema/connections.ts` | tabelas `connection_messages` e `connection_message_reads` | 3 |
| `packages/db/drizzle/0005_connection_messages.sql` (gerado) | DDL das tabelas novas | 3 |
| `packages/db/src/migrate.ts` | FORCE nas tabelas novas; confere que `body_original` está escondido | 3 |
| `packages/db/test/rls.test.ts` | isolamento das funções e das tabelas novas | 2, 3 |
| `apps/web/src/components/connections/*` | lista com marca e não lidas; tela de conversa | 2, 7 |
| `apps/web/src/app/(app)/conexoes/[id]/page.tsx` (novo) | rota da conversa | 7 |
| `apps/web/src/components/{listing/ListingDetail,search/ListingRow,AppShell}.tsx` | "Abrir conversa" e contador no menu | 8 |
| `docs/plano.md`, `docs/proximos-passos.md`, `docs/anonimizacao.md` | regra nova documentada | 9 |

---

### Task 1: Filtro de contato

**Files:**
- Create: `apps/api/src/lib/contact-filter.ts`
- Test: `apps/api/test/contact-filter.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `export const CONTACT_MASK = '[contato removido]'` e `export function maskContacts(text: string): { text: string; masked: boolean }`.

- [ ] **Step 1: Conferir o `.env` antes de rodar qualquer teste**

Run (Git Bash, na raiz): `grep -E '^(DATABASE_URL[A-Z_]*|S3_ENDPOINT)=' .env | sed -E 's#//[^@]*@#//***@#'`
Expected: as três `DATABASE_URL*` em `@localhost:5434/imob` e `S3_ENDPOINT=http://localhost:9000`. Se não, **parar** e avisar o usuário.

- [ ] **Step 2: Escrever o teste que falha**

```ts
// apps/api/test/contact-filter.test.ts
import { describe, expect, it } from 'vitest';
import { CONTACT_MASK, maskContacts } from '../src/lib/contact-filter.js';

/**
 * O filtro e a ultima barreira para a negociacao nao sair da plataforma.
 * Falso negativo vaza contato; falso positivo estraga valor, metragem e datas,
 * que aparecem em toda conversa de imovel. Os dois lados estao na tabela.
 */
describe('maskContacts', () => {
  it.each([
    ['me liga 43 98020-2000', `me liga ${CONTACT_MASK}`],
    ['(43) 3322-1100 comercial', `${CONTACT_MASK} comercial`],
    ['+55 43 980202000', CONTACT_MASK],
    ['43980202000', CONTACT_MASK],
    ['43 3322 1100', CONTACT_MASK],
    ['43.98020.2000', CONTACT_MASK],
    ['só 98020-2000', `só ${CONTACT_MASK}`],
    ['fulano@beta.com.br', CONTACT_MASK],
    ['Fulano@Beta.COM', CONTACT_MASK],
    ['www.beta.com.br', CONTACT_MASK],
    ['beta.com.br', CONTACT_MASK],
    ['site https://beta.com.br/x', `site ${CONTACT_MASK}`],
    ['wa.me/5543980202000', CONTACT_MASK],
    ['insta @betaimoveis', `insta ${CONTACT_MASK}`],
  ])('mascara %j', (input, expected) => {
    expect(maskContacts(input)).toEqual({ text: expected, masked: true });
  });

  it.each([
    'R$ 1.308.000',
    'R$ 2.209.000 à vista',
    'R$ 1308000',
    'valor 1.308.000',
    'IPTU 13.250',
    'Condomínio R$ 955',
    '233 m²',
    'área 1.200 m² e 2026',
    'CRECI 12345',
    'CEP 86050-000',
    'ref 12345678',
    '3 quartos',
    '28/09',
    '28/09/2026',
    'Olá, tudo bem? Visita às 15h 🙂',
  ])('nao mexe em %j', (input) => {
    expect(maskContacts(input)).toEqual({ text: input, masked: false });
  });

  it('mascara cada ocorrencia, nao so a primeira', () => {
    expect(maskContacts('43 98020-2000 ou vendas@beta.com.br').text).toBe(
      `${CONTACT_MASK} ou ${CONTACT_MASK}`,
    );
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm --filter @imob/api exec vitest run test/contact-filter.test.ts`
Expected: FAIL, `Cannot find module '../src/lib/contact-filter.js'` (ou equivalente).

- [ ] **Step 4: Implementar**

```ts
// apps/api/src/lib/contact-filter.ts

/**
 * Mascara contato escrito em texto livre entre as partes de uma conexao.
 *
 * A negociacao precisa ficar dentro da plataforma (spec de 28/09/2026): o
 * contato nunca atravessa, nem digitado. Telefone, e-mail, link e @perfil
 * viram CONTACT_MASK.
 *
 * A ORDEM dos padroes importa: e-mail antes de dominio e de @perfil, senao
 * "fulano@beta.com.br" vira "fulano@[contato removido]".
 *
 * O que passa intacto e tao importante quanto o que e pego: valor em reais,
 * metragem, CRECI, CEP e datas aparecem em toda conversa de imovel (ver
 * test/contact-filter.test.ts).
 */
export const CONTACT_MASK = '[contato removido]';

const PATTERNS: readonly RegExp[] = [
  // e-mail
  /[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/giu,
  // link com protocolo ou www
  /\bhttps?:\/\/\S+/giu,
  /\bwww\.\S+/giu,
  // dominio solto: beta.com.br, wa.me/5543...
  /\b(?:[a-z\d-]+\.)+(?:com|net|org|br|me|io|app|imb|info|biz)(?:\.br)?\b(?:\/\S*)?/giu,
  // @perfil de rede social
  /(?<![\p{L}\d._])@[\p{L}\d._]{3,30}/giu,
  // telefone com DDD (10 ou 11 digitos, +55 opcional). Nao pega valor apos R$.
  /(?<!R\$\s*)(?<![\d.,])(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]*9?\d{4}[\s.-]?\d{4}(?![\d.,]?\d)/gu,
  // telefone sem DDD: exige o traco, para nao pegar codigo de referencia
  /(?<!R\$\s*)(?<![\d.,])9?\d{4}-\d{4}(?![\d.,]?\d)/gu,
];

export function maskContacts(text: string): { text: string; masked: boolean } {
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, CONTACT_MASK);
  }
  return { text: result, masked: result !== text };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm --filter @imob/api exec vitest run test/contact-filter.test.ts`
Expected: PASS, todos os casos.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/contact-filter.ts apps/api/test/contact-filter.test.ts
git commit -m "feat(connections): filtro que mascara contato em texto livre"
```

---

### Task 2: Só a marca atravessa (corta o contato no banco, na API e na lista)

Conserta também o bug do roteiro de 28/09: a lista passa a trazer a outra parte.

**Files:**
- Modify: `packages/db/sql/10_security.sql` (funções `connection_disclosure` e `connection_requester`, linhas ~488–530)
- Modify: `packages/db/src/sensitive-fields.ts:85-97`
- Modify: `packages/db/test/rls.test.ts` (bloco `conexoes (linha de dois donos)`)
- Modify: `packages/contracts/src/connections.ts`
- Modify: `apps/api/src/modules/connections/repository.ts` (`PartyRow`, `hasDisclosureEvent`)
- Modify: `apps/api/src/modules/connections/service.ts` (cabeçalho, `toParty`, `hydrate`, `getById`)
- Modify: `apps/api/test/connections.test.ts`
- Modify: `apps/web/src/components/connections/ConnectionsView.tsx`, `connections.module.css`

**Interfaces:**
- Consumes: nada das tasks anteriores.
- Produces:
  - SQL: `connection_requester(uuid) RETURNS TABLE (partner_name text)`; `connection_disclosure(uuid) RETURNS TABLE (partner_name text)`, válida em `approved` e `revoked`.
  - `@imob/db`: `export const COUNTERPART_FIELDS = ['partnerName'] as const`.
  - `@imob/contracts`: `connectionParty = z.object({ partnerName: z.string() })`; `ConnectionDto.counterpart?: ConnectionParty`; `disclosureLevel`, `requester` e `disclosure` **removidos** do DTO e do módulo.
  - `repository.ts`: `interface PartyRow { partner_name: string }`; `requesterOf`/`disclosureOf` sem mudança de assinatura.
  - `service.ts`: `hydrate(tx, row, actor, listing)` preenche `counterpart`.

- [ ] **Step 1: Teste do banco que falha (funções devolvem só a marca)**

Em `packages/db/test/rls.test.ts`, dentro de `describe('conexoes (linha de dois donos)')`, logo depois da função `criarPedido`, acrescentar:

```ts
    async function removerPedido(id: string): Promise<void> {
      await withOracle((oracle) => oracle.query('DELETE FROM connection_requests WHERE id = $1', [id]));
    }

    async function mudarStatus(id: string, status: string): Promise<void> {
      await withOracle((oracle) =>
        oracle.query('UPDATE connection_requests SET status = $2::connection_status WHERE id = $1', [id, status]),
      );
    }

    it('as funcoes de revelacao devolvem so a marca, nunca contato', async () => {
      const id = await criarPedido();
      try {
        await mudarStatus(id, 'approved');

        const paraODono = await asTenant(client, beta.id, () =>
          client.query('SELECT * FROM connection_requester($1)', [id]),
        );
        expect(paraODono.fields.map((f) => f.name)).toEqual(['partner_name']);
        expect(paraODono.rows).toEqual([{ partner_name: alfa.displayName }]);

        const paraQuemPediu = await asTenant(client, alfa.id, () =>
          client.query('SELECT * FROM connection_disclosure($1)', [id]),
        );
        expect(paraQuemPediu.fields.map((f) => f.name)).toEqual(['partner_name']);
        expect(paraQuemPediu.rows).toEqual([{ partner_name: beta.displayName }]);
      } finally {
        await removerPedido(id);
      }
    });

    it('a marca do dono vale em aprovada e revogada, e em mais nenhum status', async () => {
      const id = await criarPedido();
      try {
        for (const [status, esperado] of [
          ['pending', 0],
          ['approved', 1],
          ['revoked', 1],
          ['rejected', 0],
          ['expired', 0],
          ['cancelled', 0],
        ] as const) {
          await mudarStatus(id, status);
          const { rows } = await asTenant(client, alfa.id, () =>
            client.query('SELECT * FROM connection_disclosure($1)', [id]),
          );
          expect(rows, `status ${status}`).toHaveLength(esperado);
        }
      } finally {
        await removerPedido(id);
      }
    });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:rls -- -t "revelacao|marca do dono"`
Expected: FAIL. Os nomes de coluna vêm como `['partner_name','broker_name','broker_phone','broker_email']`, e em `revoked` a função devolve 0 linhas.

- [ ] **Step 3: Trocar as duas funções no SQL**

Em `packages/db/sql/10_security.sql`, substituir o bloco inteiro de `CREATE FUNCTION connection_disclosure` e `CREATE FUNCTION connection_requester` (com os comentários acima de cada uma) por:

```sql
-- O que o DONO revela a quem pediu: so a marca.
--
-- Contato de pessoa (corretor, telefone, e-mail) nunca atravessa: a
-- negociacao fica dentro da plataforma, por mensagens (spec de 28/09/2026).
-- A marca aparece em conexao APROVADA e continua na REVOGADA, para a conversa
-- so-leitura dizer com quem foi. Quem pergunta precisa ser o SOLICITANTE.
--
-- Nao devolve endereco: aprovar conexao nao e abrir o cadastro do imovel.
CREATE FUNCTION connection_disclosure(p_request_id uuid)
RETURNS TABLE (partner_name text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT t.display_name
  FROM connection_requests r
  JOIN tenants t ON t.id = r.owner_tenant_id
  WHERE r.id = p_request_id
    AND r.status IN ('approved', 'revoked')
    AND r.requester_tenant_id = app_current_tenant();
$$;

-- Quem esta pedindo, para o DONO decidir: so a marca.
--
-- Disponivel desde a solicitacao: pedir conexao e se identificar como
-- imobiliaria. Contato de pessoa nao atravessa, como no sentido contrario.
CREATE FUNCTION connection_requester(p_request_id uuid)
RETURNS TABLE (partner_name text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT t.display_name
  FROM connection_requests r
  JOIN tenants t ON t.id = r.requester_tenant_id
  WHERE r.id = p_request_id
    AND r.owner_tenant_id = app_current_tenant();
$$;
```

(Os `DROP FUNCTION IF EXISTS` que já existem acima continuam; eles permitem mudar o `RETURNS TABLE`.)

- [ ] **Step 4: Aplicar e ver o teste do banco passar**

Run: `pnpm db:migrate` e depois `pnpm test:rls -- -t "revelacao|marca do dono"`
Expected: migrate termina com `[migrate] ok`; os dois testes PASS.

- [ ] **Step 5: Trocar `DISCLOSURE_FIELDS` por `COUNTERPART_FIELDS`**

Em `packages/db/src/sensitive-fields.ts`, substituir o comentário e a constante `DISCLOSURE_FIELDS` (linhas 85–97) por:

```ts
/**
 * O que uma parte da conexao ve da outra: so a marca.
 *
 * Contato de pessoa (corretor, telefone, e-mail) nunca atravessa -- a
 * negociacao fica dentro da plataforma, por mensagens. Endereco exato tambem
 * nunca: com ele o solicitante acha o anuncio original num portal publico e
 * fecha por fora. A suite da API confere que `counterpart` traz exatamente
 * estes campos.
 */
export const COUNTERPART_FIELDS = ['partnerName'] as const;
```

- [ ] **Step 6: Atualizar os testes da API para o contrato novo (vão falhar)**

Em `apps/api/test/connections.test.ts`:

1. No topo, trocar o import de `@imob/db` por `import { closeDb, COUNTERPART_FIELDS } from '@imob/db';`.
2. Logo abaixo de `identificadoresDaBeta()`, acrescentar:

```ts
  /** Contato de pessoa de um parceiro: nunca atravessa, em nenhum estado. */
  function contatosDe(slug: string): string[] {
    const tenant = fixture.tenants.find((t) => t.slug === slug)!;
    return [...tenant.emails, ...tenant.names, ...tenant.phones];
  }
```

3. Em `cria o pedido sem revelar NADA do dono`, trocar as duas linhas `expect(connection.disclosure)...` e `expect(connection.requester)...` por:

```ts
      // Enquanto pende, quem pediu nao sabe de quem e o imovel.
      expect(connection.counterpart).toBeUndefined();
```

4. Substituir o teste `o dono ve quem pediu, com contato: pedir e se identificar` por:

```ts
    it('o dono ve so a marca de quem pediu, sem contato', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/connections?role=received',
        cookies: beta,
      });
      expect(response.statusCode).toBe(200);

      const item = response.json().items.find((i: { id: string }) => i.id === criados[0]);
      expect(item.role).toBe('owner');
      expect(item.counterpart).toEqual({ partnerName: 'Alfa Imóveis' });
      expect(Object.keys(item.counterpart)).toEqual([...COUNTERPART_FIELDS]);
      expect(item.message).toMatch(/cliente/i);
      expect(contatosDe('alfa-imoveis').filter((v) => response.body.includes(v))).toEqual([]);
    });
```

5. Em `quem pediu nao ve o dono enquanto o pedido pende`, trocar `expect(item.disclosure).toBeUndefined();` por `expect(item.counterpart).toBeUndefined();`.
6. Substituir o teste `o dono aprova e so entao o contato dele aparece` por:

```ts
    it('o dono aprova e so entao a marca dele aparece, nunca o contato', async () => {
      const aprovado = await app.inject({
        method: 'POST',
        url: `/connections/${criados[0]}/approve`,
        cookies: beta,
      });
      expect(aprovado.statusCode).toBe(200);
      expect(aprovado.json().connection.status).toBe('approved');

      const visao = await app.inject({
        method: 'GET',
        url: `/connections/${criados[0]}`,
        cookies: alfa,
      });
      const { connection, events } = visao.json();

      expect(connection.status).toBe('approved');
      expect(connection.counterpart).toEqual({ partnerName: 'Beta Imóveis' });
      expect(contatosDe('beta-imoveis').filter((v) => visao.body.includes(v))).toEqual([]);

      // Mesmo aprovado, endereco nao: com ele o solicitante acha o anuncio
      // original num portal e fecha por fora.
      const endereco = await withOracle(async (client) => {
        const { rows } = await client.query<{ street: string; zip: string; title: string }>(
          'SELECT street, zip, title FROM properties WHERE id = $1',
          [betaListings[0]],
        );
        return rows[0]!;
      });
      for (const valor of [endereco.street, endereco.zip, endereco.title]) {
        expect(visao.body.includes(valor), `"${valor}" vazou na conexão aprovada`).toBe(false);
      }

      // Abrir o detalhe nao grava mais evento: nao ha contato a "revelar".
      expect(events.map((e: { type: string; actor: string }) => [e.type, e.actor])).toEqual([
        ['requested', 'you'],
        ['approved', 'other'],
      ]);
    });
```

7. Substituir o teste `nivel de disclosure "partner" mostra a marca e esconde o contato` por (regressão do bug de 28/09):

```ts
    it('a lista de quem pediu traz a marca do dono depois do aceite', async () => {
      const response = await app.inject({ method: 'GET', url: '/connections?role=sent', cookies: alfa });
      const item = response.json().items.find((i: { id: string }) => i.id === criados[0]);

      expect(item.status).toBe('approved');
      expect(item.counterpart).toEqual({ partnerName: 'Beta Imóveis' });
      expect(contatosDe('beta-imoveis').filter((v) => response.body.includes(v))).toEqual([]);
    });
```

8. Em `recusa com motivo, sem revelar o dono`, trocar `expect(visao.json().connection.disclosure).toBeUndefined();` por `expect(visao.json().connection.counterpart).toBeUndefined();`.
9. Substituir o teste `parceiro perde acesso apos revogacao (disclosure se vai)` inteiro por:

```ts
    it('depois da revogacao, quem pediu continua vendo so a marca', async () => {
      const response = await pedir(betaListings[9]!);
      const id = response.json().connection.id;
      await app.inject({ method: 'POST', url: `/connections/${id}/approve`, cookies: beta });
      await app.inject({
        method: 'POST',
        url: `/connections/${id}/revoke`,
        cookies: adminCookies,
        payload: { reason: 'Abuso comprovado' },
      });

      const visao = await app.inject({ method: 'GET', url: `/connections/${id}`, cookies: alfa });
      expect(visao.json().connection.status).toBe('revoked');
      expect(visao.json().connection.counterpart).toEqual({ partnerName: 'Beta Imóveis' });
      expect(contatosDe('beta-imoveis').filter((v) => visao.body.includes(v))).toEqual([]);
    });
```

10. No fim do `describe('conexoes entre parceiros')`, depois do `describe('revogacao pela plataforma')`, acrescentar a varredura de vazamento:

```ts
  describe('nenhum contato atravessa', () => {
    /** GETs de conexao de um lado, sobre tudo o que a suite criou. */
    async function respostasDe(cookies: Record<string, string>): Promise<string[]> {
      const urls = [
        '/connections?role=sent&limit=100',
        '/connections?role=received&limit=100',
        ...criados.map((id) => `/connections/${id}`),
      ];
      const bodies: string[] = [];
      for (const url of urls) {
        const response = await app.inject({ method: 'GET', url, cookies });
        bodies.push(response.body);
      }
      return bodies;
    }

    it('a Alfa nunca recebe contato da Beta, e a Beta nunca recebe o da Alfa', async () => {
      const daBeta = contatosDe('beta-imoveis');
      const daAlfa = contatosDe('alfa-imoveis');

      for (const body of await respostasDe(alfa)) {
        expect(daBeta.filter((v) => body.includes(v))).toEqual([]);
      }
      for (const body of await respostasDe(beta)) {
        expect(daAlfa.filter((v) => body.includes(v))).toEqual([]);
      }
    });
  });
```

- [ ] **Step 7: Rodar e ver falhar**

Run: `pnpm test:api -- test/connections.test.ts`
Expected: FAIL. `counterpart` vem `undefined`, e aparecem `requester`/`disclosure` com contato.

- [ ] **Step 8: Contrato**

Em `packages/contracts/src/connections.ts`:

1. Apagar `export const disclosureLevel = ...` e `export type DisclosureLevel = ...`.
2. Trocar o comentário do topo do arquivo (o parágrafo "Assimetria: ...") por:

```ts
 * Cada parte ve da outra so a marca: contato de pessoa nunca atravessa, e a
 * negociacao segue por mensagens dentro da plataforma. Quem pede aparece para
 * o dono ja no pedido; o dono aparece para quem pediu so depois do aceite.
 * Endereco exato nao e revelado em nenhum momento.
```

3. Substituir `connectionParty` por:

```ts
/** Uma das partes: so a marca. Contato de pessoa nunca atravessa. */
export const connectionParty = z.object({
  partnerName: z.string(),
});
export type ConnectionParty = z.infer<typeof connectionParty>;
```

4. No `connectionDto`, apagar a linha `disclosureLevel,` e substituir os campos `requester` e `disclosure` (com seus comentários) por:

```ts
  /**
   * A outra parte, so pela marca. Para o dono, desde o pedido; para quem
   * pediu, so em `approved` e `revoked`. A regra vive no banco, em
   * `connection_requester()` e `connection_disclosure()`.
   */
  counterpart: connectionParty.optional(),
```

- [ ] **Step 9: Repositório**

Em `apps/api/src/modules/connections/repository.ts`:

1. Apagar a função `hasDisclosureEvent` inteira.
2. Substituir `PartyRow` e os comentários de `requesterOf`/`disclosureOf` por:

```ts
export interface PartyRow {
  partner_name: string;
}

/** Marca de quem pediu, para o dono. Vazio se quem pergunta nao e o dono. */
export async function requesterOf(tx: Tx, requestId: string): Promise<PartyRow | null> {
  const { rows } = await tx.execute(sql`SELECT * FROM connection_requester(${requestId}::uuid)`);
  return (rows[0] as PartyRow | undefined) ?? null;
}

/**
 * Marca do dono, para quem pediu.
 *
 * Vazio se a conexao nao esta aprovada nem revogada, ou se quem pergunta nao
 * e o solicitante -- a regra vive na funcao, no banco.
 */
export async function disclosureOf(tx: Tx, requestId: string): Promise<PartyRow | null> {
  const { rows } = await tx.execute(sql`SELECT * FROM connection_disclosure(${requestId}::uuid)`);
  return (rows[0] as PartyRow | undefined) ?? null;
}
```

- [ ] **Step 10: Service**

Em `apps/api/src/modules/connections/service.ts`:

1. No import de `@imob/contracts`, remover `ConnectionParty`.
2. No comentário do topo, trocar o trecho "O que cada lado enxerga: ... quem pediu so ve o dono depois do aceite, e nunca o endereco." por:

```ts
 * O que cada lado enxerga da outra parte: so a marca. O dono ve quem pediu
 * desde o pedido; quem pediu ve o dono so depois do aceite. Contato de pessoa
 * nunca atravessa -- a negociacao segue pelas mensagens da conexao.
```

3. Apagar a função `toParty` inteira (com o comentário "Aplica o nivel de disclosure").
4. Substituir `hydrate` por:

```ts
async function hydrate(
  tx: Tx,
  row: ConnectionRequest,
  actor: ActorContext,
  listing: repo.ListingRow,
): Promise<ConnectionDto> {
  const role = row.ownerTenantId === actor.tenantId ? 'owner' : 'requester';

  const dto: ConnectionDto = {
    id: row.id,
    status: row.status,
    role,
    message: row.message,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    listing: toListing(listing),
  };

  // A funcao do banco decide se a marca aparece: para o dono, sempre; para
  // quem pediu, so em approved/revoked. Aqui so se copia o que ela liberou.
  const party =
    role === 'owner' ? await repo.requesterOf(tx, row.id) : await repo.disclosureOf(tx, row.id);
  if (party) dto.counterpart = { partnerName: party.partner_name };

  return dto;
}
```

5. Em `getById`, apagar tudo entre `const connection = await hydrate(...)` e `const events = await repo.listEvents(...)` (as variáveis `isRequester`/`isApproved`, a gravação do evento `disclosed` e o bloco de `disclosure`). O corpo fica:

```ts
    const row = await repo.findById(tx, id);
    // O RLS ja devolve zero linhas para quem nao e parte: 404, nunca 403.
    if (!row) throw notFound('Conexão não encontrada.');

    const connection = await hydrate(tx, row, actor, await loadListing(tx, row.id));
    const events = await repo.listEvents(tx, row.id);
    return { connection, events: events.map((event) => toEventDto(event, actor.tenantId)) };
```

- [ ] **Step 11: Rodar a suíte da API e ver passar**

Run: `pnpm test:api -- test/connections.test.ts`
Expected: PASS, incluindo `nenhum contato atravessa`.

- [ ] **Step 12: Tela da lista mostra a marca**

Em `apps/web/src/components/connections/ConnectionsView.tsx`:

1. Trocar o texto do `<p className="lead">` por:

```tsx
          Quem anuncia decide cada pedido. Depois do aceite, a conversa acontece aqui.
```

2. Substituir os dois blocos `{connection.requester && (...)}` e `{connection.disclosure && (...)}`, com os comentários `{/* Dono: ... */}` e `{/* Solicitante: ... */}`, por:

```tsx
              {/* A outra parte, so pela marca: contato nunca atravessa. */}
              {connection.counterpart && (
                <p className={styles.counterpart}>
                  <span className={styles.counterpartLabel}>
                    {connection.role === 'owner' ? 'Quem pediu' : 'Quem anuncia'}
                  </span>
                  {connection.counterpart.partnerName}
                </p>
              )}
```

Em `connections.module.css`, substituir as regras `.party`, `.revealed`, `.party div`, `.party dt` e `.party dd` (com o comentário "Dados de uma das partes." e o de `.revealed`) por:

```css
/* A outra parte, so pela marca. */
.counterpart {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}

.counterpartLabel {
  font-size: 11.5px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-3);
}
```

- [ ] **Step 13: Typecheck de tudo**

Run: `pnpm typecheck`
Expected: sem erro nos quatro pacotes. Se algum arquivo ainda usar `disclosure`, `requester`, `disclosureLevel` ou `brokerName`, o erro aponta onde; trocar por `counterpart`.

- [ ] **Step 14: Suíte completa**

Run: `pnpm test:rls` e `pnpm test:api`
Expected: as duas PASS.

- [ ] **Step 15: Commit**

```bash
git add packages/db/sql/10_security.sql packages/db/src/sensitive-fields.ts packages/db/test/rls.test.ts \
  packages/contracts/src/connections.ts apps/api/src/modules/connections apps/api/test/connections.test.ts \
  apps/web/src/components/connections
git commit -m "feat(connections): so a marca atravessa entre as partes, contato nunca"
```

---

### Task 3: Tabelas da conversa, com RLS e original escondido

**Files:**
- Modify: `packages/db/src/schema/connections.ts`
- Create (gerado): `packages/db/drizzle/0005_connection_messages.sql` e `packages/db/drizzle/meta/*`
- Modify: `packages/db/sql/10_security.sql` (bloco RLS de conexões e bloco de privilégios)
- Modify: `packages/db/src/migrate.ts` (`FORCED_TABLES`, `verify`)
- Modify: `packages/db/test/rls.test.ts`

**Interfaces:**
- Consumes: `removerPedido`, `mudarStatus`, `criarPedido` do `rls.test.ts` (Task 2).
- Produces (`@imob/db`): `connectionMessages` (colunas `id`, `connectionRequestId`, `senderTenantId`, `senderUserId`, `body`, `bodyOriginal`, `createdAt`), `connectionMessageReads` (`connectionRequestId`, `tenantId`, `lastReadAt`), tipos `ConnectionMessage` e `ConnectionMessageRead`.

- [ ] **Step 1: Testes do banco que falham**

Em `packages/db/test/rls.test.ts`, dentro de `describe('conexoes (linha de dois donos)')`, depois dos testes da Task 2, acrescentar:

```ts
    function inserirMensagem(tenantId: string, requestId: string, senderTenantId: string, body = 'Olá') {
      return asTenant(client, tenantId, () =>
        client.query(
          `INSERT INTO connection_messages (connection_request_id, sender_tenant_id, body)
           VALUES ($1, $2, $3) RETURNING id`,
          [requestId, senderTenantId, body],
        ),
      );
    }

    it('conversa: as duas pontas leem, terceiro nao, e sem tenant nao ha nada', async () => {
      const id = await criarPedido();
      const carlos = tenants[2] as SeededTenant;
      try {
        await mudarStatus(id, 'approved');
        await inserirMensagem(alfa.id, id, alfa.id);

        for (const tenant of [alfa, beta]) {
          const { rows } = await asTenant(client, tenant.id, () =>
            client.query('SELECT id, body FROM connection_messages WHERE connection_request_id = $1', [id]),
          );
          expect(rows, `${tenant.slug} deveria ler a conversa`).toHaveLength(1);
        }

        const terceiro = await asTenant(client, carlos.id, () =>
          client.query('SELECT id FROM connection_messages WHERE connection_request_id = $1', [id]),
        );
        expect(terceiro.rows).toHaveLength(0);

        const semTenant = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM connection_messages',
        );
        expect(semTenant.rows[0]?.count).toBe('0');
      } finally {
        await removerPedido(id);
      }
    });

    it('so conversa em conexao aprovada', async () => {
      for (const status of ['pending', 'rejected', 'revoked', 'expired', 'cancelled']) {
        const id = await criarPedido();
        try {
          await mudarStatus(id, status);
          await expect(inserirMensagem(alfa.id, id, alfa.id), `status ${status}`).rejects.toThrow(
            /row-level security|violates/i,
          );
        } finally {
          await removerPedido(id);
        }
      }
    });

    it('nao manda mensagem em nome da outra parte', async () => {
      const id = await criarPedido();
      try {
        await mudarStatus(id, 'approved');
        await expect(inserirMensagem(alfa.id, id, beta.id)).rejects.toThrow(/row-level security|violates/i);
      } finally {
        await removerPedido(id);
      }
    });

    it('o texto original nunca e legivel pela aplicacao', async () => {
      await expect(
        asTenant(client, alfa.id, () => client.query('SELECT body_original FROM connection_messages')),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asTenant(client, alfa.id, () => client.query('SELECT * FROM connection_messages')),
      ).rejects.toThrow(/permission denied/i);
    });

    it('a conversa e append-only', async () => {
      await expect(
        asTenant(client, alfa.id, () => client.query(`UPDATE connection_messages SET body = 'x'`)),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asTenant(client, alfa.id, () => client.query('DELETE FROM connection_messages')),
      ).rejects.toThrow(/permission denied/i);
    });

    it('leitura: cada parceiro so ve e grava a propria linha', async () => {
      const id = await criarPedido();
      try {
        await mudarStatus(id, 'approved');

        await asTenant(client, alfa.id, () =>
          client.query(
            `INSERT INTO connection_message_reads (connection_request_id, tenant_id, last_read_at)
             VALUES ($1, $2, now())`,
            [id, alfa.id],
          ),
        );

        await expect(
          asTenant(client, alfa.id, () =>
            client.query(
              `INSERT INTO connection_message_reads (connection_request_id, tenant_id, last_read_at)
               VALUES ($1, $2, now())`,
              [id, beta.id],
            ),
          ),
        ).rejects.toThrow(/row-level security|violates/i);

        const daBeta = await asTenant(client, beta.id, () =>
          client.query('SELECT tenant_id FROM connection_message_reads WHERE connection_request_id = $1', [id]),
        );
        expect(daBeta.rows).toHaveLength(0);
      } finally {
        await removerPedido(id);
      }
    });
```

E no teste `RLS esta habilitado, e FORCE onde o dono tambem precisa ser barrado`, acrescentar `'connection_messages', 'connection_message_reads'` ao array `forced`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:rls -- -t "conversa|leitura|original|append-only|aprovada|outra parte|FORCE"`
Expected: FAIL com `relation "connection_messages" does not exist`.

- [ ] **Step 3: Schema drizzle**

Em `packages/db/src/schema/connections.ts`:

1. Trocar o import de `drizzle-orm/pg-core` por:

```ts
import { check, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
```

2. Antes das linhas `export type ...` do fim do arquivo, acrescentar:

```ts
/**
 * Conversa de uma conexao aprovada. Append-only: sem UPDATE nem DELETE.
 *
 * E o unico canal entre as partes -- contato de pessoa nunca atravessa (spec
 * de 28/09/2026). `body` ja chega mascarado pelo filtro de contato.
 * `body_original` so existe quando a mascara agiu, e o app_user NAO tem
 * SELECT nessa coluna (grant por coluna em sql/10_security.sql): nenhum
 * `select()` da aplicacao pode pedir a tabela inteira.
 */
export const connectionMessages = pgTable(
  'connection_messages',
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    connectionRequestId: uuid()
      .notNull()
      .references(() => connectionRequests.id, { onDelete: 'cascade' }),
    senderTenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    senderUserId: uuid().references(() => users.id, { onDelete: 'set null' }),

    body: text().notNull(),
    bodyOriginal: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('connection_messages_request_idx').on(t.connectionRequestId, t.createdAt, t.id),
    // A API limita a entrada a 2000; a mascara pode alongar o texto.
    check('connection_messages_body_length', sql`char_length(${t.body}) BETWEEN 1 AND 8000`),
  ],
);

/**
 * Ate onde cada imobiliaria leu a conversa. Uma linha por lado.
 *
 * Por tenant, e nao por usuario: a conexao e ato da imobiliaria. Fica fora de
 * connection_requests para marcar leitura sem mexer no updated_at da conexao
 * e sem deixar um lado marcar como lido pelo outro.
 */
export const connectionMessageReads = pgTable(
  'connection_message_reads',
  {
    connectionRequestId: uuid()
      .notNull()
      .references(() => connectionRequests.id, { onDelete: 'cascade' }),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionRequestId, t.tenantId] })],
);
```

3. No fim do arquivo, acrescentar:

```ts
export type ConnectionMessage = typeof connectionMessages.$inferSelect;
export type ConnectionMessageRead = typeof connectionMessageReads.$inferSelect;
```

- [ ] **Step 4: Gerar a migration e LER o SQL**

Run: `pnpm --filter @imob/db exec drizzle-kit generate --name connection_messages`
Expected: cria `packages/db/drizzle/0005_connection_messages.sql`. Ler o arquivo e conferir que ele **só** tem `CREATE TABLE "connection_messages"`, `CREATE TABLE "connection_message_reads"`, as `FOREIGN KEY`, o índice, o `CHECK` e a `PRIMARY KEY` composta. Nenhum `DROP`, nenhum `ALTER` em tabela existente. Se aparecer algo além disso, parar e investigar antes de migrar.

- [ ] **Step 5: RLS e grants no SQL de segurança**

Em `packages/db/sql/10_security.sql`, logo depois da linha `-- Append-only: sem UPDATE e sem DELETE, como audit_log.` do bloco de `connection_events`, acrescentar:

```sql

-- Conversa da conexao. A leitura segue a da solicitacao (o EXISTS passa pela
-- policy de connection_requests): quem nao ve a conexao nao ve a conversa.
-- Escrever exige ser o remetente E a conexao estar APROVADA: revogada,
-- recusada ou pendente fica barrada no banco, e nao so no service.
ALTER TABLE connection_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_messages FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connection_messages_party_select ON connection_messages;
CREATE POLICY connection_messages_party_select ON connection_messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM connection_requests r
       WHERE r.id = connection_messages.connection_request_id
    )
  );

DROP POLICY IF EXISTS connection_messages_party_insert ON connection_messages;
CREATE POLICY connection_messages_party_insert ON connection_messages
  FOR INSERT
  WITH CHECK (
    sender_tenant_id = app_current_tenant()
    AND EXISTS (
      SELECT 1 FROM connection_requests r
       WHERE r.id = connection_messages.connection_request_id
         AND r.status = 'approved'
    )
  );
-- Append-only: sem UPDATE e sem DELETE. A conversa e prova numa disputa.

-- Ate onde cada imobiliaria leu. Cada lado so ve e grava a propria linha.
ALTER TABLE connection_message_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_message_reads FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connection_message_reads_own ON connection_message_reads;
CREATE POLICY connection_message_reads_own ON connection_message_reads
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND EXISTS (
      SELECT 1 FROM connection_requests r
       WHERE r.id = connection_message_reads.connection_request_id
    )
  );
```

No bloco `-- Conexoes: cria, le e atualiza. Nunca apaga.` da seção de privilégios, depois de `REVOKE UPDATE, DELETE, TRUNCATE ON connection_events FROM app_user;`, acrescentar:

```sql
-- Conversa: o REVOKE ALL vem primeiro porque os default privileges do
-- bootstrap dao SELECT/INSERT/UPDATE/DELETE em toda tabela nova. O SELECT e
-- por coluna: body_original fica de fora, e nem `SELECT *` passa.
REVOKE ALL ON connection_messages FROM app_user;
GRANT SELECT (id, connection_request_id, sender_tenant_id, sender_user_id, body, created_at)
  ON connection_messages TO app_user;
GRANT INSERT ON connection_messages TO app_user;
REVOKE ALL ON connection_message_reads FROM app_user;
GRANT SELECT, INSERT, UPDATE ON connection_message_reads TO app_user;
```

- [ ] **Step 6: `migrate.ts` confere o resultado**

Em `packages/db/src/migrate.ts`:

1. Acrescentar `'connection_messages', 'connection_message_reads'` ao fim de `FORCED_TABLES`.
2. Em `verify`, antes do loop final `for (const row of forced.rows)`, acrescentar:

```ts
  // O original de uma mensagem mascarada nao pode ser legivel pela aplicacao.
  // Um GRANT SELECT na tabela inteira (ou um default privilege esquecido)
  // devolveria o telefone que a mascara tirou -- e nada falharia.
  const original = await pool.query<{ allowed: boolean }>(
    `SELECT has_column_privilege('app_user', 'connection_messages', 'body_original', 'SELECT') AS allowed`,
  );
  if (original.rows[0]?.allowed) {
    throw new Error('[migrate] app_user consegue ler connection_messages.body_original.');
  }
```

- [ ] **Step 7: Migrar e ver os testes do banco passarem**

Run: `pnpm db:migrate` e depois `pnpm test:rls`
Expected: migrate lista `connection_messages` e `connection_message_reads` com `rls=true force=true` e termina em `[migrate] ok`; a suíte do banco PASS inteira.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/connections.ts packages/db/drizzle packages/db/sql/10_security.sql \
  packages/db/src/migrate.ts packages/db/test/rls.test.ts
git commit -m "feat(db): tabelas da conversa com RLS das duas pontas e original escondido"
```

---

### Task 4: API da conversa (ler e enviar)

**Files:**
- Modify: `packages/contracts/src/connections.ts`
- Modify: `apps/api/src/modules/connections/repository.ts`
- Modify: `apps/api/src/modules/connections/service.ts`
- Modify: `apps/api/src/modules/connections/routes.ts`
- Modify: `apps/api/test/connections.test.ts`

**Interfaces:**
- Consumes: `maskContacts` (Task 1); `connectionMessages` (Task 3); `contatosDe`, `respostasDe` do teste (Task 2).
- Produces:
  - `@imob/contracts`: `sendMessageInput` / `SendMessageInput` (`{ body: string }`), `messageListQuery` / `MessageListQuery` (`{ after?: string }`), `connectionMessageDto` / `ConnectionMessageDto`.
  - `repository.ts`: `interface MessageRow { id: string; senderTenantId: string; body: string; createdAt: Date }`, `insertMessage(tx, values)`, `findMessage(tx, requestId, messageId)`, `latestMessages(tx, requestId, limit)`, `messagesAfter(tx, requestId, afterId, limit)`.
  - `service.ts`: `listMessages(actor, id, query): Promise<{ items: ConnectionMessageDto[]; hasMore: boolean }>`, `sendMessage(actor, id, input): Promise<{ message: ConnectionMessageDto; masked: boolean }>`.
  - Rotas: `GET /connections/:id/messages`, `POST /connections/:id/messages`.

- [ ] **Step 1: Testes que falham**

Em `apps/api/test/connections.test.ts`:

1. Depois do `describe('revogacao pela plataforma')` e **antes** de `describe('nenhum contato atravessa')`, acrescentar:

```ts
  describe('conversa', () => {
    let conversa: string;
    let pendente: string;
    let revogada: string;
    let adminCookies: Record<string, string>;

    function enviar(cookies: Record<string, string>, id: string, body: string) {
      return app.inject({ method: 'POST', url: `/connections/${id}/messages`, cookies, payload: { body } });
    }

    function mensagens(cookies: Record<string, string>, id: string, after?: string) {
      const query = after ? `?after=${after}` : '';
      return app.inject({ method: 'GET', url: `/connections/${id}/messages${query}`, cookies });
    }

    beforeAll(async () => {
      expect(betaListings.length).toBeGreaterThan(15);
      adminCookies = (await loginAs(app, 'admin@platform.test')).cookies;

      conversa = (await pedir(betaListings[10]!)).json().connection.id;
      await app.inject({ method: 'POST', url: `/connections/${conversa}/approve`, cookies: beta });

      pendente = (await pedir(betaListings[11]!)).json().connection.id;

      revogada = (await pedir(betaListings[12]!)).json().connection.id;
      await app.inject({ method: 'POST', url: `/connections/${revogada}/approve`, cookies: beta });
      await enviar(alfa, revogada, 'Mensagem antes da revogação.');
      await app.inject({
        method: 'POST',
        url: `/connections/${revogada}/revoke`,
        cookies: adminCookies,
        payload: { reason: 'Teste da conversa só leitura' },
      });
    });

    it('as duas partes conversam; o autor vem como you/other, sem nome de pessoa', async () => {
      const ida = await enviar(alfa, conversa, 'Tenho um cliente para visitar sábado.');
      expect(ida.statusCode).toBe(201);
      expect(ida.json().masked).toBe(false);
      expect(ida.json().message).toMatchObject({ body: 'Tenho um cliente para visitar sábado.', author: 'you' });
      expect(Object.keys(ida.json().message).sort()).toEqual(['author', 'body', 'createdAt', 'id']);

      const volta = await enviar(beta, conversa, 'Sábado às 10h funciona.');
      expect(volta.statusCode).toBe(201);

      const lidoPelaAlfa = await mensagens(alfa, conversa);
      expect(lidoPelaAlfa.statusCode).toBe(200);
      expect(lidoPelaAlfa.json().hasMore).toBe(false);
      expect(lidoPelaAlfa.json().items.map((m: { author: string; body: string }) => [m.author, m.body])).toEqual([
        ['you', 'Tenho um cliente para visitar sábado.'],
        ['other', 'Sábado às 10h funciona.'],
      ]);

      const lidoPelaBeta = await mensagens(beta, conversa);
      expect(lidoPelaBeta.json().items.map((m: { author: string }) => m.author)).toEqual(['other', 'you']);
      expect(contatosDe('alfa-imoveis').filter((v) => lidoPelaBeta.body.includes(v))).toEqual([]);
    });

    it('after traz so as novas e nao repete a mensagem do cursor', async () => {
      const todas = (await mensagens(alfa, conversa)).json().items;
      const ultima = todas[todas.length - 1].id;

      const nada = await mensagens(alfa, conversa, ultima);
      expect(nada.statusCode).toBe(200);
      expect(nada.json().items).toEqual([]);

      await enviar(beta, conversa, 'Confirmado.');
      const novas = (await mensagens(alfa, conversa, ultima)).json().items;
      expect(novas.map((m: { body: string }) => m.body)).toEqual(['Confirmado.']);
    });

    it('mascara contato, avisa quem escreveu e guarda o original so no banco', async () => {
      const response = await enviar(alfa, conversa, 'Me chama no 43 98010-1000 ou renata@alfa.com.br');
      expect(response.statusCode).toBe(201);
      expect(response.json().masked).toBe(true);
      expect(response.json().message.body).toBe('Me chama no [contato removido] ou [contato removido]');

      const { id } = response.json().message;
      const gravado = await withOracle(async (client) => {
        const { rows } = await client.query<{ body_original: string }>(
          'SELECT body_original FROM connection_messages WHERE id = $1',
          [id],
        );
        const audit = await client.query<{ metadata: { field: string; messageId: string } }>(
          `SELECT metadata FROM audit_log
            WHERE action = 'connection.message_masked' AND entity_id::text = $1
            ORDER BY id DESC LIMIT 1`,
          [conversa],
        );
        return { original: rows[0]!.body_original, audit: audit.rows[0]!.metadata };
      });
      expect(gravado.original).toBe('Me chama no 43 98010-1000 ou renata@alfa.com.br');
      expect(gravado.audit).toEqual({ field: 'body', messageId: id });

      const lidoPelaBeta = await mensagens(beta, conversa);
      expect(lidoPelaBeta.body).not.toContain('98010-1000');
      expect(lidoPelaBeta.body).not.toContain('renata@alfa.com.br');
    });

    it('texto que cresce com a mascara continua aceito', async () => {
      const response = await enviar(alfa, conversa, '@abcd '.repeat(300).trim());
      expect(response.statusCode).toBe(201);
      expect(response.json().masked).toBe(true);
    });

    it('preserva quebra de linha, acento e emoji; so-espacos e 422', async () => {
      const texto = 'Visita confirmada.\nAté sábado! 🙂';
      const response = await enviar(beta, conversa, texto);
      expect(response.statusCode).toBe(201);
      expect(response.json().message.body).toBe(texto);

      const vazio = await enviar(beta, conversa, '   ');
      expect(vazio.statusCode).toBe(422);

      const longo = await enviar(beta, conversa, 'a'.repeat(2001));
      expect(longo.statusCode).toBe(422);
    });

    it('pedido pendente nao tem conversa (422 ao enviar, lista vazia)', async () => {
      const envio = await enviar(alfa, pendente, 'Oi?');
      expect(envio.statusCode).toBe(422);
      expect(envio.json().fields).toHaveProperty('status');

      const leitura = await mensagens(alfa, pendente);
      expect(leitura.statusCode).toBe(200);
      expect(leitura.json().items).toEqual([]);
    });

    it('conexao revogada fica so leitura', async () => {
      const leitura = await mensagens(beta, revogada);
      expect(leitura.statusCode).toBe(200);
      expect(leitura.json().items.map((m: { body: string }) => m.body)).toEqual(['Mensagem antes da revogação.']);

      const envio = await enviar(alfa, revogada, 'Ainda está aí?');
      expect(envio.statusCode).toBe(422);
    });

    it('terceiro parceiro recebe 404 ao ler e ao enviar', async () => {
      expect((await mensagens(carlos, conversa)).statusCode).toBe(404);
      expect((await enviar(carlos, conversa, 'Oi')).statusCode).toBe(404);
    });

    it('after de outra conexao da 404', async () => {
      const deOutra = (await mensagens(alfa, revogada)).json().items[0].id;
      expect((await mensagens(alfa, conversa, deOutra)).statusCode).toBe(404);
    });

    it('admin da plataforma nao le a conversa', async () => {
      const response = await mensagens(adminCookies, conversa);
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('Tenho um cliente');
    });
  });
```

2. Em `describe('nenhum contato atravessa')`, na função `respostasDe`, trocar o array `urls` por:

```ts
      const urls = [
        '/connections?role=sent&limit=100',
        '/connections?role=received&limit=100',
        ...criados.map((id) => `/connections/${id}`),
        ...criados.map((id) => `/connections/${id}/messages`),
      ];
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:api -- test/connections.test.ts -t conversa`
Expected: FAIL com 404 do Fastify (`Route POST:/connections/.../messages not found`).

- [ ] **Step 3: Contrato**

Em `packages/contracts/src/connections.ts`, depois de `revokeConnectionInput`/`RevokeConnectionInput`, acrescentar:

```ts
export const sendMessageInput = z.object({
  /** Texto livre. Contato digitado e mascarado no servidor antes de gravar. */
  body: z.string().trim().min(1).max(2000),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const messageListQuery = z.object({
  /** Traz so as mensagens posteriores a esta. Sem ele, as 200 mais recentes. */
  after: z.string().uuid().optional(),
});
export type MessageListQuery = z.infer<typeof messageListQuery>;
```

E no fim do arquivo:

```ts
/**
 * Mensagem da conversa.
 *
 * `author` diz de que lado veio, nunca quem escreveu: nome de pessoa e
 * contato, e contato nao atravessa. A tela mostra a marca da outra parte.
 */
export const connectionMessageDto = z.object({
  id: z.string().uuid(),
  body: z.string(),
  author: z.enum(['you', 'other']),
  createdAt: z.string().datetime(),
});
export type ConnectionMessageDto = z.infer<typeof connectionMessageDto>;
```

- [ ] **Step 4: Repositório**

Em `apps/api/src/modules/connections/repository.ts`:

1. No import de `@imob/db`, acrescentar `asc` e `connectionMessages`.
2. No fim do arquivo, acrescentar:

```ts
/**
 * Colunas da conversa que a aplicacao pode ler.
 *
 * `body_original` fica de fora de proposito: o app_user nao tem SELECT nela
 * (grant por coluna em sql/10_security.sql). Um `select()` sem esta lista
 * pediria todas as colunas e morreria com permission denied.
 */
const messageColumns = {
  id: connectionMessages.id,
  senderTenantId: connectionMessages.senderTenantId,
  body: connectionMessages.body,
  createdAt: connectionMessages.createdAt,
};

export interface MessageRow {
  id: string;
  senderTenantId: string;
  body: string;
  createdAt: Date;
}

export async function insertMessage(
  tx: Tx,
  values: {
    connectionRequestId: string;
    senderTenantId: string;
    senderUserId: string;
    body: string;
    bodyOriginal: string | null;
  },
): Promise<MessageRow> {
  const rows = await tx.insert(connectionMessages).values(values).returning(messageColumns);
  const row = rows[0];
  if (!row) throw new Error('insert de mensagem nao devolveu linha');
  return row;
}

/** A mensagem, se ela for DESTA conexao. Serve de cursor para `after`. */
export async function findMessage(
  tx: Tx,
  connectionRequestId: string,
  messageId: string,
): Promise<MessageRow | null> {
  const rows = await tx
    .select(messageColumns)
    .from(connectionMessages)
    .where(
      and(
        eq(connectionMessages.id, messageId),
        eq(connectionMessages.connectionRequestId, connectionRequestId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** As mais recentes primeiro. Quem chama inverte para a ordem da conversa. */
export async function latestMessages(tx: Tx, connectionRequestId: string, limit: number): Promise<MessageRow[]> {
  return tx
    .select(messageColumns)
    .from(connectionMessages)
    .where(eq(connectionMessages.connectionRequestId, connectionRequestId))
    .orderBy(desc(connectionMessages.createdAt), desc(connectionMessages.id))
    .limit(limit);
}

/**
 * As posteriores ao cursor, em ordem crescente.
 *
 * A comparacao le o cursor NO BANCO: created_at tem microssegundos e o Date
 * do JS so milissegundos. Comparar com o valor que passou pelo JS devolveria
 * a propria mensagem do cursor em toda atualizacao.
 */
export async function messagesAfter(
  tx: Tx,
  connectionRequestId: string,
  afterId: string,
  limit: number,
): Promise<MessageRow[]> {
  return tx
    .select(messageColumns)
    .from(connectionMessages)
    .where(
      and(
        eq(connectionMessages.connectionRequestId, connectionRequestId),
        sql`(${connectionMessages.createdAt}, ${connectionMessages.id}) >
            (SELECT c.created_at, c.id FROM connection_messages c WHERE c.id = ${afterId}::uuid)`,
      ),
    )
    .orderBy(asc(connectionMessages.createdAt), asc(connectionMessages.id))
    .limit(limit);
}
```

- [ ] **Step 5: Service**

Em `apps/api/src/modules/connections/service.ts`:

1. No import de `@imob/contracts`, acrescentar `ConnectionMessageDto`, `MessageListQuery` e `SendMessageInput`.
2. Acrescentar `import { maskContacts } from '../../lib/contact-filter.js';` junto dos outros imports de `../../lib`.
3. No fim do arquivo, acrescentar:

```ts
/**
 * Mensagens por pagina. Conversa de conexao e curta; carregar as anteriores
 * fica para quando alguem precisar (hasMore ja avisa).
 */
const MESSAGE_PAGE = 200;

function toMessageDto(row: repo.MessageRow, actorTenantId: string): ConnectionMessageDto {
  return {
    id: row.id,
    body: row.body,
    author: row.senderTenantId === actorTenantId ? 'you' : 'other',
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Conversa da conexao. Sem `after`, as 200 mais recentes; com `after`, as
 * posteriores a essa mensagem (a atualizacao periodica da tela).
 */
export async function listMessages(
  actor: ActorContext,
  id: string,
  query: MessageListQuery,
): Promise<{ items: ConnectionMessageDto[]; hasMore: boolean }> {
  return withTenant(actor.tenantId, async (tx) => {
    // O RLS ja devolve zero linhas para quem nao e parte: 404, nunca 403.
    if (!(await repo.findById(tx, id))) throw notFound('Conexão não encontrada.');

    let page: repo.MessageRow[];
    let hasMore: boolean;
    if (query.after) {
      if (!(await repo.findMessage(tx, id, query.after))) throw notFound('Mensagem não encontrada.');
      const rows = await repo.messagesAfter(tx, id, query.after, MESSAGE_PAGE + 1);
      hasMore = rows.length > MESSAGE_PAGE;
      page = rows.slice(0, MESSAGE_PAGE);
    } else {
      const rows = await repo.latestMessages(tx, id, MESSAGE_PAGE + 1);
      hasMore = rows.length > MESSAGE_PAGE;
      page = rows.slice(0, MESSAGE_PAGE).reverse();
    }

    return { items: page.map((row) => toMessageDto(row, actor.tenantId)), hasMore };
  });
}

/**
 * Envia uma mensagem. So em conexao aprovada: revogada fica so leitura.
 *
 * O contato digitado e mascarado antes de gravar. O original fica em
 * body_original, que a aplicacao nao consegue ler; a auditoria registra que
 * a mascara agiu, para a plataforma achar reincidencia.
 */
export async function sendMessage(
  actor: ActorContext,
  id: string,
  input: SendMessageInput,
): Promise<{ message: ConnectionMessageDto; masked: boolean }> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await repo.findById(tx, id);
    if (!row) throw notFound('Conexão não encontrada.');
    if (row.status !== 'approved') {
      throw validationFailed({ status: 'A conversa só existe em conexão aprovada.' });
    }

    const filtered = maskContacts(input.body);
    const message = await repo.insertMessage(tx, {
      connectionRequestId: id,
      senderTenantId: actor.tenantId,
      senderUserId: actor.userId,
      body: filtered.text,
      bodyOriginal: filtered.masked ? input.body : null,
    });

    if (filtered.masked) {
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'connection.message_masked',
        entityType: 'connection_request',
        entityId: id,
        metadata: { field: 'body', messageId: message.id },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }

    return { message: toMessageDto(message, actor.tenantId), masked: filtered.masked };
  });
}
```

- [ ] **Step 6: Rotas**

Em `apps/api/src/modules/connections/routes.ts`:

1. Trocar o import de `@imob/contracts` por:

```ts
import {
  connectionListQuery,
  createConnectionInput,
  decideConnectionInput,
  messageListQuery,
  revokeConnectionInput,
  sendMessageInput,
} from '@imob/contracts';
```

2. Dentro de `connectionRoutes`, depois da rota `POST /connections/:id/cancel`, acrescentar:

```ts
  app.get('/connections/:id/messages', guard, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    const query = parseOrThrow(messageListQuery, request.query);
    return service.listMessages(actorOf(request), id, query);
  });

  /**
   * Limite proprio: conversa e uso normal, mas um script mandando mensagem
   * sem parar entope a caixa da outra imobiliaria.
   */
  app.post(
    '/connections/:id/messages',
    { preHandler: app.requireTenant, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = parseOrThrow(idParams, request.params);
      const input = parseOrThrow(sendMessageInput, request.body);
      return reply.code(201).send(await service.sendMessage(actorOf(request), id, input));
    },
  );
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm test:api -- test/connections.test.ts`
Expected: PASS, incluindo `conversa` e `nenhum contato atravessa`.

- [ ] **Step 8: Typecheck e commit**

Run: `pnpm typecheck`
Expected: sem erro.

```bash
git add packages/contracts/src/connections.ts apps/api/src/modules/connections apps/api/test/connections.test.ts
git commit -m "feat(connections): conversa entre as partes com contato mascarado"
```

---

### Task 5: Mensagens não lidas

**Files:**
- Modify: `packages/contracts/src/connections.ts`
- Modify: `apps/api/src/modules/connections/repository.ts`
- Modify: `apps/api/src/modules/connections/service.ts`
- Modify: `apps/api/src/modules/connections/routes.ts`
- Modify: `apps/api/test/connections.test.ts`

**Interfaces:**
- Consumes: `connectionMessageReads` (Task 3); `enviar` do `describe('conversa')` (Task 4).
- Produces:
  - `ConnectionDto.unreadCount: number` (sempre presente).
  - `repository.ts`: `markRead(tx, requestId, tenantId): Promise<void>`, `unreadCounts(tx, tenantId, requestIds): Promise<Map<string, number>>`.
  - `service.ts`: `markRead(actor, id): Promise<void>`; `hydrate(tx, row, actor, listing, unreadCount)`.
  - Rota: `POST /connections/:id/read` → 204.

- [ ] **Step 1: Teste que falha**

Em `apps/api/test/connections.test.ts`, dentro de `describe('conversa')`, depois do último `it`, acrescentar:

```ts
    it('nao lidas: sobem para quem recebe, nao contam as proprias e zeram com /read', async () => {
      const id = (await pedir(betaListings[13]!)).json().connection.id;
      await app.inject({ method: 'POST', url: `/connections/${id}/approve`, cookies: beta });

      async function naoLidas(cookies: Record<string, string>, role: 'sent' | 'received') {
        const response = await app.inject({ method: 'GET', url: `/connections?role=${role}&limit=100`, cookies });
        return response.json().items.find((i: { id: string }) => i.id === id).unreadCount as number;
      }

      expect(await naoLidas(beta, 'received')).toBe(0);
      await enviar(alfa, id, 'Primeira');
      await enviar(alfa, id, 'Segunda');
      expect(await naoLidas(beta, 'received')).toBe(2);
      expect(await naoLidas(alfa, 'sent')).toBe(0);

      const lido = await app.inject({ method: 'POST', url: `/connections/${id}/read`, cookies: beta });
      expect(lido.statusCode).toBe(204);
      expect(await naoLidas(beta, 'received')).toBe(0);

      await enviar(alfa, id, 'Terceira');
      expect(await naoLidas(beta, 'received')).toBe(1);

      const detalhe = await app.inject({ method: 'GET', url: `/connections/${id}`, cookies: beta });
      expect(detalhe.json().connection.unreadCount).toBe(1);
    });

    it('terceiro nao marca como lida a conversa dos outros', async () => {
      const response = await app.inject({ method: 'POST', url: `/connections/${conversa}/read`, cookies: carlos });
      expect(response.statusCode).toBe(404);
    });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:api -- test/connections.test.ts -t "nao lidas|marca como lida"`
Expected: FAIL. `unreadCount` vem `undefined` e `/read` responde 404 do Fastify.

- [ ] **Step 3: Contrato**

Em `packages/contracts/src/connections.ts`, no `connectionDto`, depois de `counterpart`, acrescentar:

```ts
  /** Mensagens da outra parte que esta imobiliaria ainda nao marcou como lidas. */
  unreadCount: z.number().int().min(0),
```

- [ ] **Step 4: Repositório**

Em `apps/api/src/modules/connections/repository.ts`, acrescentar `connectionMessageReads` ao import de `@imob/db` e, no fim do arquivo:

```ts
/** Marca a conversa como lida ate agora, pelo lado deste parceiro. */
export async function markRead(tx: Tx, connectionRequestId: string, tenantId: string): Promise<void> {
  await tx
    .insert(connectionMessageReads)
    .values({ connectionRequestId, tenantId, lastReadAt: sql`now()` })
    .onConflictDoUpdate({
      target: [connectionMessageReads.connectionRequestId, connectionMessageReads.tenantId],
      set: { lastReadAt: sql`now()` },
    });
}

/**
 * Nao lidas por conexao, numa consulta so para a lista inteira.
 *
 * Conta so o que veio da OUTRA parte, depois da ultima leitura deste lado.
 * Sem linha de leitura, tudo o que a outra parte mandou conta.
 */
export async function unreadCounts(
  tx: Tx,
  tenantId: string,
  requestIds: string[],
): Promise<Map<string, number>> {
  if (requestIds.length === 0) return new Map();

  const { rows } = await tx.execute(sql`
    SELECT m.connection_request_id AS id, count(*)::int AS unread
      FROM connection_messages m
      LEFT JOIN connection_message_reads r
        ON r.connection_request_id = m.connection_request_id
       AND r.tenant_id = ${tenantId}::uuid
     WHERE m.connection_request_id = ANY(${sql.param(requestIds)}::uuid[])
       AND m.sender_tenant_id <> ${tenantId}::uuid
       AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
     GROUP BY m.connection_request_id
  `);

  return new Map((rows as unknown as Array<{ id: string; unread: number }>).map((row) => [row.id, row.unread]));
}
```

- [ ] **Step 5: Service**

Em `apps/api/src/modules/connections/service.ts`:

1. `hydrate` ganha o parâmetro e o campo. Trocar a assinatura e o objeto por:

```ts
async function hydrate(
  tx: Tx,
  row: ConnectionRequest,
  actor: ActorContext,
  listing: repo.ListingRow,
  unreadCount: number,
): Promise<ConnectionDto> {
  const role = row.ownerTenantId === actor.tenantId ? 'owner' : 'requester';

  const dto: ConnectionDto = {
    id: row.id,
    status: row.status,
    role,
    message: row.message,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    listing: toListing(listing),
    unreadCount,
  };
```

(o resto de `hydrate` não muda).

2. Atualizar cada chamada de `hydrate`:
   - Em `request`: `return hydrate(tx, row, actor, await loadListing(tx, row.id), 0);`. Pedido recém-criado não tem conversa.
   - Em `transition`: `return hydrate(tx, updated, actor, await loadListing(tx, id), 0);`. Toda transição parte de `pending`, que nunca tem mensagem.
   - Em `list`, antes do `for`, calcular as não lidas e passá-las:

```ts
    const unread = await repo.unreadCounts(tx, actor.tenantId, rows.map((row) => row.id));

    const items: ConnectionDto[] = [];
    for (const row of rows) {
      const listing = listings.get(row.id);
      if (listing) items.push(await hydrate(tx, row, actor, listing, unread.get(row.id) ?? 0));
    }
```

   - Em `getById`:

```ts
    const unread = await repo.unreadCounts(tx, actor.tenantId, [row.id]);
    const connection = await hydrate(tx, row, actor, await loadListing(tx, row.id), unread.get(row.id) ?? 0);
```

   - Em `revoke`, no `return` final:

```ts
    const unread = await repo.unreadCounts(tx, ownerTenantId, [id]);
    return hydrate(tx, row, ownerView, await loadListing(tx, id), unread.get(id) ?? 0);
```

3. No fim do arquivo, acrescentar:

```ts
/** Marca a conversa como lida ate agora, pelo lado de quem chamou. */
export async function markRead(actor: ActorContext, id: string): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    if (!(await repo.findById(tx, id))) throw notFound('Conexão não encontrada.');
    await repo.markRead(tx, id, actor.tenantId);
  });
}
```

- [ ] **Step 6: Rota**

Em `apps/api/src/modules/connections/routes.ts`, depois de `POST /connections/:id/messages`:

```ts
  app.post('/connections/:id/read', guard, async (request, reply) => {
    const { id } = parseOrThrow(idParams, request.params);
    await service.markRead(actorOf(request), id);
    return reply.code(204).send();
  });
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm test:api -- test/connections.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck e commit**

Run: `pnpm typecheck`
Expected: sem erro. Se o web reclamar que `unreadCount` falta em algum objeto montado à mão, é só em teste de tipo; o web só lê `ConnectionDto` da API.

```bash
git add packages/contracts/src/connections.ts apps/api/src/modules/connections apps/api/test/connections.test.ts
git commit -m "feat(connections): contador de mensagens nao lidas por imobiliaria"
```

---

### Task 6: Recado do pedido e nota de recusa passam pelo filtro

**Files:**
- Modify: `apps/api/src/modules/connections/service.ts` (`request`, `transition`)
- Modify: `apps/api/test/connections.test.ts`

**Interfaces:**
- Consumes: `maskContacts` (Task 1); `recordAudit`.
- Produces: `connection.message` e `connection.decisionNote` gravados já mascarados; auditoria `connection.message_masked` com `metadata: { field: 'message' | 'decision_note', original: string }`.

- [ ] **Step 1: Testes que falham**

Em `apps/api/test/connections.test.ts`, dentro de `describe('conversa')`, acrescentar:

```ts
    it('recado do pedido com telefone chega mascarado ao dono', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/connections',
        cookies: alfa,
        payload: { listingId: betaListings[14]!, message: 'Me chama no 43 98010-1000' },
      });
      expect(response.statusCode).toBe(201);
      const id = response.json().connection.id;
      criados.push(id);
      expect(response.json().connection.message).toBe('Me chama no [contato removido]');

      const doDono = await app.inject({ method: 'GET', url: `/connections/${id}`, cookies: beta });
      expect(doDono.body).not.toContain('98010-1000');

      const audit = await withOracle(async (client) => {
        const { rows } = await client.query<{ metadata: { field: string; original: string } }>(
          `SELECT metadata FROM audit_log
            WHERE action = 'connection.message_masked' AND entity_id::text = $1`,
          [id],
        );
        return rows[0]!.metadata;
      });
      expect(audit).toEqual({ field: 'message', original: 'Me chama no 43 98010-1000' });
    });

    it('nota de recusa com e-mail chega mascarada a quem pediu', async () => {
      const id = (await pedir(betaListings[15]!)).json().connection.id;
      const recusado = await app.inject({
        method: 'POST',
        url: `/connections/${id}/reject`,
        cookies: beta,
        payload: { note: 'Fale com vendas@beta.com.br' },
      });
      expect(recusado.statusCode).toBe(200);
      expect(recusado.json().connection.decisionNote).toBe('Fale com [contato removido]');

      const visao = await app.inject({ method: 'GET', url: `/connections/${id}`, cookies: alfa });
      expect(visao.body).not.toContain('vendas@beta.com.br');
    });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:api -- test/connections.test.ts -t "recado|nota de recusa"`
Expected: FAIL, o texto chega intacto.

- [ ] **Step 3: Máscara no recado**

Em `service.ts`, na função `request`, dentro do `withTenant` e antes de `repo.insertRequest`, acrescentar:

```ts
    // O recado e texto livre para o dono: contato digitado nao atravessa.
    const recado = input.message === null ? null : maskContacts(input.message);
```

No `insertRequest`, trocar `message: input.message,` por `message: recado?.text ?? null,`. Depois do `recordAudit` de `connection.requested`, acrescentar:

```ts
    if (recado?.masked) {
      // Recado nao tem coluna de original: ele fica na auditoria de quem
      // escreveu, que o outro lado nao le.
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'connection.message_masked',
        entityType: 'connection_request',
        entityId: row.id,
        metadata: { field: 'message', original: input.message },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }
```

- [ ] **Step 4: Máscara na nota**

Em `transition`, logo depois da checagem `if (row.status !== 'pending') {...}`, acrescentar:

```ts
    // A nota vai para a outra parte: contato digitado nao atravessa.
    const filtered = note === null ? null : maskContacts(note);
```

No `repo.updateRequest`, trocar `decisionNote: note,` por `decisionNote: filtered?.text ?? null,`. Depois do `recordAudit` de `connection.${decision}`, acrescentar:

```ts
    if (filtered?.masked) {
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'connection.message_masked',
        entityType: 'connection_request',
        entityId: id,
        metadata: { field: 'decision_note', original: note },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test:api`
Expected: a suíte inteira da API PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/connections/service.ts apps/api/test/connections.test.ts
git commit -m "feat(connections): recado e nota de recusa passam pelo filtro de contato"
```

---

### Task 7: Tela da conversa e lista com não lidas

Sem suíte de teste no front: a verificação é typecheck e build aqui, e o navegador na Task 9.

**Files:**
- Create: `apps/web/src/components/connections/price.ts`
- Create: `apps/web/src/components/connections/ConversationView.tsx`
- Create: `apps/web/src/components/connections/conversation.module.css`
- Create: `apps/web/src/app/(app)/conexoes/[id]/page.tsx`
- Modify: `apps/web/src/components/connections/ConnectionsView.tsx`
- Modify: `apps/web/src/components/connections/connections.module.css`

**Interfaces:**
- Consumes: `GET /connections/:id` → `{ connection: ConnectionDto; events: ConnectionEventDto[] }`; `GET /connections/:id/messages[?after=]` → `{ items: ConnectionMessageDto[]; hasMore: boolean }`; `POST /connections/:id/messages` `{ body }` → `{ message, masked }`; `POST /connections/:id/read` → 204.
- Produces: `connectionPrice(listing: ConnectionListing): string`; rota `/conexoes/[id]`.

- [ ] **Step 1: Extrair o formato de preço**

Criar `apps/web/src/components/connections/price.ts`:

```ts
import type { ConnectionListing } from '@imob/contracts';
import { formatPrice } from '@/lib/format';

/** Preco do imovel da conexao, como a lista e a conversa mostram. */
export function connectionPrice(listing: ConnectionListing): string {
  const { purpose, salePriceCents, rentPriceCents } = listing;
  if (purpose === 'rent') return formatPrice(rentPriceCents, 'rent');
  const sale = formatPrice(salePriceCents, 'sale');
  return purpose === 'sale_rent' ? `${sale} ou ${formatPrice(rentPriceCents, 'rent')}` : sale;
}
```

Em `ConnectionsView.tsx`, apagar a função local `price(connection)`, trocar o import `formatArea, formatPrice` por `formatArea`, acrescentar `import Link from 'next/link';` e `import { connectionPrice } from './price';`, e trocar `{price(connection)}` por `{connectionPrice(listing)}`.

- [ ] **Step 2: Cartão da lista leva à conversa e mostra não lidas**

Em `ConnectionsView.tsx`, dentro do `items.map`, logo depois de `const busy = busyId === connection.id;`, acrescentar:

```tsx
          // Aprovada conversa; revogada guarda a conversa so para leitura.
          const hasConversation = connection.status === 'approved' || connection.status === 'revoked';
```

Trocar `<span className={styles.place}>{listing.neighborhoodName}</span>` por:

```tsx
                  {hasConversation ? (
                    <Link href={`/conexoes/${connection.id}`} className={styles.place}>
                      {listing.neighborhoodName}
                    </Link>
                  ) : (
                    <span className={styles.place}>{listing.neighborhoodName}</span>
                  )}
```

Trocar o `<span className={CONNECTION_BADGE[connection.status]}>...</span>` do `cardHead` por:

```tsx
                <div className={styles.badges}>
                  {connection.unreadCount > 0 && (
                    <span className="badge badge-info">
                      {plural(connection.unreadCount, 'nova', 'novas')}
                    </span>
                  )}
                  <span className={CONNECTION_BADGE[connection.status]}>
                    {CONNECTION_LABELS[connection.status]}
                  </span>
                </div>
```

Dentro de `<div className={styles.foot}>`, depois do bloco `{connection.status === 'pending' && connection.role === 'requester' && (...)}`, acrescentar:

```tsx
                {hasConversation && (
                  <Link href={`/conexoes/${connection.id}`} className="btn btn-sm">
                    {connection.status === 'approved' ? 'Abrir conversa' : 'Ver conversa'}
                  </Link>
                )}
```

Em `connections.module.css`, depois da regra `.city`, acrescentar:

```css
a.place {
  color: inherit;
  text-decoration: none;
}

a.place:hover {
  text-decoration: underline;
}

.badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
```

- [ ] **Step 3: Rota da conversa**

Criar `apps/web/src/app/(app)/conexoes/[id]/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { ConversationView } from '@/components/connections/ConversationView';

export const metadata: Metadata = { title: 'Conversa' };

export default async function ConversaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConversationView id={id} />;
}
```

- [ ] **Step 4: Componente da conversa**

Criar `apps/web/src/components/connections/ConversationView.tsx`:

```tsx
'use client';

import type { ConnectionDto, ConnectionEventDto, ConnectionMessageDto } from '@imob/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { formatArea } from '@/lib/format';
import { CONNECTION_BADGE, CONNECTION_LABELS, TYPE_LABELS, plural } from '@/lib/labels';
import { connectionPrice } from './price';
import styles from './conversation.module.css';

/** Nao e chat em tempo real: 15 s bastam para combinar visita e proposta. */
const POLL_MS = 15_000;

interface Detail {
  connection: ConnectionDto;
  events: ConnectionEventDto[];
}

interface MessagesResponse {
  items: ConnectionMessageDto[];
  hasMore: boolean;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Ordem da conversa. O servidor desempata por id; aqui o mesmo criterio. */
function byTime(a: ConnectionMessageDto, b: ConnectionMessageDto): number {
  return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);
}

export function ConversationView({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [messages, setMessages] = useState<ConnectionMessageDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [maskedNotice, setMaskedNotice] = useState(false);
  const lastId = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const markRead = useCallback(() => {
    void apiFetch<void>(`/connections/${id}/read`, { method: 'POST' }).catch(() => undefined);
  }, [id]);

  /**
   * Junta mensagens novas sem duplicar nem desordenar: a atualizacao
   * periodica e o envio podem trazer a mesma mensagem ao mesmo tempo.
   */
  const merge = useCallback((incoming: ConnectionMessageDto[]) => {
    if (incoming.length === 0) return;
    setMessages((current) => {
      const known = new Set(current.map((m) => m.id));
      const merged = [...current, ...incoming.filter((m) => !known.has(m.id))].sort(byTime);
      lastId.current = merged[merged.length - 1]?.id ?? null;
      return merged;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [loaded, first] = await Promise.all([
          apiFetch<Detail>(`/connections/${id}`),
          apiFetch<MessagesResponse>(`/connections/${id}/messages`),
        ]);
        if (!alive) return;
        setDetail(loaded);
        merge(first.items);
        markRead();
      } catch (reason) {
        if (alive) setError(reason instanceof ApiError ? reason.message : 'Não foi possível abrir a conexão.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, merge, markRead]);

  const loadNew = useCallback(async () => {
    const query = lastId.current ? `?after=${lastId.current}` : '';
    try {
      const { items } = await apiFetch<MessagesResponse>(`/connections/${id}/messages${query}`);
      if (items.length > 0) {
        merge(items);
        markRead();
      }
    } catch {
      // A proxima volta tenta de novo; nao vale interromper quem esta lendo.
    }
  }, [id, merge, markRead]);

  // Atualizacao periodica, so com a aba visivel.
  useEffect(() => {
    if (detail === null) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void loadNew();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [detail, loadNew]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  // FormEvent (botao) ou KeyboardEvent (Ctrl+Enter): os dois sao SyntheticEvent.
  async function send(event: React.SyntheticEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await apiFetch<{ message: ConnectionMessageDto; masked: boolean }>(
        `/connections/${id}/messages`,
        { method: 'POST', body: JSON.stringify({ body }) },
      );
      merge([result.message]);
      setMaskedNotice(result.masked);
      setDraft('');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível enviar agora.');
    } finally {
      setSending(false);
    }
  }

  if (detail === null) {
    return (
      <div className={styles.page}>
        <Link href="/conexoes" className={styles.back}>
          ← Conexões
        </Link>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : (
          <p className="hint">Carregando…</p>
        )}
      </div>
    );
  }

  const { connection } = detail;
  const { listing } = connection;
  const other = connection.counterpart?.partnerName ?? 'Parceiro da rede';
  const hasConversation = connection.status === 'approved' || connection.status === 'revoked';

  return (
    <div className={styles.page}>
      <Link href="/conexoes" className={styles.back}>
        ← Conexões
      </Link>

      <header className={styles.head}>
        <div className={styles.title}>
          <h1 className="page-title">{listing.neighborhoodName}</h1>
          <p className={styles.specs}>
            {TYPE_LABELS[listing.type]}
            {listing.bedrooms > 0 && ` · ${plural(listing.bedrooms, 'quarto', 'quartos')}`}
            {listing.areaBuilt !== null && ` · ${formatArea(listing.areaBuilt)}`}
            {' · '}
            <strong className="num">{connectionPrice(listing)}</strong>
          </p>
          <p className={styles.with}>
            {connection.role === 'owner' ? 'Pedido de ' : 'Imóvel de '}
            <strong>{other}</strong>
          </p>
        </div>
        <span className={CONNECTION_BADGE[connection.status]}>{CONNECTION_LABELS[connection.status]}</span>
      </header>

      {connection.status === 'pending' && (
        <p className="hint">A conversa abre quando quem anuncia aprovar o pedido.</p>
      )}
      {!hasConversation && connection.status !== 'pending' && (
        <p className="hint">Esta conexão foi encerrada sem conversa.</p>
      )}

      {hasConversation && (
        <section className={styles.thread} aria-label="Conversa">
          <ol className={styles.messages}>
            {connection.message && (
              <li className={connection.role === 'requester' ? styles.mine : styles.theirs}>
                <p className={styles.bubble}>{connection.message}</p>
                <span className={styles.meta}>Recado do pedido · {formatTime(connection.createdAt)}</span>
              </li>
            )}
            {messages.map((message) => (
              <li key={message.id} className={message.author === 'you' ? styles.mine : styles.theirs}>
                <p className={styles.bubble}>{message.body}</p>
                <span className={styles.meta}>
                  {message.author === 'you' ? 'Você' : other} · {formatTime(message.createdAt)}
                </span>
              </li>
            ))}
          </ol>
          {messages.length === 0 && !connection.message && (
            <p className="hint">Nenhuma mensagem ainda. Combine visita e proposta por aqui.</p>
          )}
          <div ref={endRef} />
        </section>
      )}

      {connection.status === 'revoked' && (
        <p className={styles.notice}>
          Conexão revogada pela plataforma. A conversa fica disponível só para leitura.
        </p>
      )}

      {maskedNotice && (
        <p className={styles.notice} role="status">
          Removemos telefone, e-mail ou link da sua mensagem. Combine tudo por aqui.
        </p>
      )}

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {connection.status === 'approved' && (
        <form className={styles.composer} onSubmit={(event) => void send(event)}>
          <textarea
            className="input"
            aria-label="Mensagem"
            maxLength={2000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void send(event);
            }}
            placeholder={`Escreva para ${other}…`}
          />
          <button type="submit" className="btn btn-primary" disabled={sending || draft.trim() === ''}>
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Estilo da conversa**

Criar `apps/web/src/components/connections/conversation.module.css`:

```css
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 880px;
}

.back {
  align-self: flex-start;
  font-size: 13px;
  color: var(--ink-2);
  text-decoration: none;
}

.back:hover {
  text-decoration: underline;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.specs,
.with {
  margin: 0;
  font-size: 13.5px;
  color: var(--ink-2);
}

.thread {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  max-height: 60vh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
}

.messages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mine,
.theirs {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: 78%;
}

.mine {
  align-self: flex-end;
  align-items: flex-end;
}

.theirs {
  align-self: flex-start;
}

.bubble {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-m);
  font-size: 14px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.mine .bubble {
  background: var(--action);
  color: #fff;
}

.theirs .bubble {
  background: var(--surface-2);
  border: 1px solid var(--line);
}

.meta {
  font-size: 11.5px;
  color: var(--ink-3);
}

.notice {
  margin: 0;
  padding: 10px 14px;
  background: var(--warn-soft);
  color: var(--warn);
  border-radius: var(--radius-s);
  font-size: 13.5px;
}

.composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.composer textarea {
  flex: 1;
  min-height: 64px;
  resize: vertical;
}

@media (max-width: 560px) {
  .head {
    flex-direction: column;
  }

  .mine,
  .theirs {
    max-width: 92%;
  }

  .composer {
    flex-direction: column;
    align-items: stretch;
  }
}
```

- [ ] **Step 6: Typecheck e build**

Run: `pnpm --filter @imob/web typecheck`
Expected: sem erro.

O build só roda depois de avisar o usuário: o 3100 dele usa o mesmo `.next`. Com o OK, parar o 3100, apagar `apps/web/.next`, rodar `pnpm --filter @imob/web build` e subir `pnpm --filter @imob/web exec next start -p 3100` de novo.
Expected: build sem erro, com a rota `/conexoes/[id]` listada.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/connections "apps/web/src/app/(app)/conexoes"
git commit -m "feat(web): tela de conversa da conexao e nao lidas na lista"
```

---

### Task 8: "Abrir conversa" no anúncio e contador no menu

**Files:**
- Modify: `apps/web/src/components/listing/ListingDetail.tsx:405-460`
- Modify: `apps/web/src/components/search/ListingRow.tsx:135-139`
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/components/AppShell.module.css`

**Interfaces:**
- Consumes: `listing.connection: { id, status } | null` (contrato de busca, já existente); `ConnectionDto.unreadCount` (Task 5).
- Produces: nada que outra task use.

- [ ] **Step 1: Anúncio**

Em `ListingDetail.tsx`:

1. No texto de ajuda sob "Pedir conexão", trocar por:

```tsx
                  <p className="hint">
                    A rede não mostra quem anuncia. Quem recebe o pedido decide; depois do aceite,
                    vocês conversam por aqui, em Conexões.
                  </p>
```

2. Trocar o bloco `{status === 'approved' && (...)}` por:

```tsx
              {status === 'approved' && listing.connection && (
                <>
                  <span className={CONNECTION_BADGE.approved}>{CONNECTION_LABELS.approved}</span>
                  <Link href={`/conexoes/${listing.connection.id}`} className="btn">
                    Abrir conversa
                  </Link>
                </>
              )}
```

- [ ] **Step 2: Linha da busca**

Em `ListingRow.tsx`, trocar o bloco `{listing.connection?.status === 'approved' && (...)}` por:

```tsx
            {listing.connection?.status === 'approved' && (
              <Link href={`/conexoes/${listing.connection.id}`} className="btn btn-sm">
                Abrir conversa
              </Link>
            )}
```

- [ ] **Step 3: Contador no menu**

Em `AppShell.tsx`:

1. Trocar os imports do topo por:

```tsx
import type { ConnectionDto } from '@imob/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { BrandMark } from './BrandMark';
import { Icon } from './Icon';
import { useSession } from './SessionProvider';
import styles from './AppShell.module.css';
```

2. Antes de `export function AppShell`, acrescentar:

```tsx
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
```

3. Dentro de `AppShell`, depois de `const partner = ...`, acrescentar `const unread = useUnreadConnections(Boolean(user.tenant), pathname);`.
4. Dentro do `<Link>` do menu, trocar `{item.label}` por:

```tsx
                {item.label}
                {item.href === '/conexoes' && unread > 0 && (
                  <span className={styles.navCount} aria-label={`${unread} mensagens não lidas`}>
                    {unread}
                  </span>
                )}
```

Em `AppShell.module.css`, acrescentar no fim:

```css
.navCount {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--info);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @imob/web typecheck`
Expected: sem erro.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/listing/ListingDetail.tsx apps/web/src/components/search/ListingRow.tsx \
  apps/web/src/components/AppShell.tsx apps/web/src/components/AppShell.module.css
git commit -m "feat(web): abrir conversa pelo anuncio e contador de nao lidas no menu"
```

---

### Task 9: Validação ponta a ponta e documentação

**Files:**
- Modify: `docs/plano.md`
- Modify: `docs/proximos-passos.md`
- Modify: `docs/anonimizacao.md`

**Interfaces:**
- Consumes: tudo das tasks 1–8.
- Produces: evidência (saída das suítes, screenshots) e docs atualizadas.

- [ ] **Step 1: Suítes e typecheck completos**

Run: `pnpm typecheck`, `pnpm test:rls` e `pnpm test:api`
Expected: as três sem erro. Guardar as linhas de resumo (`Tests  N passed`) para o relatório.

- [ ] **Step 2: Subir o ambiente local**

Avisar o usuário antes de mexer no 3100. Depois: `pnpm dev:infra` (se o Postgres/MinIO não estiverem de pé), `pnpm db:migrate`, `pnpm dev:api` em segundo plano, e o build do web como na Task 7, passo 6. Conferir `http://localhost:3100/login`.

- [ ] **Step 3: Pedido e aceite sem contato (navegador, chrome-devtools)**

Alfa (`admin@alfa.test` / `demo1234`) abre um imóvel da Beta sem conexão e pede conexão. Beta (`admin@beta.test` / `demo1234`) aprova em Conexões. Conferir, **na tela e no JSON cru** do painel de rede (`GET /api/connections...`): a Beta vê só "Alfa Imóveis", e a Alfa vê só "Beta Imóveis". Nenhum nome de corretor, telefone ou e-mail. Screenshot dos dois lados.

- [ ] **Step 4: Conversa e máscara**

Alfa clica em "Abrir conversa" (no anúncio e na lista) e manda "Posso visitar sábado?". Depois manda "me liga 43 98010-1000". Conferir que a segunda chega como `[contato removido]` e que aparece o aviso de remoção. Beta abre a conversa e responde. Conferir o JSON cru de `GET /api/connections/:id/messages`: só `id`, `body`, `author` e `createdAt`, sem telefone. Screenshot.

- [ ] **Step 5: Não lidas**

Com a Beta fora da conversa, a Alfa manda mais duas mensagens. Beta recarrega Conexões: o selo "2 novas" aparece no cartão e o menu mostra "2". Beta abre a conversa, volta, e o selo some. Screenshot.

- [ ] **Step 6: Envio junto com a atualização (Review Focus 5)**

Com a conversa aberta nos dois lados, a Beta manda uma mensagem, e a Alfa manda outra antes de 15 s. Esperar a próxima atualização e conferir nos dois lados: cada mensagem aparece uma vez só, em ordem de horário.

- [ ] **Step 7: Revogação só leitura**

Plataforma (`admin@platform.test` / `demo1234` no ambiente local) revoga a conexão via `fetch('/api/connections/<id>/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'teste local' }) })`. Alfa e Beta reabrem a conversa: aparece "Conexão revogada…", o histórico continua visível e não há campo de envio. Screenshot.

- [ ] **Step 8: Documentação**

- `docs/plano.md`:
  - apagar o aviso "Revisado em 28/09/2026 (a implementar)";
  - substituir a tabela "Quem vê o quê" pela tabela da seção "Regras do produto" da spec;
  - trocar a frase "A assimetria é deliberada: pedir conexão é se identificar; aprovar é que revela o dono." por "Pedir conexão é se identificar como imobiliária; aprovar abre a conversa. Contato de pessoa nunca atravessa.";
  - no item 4 da lista do topo (linha ~34), trocar "só depois do aceite o contato dele aparece" por "depois do aceite, as duas imobiliárias conversam pelo sistema, sem trocar contato";
  - na linha da tarefa F1 #5, acrescentar "conversa pelo sistema (28/09)";
  - no parágrafo "**Trilha:**", tirar a menção ao evento `disclosed` como algo gravado hoje.
- `docs/anonimizacao.md`, linhas 58–60: a linha 16 passa a dizer que `connection_disclosure()` só devolve a **marca**, em `approved` ou `revoked`; acrescentar uma linha: "Contato digitado na conversa, no recado ou na nota | `maskContacts` troca por `[contato removido]`; original só em `body_original`, sem SELECT para o `app_user` | `contact-filter.test.ts`, `rls.test.ts`".
- `docs/proximos-passos.md`, seção 2: trocar "Design em andamento" pelo estado real: implementado na branch `feat/conexao-mensagens`, com testes; falta deploy (migration `0005` + `10_security.sql`), que depende de aprovação. Listar o que ficou fora (e-mails, tela da plataforma para o original, "Pedir de novo", remover `disclosure_level`).
- Rodar `grep -rn "partner_contact\|brokerPhone\|disclosed" docs apps packages --include=*.md --include=*.ts --include=*.tsx | grep -v node_modules` e resolver o que ainda descrever a regra antiga. O valor `disclosed` do enum e a coluna `disclosure_level` ficam: são histórico e migration futura.

- [ ] **Step 9: Commit**

```bash
git add docs/plano.md docs/proximos-passos.md docs/anonimizacao.md
git commit -m "docs: conversa pelo sistema substitui a revelacao de contato"
```

- [ ] **Step 10: Parar e relatar**

Relatar ao usuário: saída das suítes, screenshots e o que ficou fora. **Não** fazer push, PR nem deploy sem ordem explícita. O deploy precisa de: merge na `main`, passo `migrate` (aplica `0005` e o `10_security.sql` novo), redeploy de `api` e `web`, e repetir os passos 3–7 em produção com as conexões de teste.
