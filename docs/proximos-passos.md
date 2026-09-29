# Próximos passos

Estado em 28/09/2026, depois do deploy de `befdf52` (revogação atômica de conexões) e do
roteiro manual em produção.
Este arquivo junta o que ficou em aberto; o detalhe de cada tarefa da Fase 1 continua em
[`plano.md`](plano.md).

**Ordem sugerida:** 1 → 2 → 3 (em paralelo) → 4 → 5.

---

## 1. Validação da revogação em produção: concluída

Roteiro manual rodado em produção em 28/09/2026, pelo navegador, com as contas Alfa, Beta e
`admin@platform.test`. A API se comportou como esperado em todos os casos; a tela tem um bug
que já é tratado pela seção 2.

| Caso | Resultado | O que se viu |
|---|---|---|
| TC-001 Pedir, aprovar e revogar | API ok · **tela falhou** | Alfa pediu `58fc8742…` (conexão `0cc864a0…`), Beta aprovou pela tela, plataforma revogou (200, `role: "owner"`). A Alfa só via o contato pelo `GET /connections/:id`; na tela, nunca (bug abaixo) |
| TC-002 Revogar duas vezes | passou | segunda chamada 200, um único evento `revoked` |
| TC-003 Só a plataforma revoga | passou | rodado antes |
| TC-004 ID inexistente | passou | 404; id que não é UUID dá 422 |
| TC-005 Fora de `approved` | passou | pendente `98d64fb9…` e rejeitada `c944d472…`: 422, status e trilha intactos |
| TC-006 Evento `revoked` como plataforma | passou | trilha `requested → approved → disclosed → revoked:platform` |
| TC-007 Terceiro isolado | passou | rodado antes |
| TC-008 Motivo obrigatório | passou | `{}`, `""` e `"   "`: 422. Sem corpo nenhum: 400 (parser do Fastify) |
| TC-009 Os dois lados veem `revoked` | passou | tela e API, Alfa e Beta |
| TC-010 Nível de contato | API ok · tela não verificável | conexão G (`24020366…`, `partner`) devolve só a marca. Deixa de fazer sentido com a seção 2 |

A única conexão revogada foi a `0cc864a0…`, criada para o TC-001. Nenhum JSON visto pela
Alfa trouxe nome, contato, `tenant_id` ou endereço da Beta antes do aceite ou depois da
revogação.

**Achados:**

- **A tela `/conexoes` nunca mostra o contato a quem pediu.** A lista vem de
  `GET /connections`, e `list()` não inclui `disclosure`; só `GET /connections/:id` inclui,
  e nenhuma tela chama essa rota. Por isso o evento `disclosed` só é gravado quando alguém
  chama a API direto. Com a decisão da seção 2, o contato sai da conexão e o bug deixa de
  existir; o evento `disclosed` precisa ser repensado junto.
- Revogar sem corpo com `content-type: application/json` dá 400, não 422. Continua
  bloqueado; só o código difere.
- `platform_admin` não tem tela: cai em `/busca`, vê "Sessão sem parceiro associado." e o
  cliente faz 401 → refresh → 401.
- Depois de uma revogação pela plataforma, quem pediu vê "Pedir de novo" no anúncio e pode
  abrir outro pedido. Decidir se revogação deve bloquear novo pedido no mesmo imóvel.
- As respostas saem com `access-control-allow-origin: http://143.95.167.29:3100` (IP, não o
  domínio). O proxy é same-origin, então não quebra nada.

---

## 2. Decisão de produto: contato nunca é revelado; conversa pelo sistema

**Decidido pelo cliente em 28/09/2026.** Substitui a pergunta anterior (quem escolhe o
`disclosure_level`). Nenhum contato (telefone, e-mail, nome do corretor) aparece para a
outra parte, nem depois do aceite. Aprovada a conexão, abre-se uma opção de **chamar a outra
parte pelo próprio sistema**.

