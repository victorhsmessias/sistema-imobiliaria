# Próximos passos

Estado em 28/09/2026, depois do deploy de `befdf52` (revogação atômica de conexões).
Este arquivo junta o que ficou em aberto; o detalhe de cada tarefa da Fase 1 continua em
[`plano.md`](plano.md).

**Ordem sugerida:** 1 → 2 → 3 (em paralelo) → 4 → 5.

---

## 1. Terminar a validação da revogação em produção

A revogação pela plataforma está em produção, mas só foi testada ponta a ponta na suíte
automatizada (22/22 em `connections.test.ts`). O roteiro manual parou porque não existia
conta `platform_admin`.

**Situação do roteiro:**

| Caso | Status |
|---|---|
| TC-003 Só a plataforma revoga · TC-007 Terceiro isolado | passaram |
| TC-001 Pedir, aprovar e revogar · TC-010 Nível de contato | parciais: falta a parte da revogação |
| TC-002 Revogar duas vezes · TC-004 ID inexistente · TC-005 Fora de `approved` · TC-006 Evento `revoked` como plataforma · TC-008 Motivo obrigatório · TC-009 Os dois lados veem `revoked` | não rodados |

**O que já está pronto para o testador:**

- Conta `admin@platform.test` (papel `platform_admin`, sem tenant). A senha foi entregue
  fora do repositório.
- Seis conexões aprovadas entre Alfa e Beta, uma pendente (`98d64fb9…`) e uma rejeitada
  (`c944d472…`) para o TC-005.
- A "conexão G" (`24020366…`) foi colocada em `disclosure_level = partner` para o TC-010.
  Confirmar com o testador que é essa a conexão G.

**Já verificado depois do deploy**, sem alterar dados: login do admin (200), revogar
pendente (422, status continua `pending`), ID inexistente (404), sem motivo (422).

**Comportamento esperado que mudou:** a resposta da revogação agora vem com
`role: "owner"`. Antes vinha `requester`, porque a rota usava o id do usuário como tenant.

---

## 2. Decisão de produto: quem escolhe o nível de contato (TC-010)

O [`plano.md`](plano.md) dá como resolvido que o `disclosure_level` é "por pedido": só a
marca do parceiro, ou marca + contato do corretor. O corte funciona (`toParty` em
`connections/service.ts`), mas **não existe como escolher o nível**: o approve só aceita
`note`, e o banco usa `partner_contact` como padrão. Todo aceite hoje libera o contato
completo.

| Opção | O que muda | Esforço |
|---|---|---|
| **A. O dono escolhe ao aprovar** | Campo opcional `disclosureLevel` no approve, seletor na tela de aceite | ~0,5 dia |
| **B. Fica como está** | Registrar no plano que o padrão é contato completo; o nível `partner` só existe via banco | nenhum |

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
