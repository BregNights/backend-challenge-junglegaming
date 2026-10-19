# Teste de carga

Como rodar, o que foi medido, os gargalos encontrados, o que foi corrigido e o antes e depois. Inclui
o que o experimento revelou sobre o próprio ambiente de medição, que no fim pesou tanto quanto o
código.

## Resumo

- **Correção:** zero erros e zero divergências entre saldo e ledger em todas as execuções, com 64
  clientes concorrentes em 3 réplicas, e também com 64 clientes disputando a mesma wallet.
- **Outbox:** o pipeline no banco ficou **12× mais rápido com 100 mil eventos de histórico e 41× com
  400 mil**, e o custo deixou de crescer com o histórico. Na carga completa, a vazão de publicação foi
  de 195 para 280 eventos/s e a drenagem caiu de 113 para 65 s. O que limita a vazão agora é o
  emulador de SQS.
- **Consumer SQS:** de 291 para **361 mensagens/s (+24%)** com 2 loops por réplica e ack em lote, na
  medição isolada.
- **Wallet disputada:** o teto de cerca de 160 operações/s por wallet é o custo esperado do lock
  pessimista. As correções não mexem nisso, e nem deveriam.

## Como rodar

```bash
docker compose up -d --build
bun run test:load
bun run test:load:outbox
```

- **`test:load`:** três cenários contra as instâncias de pé (por padrão, as 3 réplicas do compose).
  Salva o relatório em `load-results/<id>.md` e `.json` (fora do git) e falha se alguma wallet
  terminar divergente.
- **`test:load:outbox`:** benchmark do pipeline da outbox no banco de teste, com um broker falso que
  confirma na hora.
- **Parâmetros:** variáveis de ambiente, no topo de [run-load.ts](../test/load/run-load.ts) e de
  [outbox-bench.ts](../test/load/outbox-bench.ts):
  - `LOAD_CONCURRENCY`, `LOAD_DURATION_S`, `LOAD_SCENARIOS`;
  - `OUTBOX_BENCH_HISTORY`, entre outras.
- **Ajustes da stack sem editar o compose:** `SQS_CONSUMER_CONCURRENCY` e `OUTBOX_BATCH_SIZE`.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Intel Core i7-10700 (8 núcleos, 16 threads), 32 GB de RAM, Windows 11 |
| Docker | Docker Desktop 29.8 (VM WSL2 com 16 CPUs e 15,5 GB) |
| Aplicação | 3 réplicas (Bun 1.4.3) com os 4 papéis ativos; pool de 10 conexões por réplica; `lock_timeout` de 3 s |
| Banco | PostgreSQL 17 em container, configuração padrão |
| Fila | MiniStack 1.5.29 (emulador do SQS) |
| Gerador de carga | O próprio script, em Bun, na mesma máquina |

## Metodologia

**Cenários do `test:load`:**

| Cenário | O que exercita |
|---|---|
| **Distribuído** | 200 wallets e 64 usuários virtuais, com 70% de BET, 20% de WIN e 10% de replays idempotentes. Mede a vazão quando as wallets não disputam lock. |
| **Wallet disputada** | 64 usuários virtuais numa única wallet. Mede o custo do lock pessimista. |
| **SQS** | 2000 mensagens publicadas em lotes de 10 na fila FIFO, em 50 wallets (grupos), consumidas pelas réplicas. |

**Como as medições são feitas:**

- **Modelo fechado:** cada usuário virtual dispara a próxima requisição assim que a anterior responde,
  em round-robin entre as réplicas.
- **Janela:** 3 s de aquecimento, descartados, seguidos de 20 s medidos.
- **Latência:** medida no cliente.
- **Tempo médio no servidor:** sai do histograma `wagering_processing_duration_seconds` e inclui a
  espera por conexão do pool.
- **Conflitos de lock e outbox:** vêm do `/metrics`.
- **Correção:** ao final, todas as 251 wallets usadas passam pela reconciliação.

**Controles que o experimento obrigou a adicionar** (ver "O que o experimento revelou"):

1. **Cenários isolados:** cada cenário só começa com a outbox vazia.
2. **Fila de eventos rasa:** ela é purgada antes de cada cenário, e um consumidor de descarte a drena
   durante a carga, imitando um consumidor downstream que acompanha o ritmo. A profundidade máxima
   aparece no relatório.
