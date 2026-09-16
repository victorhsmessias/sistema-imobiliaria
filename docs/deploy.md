# Deploy (EasyPanel)

Três serviços e um passo avulso:

| Serviço | Imagem | Exposto na internet | Papel |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` (ou Postgres gerenciado) | não | dados |
| `api` | `docker/Dockerfile.api` | **não** | Fastify, conecta como `app_user` |
| `web` | `docker/Dockerfile.web` | sim, com TLS | Next.js: telas e BFF |
| `migrate` | a **mesma** imagem da API, com outro comando | não | migrations, conecta como `app_migrator` |

O navegador fala só com o `web`; ele repassa para o `api` pela rede interna. **Não publique a
API**: fora do BFF, ela perde o controle de `X-Forwarded-For` que o rate limit do login usa.

Storage de mídia: Cloudflare R2 (produção) ou MinIO (dev). O bucket é **privado** — as fotos saem
por URL assinada de vida curta.

---

## 1. Postgres: roles, senhas e extensões

Com o superusuário, **uma vez por banco**:

```bash
psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -f packages/db/sql/00_bootstrap_roles.sql
```

Isso cria `app_migrator`, `app_user` e `app_network_reader`, e as extensões `pgcrypto`,
`unaccent` e `citext`.

**Em seguida, troque as senhas.** O arquivo traz senhas de desenvolvimento, que estão no
repositório:

```bash
MIGRATOR_PW=$(openssl rand -base64 36 | tr -d '/+=')
APP_PW=$(openssl rand -base64 36 | tr -d '/+=')

psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE app_migrator PASSWORD '$MIGRATOR_PW'" \
  -c "ALTER ROLE app_user     PASSWORD '$APP_PW'"
```

Guarde as duas: elas viram `DATABASE_URL_MIGRATOR` e `DATABASE_URL`.

> `app_network_reader` é `NOLOGIN` e não tem senha: ele existe só para ser dono das views de
> busca. Não crie login para ele.

**Postgres gerenciado:** funciona desde que você tenha um papel com permissão de `CREATE ROLE` e
de criar extensões. Se o provedor não permitir `CREATE EXTENSION`, peça `pgcrypto`, `unaccent` e
`citext` ao suporte antes de seguir — as migrations falham sem elas.

## 2. Bucket de mídia

No R2, crie o bucket (ex.: `imob-media`) e um token com leitura e escrita **apenas nele**.
O bucket precisa ser privado: nenhuma foto é servida por URL pública.

## 3. Segredos

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_SECRET
```

Um `JWT_SECRET` novo invalida todas as sessões — o que é o comportamento certo ao promover.

## 4. Variáveis de ambiente

Comuns aos dois serviços de aplicação:

| Variável | Valor em produção | Por quê |
|---|---|---|
| `NODE_ENV` | `production` | liga as travas do `env.ts` |
| `LOG_LEVEL` | `info` | `debug` loga corpo de request |

**Serviço `api`:**

| Variável | Valor | Observação |
|---|---|---|
| `DATABASE_URL` | `postgres://app_user:<APP_PW>@postgres:5432/imob` | **nunca** a do migrator |
| `JWT_SECRET` | segredo gerado | ≥ 32 caracteres |
| `ACCESS_TOKEN_TTL` | `15m` | |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | |
| `COOKIE_DOMAIN` | seu domínio (ex.: `rede.suaempresa.com.br`) | sem isso o cookie não volta |
| `COOKIE_SECURE` | `true` | o boot **falha** se ficar `false` em produção |
| `WEB_PUBLIC_URL` | `https://<domínio>` | origem do CORS |
| `TRUST_PROXY_HOPS` | `1` | cadeia Traefik → Next → API |
| `API_HOST` / `API_PORT` | `0.0.0.0` / `3333` | |
| `S3_ENDPOINT` | `https://<conta>.r2.cloudflarestorage.com` | |
| `S3_BUCKET` / `S3_REGION` | `imob-media` / `auto` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | token do R2 | |
| `S3_FORCE_PATH_STYLE` | `true` | R2 e MinIO usam path-style |
| `S3_SIGNED_URL_TTL` | `300` | validade da URL da foto |

