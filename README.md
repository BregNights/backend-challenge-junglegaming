# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) de múltiplos provedores de jogos, via HTTP e SQS. Ele permanece correto com mensagens
duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

- **Enunciado:** [docs/CHALLENGE.md](docs/CHALLENGE.md)
- **Decisões, trade-offs e limitações:** [ARCHITECTURE.md](ARCHITECTURE.md)

**Stack:** Bun 1.4, TypeScript estrito, NestJS 12, MikroORM 7, PostgreSQL 17, SQS (MiniStack) e
Docker Compose.

## Pré-requisitos

- **Docker** com Compose v2.
- **Bun 1.4+**, para rodar fora do Docker e executar os testes:
  `powershell -c "irm bun.sh/install.ps1 | iex"` no Windows, ou `curl -fsSL https://bun.sh/install | bash`.

## Subindo tudo com Docker

```bash
docker compose up -d --build
```

O comando sobe:

| Serviço | Papel |
|---|---|
| `postgres` | Banco `wagering`, mais o banco `wagering_test` para os testes (porta 5432) |
| `ministack` | Emulador AWS com SQS (porta 4566) |
| `bootstrap` | One-shot: aplica as migrations e cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wallet-events.fifo` |
| `app` | **3 réplicas** nas portas 3000, 3001 e 3002 |

```bash
curl localhost:3000/health/live
curl localhost:3000/health/ready
```

Se as portas 5432 ou 4566 já estiverem em uso, troque com `POSTGRES_PORT` e `MINISTACK_PORT`.

## Desenvolvimento local

```bash
bun install
cp .env.example .env
docker compose up -d postgres ministack
bun run migration:up
bun run queues:provision
bun run dev
```

O Bun carrega o `.env` automaticamente.

## Testes

```bash
bun run test:unit
bun run test:integration
bun test
```

- **`test:unit`:** domínio puro, sem I/O.
- **`test:integration`:** precisa de `postgres` e `ministack` no ar (`docker compose up -d postgres ministack`).
  Roda contra o banco `wagering_test`, que é recriado do zero a cada arquivo. Por segurança, o suporte se
  recusa a rodar contra um banco cujo nome não termine em `_test`.
- **`bun test`:** roda as duas suítes.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | API com reload automático |
| `bun run start` | API sem watch |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run migration:up` | Aplica as migrations pendentes |
| `bun run migration:down` | Reverte a última migration |
| `bun run migration:list` | Lista as migrations executadas e pendentes |
| `bun run queues:provision` | Cria ou converge as filas SQS (idempotente) |

As variáveis de ambiente estão documentadas em [.env.example](.env.example).

## Estado atual

- [x] Projeto Bun + NestJS + MikroORM, com config validada no bootstrap e logs JSON com `correlationId`.
- [x] Docker Compose com Postgres, MiniStack, bootstrap one-shot e 3 réplicas.
- [x] Migration inicial reversível, com todas as garantias de schema (unicidade, imutabilidade,
      não-negatividade, encadeamento do ledger e saldo = ledger no commit), coberta por testes de
      integração.
- [x] `Money` com testes de unidade.
- [x] Health checks: liveness e readiness (Postgres e SQS).
- [ ] Domínio: `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, eventos.
- [ ] Use cases e API HTTP: wallets, transações, consultas, ledger paginado, reconciliação.
- [ ] Consumer SQS com inbox, retry, DLQ e shutdown gracioso.
- [ ] Outbox publisher e worker de `PENDING_REFERENCE`.
- [ ] Métricas.
- [ ] Testes de concorrência (50 apostas paralelas, ≥ 3 processos, crash entre commit e ack...).
- [ ] Teste de carga (`bun run test:load`).