3. **Comparações de consumer feitas isoladamente:** só o cenário SQS, com o MiniStack reiniciado antes
   de cada variante, 3 repetições intercaladas e a mediana como resultado.
4. **O pipeline da outbox medido no banco**, com um broker falso, separado do emulador.

O "antes" foi medido com o código do commit anterior às correções (`c595acb`), numa imagem separada,
com a migration nova revertida para restaurar o índice antigo.

## O que o experimento revelou sobre o ambiente

**O custo de envio do MiniStack cresce linearmente com a profundidade da fila.** Medido isoladamente,
sem a aplicação, com 3000 mensagens por rodada:

| Profundidade da fila | Vazão de envio |
|---|---|
| 0 → 3 mil | 2.356 msg/s |
| 3 mil → 6 mil | 1.160 msg/s |
| 6 mil → 9 mil | 760 msg/s |
| 12 mil → 15 mil | 411 msg/s |
| 119 mil | 119 msg/s |

- **Por que isso importa:** a `wallet-events.fifo` não é consumida neste projeto, porque consumir os
  eventos é papel de sistemas downstream. Ela tinha acumulado 119 mil mensagens, e por isso **as
  primeiras medições da outbox estavam medindo o emulador, não o código**. O SQS real não tem essa
  característica.
- **Histórico recente também pesa:** o emulador fica mais lento depois de muito tráfego, provavelmente
  por causa da janela de deduplicação FIFO de 5 minutos. O cenário SQS, rodando depois dos outros
  dois, sai bem mais lento (54 a 71 msg/s) do que isolado (cerca de 300 a 360 msg/s).
- **Long polling abortado retém mensagens:** quando um processo aborta um long polling, o emulador mantém
  a requisição registrada até o fim da espera, e as mensagens que chegam nessa janela vão para um
  receptor morto e ficam invisíveis até o visibility timeout. Isso apareceu como atrasos de 30 s nas
  medições feitas logo depois de trocar a versão da aplicação. O consumer novo deixou de abortar
  pollings no shutdown por exatamente esse motivo (ver as correções).

## Gargalos encontrados

1. **Claim da outbox proporcional ao histórico.** A query
   (`… WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY sequence LIMIT n FOR UPDATE SKIP LOCKED`)
   percorria o índice único de `sequence` desde o começo, descartando uma a uma as linhas já publicadas.
   Como elas nunca são apagadas, cada claim ficava mais caro a cada evento publicado:

   ```
   Index Scan using outbox_messages_sequence_uq on outbox_messages
     Filter: ((published_at IS NULL) AND (next_attempt_at <= now()))
   ```

   Somavam-se a isso lotes de 10 com um claim e um commit por lote, um `UPDATE` por evento e um
   `COUNT(*)` do backlog depois de cada lote.
2. **Consumer SQS sequencial.** Havia um único loop de recebimento por réplica, o próximo lote só era
   recebido quando o anterior terminava, e cada mensagem fazia o próprio `DeleteMessage`.

## Correções

| Correção | Onde |
|---|---|
| Índice parcial `outbox_messages (sequence) WHERE published_at IS NULL`, em migration nova e reversível; substitui o índice antigo, que não servia à ordenação | [Migration20261019000000OutboxUnpublishedIndex.ts](../src/platform/database/migrations/Migration20261019000000OutboxUnpublishedIndex.ts) |
| Lotes de 100 por transação, publicados em `SendMessageBatch` paralelos de até 10 | [outbox-publisher.ts](../src/messaging/application/outbox-publisher.ts), [sqs-event-publisher.ts](../src/platform/messaging/sqs-event-publisher.ts) |
| Um único `UPDATE … WHERE id IN (…)` para os eventos publicados | [mikro-orm-store.ts](../src/persistence/mikro-orm-store.ts) |
| Contagem do backlog no máximo 1×/s, com subconsultas que usam o índice parcial | [outbox-publisher.ts](../src/messaging/application/outbox-publisher.ts) |
| Vários loops de recebimento por réplica (`SQS_CONSUMER_CONCURRENCY`, padrão 2) e ack em lote (`DeleteMessageBatch`) depois dos commits | [wager-transaction.consumer.ts](../src/wagering/sqs/wager-transaction.consumer.ts) |
| Shutdown espera o long polling em andamento em vez de abortá-lo; long polling padrão de 5 s, abaixo do prazo de graça de 10 s | [wager-transaction.consumer.ts](../src/wagering/sqs/wager-transaction.consumer.ts), [app-config.ts](../src/platform/config/app-config.ts) |

