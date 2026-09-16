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
| Quem aprova a conexão | **O dono do imóvel**, pedido a pedido. A plataforma credencia, arbitra e pode suspender — não aprova cada conexão (revisão de 15/09/2026) |

---

## Onde estamos — 16/09/2026

**O produto funciona de ponta a ponta em ambiente local. O que falta é colocá-lo no ar.**

Um parceiro já consegue, hoje:

1. Entrar na rede e cadastrar imóveis com fotos (sem EXIF, sob chave opaca).
2. **Importar a carteira inteira** por XML VrSync — arquivo ou URL —, simulando antes,
   vendo o diff anúncio a anúncio e resolvendo na tela os bairros que o catálogo não reconheceu.
3. **Buscar na carteira agregada** por bairro, tipo, quartos, área e faixa de valor, sem
   descobrir de quem é nenhum imóvel.
4. **Pedir conexão** num imóvel de outro parceiro. O dono vê quem pediu e decide; só depois do
   aceite o contato dele aparece — e o endereço, nunca.

O que sustenta essa afirmação: **201 testes** (31 no banco, 170 na API), typecheck limpo nos
quatro pacotes, e as imagens de produção construindo e subindo (API respondendo `/health`, web
servindo `/login`). Detalhe por tarefa nas tabelas de status abaixo.

### O que falta, e o que trava cada item

