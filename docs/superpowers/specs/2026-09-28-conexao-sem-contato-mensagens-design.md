# Conexão sem contato, com conversa pelo sistema

Spec 1 de 2. Decidido com o cliente em 28/09/2026. A spec 2 (e-mails de aviso, junto com a
tarefa 5b do [`plano.md`](../../plano.md)) vem depois e depende da escolha do provedor.

## Por que

O roteiro manual de 28/09 em produção achou que quem pede conexão nunca vê o contato na tela
(ver [`proximos-passos.md`](../../proximos-passos.md), seção 1). Na conversa sobre o conserto,
o cliente decidiu que o contato **não deve aparecer nunca**: o objetivo é **manter a
negociação dentro da plataforma**. Aprovada a conexão, as partes conversam pelo sistema.

Isso substitui a regra do `plano.md` "aprovar é que revela o dono" (tabela "Quem vê o quê",
função `connection_disclosure`) e a pergunta sobre quem escolhe o `disclosure_level`.

## Regras do produto

| Momento | O dono vê | Quem pediu vê |
|---|---|---|
| Pedido pendente | marca de quem pediu + recado (mascarado) | nada do dono |
| Recusado / expirado / cancelado | marca de quem pediu | nada do dono; só a nota de recusa (mascarada) |
| **Aprovado** | marca de quem pediu + conversa | marca do dono + conversa |
| **Revogado** | marca + conversa só leitura | marca + conversa só leitura |
| Sempre | nunca corretor, telefone, e-mail | nunca corretor, telefone, e-mail, endereço, título, descrição, código interno |

- A conversa existe só em conexão **aprovada**; revogada fica só leitura.
- Telefone, e-mail, link ou `@perfil` escrito em texto livre entre as partes (mensagem,
  recado do pedido, nota de recusa) vira `[contato removido]`. Quem escreveu é avisado. O
  original fica guardado, legível só fora do papel da aplicação.
- Não lidas são contadas por imobiliária (a conexão é ato da imobiliária, não do usuário).
- Não é tempo real: a tela busca novidades a cada 15 s enquanto está visível.

## Dados e segurança

### Funções de travessia (`packages/db/sql/10_security.sql`)

O contato sai **no banco**, para nenhuma consulta futura conseguir recuperá-lo.

- `connection_requester(uuid)` devolve só `partner_name`. Sem join em `users`.
- `connection_disclosure(uuid)` devolve só `partner_name`, com
  `r.status IN ('approved', 'revoked')` e `r.requester_tenant_id = app_current_tenant()`.
- A coluna `connection_requests.disclosure_level` fica sem uso. Sai numa migration própria,
  depois.

### `connection_messages` (append-only)

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `connection_request_id` | uuid FK → `connection_requests` | `on delete cascade`, como `connection_events` |
| `sender_tenant_id` | uuid FK → `tenants` | |
| `sender_user_id` | uuid FK → `users` | `on delete set null` |
| `body` | text not null | já mascarado. Check `char_length` 1–8000: a API limita a entrada a 2000, mas a máscara pode alongar o texto |
| `body_original` | text null | preenchido só quando houve máscara |
| `created_at` | timestamptz | `now()` |

Índice `(connection_request_id, created_at, id)`.

- **RLS FORCE.** `SELECT`: `EXISTS` na conexão (mesma forma de `connection_events`, que já passa
  pela policy das duas pontas). `INSERT`: `sender_tenant_id = app_current_tenant()` **e**
  `EXISTS (... r.status = 'approved')`.
- **Grants por coluna.** `app_user` recebe `SELECT (id, connection_request_id,
  sender_tenant_id, sender_user_id, body, created_at)` e `INSERT` — nunca `SELECT` na tabela
  inteira. `SELECT *` e `SELECT body_original` falham com erro de permissão.
- Sem `UPDATE` nem `DELETE` (revogados), como `connection_events` e `audit_log`.

### `connection_message_reads`

`(connection_request_id, tenant_id)` PK, `last_read_at timestamptz not null`.

- RLS FORCE: `tenant_id = app_current_tenant()` em `SELECT`, `INSERT` e `UPDATE`, e a conexão
  precisa ser visível (`EXISTS`). Cada lado só lê e grava a própria linha.
- Gravada com `INSERT ... ON CONFLICT DO UPDATE`.

### Migration

Cria as duas tabelas, troca as duas funções, ajusta grants. Sem backfill, então sem mexer em
`FORCE`. Seguir a nota do repositório sobre revisar à mão o SQL gerado pelo drizzle.

## API

### Contrato (`packages/contracts/src/connections.ts`)

- `ConnectionParty` = `{ partnerName: string }`.
- `ConnectionDto` perde `disclosureLevel`, `requester` e `disclosure`; ganha
  `counterpart?: ConnectionParty` (dono: sempre; quem pediu: em `approved` e `revoked`) e
  `unreadCount: number`.
- Novo `ConnectionMessage` = `{ id, body, author: 'you' | 'other', createdAt }`. Nunca expõe
  `sender_user_id` nem nome de pessoa.
- Novo `sendMessageInput` = `{ body: string trim 1..2000 }`; `messageListQuery` =
  `{ after?: uuid }`.
- O tipo de evento `disclosed` continua no enum (trilha antiga), mas não é mais gravado.

### Rotas (`apps/api/src/modules/connections`)