**Serviço `web`:**

| Variável | Valor |
|---|---|
| `API_INTERNAL_URL` | `http://api:3333` (nome do serviço na rede interna) |
| `PORT` | `3100` |

**Passo `migrate`:** as mesmas variáveis do banco, mas com `DATABASE_URL_MIGRATOR`
(`postgres://app_migrator:<MIGRATOR_PW>@postgres:5432/imob`).

> A API se recusa a subir se `DATABASE_URL` apontar para `app_migrator`
> (`assertRuntimeRole`). É proposital: com a credencial errada o RLS continua lá, correto, e
> para de filtrar qualquer coisa — a busca passaria a devolver os imóveis de todos os parceiros
> com o dono junto, sem erro e sem log.

## 5. Serviços no EasyPanel

Para `api` e `web`, aponte o build para o Dockerfile correspondente e o contexto para a **raiz do
repositório** (os Dockerfiles copiam `packages/`, não só o app).

- **api**: sem domínio público; healthcheck `GET /health`; porta interna 3333.
- **web**: domínio + TLS (Let's Encrypt); porta 3100.

## 6. Migrations: passo separado, antes de trocar a versão

```bash
node --import tsx ../../packages/db/src/migrate.ts
```

No EasyPanel, isso é um comando avulso (ou "deploy hook") na imagem da API, **antes** de promover
a nova versão dos serviços. Não coloque no start do container: com mais de uma réplica subindo
ao mesmo tempo, duas migrations concorrentes disputam o mesmo schema.

O comando aplica as migrations do drizzle e reaplica `sql/10_security.sql` (RLS, policies, views e
funções), depois **confere** o resultado: se RLS ou `FORCE` faltarem em qualquer tabela sensível,
ou se as views não pertencerem a `app_network_reader`, ele falha e o deploy para.

Ordem numa promoção: `migrate` → subir `api` → subir `web`.

## 7. Dados de demonstração (opcional)

Só para ambiente de demonstração, nunca com dados reais:

```bash
node --import tsx ../../packages/db/src/seed.ts   # 3 parceiros fictícios, senha demo1234
```

## 8. Verificação pós-deploy

1. `GET https://<domínio>/login` responde e o certificado é válido.
2. Entrar como um parceiro, cadastrar um imóvel com foto, ver na carteira.
3. Entrar como outro parceiro, buscar por bairro: o imóvel aparece **sem** nome, contato, marca
   ou endereço.
4. DevTools → Network, no JSON cru da busca: nenhum identificador do dono, nenhum `tenant_id`.
5. Baixar uma foto do resultado e rodar `exiftool`: sem GPS, autor ou copyright.
6. Pedir conexão, aprovar pelo outro lado, conferir que o contato só aparece depois do aceite.
7. `docker logs` da API: nenhum erro de credencial no boot.

## 9. Backup

Ainda **não automatizado** (tarefa 9 da Fase 1). Enquanto isso, no mínimo antes de cada deploy:

```bash
pg_dump "$SUPERUSER_URL" --format=custom --file=imob-$(date +%F).dump
```

Um backup sem restore testado não é backup: valide num banco vazio com `pg_restore` antes do
go-live.

## 10. Limites conhecidos desta versão

- **Uma réplica da API.** A importação XML roda dentro do processo e a varredura de conexões
  vencidas acontece na leitura. Escalar para duas réplicas só depois da fila (tarefa 2 da Fase 1).
- **Sem notificação por e-mail** de conexões: o parceiro só vê o pedido entrando na tela.
- **Sem fila**: uma importação grande ocupa o processo da API e se perde se o container reiniciar.
- **Marca d'água** nas fotos importadas continua sendo vazamento visual conhecido e aceito.
- **Região do storage**: se o bucket ficar fora do Brasil, registre a base legal em
  `docs/lgpd-data-map.md` (tarefa 8 da Fase 1) antes de entrar com dado real.
