# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) de múltiplos provedores de jogos, via HTTP e SQS. Ele permanece correto com mensagens
duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

- **Enunciado:** [docs/CHALLENGE.md](docs/CHALLENGE.md)
- **Decisões, trade-offs e limitações:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Teste de carga (metodologia, resultados e análise):** [docs/LOAD_TEST.md](docs/LOAD_TEST.md)

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
| `bun run test:load` | Teste de carga contra a stack do compose (ver [docs/LOAD_TEST.md](docs/LOAD_TEST.md)) |
| `bun run test:load:outbox` | Benchmark do pipeline da outbox no banco de teste, com broker falso |
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
- [x] Autenticação: IdP não integrado (decisão documentada), mas o ponto de extensão está no código:
      `ProviderIdentityPort`, `AuthGuard` global com `@Public()` para health e métricas, e a regra de
      que um provedor só age sobre as próprias operações. Coberto por um teste que troca o adaptador.
- [x] Domínio: `Wallet`, `WalletLedgerEntry`, `WagerTransaction` (máquina de estados), regras de
      `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, eventos de integração e `OutboxMessage`, com testes de unidade.
- [x] Persistência MikroORM: `EntitySchema` sem decorators, mappers, Unit of Work por fork e tradução de
      erros do banco.
- [x] Use cases e API HTTP: criação de wallet, submissão de transação (lock pessimista, idempotência,
      replay, conflito), consultas, ledger paginado por cursor e reconciliação.
- [x] Métricas Prometheus em `/metrics`.
- [x] Testes de integração da API e de concorrência: cenário 2 × 80, a mesma aposta 50 vezes em
      paralelo, wallet disputada, wallets distintas e 3 processos independentes. Um teste de mutação
      (removendo o lock da wallet) faz os 5 testes de concorrência falharem, o que confirma que eles
      detectam corridas.
- [x] Consumer SQS com inbox, retry com backoff, DLQ (explícita e por redrive) e shutdown gracioso.
- [x] Outbox publisher (vários publishers com `SKIP LOCKED`) e worker de `PENDING_REFERENCE` com lease e
      TTL.
- [x] Testes de crash entre commit e ack, crash entre publicar e commitar, publishers concorrentes,
      workers concorrentes e reinício.
- [x] Teste de carga (`bun run test:load` e `bun run test:load:outbox`) com três cenários (wallets
      distribuídas, wallet disputada e ingestão via SQS) e análise de antes e depois em
      [docs/LOAD_TEST.md](docs/LOAD_TEST.md). Zero erros e zero divergências sob carga. Os dois
      gargalos encontrados foram corrigidos:
      - outbox: índice parcial, lotes de 100 e `UPDATE` em lote, com ganho de 12× a 41× no pipeline do
        banco;
      - consumer SQS: 2 loops por réplica e ack em lote, com ganho de 24%.

## Cobertura dos testes obrigatórios

Os testes de integração usam PostgreSQL e MiniStack reais. Cada suíte de mensageria cria filas
exclusivas, e toda suíte termina verificando `wallet.balance == saldo reconstruído pelo ledger` para
todas as wallets.

| Exigência do enunciado | Onde |
|---|---|
| `Money`: escala, arredondamento, entradas inválidas, conflito de moeda | [money.spec.ts](src/shared/domain/money.spec.ts) |
| Invariantes da `Wallet` e regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK` | [wallet.spec.ts](src/wallet/domain/wallet.spec.ts), [wager-settlement.spec.ts](src/wagering/domain/wager-settlement.spec.ts), [wager-transaction.spec.ts](src/wagering/domain/wager-transaction.spec.ts) |
| Idempotency key com payload divergente | [payload-hash.spec.ts](src/wagering/application/payload-hash.spec.ts), [wagering-api.test.ts](test/integration/wagering-api.test.ts) |
| Migrations e constraints | [schema.test.ts](test/integration/schema.test.ts) |
| Atomicidade entre wallet, ledger, inbox e outbox | [schema.test.ts](test/integration/schema.test.ts) (triggers diferidos), [sqs-consumer.test.ts](test/integration/sqs-consumer.test.ts) (crash) |
| Inbox e redelivery | [sqs-consumer.test.ts](test/integration/sqs-consumer.test.ts) |
| Publishers concorrentes sobre a mesma outbox | [outbox.test.ts](test/integration/outbox.test.ts) |
| Retry e DLQ | [sqs-consumer.test.ts](test/integration/sqs-consumer.test.ts) |
| Recuperação após reinicialização | [sqs-consumer.test.ts](test/integration/sqs-consumer.test.ts), [outbox.test.ts](test/integration/outbox.test.ts) |
| 1. A mesma aposta 50 vezes em paralelo | [concurrency.test.ts](test/integration/concurrency.test.ts) |
| 2. Operações concorrentes no mesmo saldo (2 × 80) | [concurrency.test.ts](test/integration/concurrency.test.ts) |
| 3. Wallets distintas em paralelo | [concurrency.test.ts](test/integration/concurrency.test.ts) |
| 4. ≥ 3 processos simultâneos | [concurrency.test.ts](test/integration/concurrency.test.ts) |
| 5. Worker morto depois do commit e antes do ack | [sqs-consumer.test.ts](test/integration/sqs-consumer.test.ts) |
| 6. Dois publishers sobre a mesma outbox | [outbox.test.ts](test/integration/outbox.test.ts) |
| 7. `ROLLBACK`/`REFUND` antes da referência | [pending-references.test.ts](test/integration/pending-references.test.ts), [wagering-api.test.ts](test/integration/wagering-api.test.ts) |
| 8. Reinício com consistência final comprovada | [sqs-consumer.test.ts](test/integration/sqs-consumer.test.ts) |

**Testes de mutação.** Rodamos três mutantes e cada um fez os testes correspondentes falharem:
- remover o lock da wallet derruba os 5 testes de concorrência;
- deixar de devolver as mensagens no shutdown derruba o teste de reinício;
- trocar a regex de uma asserção de schema derruba o teste dela.
