# Teste de carga

Como rodar, o que foi medido, os resultados da execução de referência e o que eles dizem sobre o
sistema, incluindo onde ele não escala.

## Como rodar

```bash
docker compose up -d --build
bun run test:load
```

- **Alvo:** o script roda contra as instâncias que já estão de pé (por padrão, as 3 réplicas do compose).
- **Saída:** imprime o relatório e o salva em `load-results/<id>.md` e `.json` (fora do git).
- **Falha:** o comando sai com erro se alguma wallet terminar divergente do ledger.
- **Parâmetros:** variáveis de ambiente, documentadas no topo de
  [test/load/run-load.ts](../test/load/run-load.ts):
  - `LOAD_CONCURRENCY`, `LOAD_DURATION_S`, `LOAD_WARMUP_S`;
  - `LOAD_WALLETS`, `LOAD_SQS_MESSAGES`, `LOAD_SQS_WALLETS`;
  - `LOAD_TARGETS`, `LOAD_DRAIN_TIMEOUT_S`.

## Ambiente da execução de referência

| Item | Valor |
|---|---|
| Máquina | Intel Core i7-10700 (8 núcleos, 16 threads), 32 GB de RAM, Windows 11 |
| Docker | Docker Desktop 29.8 (VM WSL2 com 16 CPUs e 15,5 GB) |
| Aplicação | 3 réplicas (Bun 1.4.3), todas com os 4 papéis ativos; pool de 10 conexões por réplica; `lock_timeout` de 3 s |
| Banco | PostgreSQL 17 em container, configuração padrão |
| Fila | MiniStack 1.5.29 (emulador do SQS) |
| Gerador de carga | O próprio script, em Bun, **na mesma máquina** |

## Metodologia

**Três cenários**, cada um começando com a outbox vazia: o script espera o backlog do cenário
anterior zerar antes de seguir.

| Cenário | O que exercita |
|---|---|
| **Distribuído** | 200 wallets e 64 usuários virtuais, com 70% de BET, 20% de WIN e 10% de replays idempotentes de operações recentes. Mede a vazão quando as wallets não disputam lock. |
| **Wallet disputada** | 64 usuários virtuais numa única wallet, alternando BET e WIN. Mede o custo do lock pessimista, que serializa as operações de uma wallet. |
| **SQS** | 2000 mensagens publicadas em lotes de 10 na fila FIFO, espalhadas por 50 wallets (grupos), e consumidas pelas 3 réplicas. Mede a vazão ponta a ponta do consumer. |

**Como as medições são feitas:**

- **Modelo fechado:** cada usuário virtual dispara a próxima requisição assim que a anterior responde,
  em round-robin entre as 3 réplicas.
- **Janela de medição:** 3 s de aquecimento, descartados, seguidos de 20 s medidos.
- **Latência:** medida no cliente, do envio até a resposta. O p50/p95/p99 sai das amostras da janela.
- **Tempo médio no servidor:** média do histograma `wagering_processing_duration_seconds` entre dois
  scrapes do `/metrics`. Cobre o use case inteiro, inclusive a espera por conexão do pool.
- **Conflitos de lock:** variação de `wagering_lock_conflicts_total`, que soma lock timeouts e
  deadlocks.
- **Outbox:** `wagering_outbox_pending` e `wagering_outbox_lag_seconds` são amostrados a cada 500 ms
  durante a carga e até a drenagem. A vazão de publicação vem de `wagering_outbox_deliveries_total`.
- **SQS:** a vazão é o total de mensagens dividido pelo tempo entre o primeiro envio e a última
  mensagem processada. A latência de cada mensagem vai do envio ao `processedAt` gravado.
- **Correção:** ao final, todas as 251 wallets usadas passam pela reconciliação.

## Resultados

Execução de 19/10/2026:

