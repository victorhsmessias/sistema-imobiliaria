# Plataforma de Parceria Imobiliária

Rede fechada B2B entre corretores e imobiliárias parceiras. Cada parceiro sobe a própria
carteira e busca na carteira agregada de todos os outros — **sem nunca descobrir de quem é
o imóvel** até que uma conexão seja aprovada pela plataforma.

Plano de desenvolvimento completo (fases, modelagem, tarefas): `docs/plano.md`.

## A regra que define a arquitetura

Se o solicitante consegue identificar o dono do imóvel a partir de um resultado de busca,
ele fecha o negócio por fora e a plataforma perde a razão de existir. Por isso a
anonimização cross-tenant não é uma camada da aplicação — ela está no banco:

| Mecanismo | Onde | O que garante |
|---|---|---|
| Row-Level Security (`FORCE`) | `packages/db/sql/10_security.sql` | Um parceiro só lê as próprias linhas, mesmo que a query erre |
| Contexto por transação | `packages/db/src/tenant.ts` | O tenant não gruda na conexão do pool entre requests |
| View com allow-list de colunas | `network_listings` | Coluna nova não entra na rede por acidente |
| Trava de credencial no boot | `packages/db/src/client.ts` | A API se recusa a subir conectada como `app_migrator` |
| Suíte de anonimização | `packages/db/test/` e `apps/api/test/search.test.ts` | Build vermelho se qualquer identificador vazar — no banco e na resposta HTTP |

O ponto central: **esquecer de setar o tenant devolve zero linhas, nunca todas** — as
policies comparam com `current_setting('app.tenant_id', true)`, que é `NULL` quando não
definido, e `NULL` não casa com nada. Fail-closed.

## Pré-requisitos

- Node 22+
- Docker
- pnpm — rode **uma vez**, num terminal como administrador:

  ```powershell
  corepack enable
  ```

  Sem isso o `pnpm` não entra no PATH, e os atalhos da raiz (`pnpm db:migrate`) falham
  porque chamam `pnpm` internamente. Use a forma longa nesse caso — ela funciona sempre:
  `corepack pnpm --filter @imob/db migrate`.

## Subir o ambiente

```bash
cp .env.example .env
pnpm install

pnpm dev:infra      # Postgres (5434) + MinIO (9000/9001)
pnpm db:migrate     # migrations + RLS + views + funções
pnpm db:seed        # 3 parceiros, 60 imóveis, bairros de Londrina
pnpm test           # 176 testes: isolamento, anonimização, auth, carteira, busca, mídia e importação

pnpm dev:api        # API em http://localhost:3333
pnpm dev:web        # Telas em http://localhost:3100
```

Verificação rápida de ponta a ponta:

```bash
curl -c /tmp/jar -X POST http://localhost:3333/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@alfa.test","password":"demo1234"}'

# a carteira do próprio parceiro
curl -b /tmp/jar http://localhost:3333/properties

# a busca na rede: anônima, localizada por bairro
curl -b /tmp/jar 'http://localhost:3333/network/search?purpose=sale&types=apartamento&bedroomsMin=3&sort=price_asc'
```

## Endpoints

| Método | Rota | O que faz |
|---|---|---|
| POST | `/auth/login` `/auth/refresh` `/auth/logout` | Sessão em cookie httpOnly; refresh de uso único |
| GET | `/auth/me` | Usuário da sessão |
| GET | `/catalog/cities` · `/catalog/cities/:id/neighborhoods?q=` | Catálogo geográfico (bairro é a única localização) |
| GET | `/catalog/cities/:id/neighborhoods/resolve?name=Jd.+Higienopolis` | Resolve grafia livre para o bairro do catálogo |
| GET POST PATCH DELETE | `/properties` · `/properties/:id` | Carteira do próprio parceiro |
| POST GET PATCH DELETE | `/properties/:id/media` · `/media/:mediaId` · `/media/order` | Fotos: upload, ordem, exclusão |
| GET | `/network/listings/:id/media/:mediaId` | Foto de outro parceiro, por URL assinada |
| GET | `/network/search` | **Busca anônima na base agregada de todos os parceiros** |
| POST GET | `/imports/sources` | Feeds VrSync do parceiro (só `partner_admin`) |
| POST | `/imports/sources/:id/jobs?dryRun=` · `/imports/sources/:id/upload?dryRun=` | Importa pela URL do feed ou pelo XML no corpo; dry-run é o padrão |
| GET | `/imports/jobs/:id` · `/imports/jobs/:id/items?status=` | Resultado e diff por anúncio |

