# Anonimização: vetores de vazamento e mitigações

Documento vivo. Cada item abaixo é um caminho pelo qual a identidade do dono de um imóvel
pode chegar ao parceiro solicitante, apesar de todos os campos óbvios estarem escondidos.

A anonimização de campos é a parte fácil e já está resolvida no banco
(`packages/db/sql/10_security.sql`). O que segue é o resto.

## Resolvidos na Fase 0

| # | Vetor | Mitigação | Onde |
|---|---|---|---|
| 1 | `tenant_id` e campos do dono na resposta | View com allow-list explícita de colunas | `sql/10_security.sql` |
| 2 | Query sem filtro de tenant | RLS com `FORCE`, fail-closed | idem |
| 3 | Tenant vazando entre requests pelo pool | `set_config(..., true)`, local à transação | `src/tenant.ts` |
| 4 | App conectada com credencial privilegiada | `assertRuntimeRole()` derruba o boot | `src/client.ts` |
| 5 | Chave do bucket exposta ao cliente | `storage_key` fora da view; URL assinada resolvida no servidor | `network_media_storage_key()` |
| 6 | EXIF (GPS, autor, copyright) na foto | Reencode para WebP descarta todos os metadados; `sanitized_at IS NOT NULL` é obrigatório para a foto aparecer na rede | `lib/image.ts` · `network_listing_media` |
| 7 | Enumeração de IDs | UUID em vez de sequencial; rate limit na busca (F1) | schema |
| 8 | 404 vs 403 revelando existência | Cross-tenant devolve zero linhas, não erro de permissão | testado em `rls.test.ts` |

## Resolvidos na importação VrSync (14/09/2026)

| # | Vetor | Mitigação | Onde |
|---|---|---|---|
| 9 | URL original da foto no feed (domínio da imobiliária) | Foto baixada, reencodada sem EXIF e re-hospedada sob chave opaca; `source_url` e `caption` ficam fora das views | `imports/service.ts` (`syncMedia`) · `sensitive-fields.ts` |
| 10 | Link de vídeo do YouTube (canal da imobiliária) | `<Item medium="video">` é ignorado na importação | `vrsync-parser.ts` |
| 11 | URL do feed, `ContactInfo`, `Header` e payload bruto | Só em `import_sources`/`import_items`, com FORCE RLS; nada disso chega a `properties` fora dos campos ⚠️ | `sql/10_security.sql` |
| 12 | ListingID e origem do feed | `external_id` e `external_source` (`import:<uuid>`) fora da view | `sensitive-fields.ts` |
| 13 | SSRF: feed apontando foto para a rede interna | IP checado após DNS dentro do `lookup` do socket, redirect revalidado, limites de bytes/tempo/tipo | `lib/safe-fetch.ts` · `safe-fetch.test.ts` |
| 14 | Entidade XML (XXE, "billion laughs") | DOCTYPE/ENTITY recusados antes do parse | `vrsync-parser.ts` |

O teste `imports.test.ts` importa um feed com nome, e-mail, endereço, legenda "Fachada Alfa
Imoveis" e URLs de foto do parceiro, e confirma que nada disso — nem o `<Zone>` — aparece na
resposta da busca de outro parceiro.

### Sobre o EXIF, em detalhe

Uma foto de imóvel tirada no celular carrega, no metadado: coordenada GPS exata do imóvel,
modelo do aparelho, data — e muitas vezes `Artist` e `Copyright` preenchidos com o nome da
imobiliária. Servir esse arquivo entrega o dono e o endereço **com todos os campos do JSON
perfeitamente anonimizados**: o vazamento vai dentro do binário.

`processPropertyImage()` reencoda para WebP, o que descarta tudo. O `.rotate()` antes do
resize aplica a orientação do EXIF e só então a joga fora — sem ele, remover o metadado
deixaria fotos de celular deitadas.

O risco real aqui é alguém acrescentar `.withMetadata()` mais tarde, para "preservar o
perfil de cor". O teste em `apps/api/test/media.test.ts` gera um JPEG com GPS, `Artist` e
`Copyright`, confirma que a fixture realmente tem EXIF, faz o upload, baixa o arquivo
armazenado e verifica que não sobrou metadado nem sequer as strings `Alfa`, `iPhone` ou
`GPS` dentro dos bytes.

## Resolvidos no fluxo de conexão (15/09/2026)

| # | Vetor | Mitigação | Onde |
|---|---|---|---|
| 15 | Pedido pendente revelando o dono | A resposta de um pedido pendente não traz marca, contato nem endereço; a suíte serializa a resposta e procura todos os identificadores do dono | `connections.test.ts` |
| 16 | Revelação decidida pela aplicação | `connection_disclosure()` só devolve linha se o status for `approved` **e** quem pergunta for o solicitante — a regra está no `WHERE`, no banco | `sql/10_security.sql` |
| 17 | Endereço junto com a aprovação | Nenhum nível de disclosure inclui `street`, `zip`, coordenadas, título, descrição ou `reference_code`; `connection_listing()` devolve os mesmos campos da busca | idem |
| 18 | Descobrir o dono para pedir conexão | Quem pede nunca lê `tenant_id`: `network_listing_owner()` resolve o dono e o valor só carimba a linha | idem |
| 19 | Trilha revelando quem recusou | O evento diz de que lado veio o ato (`you`/`other`/`platform`), nunca o nome — recusar não pode identificar o dono | `connections/service.ts` |
| 20 | Terceiro parceiro vendo a conexão alheia | A linha pertence às duas pontas e as policies comparam as duas; um terceiro recebe 404 | `rls.test.ts` |