| Cenário | Throughput | p50 | p95 | p99 | máx | Servidor (média) | Requisições | Erros | Conflitos de lock |
|---|---|---|---|---|---|---|---|---|---|
| Distribuído | **690/s** | 80 ms | 197 ms | 237 ms | 299 ms | 88 ms | 13.804 | 0 (0%) | 0 |
| Wallet disputada | **159/s** | 403 ms | 483 ms | 551 ms | 612 ms | 407 ms | 3.179 | 0 (0%) | 0 |
| SQS | **62/s** | 15,9 s | 27,7 s | 28,5 s | 28,8 s | 29 ms | 2.000 | 0 (0%) | 0 |

| Cenário | Outbox pendente (máx) | Lag (máx) | Drenagem após a carga | Eventos publicados | Vazão de publicação |
|---|---|---|---|---|---|
| Distribuído | 26.333 | 204 s | 204 s | 28.433 | 125/s |
| Wallet disputada | 6.144 | 63 s | 63 s | 7.244 | 84/s |
| SQS | 1.250 | 13 s | 13 s | 4.000 | 88/s |

Outros dados da execução:
- **Replays:** 1.344 no cenário distribuído, todos com status 200.
- **Rejeições de negócio (422):** nenhuma, como esperado, porque o saldo inicial é alto.
- **Consistência:** **251 wallets reconciliadas, 0 divergentes.**

## Análise

### Correção sob carga

Nenhum erro, nenhuma divergência entre saldo e ledger, nenhum lock timeout, e todos os replays
devolveram o resultado original. As invariantes se mantiveram com 64 clientes concorrentes em 3
instâncias, e também com 64 clientes disputando a mesma wallet.

### Wallets distribuídas: o banco é o limite

- **O tempo está dentro do use case.** O tempo médio no servidor (88 ms) é praticamente o p50 visto
  pelo cliente (80 ms); HTTP e rede quase não pesam.
- **A Lei de Little fecha a conta:** 690 req/s × 0,088 s ≈ 61 requisições em andamento, o que bate com
  os 64 usuários virtuais.
- **Cada transação segura a conexão por cerca de 43 ms.** São 3 réplicas com 10 conexões, ou 30
  conexões, para 690 transações por segundo. Isso inclui a espera pelo pool, porque são cerca de 21
  requisições concorrentes por réplica para 10 conexões. Também é alto para uma transação que trava
  uma única linha sem contenção.
- **Contribuem para isso** (hipóteses, não medidas individualmente):
  - cerca de 9 idas e vindas ao banco por operação: dedup, lock, re-checagem, id externo, inserts de
    transação, lançamento e dois eventos, e o update da wallet. Tudo passa pela rede do Docker Desktop;
  - os triggers diferidos e as FKs compostas, que são o preço de ter as invariantes no schema;
  - **a disputa de CPU no banco com os publishers da outbox**, cuja query de claim fica mais cara a
    cada evento publicado (ver abaixo).

### Wallet disputada: o trade-off do lock pessimista, em números

- **A vazão é a mesma com 8 ou com 64 clientes** (168/s no teste curto, 159/s aqui). Isso é
  serialização: cada operação segura o lock da wallet por cerca de 6,3 ms (1/159 s), e esse é o teto
  por wallet neste ambiente.
- **A latência cresce com a fila,** exatamente como prevê a Lei de Little: 64 / 159 ≈ 0,40 s, que é o
  p50 medido (403 ms). É o custo descrito no ARCHITECTURE: wallets diferentes escalam, a mesma wallet
  não.
- **Não houve lock timeout.** Com 64 na fila, a espera ficou em cerca de 400 ms, bem abaixo dos 3 s
  do `lock_timeout`. Os timeouts, e com eles os 503 com `Retry-After`, apareceriam por volta de 475
  operações simultâneas na mesma wallet (3 s / 6,3 ms). Um jogador real não chega perto disso; o
  risco realista é uma tempestade de retries de um provedor com defeito.

### SQS: o consumer é sequencial demais

- **O banco não é o problema aqui.** Cada mensagem leva só 29 ms no use case, mas a vazão total é de
  62/s: cerca de 21 mensagens/s por réplica, ou 48 ms por mensagem. O processamento está praticamente
  sequencial.