**Cobertura nos testes:**
- dois testes de schema novos: a migration reverte sozinha, e o claim usa o índice parcial mesmo com
  20 mil eventos publicados;
- o teste de shutdown seguido de reinício passou a pegar o problema dos pollings abortados assim que o
  consumer ganhou vários loops;
- os 184 testes passam.

## Antes e depois

### 1. Pipeline da outbox no banco (`test:load:outbox`)

Broker falso que confirma na hora, 3 publishers concorrentes e backlog de 20 mil eventos sobre um
histórico de eventos já publicados:

| Histórico publicado | Antes (índice antigo, lote de 10, `UPDATE` por evento) | Depois (índice parcial, lote de 100, `UPDATE` em lote) | Ganho |
|---|---|---|---|
| 100 mil eventos | 1.298 eventos/s | 16.002 eventos/s | **12,3×** |
| 400 mil eventos | 485 eventos/s | 19.698 eventos/s | **40,6×** |

**O antes degrada com o histórico; o depois não.** Num sistema que roda por meses, o pipeline antigo
pararia de acompanhar a produção de eventos mesmo com um broker infinitamente rápido.

### 2. Consumer SQS isolado

Só o cenário SQS (2000 mensagens, 50 grupos), com o MiniStack reiniciado antes de cada variante, em 3
repetições intercaladas:

| Variante | Repetições | Mediana | Tempo no servidor |
|---|---|---|---|
| Antes: 1 loop, `DeleteMessage` por mensagem | 293 / 291 / 287 | **291 msg/s** | cerca de 49 ms |
| Depois: 1 loop, ack em lote | 325 / 333 / 316 ¹ | 325 msg/s (+12%) | cerca de 48 ms |
| **Depois: 2 loops, ack em lote (padrão)** | 370 / 361 / 345 | **361 msg/s (+24%)** | cerca de 67 ms |
| Depois: 4 loops, ack em lote | 314 / 314 / 311 | 314 msg/s (+8%) | cerca de 82 ms |

¹ Duas outras execuções com 1 loop deram cerca de 60 msg/s. As duas vieram logo depois da variante
com o código antigo, cujo long polling de 20 s, abortado no shutdown, deixou requisições "fantasmas" no
emulador que retiveram mensagens por um visibility timeout. Com o MiniStack reiniciado sem essa troca
de versão, 1 loop deu 333 e 316 msg/s, sem nenhum aviso nos logs.

- **Por que mais loops não ajudam sempre:** com 4 loops, cada réplica chega a ter até 40 mensagens em
  processamento para um pool de 10 conexões. O tempo no servidor sobe de 48 para 82 ms (espera por
  conexão), e o emulador passa a ter mais receptores disputando a fila FIFO.
- **2 loops é o melhor ponto neste ambiente.** No SQS real, onde o limite é a vazão por grupo, vale
  reavaliar junto com o tamanho do pool.

### 3. Carga completa (`test:load`, mesmos parâmetros)

| Cenário | Métrica | Antes | Depois |
|---|---|---|---|
| Distribuído | Throughput / p99 | 658/s / 203 ms | 620/s / 212 ms |
| Wallet disputada | Throughput / p99 | 110/s / 1.412 ms | 140/s / 1.177 ms |
| Distribuído | Outbox: vazão de publicação / drenagem | 195/s / 113 s | **280/s / 65 s** |
| Wallet disputada | Outbox: vazão de publicação / drenagem | 84/s / 39 s | 122/s / 30 s |
| SQS (depois dos outros cenários) | Throughput | 71/s | 54/s |

Em todas as execuções: **0 erros, 0 conflitos de lock, 251 wallets reconciliadas e 0 divergentes.**

**Como ler esta tabela:**
- **HTTP:** distribuído e wallet disputada não passam pelo código alterado. As diferenças estão dentro
  da variação entre execuções do mesmo código: a wallet disputada deu 166, 159 e 110/s com o código
  antigo, e 163, 167 e 140/s com o novo.
