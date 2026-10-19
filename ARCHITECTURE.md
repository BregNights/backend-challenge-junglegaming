# Arquitetura — Distributed Wagering Processor

Este documento descreve o desenho completo da solução, as decisões tomadas e seus trade-offs.
É um documento vivo: o que já está implementado aparece em **Estado atual**, no [README](README.md).
O enunciado original está em [docs/CHALLENGE.md](docs/CHALLENGE.md).

**Princípio central:** o PostgreSQL é a única fonte de verdade. Cada invariante financeira é aplicada
pelo código de domínio **e** pelo schema. Um bug na aplicação faz a transação falhar em vez de corromper
saldo. O SQS é só transporte, e seus recursos de ordenação e deduplicação são otimizações, não garantias.

---

## 1. Topologia

Um **monólito modular** em uma única imagem, que roda em N réplicas idênticas (3 por padrão no compose).
Cada instância executa quatro papéis, ligáveis pela variável `APP_ROLES`:

| Papel | Responsabilidade |
|---|---|
| `api` | Endpoints HTTP |
| `sqs-consumer` | Consome `wager-transactions.fifo`, com deduplicação via inbox |
| `outbox-publisher` | Publica eventos pendentes da outbox em `wallet-events.fifo` |
| `pending-reference-worker` | Reprocessa transações `PENDING_REFERENCE` com backoff |

```
   HTTP (provedores)                       SQS wager-transactions.fifo
          │                                          │
  ┌───────▼──────────────────────────────────────────▼───────────────┐
  │ instância (N réplicas idênticas)                                  │
  │                                                                   │
  │   api ───────────┐                  ┌──────── sqs-consumer (inbox)│
  │                  ▼                  ▼                             │
  │            ProcessWagerTransaction (um único use case)            │
  │                  ▲          │                                     │
  │   pending-reference-worker  │  uma transação SQL:                 │
  │                             │  inbox + wallet + ledger + tx + outbox
  │   outbox-publisher ─────────┼──── SKIP LOCKED ──► wallet-events.fifo
  └─────────────────────────────┼─────────────────────────────────────┘
                                ▼
                    PostgreSQL (fonte da verdade)
```

**Por que não microsserviços:** inbox, transação, saldo, ledger e outbox precisam estar na **mesma
transação SQL**. Separá-los exigiria saga ou 2PC, o que só acrescenta modos de falha. **Por que todos
os papéis em todas as instâncias:** `docker compose up` já coloca todas as disputas de concorrência
(API × consumer × worker × publisher) para rodar ao mesmo tempo, em várias réplicas.

**Bootstrap:** um serviço one-shot (`bootstrap`) aplica as migrations e provisiona as filas antes de
qualquer réplica subir, para que N instâncias nunca disputem a mudança de schema.

## 2. Camadas e módulos

Arquitetura hexagonal (ports & adapters), com DDD tático só onde ele paga o custo:

```
src/
  shared/
    domain/           Money, DomainError, IntegrationEvent, backoff          ← TS puro
    application/      portas (UnitOfWork, Clock, IdGenerator, WageringMetrics), erros, JSON canônico
  wallet/
    domain/           Wallet, WalletLedgerEntry, WalletBalanceChanged
    application/      OpenWallet, WalletQueries (consulta, ledger paginado, reconciliação)
    http/             WalletsController
  wagering/
    domain/           WagerTransaction, settleWagerTransaction, FailureCode, eventos
    application/      ProcessWagerTransaction, ResolvePendingReference, WagerQueries, payloadHash
    http/             WageringController
    sqs/              WagerTransactionConsumer (adapter de entrada, mesmo use case da API)
    workers/          PendingReferenceWorker
  messaging/
    domain/           InboxMessage, OutboxMessage
    application/      OutboxPublisher + porta EventPublisher
    workers/          OutboxPublisherWorker
  persistence/        adapter MikroORM: records, mappers, repositórios, UnitOfWork, tradução de erros
  platform/           config, database (ORM + migrations), auth (guard + adaptador no-op), logging,
                      health, métricas, filtro HTTP, SQS
```

Wallet e wagering formam **um único limite de consistência**: toda operação de aposta altera a wallet
na mesma transação SQL. Os módulos organizam o código, mas compartilham o mesmo `UnitOfWork`. A regra
de dependência:

- **`domain/`** não importa NestJS, MikroORM nem o SDK da AWS. Construtores são `private`, com
  factories `create`/`open`/`from` (que validam) e `rehydrate` (que só reconstrói estado persistido).
  As regras de negócio de cada operação ficam num serviço de domínio puro
  (`settleWagerTransaction`), testado sem banco.
- **`application/`** contém os use cases e conhece apenas portas. Usa a DI do NestJS (`@Injectable`),
  mas nenhum tipo do ORM.
- **`persistence/`** e **`*/http/`** implementam as portas e os adapters de entrada.

