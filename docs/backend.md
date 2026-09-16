# Guia do backend

Para quem vai mexer em `apps/api` e `packages/db` sem ter acompanhado as decisões.
Leia primeiro `docs/plano.md` (seção "Onde estamos") para o estado atual, e
`docs/anonimizacao.md` para o porquê das travas.

## Modelo mental em cinco linhas

Rede fechada entre imobiliárias. Cada parceiro é um `tenant`. Um parceiro busca na carteira
agregada de todos **sem descobrir de quem é o imóvel**; para negociar, pede uma conexão, e o
dono decide. Se o solicitante conseguir identificar o dono a partir da busca, ele fecha por fora
e a plataforma perde a razão de existir — por isso a anonimização não é camada de aplicação,
é invariante de banco.

## As invariantes (não negocie sem decisão de produto)

| Invariante | Onde vive | O que quebra se violar |
|---|---|---|
| Toda leitura/escrita de dado de parceiro passa por `withTenant()` | `packages/db/src/tenant.ts` | consulta fora dela devolve zero linhas (fail-closed) ou vaza se o RLS mudar |
| `app_user` nunca tem `BYPASSRLS`; a API recusa subir como `app_migrator` | `packages/db/src/client.ts` (`assertRuntimeRole`) | RLS vira enfeite e a busca devolve tudo, sem erro e sem log |
| A busca cross-tenant lê **só** as views `network_*` | `apps/api/src/modules/search/repository.ts` | `properties` tem `tenant_id` em cada linha |
| A lista de colunas da view existe em **dois** lugares | `packages/db/sql/10_security.sql` e `packages/db/src/sensitive-fields.ts` | divergiu, a suíte quebra — é essa a intenção |
| O único bypass de RLS é o dono das views/funções (`app_network_reader`) | `sql/10_security.sql` | espalhar bypass pela aplicação torna o vazamento impossível de auditar |
| Endereço, título, descrição e `reference_code` nunca cruzam a fronteira de tenant | view + `connection_listing()` | com o endereço, acha-se o anúncio original num portal em segundos |

Testes que protegem isso: `packages/db/test/rls.test.ts`, `packages/db/test/anonymization.test.ts`,
`apps/api/test/search.test.ts`, `apps/api/test/connections.test.ts`. São gate de CI.

## Mapa dos módulos

Cada módulo em `apps/api/src/modules/` segue `routes.ts` → `service.ts` → `repository.ts`.
Rota valida e traduz HTTP; service tem a regra e abre `withTenant`; repository fala SQL.

| Módulo | Faz | Ponto de atenção |
|---|---|---|
| `auth` | login, refresh de uso único, logout, `/auth/me` | login roda **antes** de existir tenant: usa funções `SECURITY DEFINER` |
| `properties` | CRUD da carteira do próprio parceiro | cidade é derivada do bairro, nunca aceita do cliente |
| `search` | busca cross-tenant anônima | lê só as views; `purpose` obrigatório para ordenar/filtrar por valor |
| `media` | upload, ordem, URL assinada | `processPropertyImage` remove EXIF; nunca adicione `.withMetadata()` |
| `catalog` | cidades, bairros, aliases, resolução de grafia | escrita só via `catalog_add_alias()` |
| `imports` | XML VrSync: parser, tipo, bairro, fotos, arquivamento | `safeFetch` obrigatório em toda URL do feed |
| `connections` | pedir, aprovar, recusar, cancelar, expirar | linha de **dois** tenants; revelação no banco |
| `audit` | trilha append-only | `recordAudit` recebe a transação, nunca abre a própria |

## Padrões obrigatórios

- **Validação**: `parseOrThrow(schema, data)` (`lib/validate.ts`) com schema de `@imob/contracts`.
  Erros: `lib/errors.ts` (`notFound`, `forbidden`, `validationFailed`, `unauthenticated`).
  **404, nunca 403, para recurso de outro parceiro** — 403 já confirma que o recurso existe.
- **Transação**: `withTenant(tenantId, fn)`. Repositório que pega conexão por fora não passa.
- **Arrays em SQL**: `sql.param(lista)`. Sem isso o drizzle desenrola o array em placeholders
  separados e a consulta quebra.