`/network/search` é a única rota em que um parceiro vê dado de outro. Ela lê apenas das
views `network_*`, nunca da tabela `properties`.

Filtros: `cityId`, `neighborhoodIds`, `types`, `purpose`, `bedroomsMin`, `bathroomsMin`,
`parkingMin`, `areaBuiltMin`, `areaTotalMin`, `priceMin`, `priceMax`. Não há filtro por zona:
zona não é campo padronizado nos dados de origem.

`purpose=sale` devolve anúncios de venda **e** de venda e aluguel; `purpose=rent` também.
Venda e aluguel têm colunas de valor separadas, então **ordenar ou filtrar por valor exige
`purpose`** — sem ele a API responde 422, porque "R$ 5.250/mês" acima de "R$ 617.000 à venda"
não é um resultado confuso, é um resultado errado.

Paginação por keyset via `cursor`, não OFFSET — com OFFSET, um imóvel cadastrado entre
duas páginas faz um resultado aparecer duas vezes ou sumir.

Login de demonstração: `admin@alfa.test` / `demo1234`.

> Portas ocupadas nesta máquina por outros projetos: 5432 e 5433 (Postgres local e o
> container `imobiliaria-db`) e **3000** (o Next.js de `Documentos/Imobiliaria`). Por isso
> este ambiente usa **5434** para o banco e **3100** para as telas.


## Telas e BFF

O navegador fala só com o Next (`apps/web`); o Next repassa para a API em
`src/app/api/[...path]/route.ts`. Isso não é conveniência:

- **Cookie no domínio do site.** O BFF remove o `Domain` do cookie e reescreve o path do
  refresh de `/auth` para `/api/auth`. Sem isso o navegador nunca mandaria o refresh token
  e a sessão cairia a cada 15 minutos.
- **API fora da internet.** Só os prefixos `auth`, `catalog`, `properties`, `network` e
  `imports` passam; qualquer outro caminho responde 404 no próprio Next.
- **IP real no rate limit.** O `X-Forwarded-For` é repassado e a API confia em exatamente
  um salto (`TRUST_PROXY_HOPS=1`). Com `trustProxy: true`, bastaria o cliente forjar o
  cabeçalho para zerar o limite de tentativas de login.
- **Fotos não passam pelo Next.** A API responde 302 para a URL assinada do storage e o
  BFF devolve o redirect sem seguir — os bytes vão direto do bucket para o navegador.

## Três credenciais de banco, e por quê

| Role | Uso | RLS |
|---|---|---|
| `app_user` | Runtime da API. A única que a aplicação recebe. | Sujeito |
| `app_migrator` | Dono das tabelas, roda migrations. | Sujeito (por causa do `FORCE`) |
| `app_network_reader` | `NOLOGIN`. Dono das views de busca e das funções de auth. | **Bypass** |

A busca cross-tenant precisa, por definição, atravessar o RLS. Em vez de enfraquecer as
policies para permitir isso, a travessia foi concentrada num único funil estreito: duas
views com lista explícita de colunas, cujo dono tem bypass. O bypass existe, mas é
auditável e cabe numa tela.

`DATABASE_URL_TEST_ORACLE` existe **apenas em dev e CI**: a suíte precisa de uma conexão
que enxergue tudo para comparar contra o que a aplicação enxerga. Um teste de anonimização
precisa conhecer a verdade para afirmar que ela não vazou.

## Estrutura

