# Plataforma de Parceria Imobiliária — Plano de Desenvolvimento (Fase 0 → Fase 1)

## Context

Rede fechada B2B entre corretores/imobiliárias parceiras. Hoje a busca por imóvel de terceiros acontece por WhatsApp, manualmente. O objetivo é centralizar essa busca numa base agregada, **com intermediação obrigatória da plataforma** — o que só funciona se o resultado de busca nunca revelar quem é o dono do imóvel. Se o solicitante consegue identificar o proprietário, ele fecha por fora e a plataforma perde a razão de existir.

Isso faz da **anonimização cross-tenant o requisito central de arquitetura**, não uma feature. O plano trata isolamento e anonimização como invariantes do banco de dados desde a Fase 0, e não como camada aplicada depois.

### Decisões fechadas
| Decisão | Escolha |
|---|---|
| Acesso a dados / isolamento | **Drizzle ORM + Row-Level Security no Postgres** |
| Localização | **Só bairro** — tabela normalizada + aliases. **Sem zona** (revisão de 14/09/2026) |
| Escopo Fase 0 | **Já nasce com tenant_id, RLS e view de busca segura** |
| Autenticação | **Fastify emite JWT em cookie httpOnly; Next.js como BFF** |
| Importação em massa | **XML VrSync** como formato único (revisão de 14/09/2026) |
| Valores | **Venda e aluguel em colunas separadas**; IPTU anual (revisão de 14/09/2026) |
| Marca e login | Mensagem neutra, sem promessa de zona; identidade definitiva é item futuro |

---

## Revisão de 14/09/2026 — bairro como filtro único e importação VrSync

### O que motivou

1. **Filtro por bairro, não por zona.** Zona é agrupamento coloquial, sem valor padronizado.
   A documentação oficial do VrSync (developers.grupozap.com) **tem** um elemento `<Zone>`,
   mas ele é **opcional e texto livre** — só o obrigatório (Country, State, City, Neighborhood,
   PostalCode) é confiável. Filtrar por um campo que a maioria dos feeds não preenche devolve
   menos imóveis sem erro, que é o modo de falha mais caro deste produto.
   `<Zone>` fica guardado **apenas** no payload bruto do item importado (`import_items.raw_payload`),
   como pista para a curadoria de bairros homônimos. Não é coluna, filtro nem elemento de tela.
2. **VrSync como referência da importação.** Padrão atual do Grupo OLX (ZAP+/VivaReal/OLX);
   os formatos diferentes de VrSync foram desligados em outubro de 2024. O schema já traz as
   fotos em `<Media><Item medium="image">URL</Item>`, então imóvel importado **não precisa de
   upload manual de fotos** — mas a URL do feed **nunca** é servida: a foto é baixada e
   re-hospedada (ver vetor 4 em `docs/anonimizacao.md`).

### Pesquisa de mercado (resumo)

- **Homer**: match por IA entre imóvel e intenção de compra; endereço completo não vai para a
  rede; os Termos de Uso autorizam mostrar nome, CRECI, telefone e e-mail do corretor ao outro
  usuário no match. **ImóvelPro**: match mútuo antes do chat, sem intermediação. **Brokers**:
  "só o responsável consulta as informações sensíveis". **ImobiShare**: projeto pessoal no GitHub.