- **Dinheiro**: `bigint` em centavos, nunca float. Venda e aluguel em colunas separadas.
- **`numeric`** volta do driver como **string** (áreas, coordenadas). Converta na borda.
- **IPTU é anual.** A importação normaliza mensal → anual.

## Armadilhas já pagas (não repita)

1. **Migration que remove coluna usada pelas views**: `DROP VIEW` → trava → `DROP COLUMN`.
   O `drizzle-kit` gera na ordem errada. Ver `drizzle/0001_remove_zones.sql` e `0003_*.sql`.
2. **`UPDATE` de backfill numa tabela com `FORCE RLS`** roda como `app_migrator` sem tenant e
   afeta **zero linhas, sem erro**. Desligue o `FORCE` dentro da migration e confira o resultado
   (`drizzle/0002_*.sql`).
3. **Função `SECURITY DEFINER` que chama `app_current_tenant()`** precisa de
   `GRANT EXECUTE ... TO app_network_reader`. Sem isso, morre em runtime com "permission denied".
4. **Função fail-closed chamada fora de `withTenant`** devolve vazio, e o service traduz como 404.
   Se uma função depende do tenant da sessão, o chamador **tem** que abrir a transação.
5. **Teste de RLS vacuoso**: montar o `INSERT` com um `SELECT` sujeito ao RLS faz a consulta
   interna devolver zero linhas, o insert não viola nada e o teste passa sem testar. Use ids
   concretos vindos do oráculo.

## Receitas

**Expor um campo novo na busca da rede** (é decisão de produto, não refactor):
1. adicione a coluna na view em `sql/10_security.sql`;
2. adicione o mesmo nome em `NETWORK_ALLOWED_COLUMNS` (`sensitive-fields.ts`);
3. adicione ao `NetworkRow` e ao SELECT em `search/repository.ts` e ao DTO em `contracts/search.ts`;
4. rode `pnpm test:rls` — se o campo identifica o dono, a suíte quebra.

**Migration**: edite o schema em `packages/db/src/schema/`, rode `pnpm db:generate`, **leia o SQL
gerado**, corrija a ordem se houver `DROP COLUMN`, e só então `pnpm db:migrate`. Para evitar o
prompt interativo de rename, separe "adicionar coluna" de "remover coluna" em duas migrations.

**Endpoint novo**: rota com `preHandler: app.requireTenant` (ou `app.authenticate`), `parseOrThrow`,
service com `withTenant`, `recordAudit` na mesma transação da escrita. Se o front for consumir,
acrescente o prefixo em `ALLOWED_PREFIXES` no BFF (`apps/web/src/app/api/[...path]/route.ts`).

## Importação VrSync, em uma passada

`vrsync-parser.ts` é **puro** (XML → dados normalizados; sem banco, sem rede) e tolerante:
namespace opcional, qualquer caixa de tag, CDATA, vírgula decimal, `Iptu` mensal ou anual,
aluguel anual/trimestral convertido, temporada recusada. Recusa DOCTYPE/ENTITY e o formato ZAP
legado. `service.ts` resolve cidade e bairro (nome → alias → CEP → curadoria), traduz o tipo por
`property_type_mappings`, compara com o que já existe, sincroniza fotos e arquiva o que sumiu do
feed. **Toda URL do feed passa por `lib/safe-fetch.ts`** — é entrada não confiável.

## Conexões, em uma passada

Primeira tabela cuja linha pertence a **dois** tenants: as policies comparam
`requester_tenant_id` **ou** `owner_tenant_id`. O dono vê quem pediu desde o pedido; o
solicitante só vê o dono depois do aceite — e isso está no `WHERE` de `connection_disclosure()`,
no banco, não no service. `network_listing_owner()` existe porque quem pede não pode descobrir o
dono (a view não tem `tenant_id`); o valor só carimba a linha.

## Verificação

```bash
pnpm db:migrate && pnpm db:seed
pnpm test:rls    # 31 testes: isolamento e anonimização, contra Postgres real
pnpm test:api    # 170 testes
pnpm typecheck
```

RLS e anonimização **não podem ser testados com mock**. `DATABASE_URL_TEST_ORACLE` é a conexão
que enxerga tudo: um teste de anonimização precisa conhecer a verdade para afirmar que ela não
vazou. Só existe em dev e CI.