Os modelos de persistência (`EntitySchema` sem decorators) são separados do domínio, e os mappers
chamam `rehydrate`. Assim, o ORM nunca hidrata objetos de domínio passando por cima das factories. Cada
execução de use case usa um `em.fork()` novo dentro de `em.transactional()`: identity map vazio, sem
estado velho de tentativas ou requisições anteriores. As escritas são registradas no Unit of Work e vão
juntas no flush do commit.

## 3. Stack

| Item | Escolha | Observação |
|---|---|---|
| Runtime | Bun 1.4 | Executa TypeScript direto: sem etapa de build, nem na imagem |
| Framework | NestJS 12 | ESM; DI com `emitDecoratorMetadata`, suportado pelo transpilador do Bun |
| ORM | MikroORM 7 | Ver abaixo |
| Banco | PostgreSQL 17 | |
| Mensageria | SQS via **MiniStack** | Ver abaixo |
| Logs | pino (nestjs-pino) | JSON estruturado |
| Typecheck | TypeScript 7 (`tsc --noEmit`, modo estrito) | |

**Por que MikroORM, e como ele é usado.** Unit of Work explícito, `em.transactional()` e `LockMode`
encaixam no fluxo load → apply → save do aggregate. Ainda assim, o ORM **não é dono do schema**: as
migrations são SQL escrito à mão (constraints compostas, índices parciais e triggers diferidos não se
expressam bem em metadata de ORM), e o snapshot/diff de schema está desligado. Migrations e entidades
são registradas explicitamente (`migrationsList`), sem descoberta por glob, que é frágil sob o Bun.
Como a CLI do MikroORM depende de detectar ts-node/tsx, o runner é próprio
(`src/platform/database/migrate.ts`).

**Por que MiniStack e não LocalStack.** Em 2026 a LocalStack passou a exigir conta e token até para os
serviços básicos. O MiniStack é um emulador gratuito e drop-in na mesma porta 4566, com SQS FIFO, DLQ e
redrive. O enunciado aceita os dois. **Limitação:** é um emulador, e a semântica fina de FIFO pode
diferir da AWS real. Por isso nenhuma garantia depende do broker.

## 4. Money

- **Representação interna:** `bigint` em unidades menores (centavos). O enunciado sugere `Decimal`, mas
  com escala fixa de 2 e apenas soma e subtração, `bigint` é exato, dispensa arredondamento e não
  precisa de dependência. `number` nunca aparece no caminho do dinheiro.
- **Contrato de entrada:** string decimal com **exatamente 2 casas**:
  `^(0|[1-9]\d{0,17})\.\d{2}$`. Ficam rejeitados NaN, Infinity, notação científica, sinais, espaços,
  string vazia, separadores e qualquer outra escala. **Nada é arredondado:** `"10.005"` é inválido,
  não vira `"10.01"`.
- **Limite:** 18 dígitos inteiros, o espelho de `numeric(20, 2)`. Um resultado acima disso é rejeitado.
- **Imutabilidade:** `Object.freeze` no construtor, e toda operação devolve uma nova instância.
- **Moedas:** operações entre moedas diferentes lançam `CurrencyMismatchError`
  (code `CURRENCY_MISMATCH`), e `equals` entre moedas diferentes devolve `false`.
- **Persistência:** `numeric(20, 2)` mais `char(3)` em colunas separadas. O driver devolve `numeric` como
  string, e o mapper converte string ↔ `Money` sem passar por `number`.

## 5. Concorrência

**A unidade de concorrência é a wallet. Estratégia: lock pessimista na linha da wallet**
(`SELECT … FOR UPDATE`, com `LockMode.PESSIMISTIC_WRITE`), no início da transação.

| Alternativa | Por que não |
|---|---|
| Lock otimista com retry | Numa wallet muito disputada (50 apostas idênticas em paralelo), vira uma tempestade de retries. Como os retries precisam de limite, aparecem rejeições transitórias falsas. |
| Update condicional (`SET balance = balance - x WHERE balance >= x`) | Rápido, mas as reversões precisam ler e validar a referência antes. A regra de domínio iria parar no SQL. |
| **Lock pessimista por wallet** | Serializa só a mesma wallet (wallets diferentes seguem em paralelo), encaixa no aggregate e tem custo previsível. |

Complementos:

- **`lock_timeout` (3 s por padrão):** estourar o tempo vira erro **transitório** (HTTP 503 ou retry
  no SQS), nunca uma espera infinita. Também configurados: `statement_timeout` e
  `idle_in_transaction_session_timeout`, para que um worker travado não segure locks.
- **Ordem de lock global: sempre a wallet antes da transação.** Vale também para o worker de pendências
  (ele reclama candidatos com `SKIP LOCKED`, e cada um é processado pelo mesmo use case). Elimina
  deadlocks por ordem invertida.
- **Sem lock global:** nada além da linha da wallet é travado.
- **Rede de segurança no banco**, se o lock falhar por bug: `UNIQUE (wallet_id, wallet_version)` no
  ledger, encadeamento de saldo verificado por trigger e saldo igual à cauda do ledger no commit
  (seção 7). O teste `two blind read-calculate-update writers` prova que, mesmo sem lock, só um commit
  passa.