```
apps/web            Next.js: login, busca, carteira    [pronto]
apps/api            Fastify: auth, carteira, busca     [pronto]
packages/db         schema Drizzle, RLS, views, seed   [pronto]
packages/contracts  DTOs Zod compartilhados            [pronto]
docker/         compose de desenvolvimento
docs/           plano, mapa LGPD, notas de anonimização
```

## Comandos

| Comando | O que faz |
|---|---|
| `pnpm dev:infra` | Sobe Postgres e MinIO |
| `pnpm dev:infra:reset` | Destrói os volumes e recria do zero |
| `pnpm db:generate` | Gera migration a partir do schema Drizzle |
| `pnpm db:migrate` | Aplica migrations + `sql/10_security.sql` |
| `pnpm db:seed` | Popula dados de demonstração (determinístico) e gera as fotos ilustrativas no storage |
| `pnpm db:seed:media` | Só as fotos: envia ao storage as que faltam e troca chaves não opacas (idempotente) |
| `pnpm dev:api` | Sobe a API em modo watch |
| `pnpm dev:web` | Sobe as telas em modo watch (porta 3100) |
| `pnpm test` | Todas as suítes |
| `pnpm test:rls` | Isolamento, anonimização e RLS da importação no banco (26 testes) |
| `pnpm test:api` | Auth, carteira, busca, mídia, importação, parser VrSync e SSRF (150 testes) |
| `pnpm catalog:export` | Exporta o catálogo de bairros para CSV (revisão em planilha) |
| `pnpm catalog:import` | Aplica o CSV revisado (dry-run; `--apply` grava) |

## Importação VrSync

Formato único: XML VrSync (Grupo OLX / ZAP+ / VivaReal). O feed ZAP antigo, desligado em
outubro de 2024, é recusado com mensagem orientando a exportar em VrSync.

- As fotos vêm do `<Media>` e são **baixadas e re-hospedadas** sob chave opaca, sem EXIF —
  a URL do feed nunca é servida, porque aponta para o domínio da imobiliária.
- Todo download passa por `lib/safe-fetch.ts` (proteção contra SSRF): o feed é escrito pelo
  parceiro, então a URL é entrada não confiável.
- Bairro: nome → alias → CEP (ViaCEP) → **curadoria**. Nunca cria bairro sozinho.
- `<Zone>` é guardado só no payload bruto do item (`import_items.raw_payload`), para a
  curadoria de bairros homônimos. Não vira coluna, filtro nem tela.
- Tipo: tabela `property_type_mappings`; sem tradução, `outro` com aviso.

## Ao escrever migration

Revise o SQL que o drizzle-kit gera antes de aplicar. Coluna usada pelas views `network_*`
exige `DROP VIEW` **antes** do `DROP COLUMN` (veja a trava em `drizzle/0001_remove_zones.sql`),
e `UPDATE` de cópia numa tabela com FORCE RLS afeta zero linhas sem erro se o FORCE não for
desligado dentro da migration (veja `drizzle/0002_imports_and_split_prices.sql`).

## Ao mexer em `sql/10_security.sql`

É o arquivo onde a anonimização vive. Ele é idempotente e reaplicado a cada `db:migrate`,
de modo que não existe estado de segurança no banco que não esteja no repositório.

Para adicionar uma coluna à busca da rede é preciso mudar **dois** lugares: a view em
`sql/10_security.sql` e a lista em `src/sensitive-fields.ts`. Mudar só um quebra o build.
Isso é deliberado — expor um campo novo a todos os parceiros é decisão de produto, não
efeito colateral de um `ALTER TABLE`.

Para confirmar que a suíte ainda morde, injete um vazamento de propósito (adicione
`p.tenant_id` à view, rode os testes, veja ficar vermelho) e restaure com `db:migrate`.

## Nota sobre o diretório

O projeto está dentro de uma pasta do OneDrive. `node_modules` tem dezenas de milhares de
arquivos e o pnpm usa links — a sincronização pode ficar lenta ou travar builds. Vale
excluir `node_modules` da sincronização do OneDrive, ou mover o repositório para fora dela
(por exemplo `C:\dev\sistema-imob`).