## Abertos — decisão de produto, não técnica

### 1. Marca d'água queimada na foto — **ADIADO por decisão do cliente (12/09/2026)**

> Decisão: não tratar por enquanto; reavaliar depois.
>
> Registrado como **adiado**, não como resolvido. A distinção importa: quem reabrir o
> assunto precisa saber que o risco foi aceito conscientemente, e não que o problema
> deixou de existir. Enquanto isso, a Fase 1 entrega anonimização íntegra dos dados com
> vazamento visual possível nas fotos que já vierem marcadas.

A maioria das imobiliárias aplica logo ou faixa com a marca sobre as fotos. Nenhum
pipeline remove isso de forma confiável: inpainting deixa artefato visível e falha em cima
de textura. Opções para quando o assunto voltar:

- **(a)** Exigir foto sem marca para publicar na rede — validação manual ou detecção
  automática com revisão; move o custo para o parceiro.
- **(b)** Crop automático das bordas — resolve faixa e canto, não resolve marca central.
- **(c)** Aceitar o vazamento para fotos importadas e marcar esses imóveis como
  "identificáveis" na interface.

Sem uma decisão aqui, a Fase 1 entrega anonimização perfeita de dados e vazamento visual.

### 2. Endereço exato — **recomendação: nunca expor**

Com rua e número, o solicitante encontra o anúncio original em qualquer portal público em
segundos e vê a marca do dono. É o vetor mais barato de explorar e o que derrota a
anonimização inteira, mesmo com todos os outros campos limpos.

Posição adotada: cross-tenant expõe o bairro, nada mais fino (não há agrupamento por zona).
Se houver mapa na interface, usar o centroide do bairro, jamais a coordenada do imóvel.

### 3. Descrição livre — mitigado na F0, resolvido na F1

`title` e `description` estão **fora** da view na Fase 0 justamente por isso: são campos
onde o corretor escreve "falar com João, 11 9xxxx-xxxx" e o nome da imobiliária.

Na Fase 1 entram como `description_sanitized`, produzida por um pipeline que redige
telefone, e-mail, URL, `@handle` e os nomes de todos os parceiros cadastrados. O campo
original permanece visível só para o dono.

### 4. URL de foto vinda do XML — resolvido (ver item 9)

Feeds VrSync trazem `<Item medium="image">https://imobiliariafulano.com.br/fotos/123.jpg</Item>`.
Servir essa URL entregaria o dono no HTML com todos os outros campos perfeitamente anonimizados.
As fotos são **baixadas e re-hospedadas** sob chave opaca. A marca d'água queimada nessas fotos
continua sendo o vetor 1, ainda aberto.

### 5. Metadata do PDF compartilhado — F1

Os campos Author, Producer e Creator do PDF. Setar explicitamente na geração, nunca deixar
o default da biblioteca.

### 6. Correlação por unicidade — risco residual aceito

Uma cobertura de 400 m² num bairro que tem três é identificável mesmo com todos os campos
anonimizados. Não há mitigação sem degradar o produto (suprimir resultados raros tornaria
a busca inútil justamente nos casos de maior valor).

Registrado como risco conhecido. Se virar problema, a mitigação é de processo — auditar
quem consultou o quê — e não técnica.

## Como verificar

A suíte em `packages/db/test/anonymization.test.ts` serializa a resposta inteira da busca
e procura por qualquer identificador conhecido dentro dela, em vez de checar campo a campo
o que alguém lembrou de esconder. Um campo novo que vaze é pego mesmo sem teste próprio.

Para confirmar que a suíte ainda morde, injete um vazamento de propósito: recrie
`network_listings` incluindo `p.tenant_id`, `p.title` e `p.street`, e rode `pnpm test:rls`.

Já verificado nesta base — o resultado são **5 testes vermelhos**, cada um por um motivo
diferente:

```
× a view expoe exatamente a allow-list declarada em sensitive-fields.ts
× nenhuma coluna identificadora do dono aparece nas views
  -> coluna "street" identifica o dono: Com o endereco o solicitante acha o
     anuncio original num portal publico.
× a resposta serializada da busca nao contem NENHUM identificador de parceiro
× a resposta nao contem texto livre nem endereco vindos de properties
× a string "tenant_id" nao aparece em lugar nenhum da resposta
```

`pnpm db:migrate` restaura o estado correto, porque `sql/10_security.sql` é idempotente.