## 6. Fluxo do use case e idempotência

```
BEGIN
  [SQS]  INSERT inbox (consumer_name, message_id) ON CONFLICT DO NOTHING
         → 0 linhas = mensagem já processada → COMMIT e ack
  SELECT wager_tx WHERE (provider_id, idempotency_key)   ← caminho rápido, sem lock
         → existe com o mesmo payload_hash → replay: devolve o resultado original
         → existe com hash diferente       → 409 (conflito, não replay)
  SELECT wallet ... FOR UPDATE                           ← serializa por wallet
  SELECT wager_tx WHERE (provider_id, idempotency_key)   ← re-checagem sob o lock
  SELECT wager_tx WHERE (provider_id, external_transaction_id) → existe com outra chave → 409
  resolve a referência (REFUND/ROLLBACK obrigatória, WIN opcional)
         → ausente ou ainda não terminal   → PENDING_REFERENCE
  o domínio decide: PROCESSED | REJECTED(failureCode)
  UPDATE wallet (balance, version + 1)  ┐ só quando o saldo muda
  INSERT ledger entry                   ┘
  INSERT wager_tx (com snapshot balance_after)
  INSERT outbox (eventos)
COMMIT  →  só então: resposta HTTP ou ack no SQS; métricas e logs também só depois do commit
```

- **Caminho rápido antes do lock:** uma duplicata de transação já decidida é respondida sem entrar na
  fila do lock da wallet. Resultados terminais são imutáveis, então lê-los sem lock é seguro.
- **Re-checagem depois do lock:** as 50 apostas idênticas que chegam juntas esperam na fila do lock da
  wallet. A primeira grava, as outras 49 encontram o registro e fazem replay.
- **`UNIQUE (provider_id, idempotency_key)` cobre o caso restante:** a mesma chave apontando para
  wallets diferentes, que pegam locks diferentes. O Unit of Work traduz a violação em
  `UniqueConstraintConflict` com o nome do constraint, e o use case refaz a operação inteira (até 3
  tentativas). Na nova tentativa ele encontra o vencedor, e o resultado é replay ou 409.
- **Replay devolve o saldo observado na época,** gravado em `wager_transactions.balance_after`. Isso
  vale também para `LOSS` e `REJECTED`, que não têm lançamento no ledger.
- **`Idempotency-Key` é obrigatório e é a fonte da verdade,** com escopo por `providerId`. Default
  recomendado: `"{providerId}:{externalTransactionId}"`. Um mesmo `externalTransactionId` com outra
  chave também é conflito (`UNIQUE (provider_id, external_transaction_id)`).
- **Inbox × idempotência:** a inbox deduplica a *mensagem de transporte* (`messageId`); a idempotency
  key deduplica a *operação de negócio*. Duas mensagens distintas com a mesma chave caem na segunda
  camada.

**`payloadHash`:** SHA-256 em hexadecimal do **JSON canônico** do subconjunto de negócio:

- Campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
  `money` (`{ amount, currency }`) e `referenceExternalTransactionId`.
- Canonicalização: chaves ordenadas recursivamente, sem espaços, campos opcionais ausentes omitidos
  (nunca `null`), `amount` na forma canônica de 2 casas.
- Ficam fora: o header `Idempotency-Key` e os metadados de transporte (`messageId`, `type`,
  `occurredAt`).

### Máquina de estados da `WagerTransaction`

Implementação: [`WagerTransaction`](src/wagering/domain/wager-transaction.ts), com as decisões tomadas
em [`settleWagerTransaction`](src/wagering/domain/wager-settlement.ts).

```
                      markProcessed
            ┌──────────────────────────────────────────► PROCESSED
            │          reject                              (terminal)
  create ─► PENDING ──────────────────────────────────────► REJECTED
            │          fail                                (terminal)
            ├─────────────────────────────────────────────► FAILED
            │                                              (terminal)
            │  markPendingReference
            └─────────────────────► PENDING_REFERENCE ──┬─ markProcessed ─► PROCESSED
                                      │          ▲      ├─ reject ────────► REJECTED
                                      └──────────┘      └─ fail ──────────► FAILED
                                  markPendingReference
                                   (nova tentativa)

  opening ─► PROCESSED        (o OPENING interno já nasce aplicado)
```

| De | Para | Transição | Quando | O que é gravado |
|---|---|---|---|---|
| — | `PENDING` | `create` | Operação de provedor válida (kind, referência obrigatória ou proibida, valor) | Nada ainda: é decidida na mesma transação SQL |
| — | `PROCESSED` | `opening` | Wallet criada com saldo inicial maior que zero | `balance_after`, `processed_at` e o lançamento `CREDIT` |
| `PENDING` ou `PENDING_REFERENCE` | `PROCESSED` | `markProcessed` | Todas as regras satisfeitas | `reference_transaction_id` (obrigatório em REFUND/ROLLBACK), `balance_after`, `processed_at` e o lançamento, se a operação mexe no saldo |
| `PENDING` ou `PENDING_REFERENCE` | `REJECTED` | `reject` | Regra de negócio violada, ou TTL da referência esgotado | `failure_code` e `balance_after` (o saldo observado, devolvido nos replays) |
| `PENDING` ou `PENDING_REFERENCE` | `PENDING_REFERENCE` | `markPendingReference` | Referência ausente, ou existente mas ainda não terminal | `attempts + 1` e `next_attempt_at` (backoff) |
| `PENDING` ou `PENDING_REFERENCE` | `FAILED` | `fail` | Erro permanente de infraestrutura depois de a transação existir | `failure_code` |

