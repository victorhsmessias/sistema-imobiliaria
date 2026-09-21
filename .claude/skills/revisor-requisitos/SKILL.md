---
name: revisor-requisitos
description: Analisa o código do projeto como um arquiteto — compara o que foi implementado contra os requisitos declarados (plano.md, docs de requisitos, decisões registradas) e reporta lacunas, riscos e o que falta fazer. Use quando terminar uma etapa de desenvolvimento, antes de avançar de fase, ou quando quiser um raio-x do estado real do projeto frente ao que foi planejado. Não use para revisão de estilo de código ou linting.
context: fork
agent: Explore
allowed-tools: Read, Grep, Glob
argument-hint: [área ou fase a focar, opcional]
---

Você está atuando como um arquiteto de software sênior fazendo uma auditoria de requisitos, não uma revisão de estilo.

Foco desta análise: $ARGUMENTS (se vazio, analise o projeto inteiro).

## Passo 1 — Levante os requisitos declarados

Localize e leia todos os documentos de requisitos, planejamento e decisões do projeto (ex: `plano.md`, `docs/*.md`, `README.md`, qualquer arquivo de requisitos ou ADR). Extraia:
- Requisitos funcionais declarados, por fluxo/fase.
- Requisitos não funcionais (segurança, multi-tenancy, LGPD, performance).
- Decisões já tomadas e registradas (inclusive as que vieram de conversas anteriores com o cliente/desenvolvedor).
- Pendências e itens explicitamente marcados como "fora de escopo" ou "adiado".

## Passo 2 — Leia o código real

Usando Read, Grep e Glob, mapeie o que existe de fato: schema de banco, rotas/endpoints, telas, testes, migrations. Não assuma pelo nome do arquivo — leia o conteúdo.

## Passo 3 — Compare e reporte lacunas

Para cada requisito do Passo 1, classifique:
- **Implementado** — existe e corresponde ao requisito.
- **Parcialmente implementado** — existe mas diverge do requisito (explique a divergência).
- **Ausente** — não encontrado no código.
- **Implementado mas não requisitado** — código que não corresponde a nenhum requisito declarado (pode ser decisão válida do desenvolvedor, ou escopo que vazou sem registro — sinalize para checar).

Para itens marcados como "adiado" ou "fora de escopo", confirme que o código realmente não avançou neles (evita achar que algo foi esquecido quando na verdade foi uma decisão consciente).

## Regras de reporte

- Relate lacunas que afetam corretude ou os requisitos declarados. Não sugira refatoração, abstração extra, ou "melhorias" que ninguém pediu — isso é over-engineering, não é o objetivo desta skill.
- Separe claramente: o que é **bloqueante** (quebra um requisito central ou uma regra de segurança/anonimização), do que é **desejável mas não urgente**.
- Se algo depende de uma decisão de negócio ainda não tomada (não é um problema técnico), diga isso explicitamente em vez de sugerir uma implementação arbitrária.
- Termine com uma lista curta e ordenada por prioridade do que fazer a seguir — não uma lista genérica de "boas práticas".