- **A causa está no código do consumer:**
  - há **um único loop de recebimento por réplica**;
  - cada recebimento traz até 10 mensagens, e o próximo só começa quando o lote inteiro termina;
  - as mensagens de um mesmo grupo FIFO são processadas em ordem;
  - cada mensagem faz o próprio `DeleteMessage`.

  Quando um lote concentra poucos grupos, o processamento vira uma fila indiana.
- **O p50 de 16 s é tempo de fila, não de processamento.** As 2000 mensagens entraram em 3,4 s e
  saíram a 62/s, cerca de 32 s no total; em média, cada mensagem esperou a metade disso.

### Outbox: o principal gargalo encontrado

- **Os publishers não acompanham a produção de eventos.** No cenário distribuído, foram produzidos
  cerca de 1.240 eventos/s (28.433 em 23 s de carga), mas a publicação ficou em 85 a 125 eventos/s. O
  backlog chegou a 26 mil eventos, o lag a 204 s, e a drenagem levou mais de 3 minutos.
- **Causa confirmada pelo plano de execução:** a query de claim
  (`… WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY sequence LIMIT 10 FOR UPDATE SKIP LOCKED`)
  percorre o índice único de `sequence` desde o começo e descarta, uma a uma, todas as linhas já
  publicadas:

  ```
  Limit
    ->  LockRows
          ->  Index Scan using outbox_messages_sequence_uq on outbox_messages
                Filter: ((published_at IS NULL) AND (next_attempt_at <= now()))
  ```

  Como linhas publicadas nunca são apagadas, **cada claim fica mais caro à medida que o histórico
  cresce**. É um problema de escalabilidade de verdade, que o teste de carga expôs.
- **Agravantes:**
  - lotes limitados a 10, que é o máximo do `SendMessageBatch`, com um claim e um commit por lote;
  - dez `UPDATE`s individuais por lote;
  - um `COUNT(*)` do backlog depois de cada lote, para a métrica de lag.
- **O que não acontece:** nenhum evento se perde e a correção financeira não é afetada. Os eventos
  só atrasam, e o atraso fica visível em `wagering_outbox_lag_seconds`, que merece um alerta.

### Correções propostas, por impacto

1. **Índice parcial `outbox_messages (sequence) WHERE published_at IS NULL`.** O claim passa a tocar só
   as linhas pendentes: custo proporcional ao lote, não ao histórico. Vem numa migration nova e
   reversível.
2. **Lotes maiores por transação.** Reivindicar, por exemplo, 100 eventos e publicá-los em 10
   `SendMessageBatch` paralelos. Marcar os publicados com um único
   `UPDATE … WHERE id = ANY(…)`.
3. **Calcular o backlog no máximo uma vez por segundo**, e não a cada lote.
4. **Vários loops de publicação por réplica.** O `SKIP LOCKED` já garante lotes disjuntos.
5. **Retenção:** apagar ou arquivar eventos publicados há mais de N dias, mantendo a tabela pequena.
6. **Consumer:** vários loops de recebimento por réplica (mais grupos FIFO em paralelo) e
   `DeleteMessageBatch` ao final de cada lote, depois dos commits.

## Limitações do experimento

- **Tudo roda na mesma máquina:** gerador, aplicação, banco e fila disputam CPU dentro do Docker
  Desktop no Windows. Os números absolutos não representam produção; as comparações entre cenários e
  os gargalos encontrados, sim.
- **O MiniStack é um emulador.** A latência e a vazão do SQS real são outras.
- **As execuções são curtas** (20 s por cenário): não há teste de longa duração (soak), nem medição de
  memória ou de GC.
- **Modelo fechado:** o throughput depende da concorrência escolhida. Um modelo aberto, com taxa de
  chegada fixa, mostraria a latência numa vazão-alvo e o ponto de saturação.
- **O tempo do servidor é uma média.** Os buckets do histograma não dão percentis exatos do lado do
  servidor.
- **Lição de metodologia:** na primeira execução os cenários não eram isolados, e o backlog da outbox
  de um cenário contaminou o seguinte (o SQS apareceu com a mesma vazão, mas com a outbox ainda
  drenando eventos antigos). O script agora espera a outbox zerar entre cenários.