- Conclusão: esconder endereço e proprietário **já existe no mercado**. O que não encontramos é
  **manter o corretor captador anônimo até a plataforma aprovar a conexão**. O diferencial real
  é o fluxo de conexão (F1 #5), não a view anônima — o que reforça a prioridade dessa tarefa.
- Fontes lidas via resumo automático; a matéria sobre o Homer é de 2020 e pode estar defasada.

### O que mudou no código

| Área | Mudança |
|---|---|
| Banco | `0001_remove_zones`: sai a tabela `zones` e as colunas `zone_id` (views derrubadas antes, com trava) |
| Banco | `0002_imports_and_split_prices`: `sale_price_cents`/`rent_price_cents`, colunas de origem em `property_media`, `import_sources`/`import_jobs`/`import_items` (FORCE RLS), `property_type_mappings` com 36 traduções padrão; cópia de `price_cents` com `NO FORCE` temporário e trava |
| Banco | `0003_drop_price_cents`: sai `price_cents` (views derrubadas antes, com trava) |
| API | `/catalog/cities/:id/zones` removida; `zoneIds` removido da busca; `zone` removido de todos os DTOs |
| API | Busca: faixa de valor exige finalidade (422); "venda" inclui anúncios de venda e aluguel, idem "aluguel" |
| API | Módulo `imports`: parser VrSync, tradução de tipo, resolução de bairro por alias e por CEP, sincronização de fotos com `safeFetch` (SSRF), arquivamento do que sai do feed |
| Telas | Mapa de zonas removido; bairro com autocomplete é o filtro de localização e o campo do cadastro |
| Telas | Formulário com valor de venda e de aluguel conforme a finalidade; IPTU por ano |
| Marca | `BrandMark` neutra (dois imóveis); login diz "Busca por bairro" |
| Seed | Sem zonas; 10% dos anúncios em venda e aluguel; IPTU anual |

### Descartado por causa das decisões

- Tabela `zones`, `ZoneMap`, cores por zona, `ZoneGlyph`, coluna `zona` do CSV de catálogo.
- **Pendência com o cliente "validar bairro → zona com corretor local"** — deixou de existir.
- Adapters XML ZAP legado, Imovelweb e OLX previstos na F1 #1. Feed ZAP antigo é recusado com
  mensagem que orienta a exportar em VrSync.
- Fluxo de upload manual de fotos para imóvel importado (o upload pela tela continua para
  cadastro manual).

---

## Status de execução

Atualizado em 14/09/2026. Verificado com migrate → seed → todas as suítes.

### Fase 0

| # | Tarefa | Status |
|---|---|---|
| 1 | Scaffold do monorepo + compose de dev | **pronto** |
| 2 | `packages/db`: Drizzle, roles, extensions, migration inicial | **pronto** |
| 3 | Schema F0 | **pronto** (revisado: sem zonas, preços separados) |
| 4 | RLS, policies, views de busca, grants | **pronto** |
| 5 | `withTenant()` + testes de fail-closed | **pronto** |
| 6 | Auth (argon2id, JWT, cookies, BFF no Next) | **pronto** |
| 7 | Seed determinístico | **pronto** — 3 parceiros, 60 imóveis, 25 bairros de Londrina, 57 aliases |
| 8 | CRUD de imóveis | **pronto** — API e telas; venda e aluguel separados |
| 7b | Curadoria do catálogo via CSV (`catalog:export` / `catalog:import`) | **pronto** — colunas `bairro,slug,aliases` |
| 9 | Upload de mídia (sharp, WebP, EXIF strip, URL assinada) | **pronto** |
| 10 | Busca com filtros sobre `network_listings` | **pronto** — bairro com autocomplete, sem zona |
| 11 | Suíte de anonimização + gate de CI | **pronto** |
| 12 | Deploy no EasyPanel | pendente |

### Fase 1 — adiantado nesta revisão

| # | Tarefa | Status |
|---|---|---|
| 1 | Parser VrSync + tradução de PropertyType + resolução de bairro (alias → CEP → curadoria) | **pronto** |
| 3 | Download seguro (SSRF) e re-hospedagem das fotos do `<Media>` | **pronto** |
| — | Tabelas `import_sources`/`import_jobs`/`import_items` com FORCE RLS; dry-run; relatório de diff por anúncio | **pronto** |
| — | Rotas `/imports/*` (só `partner_admin`) | **pronto** — execução em processo, sem fila ainda |

**176 testes verdes**: 26 no banco (isolamento, anonimização, RLS das tabelas de importação) e
150 na API (auth, carteira, busca, mídia, importação, parser VrSync e SSRF).

### Decisões do cliente registradas (12/09/2026)

- **Cidade da demo: Londrina/PR.** Catálogo com 25 bairros e 57 aliases, valores e vias locais.
- **Infra:** desenvolvimento em localhost, VPS depois. O bootstrap usa `current_database()`
  e as migrations são step separado — os dois pontos que quebram na promoção para produção.
- **Marca d'água nas fotos:** adiada, não resolvida. Ver `docs/anonimizacao.md`.
- **Catálogo de bairros não vem de API.** A tabela é a fonte de verdade; a curadoria acontece
  por CSV (`pnpm catalog:export` → planilha → `pnpm catalog:import`). ViaCEP entra na importação
  como *fallback*: quando o nome do bairro não bate, o CEP do anúncio (obrigatório no VrSync)
  ainda pode resolver.

### Ajustes ao plano descobertos na implementação

1. **A view de busca não pode pertencer ao dono das tabelas.** `FORCE ROW LEVEL SECURITY`
   aplica as policies inclusive ao owner — foi preciso um terceiro role,
   `app_network_reader` (`NOLOGIN`, `BYPASSRLS`), dono apenas das duas views e das funções
   de auth. O bypass existe, mas passa por um funil estreito e auditável.

2. **O login acontece antes de existir tenant no contexto.** Resolvido com funções
   `SECURITY DEFINER` de superfície mínima. Efeito colateral bom: `refresh_tokens` ficou
   sem privilégio nenhum para `app_user`.

3. **A suíte precisa de uma terceira credencial.** Um teste de anonimização precisa
   conhecer a verdade para afirmar que ela não vazou. Daí `DATABASE_URL_TEST_ORACLE`, que
   existe só em dev e CI.

4. **Array em parâmetro do Drizzle precisa de `sql.param()`.** No template `sql`, um
   array solto é desenrolado em placeholders separados e a consulta quebra. Afetava os
   filtros por bairro e tipo.

5. **Valor de venda e de aluguel em colunas separadas.** Com uma coluna só, a ordenação punha
   "R$ 5.250/mês" acima de "R$ 617.000 à venda", e um anúncio VrSync `Sale/Rent` perdia um dos
   dois valores. A API responde 422 pedindo `purpose` quando ordena ou filtra por valor.

6. **Cidade é derivada do bairro, nunca aceita do cliente.**

7. **Migration gerada pelo drizzle-kit precisa de revisão manual** (14/09/2026). Duas armadilhas:
   `DROP COLUMN` de coluna usada pelas views `network_*` sem derrubá-las antes; e `UPDATE` de
   cópia como `app_migrator` numa tabela com FORCE RLS afeta zero linhas sem erro. As migrations
   0001–0003 trazem `DROP VIEW` + trava antes do `DROP COLUMN`, e a 0002 desliga o FORCE só
   durante a cópia, com verificação.

8. **SSRF no download do feed** (14/09/2026). O feed é escrito pelo parceiro, então a URL do
   feed e a de cada foto são entrada não confiável. `lib/safe-fetch.ts` checa o IP depois do
   DNS, dentro do `lookup` do próprio socket (sem janela de DNS rebinding), revalida cada
   redirecionamento e limita bytes, tempo e Content-Type. O `net.BlockList` do Node compara
   IPv4 também como IPv6 mapeado — a regra `::ffff:0:0/96` bloqueava a internet inteira e foi
   substituída por conversão explícita.

---

## Arquitetura de pastas

Monorepo com pnpm workspaces (sem Turborepo na v1 — scripts bastam para 2 apps).

```
sistema-imob/
├── apps/
│   ├── web/                  # Next.js 15 (App Router) — UI + BFF
│   │   └── src/
│   │       ├── app/
│   │       │   ├── login/
│   │       │   ├── (app)/carteira/          # CRUD da própria carteira
│   │       │   ├── (app)/busca/             # busca cross-tenant anonimizada
│   │       │   └── api/[...path]/route.ts   # BFF: repassa cookie ao Fastify
│   │       ├── components/
│   │       └── lib/
│   └── api/                  # Fastify 5
│       └── src/
│           ├── server.ts
│           ├── plugins/auth.ts
│           ├── lib/
│           │   ├── image.ts           # sharp: resize, WebP, sem EXIF
│           │   ├── storage.ts         # S3/R2, chave opaca, URL assinada
│           │   └── safe-fetch.ts      # download com proteção contra SSRF
│           └── modules/               # vertical slices
│               ├── auth/
│               ├── properties/        # CRUD da própria carteira
│               ├── search/            # busca cross-tenant (SÓ lê a view)
│               ├── media/
│               ├── catalog/           # cities/neighborhoods + aliases
│               ├── audit/
│               ├── imports/           # parser VrSync, tradução de tipo, CEP, sync de fotos
│               ├── connections/       # F1 — solicitação/aprovação
│               └── sharing/           # F1 — link anônimo + PDF
├── packages/
│   ├── db/                   # schema Drizzle, migrations, políticas RLS, seed
│   └── contracts/            # schemas Zod compartilhados (DTOs) + tipos
├── docker/
└── docs/
    ├── plano.md
    ├── anonimizacao.md       # vetores de vazamento e mitigações
    └── catalogo-londrina.csv
```

---

## Modelagem de banco

Extensões: `pgcrypto`, `unaccent`, `citext`. (`pg_trgm` fica para o autocomplete no servidor.)

### Identidade e acesso
**`tenants`** — o parceiro · `id` · `legal_name` · `display_name` (**nunca cross-tenant**) · `slug` · `status`

**`users`** · `tenant_id` (null para admin de plataforma) · `email citext unique` · `password_hash` (argon2id) · `role` (`partner_admin|partner_agent|platform_admin`) · `token_version`

**`refresh_tokens`** · sem privilégio para `app_user`; só funções `SECURITY DEFINER`

### Catálogo geográfico (global — sem `tenant_id`, leitura para todos, escrita só admin)
**`cities`** `id` · `uf char(2)` · `name` · `slug` — unique `(uf, slug)`
**`neighborhoods`** `id` · `city_id fk` · `name` · `slug` — unique `(city_id, slug)`
**`neighborhood_aliases`** `id` · `city_id` · `neighborhood_id` · `alias_slug` · `source` — unique `(city_id, alias_slug)`

> Sem agrupamento por zona. Sem os aliases, a importação XML cria "Jd. América" e
> "Jardim América" como bairros distintos e **o filtro que é o produto quebra em silêncio**.

**`property_type_mappings`** (global) `source_key` (slug, unique) · `type` · `source` — tradução
do `PropertyType` do feed. "Residential / Apartment" é procurado como `residential-apartment` e
depois `apartment`. Cobertura, kitnet, studio e flat → `apartamento`; sobrado → `casa`; sem
tradução → `outro` com aviso no relatório.

### Imóveis
**`properties`**
`id uuid pk` · `tenant_id uuid not null`
`reference_code` ⚠️ · `title` ⚠️ · `description` ⚠️
`purpose` (`sale|rent|sale_rent`) · `type` · `status` (`draft|active|reserved|sold_rented|archived`)
`city_id` · `neighborhood_id`
`street` ⚠️ · `street_number` ⚠️ · `complement` ⚠️ · `zip` ⚠️ · `latitude` ⚠️ · `longitude` ⚠️
`bedrooms` · `suites` · `bathrooms` · `parking_spots`
`area_total` · `area_built`
`sale_price_cents` · `rent_price_cents` (mensal) · `condo_fee_cents` (mensal) · `iptu_cents` (**anual**) · `currency`
`accepts_exchange` · `is_exclusive` ⚠️ · `published_to_network`
`external_source` ⚠️ (`import:<source_id>`) · `external_id` ⚠️ (ListingID)
`created_by` ⚠️ · timestamps · `deleted_at`

⚠️ = campo identificador: **jamais pode cruzar a fronteira de tenant.**

Índices: `(tenant_id, status)`; `(neighborhood_id, type, sale_price_cents)` e `(neighborhood_id, type, rent_price_cents)` parciais na rede; `(type, bedrooms)`; unique `(tenant_id, external_source, external_id)`.

**`property_media`**
`tenant_id` · `property_id` · `storage_key` (**chave opaca**) · `kind` · `position` · `width` · `height` · `sanitized_at` · `original_filename` ⚠️
`source_url` ⚠️ · `source_url_hash` · `content_sha256` · `caption` ⚠️ — preenchidos só na importação

### Importação (FORCE RLS)
- **`import_sources`** — `tenant_id` · `name` ⚠️ · `format` (`vrsync`) · `feed_url` ⚠️ · `publish_to_network` (só para imóvel criado) · `active` · `last_run_at`
- **`import_jobs`** — `source_id` · `status` (`queued|running|succeeded|failed`) · `dry_run` · `stats` jsonb · `error`
- **`import_items`** — `job_id` · `external_id` ⚠️ · `property_id` · `status` (`created|updated|unchanged|archived|skipped|needs_curation|failed`) · `changes` (campo → de/para) · `warnings` · `errors` · `raw_payload` ⚠️ (o `<Listing>` original, **único lugar onde `<Zone>` é guardado**)

### Tabelas da Fase 1 ainda não criadas
- **`connection_requests`** — `property_id` · `requester_tenant_id` · `owner_tenant_id` · `status` (`pending|approved|rejected|cancelled|expired`) · `decided_by_user_id` · `disclosure_level`
- **`connection_events`** — trilha fina de cada transição
- **`shared_links`** — `token_hash` · `property_id` · `expires_at` · `revoked_at` · `view_count`

---

## Isolamento: RLS

Três roles no Postgres. **O app não pode ser dono das tabelas.**

- `app_migrator` — owner das tabelas, roda migrations (sujeito ao RLS por causa do `FORCE`)
- `app_user` — role da aplicação; `NOSUPERUSER`, sem `BYPASSRLS`
- `app_network_reader` — `NOLOGIN`, `BYPASSRLS`; dono só das views de busca e funções de auth

FORCE em `properties`, `property_media`, `refresh_tokens`, `import_sources`, `import_jobs`,
`import_items`. O `migrate.ts` confere RLS e FORCE a cada execução e derruba o deploy se faltar.

`current_setting('app.tenant_id', true)` devolve null quando não setado → nenhuma linha casa → **fail-closed**.

---

## Busca cross-tenant anonimizada

```sql
CREATE VIEW network_listings WITH (security_invoker = false) AS
SELECT
  p.id AS listing_id,        -- tenant_id deliberadamente AUSENTE
  p.type, p.purpose,
  p.city_id, p.neighborhood_id,
  p.bedrooms, p.suites, p.bathrooms, p.parking_spots,
  p.area_total, p.area_built,
  p.sale_price_cents, p.rent_price_cents, p.condo_fee_cents, p.iptu_cents,
  p.currency, p.accepts_exchange, p.created_at, p.updated_at
FROM properties p
WHERE p.deleted_at IS NULL AND p.status = 'active' AND p.published_to_network;
```

**Nunca `SELECT *`.** A lista é espelhada em `src/sensitive-fields.ts`, e a suíte quebra se as duas divergirem.

Filtros: `cityId`, `neighborhoodIds`, `types`, `purpose` (`sale` inclui `sale_rent`; `rent` também),
`bedroomsMin`, `bathroomsMin`, `parkingMin`, `areaBuiltMin`, `areaTotalMin`, `priceMin`/`priceMax`
(exigem `purpose`). Ordenação por valor exige `purpose`. Paginação por keyset.

Fotos cross-tenant são servidas por `GET /network/listings/:id/media/:mediaId` como URL assinada
de curta duração sobre chave opaca — inclusive as importadas, que nunca usam a URL do feed.

---

## Importação VrSync

`POST /imports/sources` · `POST /imports/sources/:id/jobs?dryRun=` (URL cadastrada) ·
`POST /imports/sources/:id/upload?dryRun=` (XML no corpo) · `GET /imports/jobs/:id` ·
`GET /imports/jobs/:id/items?status=`. Só `partner_admin`. **Dry-run é o padrão.**

Por anúncio:
1. **Parser** (`vrsync-parser.ts`): com ou sem namespace, qualquer caixa, CDATA, números com
   ponto ou vírgula, campos de `<Details>` soltos, `Iptu` mensal/anual ou `YearlyTax`, aluguel
   anual/trimestral convertido para mensal, temporada recusada. Recusa DOCTYPE/ENTITY, XML
   malformado e o formato ZAP legado. `ListingID` ausente ou repetido falha só aquele anúncio.
2. **Cidade e bairro**: nome → aliases → CEP (ViaCEP, mesma cidade) → **curadoria**. Nunca cria
   bairro automaticamente.
3. **Tipo**: `property_type_mappings`; sem tradução, `outro` com aviso.
4. **Grava ou compara**: cria, atualiza (diff campo a campo), mantém, ou pula imóvel que o
   parceiro excluiu. Imóvel arquivado que volta ao feed volta ao ar.
5. **Fotos**: `safeFetch` → `processPropertyImage` (sem EXIF) → chave opaca. A mesma URL não é
   baixada de novo (hash); foto que sai do feed sai do imóvel; vídeo do YouTube é ignorado
   (o canal identifica a imobiliária); fotos enviadas pela tela ficam depois das do feed.
6. **Arquivamento**: o que a fonte trouxe antes e sumiu do feed é arquivado. Feed sem nenhum
   anúncio válido não arquiva nada (é mais provável exportação quebrada).

---

## Vetores de vazamento que exigem decisão de produto

1. **Marca d'água queimada na foto** — adiado por decisão do cliente. Afeta também fotos importadas.
2. **Endereço exato** — cross-tenant expõe bairro e nada mais fino.
3. **Descrição livre** — fora da view até o pipeline de redação (F1 #4).
4. **URL da foto vinda do XML** — **resolvido**: re-hospedagem obrigatória em `syncMedia`.
5. **EXIF** — strip no upload e na importação.
6. **Metadata do PDF** — F1.
7. **Unicidade** — risco residual aceito.
8. **Enumeração** — UUID + rate limit na busca.

---

## Tarefas — Fase 0 (demo)

| # | Tarefa | Status |
|---|---|---|
| 1–11 | Ver status acima | **pronto** |
| 12 | Deploy: Dockerfiles multi-stage, EasyPanel, migrations como step separado, healthcheck, TLS | pendente |

## Tarefas — Fase 1 (v1 operacional), revisada em 14/09/2026

| # | Tarefa | Est. | Status |
|---|---|---|---|
| 1 | ~~Normalizador XML + adapters ZAP/Imovelweb/OLX/genérico~~ → **Parser VrSync** + tradução de tipo + bairro por alias/CEP | 3d | **pronto** |
| 2 | Fila **pg-boss**: agendamento por fonte, retry, execução fora do processo da API (hoje roda em processo) | 1,5d | pendente |
| 3 | Download seguro e **re-hospedagem das fotos do `<Media>`** | 1,5d | **pronto** |
| 3b | **Tela de importação e curadoria**: cadastrar feed, rodar dry-run, ver diff, resolver `needs_curation` criando alias | 2d | pendente |
| 3c | Autocomplete de bairro no servidor (`pg_trgm`, cidade no rótulo) quando houver mais de uma cidade | 1d | pendente |
| 4 | Pipeline de sanitização de descrição (telefone, e-mail, URL, marcas) + `description_sanitized` na view | 2d | pendente |
| 5 | **Fluxo de conexão**: solicitar, aprovar/recusar, expiração, e-mail, revelação controlada — **o diferencial real frente ao mercado** | 3d | pendente, **prioridade** |
| 6 | Auditoria completa das transições + tela de histórico | 1d | pendente |
| 7 | Compartilhamento: link com token + página anônima + PDF com metadata limpo | 3d | pendente |
| 8 | LGPD: `docs/lgpd-data-map.md` (inclui CEP enviado ao ViaCEP), retenção, export/exclusão | 1,5d | pendente |
| 9 | Backup `pg_dump` agendado → R2 **com teste de restore** | 1d | pendente |
| 10 | Hardening: rate limit, CSP, logs de acesso, revisão final de vazamento | 1,5d | pendente |
| — | Refinamento de marca (identidade visual definitiva) | — | futuro, fora do escopo técnico |

**≈ 17 dias úteis restantes.**

---

## Decisões técnicas adicionais

1. **Fila** — `pg-boss` (usa o próprio Postgres). A importação já expõe `done` como promessa; a fila só troca quem espera por ela.
2. **PDF** — `@react-pdf/renderer`.
3. **Imagens** — `sharp`; hoje síncrono no upload e na importação, vai para worker com a fila.
4. **Migrations** — step separado no EasyPanel, **não** no start do container. **Revisar à mão todo SQL gerado** (ajuste 7).
5. **Senha** — argon2id.
6. **Valores monetários** — `bigint` em centavos; venda e aluguel separados; IPTU anual.
7. **Backup** — `pg_dump` agendado para R2, com restore testado antes do go-live.
8. **Região fora do Brasil** — base legal documentada em contrato e em `docs/lgpd-data-map.md`.
9. **Testes** — vitest + Postgres real. RLS e anonimização não podem ser testados com mock.
10. **XML** — `fast-xml-parser` (sem resolução de entidade externa), DOCTYPE recusado na entrada.

## Pendências com o cliente

| Pendência | O que trava | Premissa para seguir |
|---|---|---|
| Quem aprova a conexão | F1 #5 | Dono do imóvel aprova; admin pode intervir. |
| O que é liberado após aprovar | F1 #5 | `disclosure_level`: revela parceiro + contato do corretor, nunca endereço exato. |
| ~~XML traz fotos?~~ | — | **Resolvido**: VrSync traz em `<Media>`; re-hospedagem implementada. |
| Aumentar os tipos da plataforma (cobertura, kitnet…) | Nada | Hoje mapeados para `apartamento`/`casa`; ampliar o enum é decisão de produto. |
| Volume de parceiros/imóveis | Nada estrutural na v1 | <20 parceiros, <5k imóveis. |

---

## Verificação

```bash
pnpm db:migrate && pnpm db:seed
pnpm test:rls     # 26 testes: isolamento, anonimização, RLS da importação
pnpm test:api     # 150 testes: auth, carteira, busca, mídia, importação, parser, SSRF
```

**Fim a fim, manual**
1. Login como parceiro A → cadastrar imóvel com fotos → aparece na carteira de A.
2. Login como parceiro B → buscar por bairro → o imóvel de A aparece **sem** nome, contato, marca ou endereço.
3. DevTools → Network: JSON cru da busca sem identificador de A, sem `tenant_id`, sem `zone`.
4. `exiftool` numa foto do resultado — sem GPS, autor ou copyright.
5. `GET /properties/:id` do imóvel de A autenticado como B → 404.
6. Como admin de A: `POST /imports/sources`, depois `POST /imports/sources/:id/upload` com um XML
   VrSync (dry-run) → `GET /imports/jobs/:id/items` mostra o diff e os itens em curadoria.