- **Outbox de ponta a ponta:** melhorou, mas segue limitada pelo emulador. Mesmo com 8 drenadores, a
  fila de eventos chegou a 18,8 mil mensagens no cenário distribuído, e o custo de envio do MiniStack
  cresce com a profundidade. A evidência confiável do ganho do código é a medição 1.
- **SQS na carga completa:** reflete o estado do emulador depois de dezenas de milhares de eventos. A
  comparação confiável do consumer é a medição 2.

## Análise

**Correção sob carga.** Nenhuma execução produziu erro, divergência, lock timeout ou replay incorreto.
As invariantes valeram em todos os cenários, antes e depois das mudanças.

**Wallet disputada: o trade-off do lock pessimista, em números.**
- **A vazão não muda com o número de clientes** (com 8 ou com 64 clientes, cerca de 160/s): cada
  operação segura o lock da wallet por cerca de 6 ms.
- **A latência segue a Lei de Little:** 64 / 160/s ≈ 0,40 s, que é o p50 medido.
- **Lock timeout:** só apareceria por volta de 475 operações simultâneas na mesma wallet (3 s / 6,3 ms).
  Um jogador real não chega perto disso; o risco realista é uma tempestade de retries de um provedor com
  defeito, que terminaria em 503 com `Retry-After`.

**Wallets distribuídas: o banco é o limite.**
- **O tempo está dentro do use case:** o tempo médio no servidor (cerca de 90 a 100 ms) é praticamente
  o p50 do cliente.
- **Cada transação segura a conexão por cerca de 45 ms** (3 × 10 conexões para cerca de 650 req/s),
  incluindo a espera pelo pool.
- **Prováveis contribuintes:** cerca de 9 idas e vindas ao banco por operação, os triggers diferidos e
  as FKs compostas (o preço das invariantes no schema), e a disputa de CPU com os publishers da outbox.

**Outbox.** Depois da correção, o lado do banco publica mais de 16 mil eventos/s. Neste ambiente, o
limite passa a ser o broker emulado. Os eventos atrasam sob carga, mas nunca se perdem, e o atraso fica
visível em `wagering_outbox_lag_seconds`, que merece um alerta.

## Limitações e próximos passos

- **Ambiente compartilhado:** gerador, aplicação, banco e emulador disputam a mesma máquina, no Docker
  Desktop sobre Windows. Os números absolutos não representam produção. As comparações e os gargalos
  encontrados, sim.
- **O MiniStack não é o SQS:** a vazão dele depende da profundidade da fila e do histórico recente. Uma
  medição de verdade de outbox e consumer precisa do SQS real.
- **Ordem dos eventos:** os `SendMessageBatch` paralelos podem inverter a ordem de dois lotes da mesma
  wallet, o que já acontecia com vários publishers. Os consumidores devem ordenar por `walletVersion`
  (ver ARCHITECTURE).
- **Retenção:** a outbox nunca é limpa. O índice parcial tirou o histórico do caminho do claim, mas uma
  rotina que apague ou arquive eventos publicados há mais de N dias mantém a tabela pequena.
- **Em produção:** o índice seria criado com `CREATE INDEX CONCURRENTLY`, numa migration fora de
  transação.
- **Modelo do teste:** as execuções são curtas (20 s por cenário) e em modelo fechado. Um teste de
  longa duração (soak) e um modelo aberto, com taxa de chegada fixa, mostrariam o ponto de saturação e
  o comportamento de memória.

## Lições de metodologia

1. **Isolar os cenários:** o backlog da outbox de um cenário contaminava o seguinte.
2. **Desconfiar do ambiente antes do código:** a primeira hipótese para a outbox lenta (o claim) era
   real, mas o teto observado vinha do emulador. Só um benchmark com broker falso separou as duas
   coisas.
3. **Repetir e intercalar:** medições em sequência herdavam o estado do emulador, e uma variante
   chegou a ter resultados bimodais. Reiniciar o MiniStack, repetir 3 vezes e usar a mediana tornou a
   comparação estável.
4. **O teste de carga também achou um problema de correção operacional:** abortar long pollings no
   shutdown retinha mensagens. Ele virou uma mudança no consumer, e um teste de integração existente
   passou a cobri-lo.