| Falta | Impacto | O que destrava |
|---|---|---|
| **Executar o deploy** (F0 #12) | ninguém fora daqui usa | domínio, tipo de Postgres, storage e credencial do EasyPanel — artefatos e guia já prontos em `docs/deploy.md` |
| **Fila (pg-boss)** (F1 #2) | importação ocupa o processo da API e se perde se o container reiniciar; prende a API em **uma réplica** | nada; é trabalho |
| **E-mail das conexões** (F1 #5b) | o dono só descobre o pedido entrando na tela | definir remetente e provedor |
| **Sanitização da descrição** (F1 #4) | título e descrição ficam fora da busca; o anúncio da rede mostra só dados estruturados | nada; é trabalho |
| **Mapa LGPD** (F1 #8) | inclui o CEP enviado ao ViaCEP e a região do storage | decisão sobre onde o bucket fica |
| **Backup com restore testado** (F1 #9) | risco alto no dia em que entrar dado real | nada; é trabalho |
| **Marca d'água nas fotos** | vazamento visual nas fotos importadas | decisão do cliente (adiada, não resolvida) |
| **Termo de parceria antes do contato** | mudaria o fluxo de conexão | decisão do cliente |
| **Revogar conexão pela plataforma** | o status `revoked` existe, a rota não | definir como `platform_admin` age (hoje não tem tenant no contexto) |

### O que nunca foi verificado

**As telas não foram abertas num navegador.** A verificação foi por typecheck, testes e build;
as imagens sobem e servem a página de login, mas busca, carteira, conexões e importação nunca
passaram por um olho humano. É o tipo de defeito que teste não pega.

### Ordem sugerida

1. Deploy da demo (destrava a validação com corretor de verdade).
2. Fila + e-mail das conexões (são o que falta para uso diário).
3. LGPD, backup e sanitização de descrição, antes de qualquer dado real.

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

Atualizado em 16/09/2026. Verificado com migrate → seed → todas as suítes, typecheck e build das imagens.

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
| 12 | Deploy no EasyPanel | **artefatos prontos** (16/09/2026): Dockerfiles, `.dockerignore`, build das imagens no CI e `docs/deploy.md`. Execução no servidor pendente |

### Fase 1 — adiantado nesta revisão

| # | Tarefa | Status |
|---|---|---|
| 1 | Parser VrSync + tradução de PropertyType + resolução de bairro (alias → CEP → curadoria) | **pronto** |
| 3 | Download seguro (SSRF) e re-hospedagem das fotos do `<Media>` | **pronto** |
| — | Tabelas `import_sources`/`import_jobs`/`import_items` com FORCE RLS; dry-run; relatório de diff por anúncio | **pronto** |
| — | Rotas `/imports/*` (só `partner_admin`) | **pronto** — execução em processo, sem fila ainda |
| 5 | **Fluxo de conexão**: pedir, aprovar, recusar, cancelar, expirar, revelação controlada + tela | **pronto** — falta notificação por e-mail |
| 3b | **Tela de importação e curadoria**: cadastrar feed, simular, ver o diff, ligar grafia a bairro | **pronto** (16/09/2026) |

**201 testes verdes**: 31 no banco (isolamento, anonimização, RLS da importação e das conexões) e
170 na API (auth, carteira, busca, mídia, importação, parser VrSync, SSRF, conexões e curadoria).

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

### Conexões (FORCE RLS) — implementado em 15/09/2026
- **`connection_requests`** — `property_id` · `requester_tenant_id` · `requester_user_id` · `owner_tenant_id` · `status` (`pending|approved|rejected|cancelled|expired|revoked`) · `disclosure_level` (`partner|partner_contact`) · `message` · `decision_note` · `decided_by_user_id` · `decided_at` · `expires_at` — unique parcial `(property_id, requester_tenant_id) WHERE status='pending'`
- **`connection_events`** — `type` (`requested|approved|rejected|cancelled|expired|revoked|disclosed`) · `actor_tenant_id` (nulo = expiração automática) · `actor_user_id` · `metadata` — append-only

> **A linha pertence a DOIS tenants.** É a primeira do sistema assim: as policies comparam as
> duas pontas (`requester_tenant_id` ou `owner_tenant_id`), e não o `tenant_id` único das
> outras tabelas. Um terceiro parceiro não vê a linha nem sabe que ela existe.

### Tabelas da Fase 1 ainda não criadas
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

### Tela e curadoria (16/09/2026)

`/importacao`, visível só para `partner_admin`: cadastra o feed, envia o XML ou usa a URL,
acompanha a execução, mostra os contadores e o diff campo a campo de cada anúncio. **Simular é
o padrão**; gravar exige um segundo clique.

Para os itens em `needs_curation`, a tela mostra o bairro **como veio no feed** (e a `<Zone>`,
quando existe, só como pista), e o administrador escolhe o bairro do catálogo correspondente.
Isso chama `POST /catalog/neighborhoods/:id/aliases`, que passa por `catalog_add_alias()`
(`SECURITY DEFINER`): `app_user` continua sem escrita no catálogo, a função só **acrescenta
grafia** a um bairro existente — não cria bairro, não renomeia e não toma o alias de outro
bairro (conflito volta descrito, para a tela explicar). O alias fica com `source` =
`partner:<slug>`, e a criação é auditada.

O slug chega pronto do TypeScript: reescrever a normalização em SQL criaria duas
implementações de `slugify` divergindo em silêncio.

---

## Fluxo de conexão

Decidido em 15/09/2026, a partir de pesquisa de mercado (resumo abaixo).

**O dono do imóvel aprova cada pedido. A plataforma não aprova conexão a conexão** — ela
credencia quem entra, arbitra e pode suspender. Rotas: `POST /connections`,
`GET /connections?role=received|sent`, `GET /connections/:id`, e
`POST /connections/:id/{approve,reject,cancel}`. Qualquer usuário do parceiro usa (não exige
`partner_admin`: é ato comercial, não configuração de conta).

**Quem vê o quê:**

| Momento | O dono vê | Quem pediu vê |
|---|---|---|
| Pedido criado | marca, corretor, telefone e e-mail de quem pediu, mais o recado | nada do dono |
| Recusado / expirado / cancelado | idem | nada do dono; só o motivo, se houver |
| **Aprovado** | idem | marca do parceiro e, no nível `partner_contact`, contato do corretor |
| Sempre | — | **nunca o endereço, o título, a descrição nem o código interno** |

A assimetria é deliberada: pedir conexão é se identificar; aprovar é que revela o dono.

**Onde a regra mora:** em funções `SECURITY DEFINER` (`connection_disclosure`,
`connection_requester`, `connection_listing`, `network_listing_owner`), não no service. O
`WHERE` de `connection_disclosure()` exige status `approved` **e** que quem pergunta seja o
solicitante — uma consulta de qualquer outro lugar devolve zero linhas. `network_listing_owner()`
existe porque quem pede não pode descobrir o dono: a view de busca não tem `tenant_id`, e o
valor devolvido só carimba a linha, nunca chega ao cliente.

**Prazo:** pedido pendente expira em 7 dias. A varredura roda na leitura (volume pequeno) e
vira job quando a fila entrar; o evento de expiração fica sem ator, e a trilha mostra "plataforma".

**Trilha:** cada transição vira evento, inclusive a primeira abertura dos dados revelados
(`disclosed`). O evento diz **de que lado** veio o ato, nunca quem é — mostrar o nome de quem
recusou revelaria o dono justamente no caso em que ele disse não.

### Pesquisa que embasou a decisão (15/09/2026)

- **Match mútuo tem precedente e é o padrão do nicho.** Os Termos do Homer descrevem "dupla
  aceitação, que permite aos Usuários se comunicarem apenas se ambos tiverem interesse", e só
  então exibem nome, CRECI, telefone e e-mail. ImóvelPro e Casafari Connect seguem a mesma ideia.
- **Plataforma aprovando cada conexão não tem precedente imobiliário.** Onde existe
  (ReferralExchange, HomeLight) não há dono do imóvel do outro lado. No Axial (M&A), a
  plataforma aprova a **entrada** e o dono decide cada contraparte.
- **A camada de plataforma existe em todas as redes**, em outro ponto: credenciamento (CRECI),
  moderação e banimento — o Homer cancela conta por "ponte" — e garantia financeira.
- **Anonimizar o corretor captador não tem precedente localizado**: o setor anonimiza o
  proprietário e o endereço. O modelo mais próximo é o de M&A: teaser anônimo → NDA → identidade.
- **Risco documentado:** "by-pass" (fechar por fora) é reconhecido no setor e vedado pelo Código
  de Ética do COFECI, art. 6º. A barreira de adoção citada é "medo de ser passado para trás".

Ressalvas: os termos do ImóvelPro estão fora do ar (404) e as regras de visibilidade pré-aceite
do Casafari e do Top Agent Network não foram verificadas.

## Vetores de vazamento que exigem decisão de produto

1. **Marca d'água queimada na foto** — **pendência conhecida, adiada e não bloqueante** (reconfirmado
   pelo cliente em 15/09/2026). Nenhuma solução (detecção, corte, IA) deve ser implementada até nova
   decisão. Com a importação VrSync, passa a ser o principal vazamento residual: as fotos importadas
   chegam com a marca da imobiliária.
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
| 12 | Deploy: Dockerfiles multi-stage, EasyPanel, migrations como step separado, healthcheck, TLS | **artefatos prontos**; falta executar no servidor (ver `docs/deploy.md`) |

## Tarefas — Fase 1 (v1 operacional), revisada em 14/09/2026

| # | Tarefa | Est. | Status |
|---|---|---|---|
| 1 | ~~Normalizador XML + adapters ZAP/Imovelweb/OLX/genérico~~ → **Parser VrSync** + tradução de tipo + bairro por alias/CEP | 3d | **pronto** |
| 2 | Fila **pg-boss**: agendamento por fonte, retry, execução fora do processo da API (hoje roda em processo) | 1,5d | pendente |
| 3 | Download seguro e **re-hospedagem das fotos do `<Media>`** | 1,5d | **pronto** |
| 3b | **Tela de importação e curadoria**: cadastrar feed, rodar dry-run, ver diff, resolver `needs_curation` criando alias | 2d | **pronto** |
| 3c | Autocomplete de bairro no servidor (`pg_trgm`, cidade no rótulo) quando houver mais de uma cidade | 1d | pendente |
| 4 | Pipeline de sanitização de descrição (telefone, e-mail, URL, marcas) + `description_sanitized` na view | 2d | pendente |
| 5 | **Fluxo de conexão**: pedir, aprovar, recusar, cancelar, expirar, revelação controlada, tela | 3d | **pronto** |
| 5b | Notificação por e-mail (pedido recebido, decisão tomada, pedido perto de vencer) | 1d | pendente |
| 6 | Auditoria completa das transições + tela de histórico por conexão | 1d | parcial — trilha pronta (`connection_events`), falta tela |
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
| ~~Quem aprova a conexão~~ | — | **Resolvido (15/09/2026)**: o dono aprova cada pedido; a plataforma credencia, arbitra e pode suspender. |
| ~~O que é liberado após aprovar~~ | — | **Resolvido**: `disclosure_level` por pedido — marca do parceiro, ou marca + contato do corretor. Endereço nunca. |
| **Termo de parceria antes de liberar o contato?** | Nada hoje | Em aberto. Tem precedente fora do imobiliário (M&A, ReferralExchange); no Brasil o termo vem depois do contato. Implementar exigiria uma coluna de aceite e uma etapa na tela. |
| Revogação de conexão pela plataforma | Nada hoje | O status `revoked` já existe no schema; falta a rota de admin, que precisa de um caminho para `platform_admin` (hoje sem tenant no contexto). |
| ~~XML traz fotos?~~ | — | **Resolvido**: VrSync traz em `<Media>`; re-hospedagem implementada. |
| Aumentar os tipos da plataforma (cobertura, kitnet…) | Nada | Hoje mapeados para `apartamento`/`casa`; ampliar o enum é decisão de produto. |
| Volume de parceiros/imóveis | Nada estrutural na v1 | <20 parceiros, <5k imóveis. |

---

## Verificação

```bash
pnpm db:migrate && pnpm db:seed
pnpm test:rls     # 31 testes: isolamento, anonimização, RLS da importação e das conexões
pnpm test:api     # 170 testes: auth, carteira, busca, mídia, importação, parser, SSRF, conexões, curadoria
```

**Fim a fim, manual**
1. Login como parceiro A → cadastrar imóvel com fotos → aparece na carteira de A.
2. Login como parceiro B → buscar por bairro → o imóvel de A aparece **sem** nome, contato, marca ou endereço.
3. DevTools → Network: JSON cru da busca sem identificador de A, sem `tenant_id`, sem `zone`.
4. `exiftool` numa foto do resultado — sem GPS, autor ou copyright.
5. `GET /properties/:id` do imóvel de A autenticado como B → 404.
6. Como admin de A, em **Importação**: cadastrar o feed, enviar um XML VrSync (simulação) → ver
   contadores e diff; num item em curadoria, escolher o bairro e ligar a grafia; importar de
   verdade e conferir que o imóvel entrou com as fotos.
7. Como B: "Pedir conexão" num imóvel de A → em **Conexões**, o pedido aparece sem nada de A.
   Como A: o pedido mostra quem pediu, com contato. A aprova → B passa a ver marca e contato de
   A, e continua sem endereço. A trilha mostra `requested`, `approved` e `disclosed`.