Isso muda a regra "aprovar é que revela o dono" do [`plano.md`](plano.md) (tabela "Quem vê
o quê" e a função `connection_disclosure`).

**Implementado na branch `feat/conexao-mensagens`**, com testes (suíte do banco: 39 testes;
suíte da API: 230 testes; typecheck limpo nos quatro pacotes). Validado no navegador em
ambiente local em 29/09: pedido e aceite mostram só a marca (tela e JSON cru), conversa com
máscara de telefone, não lidas no cartão e no menu, revogação só leitura nos dois lados. A
validação achou e corrigiu uma corrida em que o envio escondia a mensagem recém-chegada da
outra parte. Falta o deploy, que depende de aprovação explícita: aplicar a migration
`0005_connection_messages` e o `10_security.sql` novo, e subir `api` e `web`.

**Antes do deploy:** recados e notas de recusa gravados antes desta mudança não passaram
pelo filtro. Contar em produção quantos `message`/`decision_note` têm telefone, e-mail ou
link; se houver parceiro real afetado, mascarar também na leitura.

Ficou fora desta spec:
- notificação por e-mail da conversa;
- tela da plataforma para ler o texto original (sem máscara) de uma mensagem;
- se a revogação deve bloquear "Pedir de novo" no mesmo imóvel;
- remover a coluna `disclosure_level`, que ficou sem uso.

Pendências conhecidas (não bloqueiam o merge):
- **Falso positivo do filtro**: intervalo de anos escrito com traço ("reformado 2020-2021") vira
  `[contato removido]`, porque tem a forma de um telefone de 8 dígitos sem DDD.
- O filtro não pega contato escrito com separador fora da lista (espaço, ponto, traço,
  parênteses), como `43_98020_2000`, nem número por extenso. É limite de regex; a trilha de
  auditoria `connection.message_masked` ajuda a achar quem tenta contornar.
- A conversa carrega as 200 mensagens mais recentes; não há "carregar anteriores" (a API já
  devolve `hasMore`).

---

## 3. Segurança e operação

| # | Item | Por quê | Esforço |
|---|---|---|---|
| 3.1 | **Trocar a senha de root da VPS** e passar a usar só chave SSH (`PasswordAuthentication no`) | A senha atual circulou fora do servidor | 15 min |
| 3.2 | **Gerar nova chave de acesso do Cloudflare R2** | A chave antiga estava no `.env` de desenvolvimento e circulou junto | 15 min |
| 3.3 | **Remover o contêiner órfão da API** (`sistemaimob_api.1…` criado em 24/09) | Ficou rodando fora do Swarm; só recebe health check e ocupa ~60 MB | 5 min |
| 3.4 | **Nunca rodar o seed em produção** a partir de agora | `seed.ts` começa com `TRUNCATE` de parceiros, usuários, imóveis e auditoria. Com o primeiro parceiro real, o seed apaga tudo | — |
| 3.5 | Instalar o GitHub CLI (`gh`) e voltar ao fluxo de PR | O último merge na `main` foi feito direto, sem PR | 10 min |
| 3.6 | Atualizar a linha "Revogação de conexão pela plataforma" em `plano.md` | Ainda diz que falta a rota de admin | 5 min |

**Como publicar hoje** (o Easypanel publica a partir da branch `main`, com deploy
automático **desligado**):

1. Merge na `main` no GitHub.
2. Se houver migration: rodar o passo `migrate` antes (ver [`deploy.md`](deploy.md), seção 6).
3. No Easypanel, botão **Deploy** do serviço `api` e, se o front mudou, do `web`.
4. Conferir que o contêiner novo fica `healthy` e repetir a verificação pós-deploy.

**Desenvolvimento local:** o `.env` precisa apontar o S3 para o MinIO
(`http://localhost:9000`, `minioadmin`), nunca para o R2. Com o R2, os testes de mídia e
o `seed:media` gravam e apagam arquivos no bucket real.

---

## 4. Expansão nacional: cadastrar imóveis do Brasil inteiro

**Objetivo:** deixar de ser um produto só de Londrina.

### O que a pesquisa encontrou

| Fonte | Serve para | Limitação |
|---|---|---|
| API de localidades do IBGE | Lista oficial dos 5.571 municípios, com código IBGE | Não tem bairros |
| ViaCEP (já usado na importação) | Rua, bairro, cidade e código IBGE a partir do CEP | Bloqueia IP em uso massivo; não distribui a base |
| BrasilAPI CEP v2 | O mesmo, mais coordenadas; tenta vários provedores | Coordenadas costumam ser o centro da cidade |
| Bairros do Censo 2022 (IBGE) | — | Cobre só 895 dos 5.570 municípios (a capital paulista não está entre eles); são regiões grandes, não os bairros que o mercado usa |
| e-DNE dos Correios | Lista completa de bairros por cidade, de uma vez | Licença paga; confirmar preço com os Correios |

**A conclusão que orienta a proposta:** nenhuma fonte traz o bairro como o mercado usa.
Em Londrina, só 4 dos 25 bairros do seed batem com os nomes oficiais do IBGE. Os Correios
chegam mais perto, mas também divergem ("Gleba Fazenda Palhano" contra "Gleba Palhano").
Em cidades de CEP único o bairro vem vazio. As tabelas de apelidos continuam
indispensáveis; o que muda é que o catálogo precisa crescer sozinho.

### Proposta em três etapas

| Etapa | O que entrega | Est. |
|---|---|---|
| **4.1 Municípios** | Importar os 5.571 municípios do IBGE; coluna `ibge_code` em `cities`; autocomplete de cidade com `pg_trgm` (absorve a tarefa 3c do plano) | ~1,5 dia |
| **4.2 Cadastro pelo CEP** | O corretor digita o CEP e o endereço se preenche. BrasilAPI v2 como fonte principal, ViaCEP como reserva. Tabela `postal_codes` guarda cada CEP consultado: consulta uma vez só e respeita a regra do ViaCEP | ~2 dias |
| **4.3 Bairro provisório** | Nome do CEP passa pelos apelidos da cidade. Se não encontrar, cria bairro **provisório** que já aparece na busca e entra numa fila de revisão. O admin junta a um bairro existente (o nome vira apelido) ou confirma o novo | ~2 dias |

A busca passa a ser **cidade primeiro, depois bairro**. A e-DNE fica como opção para
carregar uma cidade inteira de antemão, se um cliente precisar disso no primeiro dia.

### Decisões necessárias antes da etapa 4.3

- **Mudança de regra:** hoje o plano diz que o sistema nunca cria bairro sozinho
  (`plano.md`, seção de importação). A etapa 4.3 troca isso por "cria como provisório e
  revisa depois". Sem essa troca, o administrador vira gargalo em escala nacional.
- **LGPD:** o CEP passa a ir também para a BrasilAPI e os provedores dela. O mapa de dados
  (tarefa 8 da Fase 1) precisa registrar isso.

A etapa 4.1 não depende dessas decisões e pode começar já.

---

## 5. Restante da Fase 1

Tarefas ainda abertas em [`plano.md`](plano.md), na ordem da tabela original:

| # | Tarefa | Est. |
|---|---|---|
| 2 | Fila `pg-boss` para a importação, fora do processo da API | 1,5d |
| 4 | Sanitização da descrição (telefone, e-mail, URL, marcas) | 2d |
| 5b | E-mails de conexão (pedido recebido, decisão, pedido perto de vencer) | 1d |
| 6 | Tela de histórico por conexão (a trilha já existe; falta a tela) | 1d |
| 7 | Compartilhamento: link com token, página anônima, PDF sem metadados | 3d |
| 8 | LGPD: `docs/lgpd-data-map.md`, retenção, exportação e exclusão | 1,5d |
| 9 | Backup `pg_dump` agendado para o R2, **com teste de restore** | 1d |
| 10 | Hardening: rate limit, CSP, logs de acesso, revisão final de vazamento | 1,5d |

**Pendências com o cliente** que continuam abertas: termo de parceria antes de liberar o
contato, e ampliar os tipos de imóvel (cobertura, kitnet…).

O backup (tarefa 9) deve vir antes do primeiro parceiro real: enquanto ele estiver
pendente, perder o volume do Postgres na VPS é perder o banco.