| Rota | Resposta | Erros |
|---|---|---|
| `GET /connections` | itens com `counterpart` e `unreadCount` | — |
| `GET /connections/:id` | `{ connection, events }`, **sem efeito colateral** | 404 |
| `GET /connections/:id/messages?after=` | `{ items, hasMore }` em ordem crescente. Sem `after`: as 200 mais recentes (`hasMore` diz se há anteriores; carregar anteriores fica para quando alguém precisar). Com `after`: as posteriores a essa mensagem, por `(created_at, id)` | 404; `after` de outra conexão = 404 |
| `POST /connections/:id/messages` | 201 `{ message, masked }` | 404; 422 fora de `approved` ou texto vazio |
| `POST /connections/:id/read` | 204 | 404 |

- **"Sem efeito colateral" em `GET /connections/:id`** quer dizer que abrir o detalhe não
  grava mais o evento `disclosed`. A única exceção pré-existente é a varredura de expiração
  (`sweepExpired`), que continua marcando como `expired` um pedido pendente vencido durante a
  própria leitura.
- Terceiro recebe 404 (o RLS devolve zero linhas), como hoje.
- `POST /messages` com rate limit próprio de 30/min.
- `unreadCount` = mensagens da outra parte com `created_at > last_read_at` (ou todas, sem
  linha de leitura). Calculado numa consulta só para a lista inteira.
- O `create` (recado) e o `reject` (nota) passam pelo mesmo filtro antes de gravar.
- Auditoria: `connection.message_masked` no `audit_log` só quando a máscara age, com
  `metadata.field` (`body`, `message` ou `decision_note`). Recado e nota não têm coluna de
  original: o texto original vai em `metadata.original` dessa entrada, que fica no tenant de
  quem escreveu e a outra parte não lê. A mensagem guarda o original em `body_original` e a
  auditoria leva só `messageId`.

### Filtro (`apps/api/src/lib/contact-filter.ts`)

Função pura `maskContacts(text): { text: string; masked: boolean }`. Substitui por
`[contato removido]`:

- e-mail;
- URL e domínio (`http…`, `www.…`, `wa.me/…`, `algo.com`, `algo.com.br`);
- `@perfil`;
- telefone brasileiro: 10 ou 11 dígitos (com ou sem `+55`), aceitando espaço, ponto, traço e
  parênteses entre os grupos, e 8 ou 9 dígitos com traço (`98020-2000`).

Não mascara: valor precedido de `R$`, metragem (`m²`), números curtos (CRECI, quartos),
datas (`28/09`, `28/09/2026`). A tarefa 4 do plano (sanitizar a descrição) reaproveita este
módulo.

## Tela (`apps/web`)

### `/conexoes`

- Saem os blocos de contato (`requester`/`disclosure`). O cartão mostra a marca de
  `counterpart`.
- Cartão `approved` ou `revoked` vira link para `/conexoes/[id]`, com selo "N novas" quando
  `unreadCount > 0`.
- Texto do topo: "Depois do aceite, a conversa acontece aqui."
- Aprovar, recusar e cancelar ficam como estão.

### `/conexoes/[id]` (nova)

- Cabeçalho: resumo do imóvel, marca da outra parte, status.
- Conversa: o recado do pedido como primeiro item; mensagens próprias à direita, da outra
  parte à esquerda com a marca.
- Envio só em `approved`. `masked: true` mostra: "Removemos telefone, e-mail ou link da sua
  mensagem. Combine tudo por aqui."
- `revoked`: sem campo de envio; "Conexão revogada pela plataforma. A conversa fica
  disponível só para leitura."
- Outros status: só o status, sem conversa.
- Atualização: a cada 15 s com `after=<última>`, só com a aba visível; `POST /read` ao abrir
  e quando chegam mensagens novas.

### Outros pontos

- `/imovel/[id]`: com conexão aprovada, "Abrir conversa" leva a `/conexoes/[id]`.
- Menu: "Conexões" mostra o total de não lidas, somado da lista.

## Testes

**Banco (`packages/db/test/rls.test.ts`):** terceiro não lê nem insere; insert barrado em
`pending`/`rejected`/`revoked`; `sender_tenant_id` alheio barrado; `app_user` não lê
`body_original` nem com `SELECT *`; `UPDATE`/`DELETE` falham; `connection_message_reads` só a
própria linha; as duas funções devolvem só `partner_name`.

**Filtro (`apps/api/test/contact-filter.test.ts`):** tabela de casos que mascaram
(`43 98020-2000`, `(43) 3322-1100`, `+55 43 980202000`, `43980202000`,
`fulano@beta.com.br`, `www.beta.com.br`, `wa.me/5543…`, `@betaimoveis`) e que não mascaram
(`R$ 1.308.000`, `233 m²`, `CRECI 12345`, `3 quartos`, `28/09`).

**API (`apps/api/test/connections.test.ts`):**

- Expectativas de corretor/telefone/e-mail passam a ser **só a marca**, nos dois lados e em
  todos os status.
- Teste de vazamento: varre o JSON cru de todas as rotas de conexão, pelas duas partes, atrás
  do telefone, e-mail e nome do corretor do seed. Não pode achar nada.
- Mensagens: envio e leitura; `after`; 422 fora de `approved`; 404 para terceiro;
  `masked: true`; recado e nota mascarados.
- Não lidas: sobem ao receber, zeram com `/read`, contam só a outra parte.
- Revogada: leitura ok, envio 422.
- `GET /connections/:id` não grava evento.

**Validação:** typecheck dos quatro pacotes e suítes `db` e `api` verdes; roteiro manual pelo
navegador em ambiente local (Alfa, Beta, plataforma), conferindo o JSON cru em cada passo.
Deploy e migration em produção só com aprovação, pelo [`deploy.md`](../../deploy.md).

## Fora desta spec

- E-mails de aviso (spec 2, com a tarefa 5b).
- Tela da plataforma para ler `body_original`.
- Se revogação deve impedir "Pedir de novo" no mesmo imóvel.
- Remover a coluna `disclosure_level`.