Regras:

- **Estados terminais:** `PROCESSED`, `REJECTED` e `FAILED`. Qualquer transição a partir deles lança
  `InvalidTransactionStateError`. Isso é erro de programação, não caminho de negócio.
- **O banco garante o mesmo** ([seção 7](#7-schema-e-constraints)):
  - o trigger `wager_transactions_guard` bloqueia `UPDATE` de linha terminal, mudança das colunas de
    identidade e `DELETE`;
  - os CHECKs exigem `failure_code` se e somente se o status é `REJECTED`/`FAILED`, `processed_at` se
    e somente se é `PROCESSED`, `next_attempt_at` em `PENDING_REFERENCE`, `balance_after` em
    `PROCESSED`/`REJECTED` e referência resolvida em REFUND/ROLLBACK processados.
- **`PENDING` não chega ao banco na prática:** a transação nasce e é decidida dentro da mesma transação
  SQL. O estado existe no modelo de domínio e o schema o aceita.
- **Quem conduz as transições:**
  - `ProcessWagerTransaction` (HTTP e SQS) decide as transações novas;
  - `ResolvePendingReference` (worker) decide as que estão em `PENDING_REFERENCE`.

  Os dois chamam `settleWagerTransaction` com a wallet travada.
- **Ordem das verificações na liquidação:**
  1. player dono da wallet (`PLAYER_WALLET_MISMATCH`);
  2. moeda (`CURRENCY_MISMATCH`);
  3. referência: escopo, kind permitido, se já é terminal, se foi processada, valor e reversão única;
  4. saldo (`INSUFFICIENT_FUNDS` ou `REVERSAL_INSUFFICIENT_FUNDS`).
- **`FAILED` fica reservado.** Hoje nenhum caminho o grava. Falhas permanentes de mensagens (envelope
  inválido, wallet inexistente) vão para a DLQ, com o motivo, antes de existir uma transação válida a
  registrar. O estado existe para falhas descobertas depois de a transação existir, como um
  reprocessamento manual que esgotou as tentativas.

## 7. Schema e constraints

Migration: `src/platform/database/migrations/Migration20261018000000InitialSchema.ts`, reversível
(`down` remove todos os objetos). Cada garantia abaixo é coberta por `test/integration/schema.test.ts`.

### Unicidade

| Garantia | Mecanismo |
|---|---|
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Uma operação por chave de idempotência | `UNIQUE (provider_id, idempotency_key)` |
| Uma operação por id externo | `UNIQUE (provider_id, external_transaction_id)` |
| Um `OPENING` por wallet | índice único parcial `(wallet_id) WHERE kind = 'OPENING'` |
| Reversão única | índice único parcial `(reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| No máximo um lançamento por transação e wallet | `UNIQUE (transaction_id, wallet_id)` |
| Um lançamento por versão da wallet (lost update colide) | `UNIQUE (wallet_id, wallet_version)` |
| Deduplicação de mensagens | `PRIMARY KEY (consumer_name, message_id)` na inbox |

### Não-negatividade e aritmética

- `CHECK (balance >= 0)` na wallet, e o mesmo para `balance_before`, `balance_after` e o snapshot da
  transação.
- `CHECK (amount > 0)` no ledger. Na transação também, exceto `LOSS`, que aceita `0.00`.
- `CHECK (balance_after = balance_before ± amount)` conforme a direção do lançamento.

### Imutabilidade

- **Ledger append-only:** trigger `BEFORE UPDATE OR DELETE OR TRUNCATE` rejeita qualquer mutação.
- **Transação:** trigger impede `DELETE`, qualquer mudança depois de um estado terminal
  (`PROCESSED`, `REJECTED`, `FAILED`) e mudança nas colunas de identidade (valor, kind, wallet,
  provider, chaves, hash...).
- **Wallet:** trigger impede `DELETE` e mudança de identidade. Também exige que `version` incremente
  **exatamente 1** quando o saldo muda e **não mude** quando o saldo não muda.

### Consistência entre tabelas

- **FKs compostas:**
  - `ledger (wallet_id, currency) → wallets (id, currency)`: todo lançamento está na moeda da wallet.
  - `ledger (transaction_id, wallet_id, currency, amount) → wager_transactions (...)`: valor, moeda e
    wallet do lançamento são exatamente os da transação.
  - `wager_tx (reference_transaction_id, wallet_id, provider_id, round_id, currency) → wager_transactions (...)`:
    uma referência resolvida pertence à mesma wallet, provider, rodada e moeda.
- **Encadeamento do ledger** (trigger `BEFORE INSERT`): cada lançamento continua o anterior, com a
  próxima versão e `balance_before` igual ao `balance_after` anterior. O primeiro parte de zero.
- **Saldo igual ao ledger no commit** (constraint trigger `DEFERRABLE INITIALLY DEFERRED`): toda wallet
  tocada tem `balance` e `version` iguais aos da cauda do seu ledger. Com o encadeamento, isso garante
  `wallet.balance == Σ ledger` como invariante **do banco**.
- **Transação ↔ lançamento no commit** (constraint trigger diferido): existe lançamento **se e somente
  se** a transação está `PROCESSED` e move saldo (todo kind exceto `LOSS`). A direção também é
  conferida: `BET` debita, `WIN`/`REFUND`/`OPENING` creditam, `ROLLBACK` inverte a referência.
- **Origem:** `OPENING` é o único kind sem identidade de provedor (`provider_id IS NULL`), e todos os
  outros a exigem por inteiro. Um provedor não consegue submeter um `OPENING`, nem pela API, nem pela
  fila, nem por SQL.
- **Coerência de estado:**
  - `failure_code` existe se e somente se o status é `REJECTED` ou `FAILED`.
  - `processed_at` existe se e somente se o status é `PROCESSED`.
  - `PENDING_REFERENCE` exige `next_attempt_at`.
  - `REFUND` e `ROLLBACK` exigem referência, e só `WIN`, `REFUND` e `ROLLBACK` podem tê-la.

Os constraints são nomeados (`wallets_balance_non_negative_ck`, `wager_tx_idempotency_uq`...), para que
os adapters mapeiem cada violação para uma resposta precisa.

**Índices de trabalho:**

- `(next_attempt_at) WHERE status = 'PENDING_REFERENCE'`, para o worker.
- `(provider_id, reference_external_transaction_id) WHERE status = 'PENDING_REFERENCE'`, para acordar
  quem espera uma referência que acabou de chegar.
- `(next_attempt_at, sequence) WHERE published_at IS NULL` na outbox.

## 8. Mensageria

### Consumer SQS (`wager-transactions.fifo`)

Implementação: [`WagerTransactionConsumer`](src/wagering/sqs/wager-transaction.consumer.ts).

- **Long polling** (20 s). O produtor usa `MessageGroupId = walletId`. Num lote, as mensagens de um
  mesmo grupo (wallet) são processadas em ordem, e grupos diferentes em paralelo.
- **O mesmo use case da API** (`ProcessWagerTransaction.executeFromMessage`). O registro na inbox,
  `(consumer_name, message_id)` com `INSERT … ON CONFLICT DO NOTHING`, é o primeiro comando da mesma
  transação SQL. Se duas entregas da mesma mensagem chegam juntas, a segunda espera no índice único e
  vê o registro da primeira depois do commit dela.
- **Duas camadas de deduplicação:**
  - a inbox absorve redeliveries (mesmo `messageId`);
  - a idempotency key absorve mensagens diferentes com a mesma operação.

  O mesmo `messageId` com outro corpo é `INBOX_CONFLICT` e vai para a DLQ.
- **Ack (`DeleteMessage`) só depois do commit.** Se o processo morrer entre o commit e o ack, a mensagem
  volta depois do visibility timeout, a inbox a reconhece e ela recebe ack sem efeito. Se o próprio ack
  falhar, vale o mesmo raciocínio.
- **Classificação de erros:**

| Erro | Exemplos | Ação |
|---|---|---|
| Negócio | saldo insuficiente, referência inválida | Persistido como `REJECTED`, evento na outbox, **ack** |
| Transitório | banco fora, `lock_timeout`, deadlock, falha de serialização, erro inesperado | Sem ack; `ChangeMessageVisibility(min(base · 2^(n−1), máx))`, com `n` = `ApproximateReceiveCount` |
| Permanente | JSON ou envelope inválido, `kind: OPENING`, wallet inexistente, conflito de idempotência ou de inbox | Enviado explicitamente para a DLQ (com `failureReason`), depois ack |

- **Redrive policy** (`maxReceiveCount = 5`): a DLQ recebe os transitórios que nunca se resolvem. Se o
  envio para a DLQ falhar, a mensagem fica na fila (retry), nunca é perdida.
- **FIFO bloqueia por grupo:** uma mensagem em retry segura as próximas da mesma wallet. Isso é
  aceitável, e até desejável para a ordem, mas significa que uma mensagem com problema transitório
  atrasa a wallet até se resolver ou chegar à DLQ.
- **SIGTERM** (via `enableShutdownHooks`, no hook `beforeApplicationShutdown`, antes de o pool do banco
  fechar):
  1. aborta o long polling;
  2. deixa terminar, até `SHUTDOWN_GRACE_MS`, as mensagens que já começaram;
  3. devolve imediatamente, com `ChangeMessageVisibility(0)`, as recebidas e não liquidadas.

  O teste de reinício usa visibility timeout de 30 s justamente para provar essa devolução.

### Transactional Outbox

- O evento é gravado na mesma transação do efeito financeiro, e nunca é publicado antes do commit.
- **Publisher:** `SELECT … WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY sequence
  LIMIT n FOR UPDATE SKIP LOCKED`, seguido de `SendMessageBatch` e da marcação de publicado ou
  `scheduleRetry` (backoff), tudo na mesma transação curta.
- **Vários publishers pegam lotes disjuntos.** Se uma instância morrer, a conexão cai, o Postgres solta
  os locks e outra instância assume. `idle_in_transaction_session_timeout` limita o pior caso.
- **Duplicatas são possíveis** (a instância publica e morre antes do commit). O destino usa
  `MessageDeduplicationId = eventId`, e o consumidor deduplica por `eventId`.
- **Destino:** `wallet-events.fifo`, com `MessageGroupId = walletId` (coluna `message_group_id`).
- **Falha do broker:** a transação não é desfeita. As mensagens recebem `scheduleRetry` (backoff de 1 s
  a 5 min), e a tentativa e o erro ficam registrados.
- **Lag:** a cada ciclo, o publisher atualiza `wagering_outbox_pending` e
  `wagering_outbox_lag_seconds` (idade do evento pendente mais antigo).
- **Limitação de ordem:** com vários publishers, dois lotes da mesma wallet podem ser publicados fora
  de ordem (o lote 2 sai antes do lote 1). Os consumidores de eventos devem usar `walletVersion`
  (`WalletBalanceChanged`) e `occurredAt` para ordenar. A ordem do FIFO é uma otimização, não uma
  garantia.

### Referências fora de ordem

- **Referência ausente**, ou existente mas ainda não terminal: a transação é gravada como
  `PENDING_REFERENCE` e o evento `WagerTransactionPendingReference` é emitido (só na primeira vez).
- **Claim com lease:** o worker ([`PendingReferenceWorker`](src/wagering/workers/pending-reference.worker.ts))
  reclama as vencidas com `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED) … RETURNING`, empurrando
  `next_attempt_at` 30 s à frente. Workers concorrentes pegam conjuntos disjuntos, e o claim de um
  worker que morreu expira sozinho.
- **Resolução** ([`ResolvePendingReference`](src/wagering/application/resolve-pending-reference.ts)):
  segue a mesma ordem de lock (wallet primeiro) e as mesmas regras. Ao pegar o lock, confere que a
  transação continua `PENDING_REFERENCE`; se outra instância já decidiu, pula.
- **Backoff:** `min(2^(attempts − 1) s, 5 min)`.
- **TTL de 30 min** (`PENDING_REFERENCE_TTL_MS`): provedores costumam reenviar a referência em
  segundos ou minutos, e um TTL longo deixa a operação em limbo.
- **Ao esgotar o TTL:**
  - referência ausente: `REJECTED` com `REFERENCE_NOT_FOUND`, mais o evento `WagerTransactionRejected`;
  - referência que existe mas nunca terminou: `REFERENCE_NOT_PROCESSED`.
- **Otimização:** quando uma transação é processada, as pendentes que a referenciam têm o
  `next_attempt_at` antecipado na mesma transação. Cadeias como ROLLBACK de um REFUND de uma BET
  atrasada se resolvem um elo de cada vez.

### Pontos de falha injetáveis (somente testes)

`FAULT_INJECTION=crash-after-commit` mata o processo (`SIGKILL`) entre o commit e o ack do consumer.
`crash-after-publish` mata o processo entre o `SendMessageBatch` e o commit da outbox. Os testes de
integração sobem processos reais com essas variáveis para provar a recuperação. Sem a variável, o
código não faz nada.

## 9. Códigos de falha

Todo `REJECTED` carrega um `failureCode` estável. A coluna "provedor" indica a ação esperada.

| Código | Quando | Provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo | Não reenviar |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` de `WIN`/`REFUND` deixaria o saldo negativo | Não reenviar; tratar manualmente |
| `CURRENCY_MISMATCH` | Moeda da operação ≠ moeda da wallet | Corrigir o payload |
| `PLAYER_WALLET_MISMATCH` | `playerId` não é o dono da wallet | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | Referência não chegou dentro do TTL | Enviar a referência e reenviar com nova chave |
| `REFERENCE_MISMATCH` | Referência de outro player, wallet, rodada ou moeda | Corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | `REFUND` de algo que não é `BET`; `ROLLBACK` de `LOSS`/`ROLLBACK`; `WIN` referenciando algo que não é `BET` | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | A referência terminou `REJECTED` ou `FAILED` | Desistir |
| `REFERENCE_ALREADY_REVERSED` | A referência já foi revertida | Desistir (duplicata semântica) |
| `AMOUNT_MISMATCH` | Valor da reversão ≠ valor da referência | Corrigir o payload |

Erros que **não** são persistidos, porque não há transação válida a registrar:

- payload inválido: `VALIDATION_ERROR`, HTTP 400;
- wallet inexistente: `WALLET_NOT_FOUND`, HTTP 404;
- conflito de idempotência: `IDEMPOTENCY_CONFLICT`, HTTP 409.

## 10. API HTTP: mapeamento de status

O mesmo mapeamento vale em todos os endpoints. O corpo sempre traz `status` e, se houver,
`failureCode`.

| Situação | Status |
|---|---|
| Processada (nova ou replay, com `idempotentReplay` no corpo) | `200` |
| Wallet criada | `201` |
| Aceita, aguardando referência (`PENDING_REFERENCE`) | `202` |
| Payload inválido | `400` |
| Credencial ausente ou inválida (quando um IdP estiver ligado) | `401` |
| Provedor agindo sobre operações de outro provedor | `403` |
| Recurso inexistente | `404` |
| Conflito de idempotência ou wallet duplicada | `409` |
| Rejeição de negócio (inclusive em replay); também `FAILED` (terminal) | `422` |
| Falha transitória (banco ou SQS fora, `lock_timeout`), com `Retry-After` | `503` |
| Erro inesperado (bug) | `500` |

O corpo de erro tem sempre o mesmo formato: `{ "error": "<CODE>", "message": "...", "issues"?: [...] }`.
O código transitório vem da tradução de erros do banco: `55P03` (lock timeout), `40P01` (deadlock),
`40001` (serialização), `57014` (statement timeout), classe `08` (conexão) e erros de rede viram 503.
Lock timeouts e deadlocks também incrementam a métrica `wagering_lock_conflicts_total`.

A regra que o provedor usa: `4xx` **não** se reenvia igual, `202` aguarda o evento, `503` reenvia com a
mesma chave. Os endpoints `/health/live` e `/health/ready` são abertos. O ready responde 503 se o
Postgres ou o SQS não respondem em 2 s.

## 11. Eventos de integração

Envelope `IntegrationEvent<T>` (classe abstrata; `eventType` e `version` ficam na subclasse) com
`eventId`, `aggregateId`, `correlationId`, `causationId`, `occurredAt` e `data`. Em `data`, o dinheiro
vai sempre como `MoneyProps` (string), nunca como instância.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | Qualquer transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | Rejeição de negócio, inclusive TTL de referência esgotado |
| `WalletBalanceChanged` | Somente quando o saldo muda |
| `WagerTransactionPendingReference` | Referência ausente |

## 12. Observabilidade

- **Logs JSON (pino)** com `correlationId`, vindo do header `x-correlation-id` e validado contra
  injeção, ou gerado e devolvido no response. Também levam `messageId`, `transactionId`, `walletId` e
  `providerId` quando conhecidos. Corpos de request e response nunca são logados, e
  `authorization`/`idempotency-key` são redigidos. Os health checks ficam fora do log de acesso.
- **Métricas (Prometheus, `/metrics`):**

| Métrica | O que mede |
|---|---|
| `wagering_transactions_total{kind,status,source}` | Transações decididas, por status |
| `wagering_duplicates_detected_total{kind}` | Duplicatas absorvidas: `idempotency-replay` e `inbox` |
| `wagering_messages_retried_total` | Mensagens devolvidas à fila por falha transitória |
| `wagering_messages_dead_lettered_total{reason}` | Mensagens enviadas pelo consumer à DLQ (o redrive por `maxReceiveCount` aparece nas métricas da própria fila) |
| `wagering_lock_conflicts_total{reason}` | Lock timeouts e deadlocks |
| `wagering_outbox_pending`, `wagering_outbox_lag_seconds` | Backlog e lag da outbox |
| `wagering_outbox_deliveries_total{result}` | Publicações bem-sucedidas e falhas |
| `wagering_processing_duration_seconds{source,outcome}` | Latência de processamento (histograma) |
| `wagering_reconciliations_total{result}` | Reconciliações consistentes e divergentes |

Também ficam expostas as métricas padrão do processo.
- **Health:** liveness não depende de nada externo; readiness checa Postgres (`select 1` real) e SQS.

## 13. Autenticação

**Decisão: não integrar um IdP nesta entrega.** Autenticação não pontua, e o tempo foi para correção
financeira, concorrência e idempotência. O ponto de extensão, porém, está no código e testado.

**Ponto de extensão (implementado):**

| Peça | Papel |
|---|---|
| [`ProviderIdentityPort`](src/shared/application/provider-identity.ts) | Resolve quem chama (`Caller`) a partir das credenciais: `unrestricted` ou `provider` (com `providerId`). Credencial ausente ou inválida lança `UnauthenticatedError`. |
| [`AuthGuard`](src/platform/auth/auth.guard.ts) | Guard global (`APP_GUARD`): toda rota é autenticada, exceto as marcadas com `@Public()` (`/health/*` e `/metrics`). Só resolve o caller; não decide permissões. |
| [`NoAuthProviderIdentity`](src/platform/auth/no-auth.provider-identity.ts) | O adaptador ligado hoje, no [`AuthModule`](src/platform/auth/auth.module.ts): todo caller é `unrestricted`. |
| `assertCallerMayActAs` | Regra de domínio: um provedor autenticado só submete e consulta as próprias operações. Aplicada em `POST /wagering/transactions` e nos dois `GET` de transação. |

- **Respostas:** credencial inválida é 401 `UNAUTHENTICATED`, com `WWW-Authenticate: Bearer`. Agir em
  nome de outro provedor é 403 `PROVIDER_FORBIDDEN`, e nada é persistido.
- **Prova de que o ponto de extensão funciona:** [auth.test.ts](test/integration/auth.test.ts) troca
  o adaptador no-op por um adaptador OIDC falso e verifica o 401, o 403, as consultas restritas ao
  próprio provedor e que health e métricas continuam abertos.

**Desenho para ligar a autenticação de verdade:**

- **IdP externo (Keycloak) via OIDC**, com um client confidencial por provedor de jogos, no fluxo
  `client_credentials`.
- **Um adaptador da `ProviderIdentityPort` valida o JWT** (assinatura via JWKS, `iss`, `aud`, `exp`)
  e mapeia uma claim para o `providerId`. É a única troca necessária no código.
- **Endpoints de wallet** (criação, ledger, reconciliação) são de operador. Com o IdP, passariam a
  exigir um papel de back-office; hoje qualquer caller `unrestricted` os acessa.
- **Mensagens da fila** chegam por canal interno confiável. O `providerId` delas passa pelas mesmas
  validações de domínio (formato e resolução de referência dentro do mesmo provedor).

## 14. Interpretações adotadas

1. **Uma única reversão por referência, de qualquer tipo.** O enunciado proíbe reverter duas vezes
   "pelo mesmo tipo", mas um `REFUND` mais um `ROLLBACK` da mesma `BET` creditariam o valor duas vezes.
2. **`amount` com exatamente 2 casas.** `LOSS` aceita `0.00`; os outros kinds exigem valor maior que
   zero, porque um lançamento de zero não tem significado.
3. **`WIN` pode ou não referenciar uma `BET`.** Se referenciar uma que ainda não chegou, a `WIN` fica
   `PENDING_REFERENCE`.
4. **Referência existente mas não terminal** (por exemplo, `ROLLBACK` de um `REFUND` que ainda espera
   sua `BET`): aguardar. **Referência `REJECTED`/`FAILED`:** `REFERENCE_NOT_PROCESSED`.
5. **`ROLLBACK` de `WIN` ou `REFUND` debita.** Se o saldo não cobrir, o resultado é
   `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS`.
6. **Wallet inexistente:** 404 sem persistir; a FK impede gravar e não há saldo a proteger.
   **`playerId` que não é o dono da wallet:** `REJECTED` persistido, para ficar auditável e ter replay
   determinístico.
7. **`Idempotency-Key` tem escopo por `providerId`.** Chaves iguais de provedores diferentes não colidem.

## 15. Trade-offs e limitações

- **O lock pessimista serializa uma wallet muito disputada.** O [teste de carga](docs/LOAD_TEST.md)
  confirmou em números:
  - cerca de 160 operações/s numa única wallet, com 8 ou com 64 clientes;
  - latência crescendo com a fila (p50 de 403 ms com 64 clientes);
  - wallets distribuídas chegando a cerca de 690/s no mesmo ambiente.

  É aceitável, porque uma wallet é um jogador.
- **Triggers diferidos custam algumas buscas por índice por commit.** É o preço de ter as invariantes no
  banco. Não foram isolados no teste de carga; entram entre as hipóteses para os 43 ms de conexão por
  transação.
- **Gargalos encontrados no teste de carga, ainda não corrigidos** (detalhes e correções propostas em
  [docs/LOAD_TEST.md](docs/LOAD_TEST.md)):
  1. **Outbox.** O claim percorre todo o histórico de eventos publicados, porque o índice que ele usa
     inclui as linhas já publicadas, e os lotes são de só 10 eventos. A publicação, de cerca de 100/s,
     fica abaixo da produção no pico, de cerca de 1.200/s. Os eventos atrasam, mas nunca se perdem.
  2. **Consumer SQS.** Há um loop de recebimento por réplica, e cada lote é processado de forma
     praticamente sequencial: 62 mensagens/s, contra 29 ms de processamento por mensagem.
- **Índices únicos compostos extras em `wager_transactions`** (alvos das FKs compostas) encarecem a
  escrita em troca de garantias de escopo no schema.
- **Papel de banco único no ambiente local.** Em produção, o papel da aplicação seria separado do papel
  de migração, com `REVOKE UPDATE, DELETE` no ledger como defesa adicional aos triggers.
- **Bun não é plataforma oficial do NestJS.** Funciona bem aqui (DI, decorators, shutdown hooks), mas é
  um risco a monitorar em upgrades.
- **MiniStack é um emulador:** a semântica de FIFO e visibilidade pode diferir da AWS real. As
  garantias não dependem dela.
