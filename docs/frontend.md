# Guia do frontend

Para quem vai mexer em `apps/web` sem ter acompanhado as decisões.
Leia antes `docs/plano.md` (seção "Onde estamos"). O contrato de dados vive em
`packages/contracts` — importe de lá, não redeclare tipos.

## A regra que rege a tela

A busca mostra imóveis de outros parceiros **sem dizer de quem são**. Não existe campo com nome
de imobiliária, corretor, telefone, endereço, título ou código interno no resultado — e não
adianta procurar: a API não envia. Se uma tela precisar mostrar algo assim, isso é mudança de
produto e de banco, não de componente.

O contato do dono aparece **apenas** em `/conexoes`, depois que ele aprova o pedido.

## Telas

| Rota | Componente | Observação |
|---|---|---|
| `/login` | `app/login/LoginView.tsx` | tenta renovar a sessão em silêncio antes de pedir senha |
| `/busca` | `components/search/SearchView.tsx` + `ListingRow`, `NeighborhoodPicker` | filtros na URL, paginação por cursor |
| `/carteira` | `components/property/PortfolioView.tsx` | carteira do próprio parceiro |
| `/carteira/novo` e `/carteira/[id]` | `PropertyForm`, `EditProperty`, `MediaManager` | formulário e fotos |
| `/conexoes` | `components/connections/ConnectionsView.tsx` | duas caixas: recebidos e enviados |
| `/importacao` | `components/imports/ImportsView.tsx` | **só `partner_admin`**; o menu esconde e a tela recusa |

Casca e sessão: `components/AppShell.tsx` (menu, filtrado por papel) e
`components/SessionProvider.tsx` (`useSession()` devolve `user`, com `role` e `tenant`).

## Como falar com a API

Sempre por `apiFetch` (`lib/api.ts`), nunca `fetch` direto. Ele:
- prefixa `/api`, que é o **BFF** (`app/api/[...path]/route.ts`) — o navegador nunca fala com a
  API diretamente;
- injeta `Content-Type: application/json` quando há corpo (exceto `FormData`);
- em 401, renova a sessão **uma vez só** e repete; se não der, manda para `/login`.

Duas consequências práticas:
- **Enviar XML**: passe `headers: { 'Content-Type': 'application/xml' }` e o `File` como corpo.
  Mandar texto convertido estragaria acento de arquivo ISO-8859-1.
- **Prefixo novo** na API exige liberar em `ALLOWED_PREFIXES` no BFF, senão dá 404 no próprio Next.

## Regras de dados que a tela precisa respeitar

- **Dinheiro é centavo, inteiro.** Use `parseMoneyToCents` e `centsToInput` (`lib/format.ts`).
  Nunca `Number(valor) * 100` na mão.
- **Venda e aluguel são campos distintos** (`salePriceCents`, `rentPriceCents`). Um imóvel pode
  ter os dois. `formatPrice(cents, purpose)` põe "/mês" quando é aluguel.
- **Filtrar ou ordenar por valor exige finalidade.** Sem `purpose`, a API responde 422 — por isso
  a busca desabilita os campos de valor quando a finalidade é "ambas".
- **IPTU é anual**, condomínio é mensal.
- **Paginação é por cursor** (`nextCursor`), não por página. Concatene, não substitua.
- **Filtros vivem na URL, em português** (`bairros`, `tipos`, `de`, `ate`, `ordem`) e são
  atualizados com `history.replaceState` — `router.replace` refaria o render do servidor e
  empilharia histórico a cada tecla.
- **Localização é só bairro.** Não existe zona; não a reintroduza na interface.

## Estilo

Tokens e classes globais em `app/globals.css`; o resto é CSS Module por componente
(`*.module.css`). Não há framework de CSS.

Classes globais em uso: `.page-title`, `.section-title`, `.lead`, `.panel`, `.field`,
`.field-label`, `.input`, `.btn` (+ `.btn-primary`, `.btn-quiet`, `.btn-danger`, `.btn-sm`),
`.badge` (+ `.badge-ok`, `.badge-warn`, `.badge-info`, `.badge-outline`), `.segmented`,
`.toggle-chip`, `.hint`, `.alert`, `.error-text`, `.skeleton`, `.num`, `.visually-hidden`.

`.num` aplica algarismos tabulares: use em **todo** número que o corretor compara em coluna
(valores, áreas, contagens).

Rótulos de enum não se escrevem à mão: `lib/labels.ts` (`TYPE_LABELS`, `PURPOSE_LABELS`,
`STATUS_LABELS`, `STATUS_BADGE`, `CONNECTION_LABELS`, `CONNECTION_BADGE`).

## Estados que a interface precisa cobrir

Nenhuma das telas é só "lista feliz":

- **Carregando** (`.skeleton` na busca, texto em outras), **vazio** (com o que fazer a seguir),
  **erro** (`.alert` com `role="alert"`) e **sem permissão** (importação).
- **Conexão**: cada anúncio na busca mostra o estado do **próprio** pedido (`listing.connection`):
  ausente → botão "Pedir conexão"; pendente → selo; aprovada → link para `/conexoes`; recusada,
  expirada ou cancelada → selo + "Pedir de novo".
- **Importação**: simular é o padrão; a tela precisa deixar claro que nada foi gravado.

## Armadilhas já pagas

1. **Fotos não passam pelo Next.** A API responde 302 para uma URL assinada de vida curta; use
   `<img>` simples apontando para `/api/network/listings/:id/media/:mediaId`. Nada de `next/image`
   com loader customizado aqui.
2. **O catálogo de bairros é carregado uma vez por sessão** (`lib/catalog.ts`, promessa
   compartilhada). Não faça fetch por componente.
3. **Autocomplete de bairro** é um componente só (`NeighborhoodPicker`), usado na busca
   (múltipla escolha) e no cadastro (`single`). Ele é combobox WAI-ARIA e busca sem acento.
4. **`useSession()` só existe dentro do `AppShell`** (rotas em `(app)`); `/login` não tem sessão.
5. **Papel do usuário**: `user.role === 'partner_admin'` libera importação e curadoria de bairro.
   Esconder no menu não basta — a tela também recusa, e a API recusa de novo.

## Verificação

```bash
pnpm dev:api          # API em 3333
pnpm dev:web          # telas em 3100
pnpm --filter @imob/web build    # o build também typecheca
```

Não há teste automatizado de frontend hoje: a verificação é `typecheck` + `build` + olhar a tela.
Quando for mexer em algo que envolve anonimização, confira o JSON cru na aba Network — o que a
tela não pode mostrar, a API não deve nem enviar.
