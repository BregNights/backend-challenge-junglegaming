/**
 * Teste de carga: `bun run test:load`.
 *
 * Roda contra instâncias já de pé (por padrão, as 3 réplicas do docker-compose) e
 * mede três cenários:
 *
 *   1. wallets distribuídas — muitas wallets, operações misturadas (BET, WIN e
 *      replays idempotentes); mostra a vazão quando as wallets não disputam lock;
 *   2. wallet disputada — todas as requisições na mesma wallet; mostra o custo
 *      do lock pessimista, que serializa as operações de uma wallet;
 *   3. ingestão via SQS — mensagens publicadas na fila e consumidas pelas
 *      réplicas; mostra a vazão ponta a ponta do consumer.
 *
 * Para cada cenário: throughput, latência p50/p95/p99, taxa de erro, conflitos de
 * lock (via /metrics) e backlog/lag da outbox. No fim, reconcilia todas as wallets
 * usadas: qualquer divergência entre saldo e ledger faz o comando falhar.
 *
 * Configuração por variáveis de ambiente (valores padrão entre parênteses):
 *   LOAD_TARGETS (http://localhost:3000,3001,3002), LOAD_DURATION_S (20),
 *   LOAD_WARMUP_S (3), LOAD_CONCURRENCY (64), LOAD_WALLETS (200),
 *   LOAD_SQS_MESSAGES (2000), LOAD_SQS_WALLETS (50), AWS_ENDPOINT_URL, SQS_WAGER_QUEUE.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";

const config = {
  targets: (process.env.LOAD_TARGETS ?? "http://localhost:3000,http://localhost:3001,http://localhost:3002")
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean),
  durationMs: Number(process.env.LOAD_DURATION_S ?? 20) * 1_000,
  warmupMs: Number(process.env.LOAD_WARMUP_S ?? 3) * 1_000,
  concurrency: Number(process.env.LOAD_CONCURRENCY ?? 64),
  wallets: Number(process.env.LOAD_WALLETS ?? 200),
  sqsMessages: Number(process.env.LOAD_SQS_MESSAGES ?? 2_000),
  sqsWallets: Number(process.env.LOAD_SQS_WALLETS ?? 50),
  sqsEndpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  sqsQueue: process.env.SQS_WAGER_QUEUE ?? "wager-transactions.fifo",
  /** Quanto esperar a outbox zerar depois de cada cenário, antes do próximo começar. */
  drainTimeoutMs: Number(process.env.LOAD_DRAIN_TIMEOUT_S ?? 300) * 1_000,
};

const PROVIDER = "load-provider";
/** Saldo inicial alto: os cenários medem concorrência, não falta de saldo. */
const INITIAL_BALANCE = "1000000.00";
const runId = Date.now().toString(36);

interface Wallet {
  id: string;
  playerId: string;
}

interface Operation {
  key: string;
  body: Record<string, unknown>;
}

interface Sample {
  latencyMs: number;
  /** 0 = erro de rede. */
  status: number;
  replay: boolean;
}

interface OutboxObservation {
  maxPending: number;
  maxLagSeconds: number;
  /** Tempo para a outbox zerar depois que a carga parou; null se não zerou dentro do limite. */
  drainMs: number | null;
  /** Eventos publicados do início do cenário até a outbox zerar, e a vazão média de publicação. */
  published: number;
  publishRate: number;
}

interface ScenarioResult {
  name: string;
  description: string;
  concurrency: number | null;
  durationS: number;
  requests: number;
  throughput: number;
  latency: { p50: number; p95: number; p99: number; max: number };
  ok: number;
  replays: number;
  businessRejections: number;
  errors: number;
  errorRate: number;
  statusCounts: Record<string, number>;
  lockConflicts: number;
  /** Tempo médio dentro do use case (transação SQL), pelo histograma do servidor. */
  serverMeanMs: number;
  outbox: OutboxObservation;
  extra?: Record<string, string | number>;
}

// ------------------------------------------------------------------ utilidades

let roundRobin = 0;
const nextTarget = () => config.targets[roundRobin++ % config.targets.length]!;

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!, index);
      }
    }),
  );
  return results;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function latencyStats(latencies: number[]) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  };
}

// --------------------------------------------------------------- métricas (Prometheus)

async function scrapeAll(): Promise<string[]> {
  return Promise.all(config.targets.map(async (target) => (await fetch(`${target}/metrics`)).text()));
}

/** Valores das séries `name` cujos labels contêm `filter`, por instância. */
function metricValues(text: string, name: string, filter: Record<string, string> = {}): number[] {
  const values: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(name) || (line[name.length] !== "{" && line[name.length] !== " ")) continue;
    const labels = Object.fromEntries([...line.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
    if (Object.entries(filter).every(([key, value]) => labels[key] === value)) {
      values.push(Number(line.split(" ").at(-1)));
    }
  }
  return values;
}

const sumMetric = (texts: string[], name: string, filter?: Record<string, string>) =>
  texts.flatMap((text) => metricValues(text, name, filter)).reduce((sum, value) => sum + value, 0);

const maxMetric = (texts: string[], name: string) =>
  Math.max(0, ...texts.flatMap((text) => metricValues(text, name)));

/** Média do histograma de latência do servidor entre dois scrapes, em ms. */
function serverMeanMs(before: string[], after: string[], source: string): number {
  const delta = (name: string) => sumMetric(after, name, { source }) - sumMetric(before, name, { source });
  const count = delta("wagering_processing_duration_seconds_count");
  return count > 0 ? (delta("wagering_processing_duration_seconds_sum") / count) * 1_000 : 0;
}

const publishedEvents = (texts: string[]) => sumMetric(texts, "wagering_outbox_deliveries_total", { result: "published" });

/**
 * Amostra o backlog da outbox a cada 500 ms enquanto a carga roda; ao final,
 * continua amostrando até a outbox zerar (o próximo cenário só começa com ela
 * vazia) e calcula a vazão média de publicação do período.
 */
function startOutboxSampler(before: string[]) {
  const startedAt = performance.now();
  let maxPending = 0;
  let maxLagSeconds = 0;
  let running = true;

  const sample = async () => {
    const texts = await scrapeAll();
    const pending = maxMetric(texts, "wagering_outbox_pending");
    maxPending = Math.max(maxPending, pending);
    maxLagSeconds = Math.max(maxLagSeconds, maxMetric(texts, "wagering_outbox_lag_seconds"));
    return pending;
  };

  const loop = (async () => {
    while (running) {
      await sample();
      await Bun.sleep(500);
    }
  })();

  return {
    async finish(): Promise<OutboxObservation> {
      running = false;
      await loop;
      const stoppedAt = performance.now();
      let drainMs: number | null = null;
      while (performance.now() - stoppedAt < config.drainTimeoutMs) {
        if ((await sample()) === 0) {
          drainMs = performance.now() - stoppedAt;
          break;
        }
        await Bun.sleep(250);
      }
      const published = publishedEvents(await scrapeAll()) - publishedEvents(before);
      return {
        maxPending,
        maxLagSeconds,
        drainMs,
        published,
        publishRate: published / ((performance.now() - startedAt) / 1_000),
      };
    },
  };
}

// ---------------------------------------------------------------- operações

async function createWallets(count: number): Promise<Wallet[]> {
  return mapConcurrent(Array.from({ length: count }), 16, async () => {
    const playerId = Bun.randomUUIDv7();
    const response = await postJson(`${nextTarget()}/wallets`, {
      playerId,
      initialBalance: { amount: INITIAL_BALANCE, currency: "BRL" },
    });
    if (response.status !== 201) throw new Error(`falha ao criar wallet: ${response.status} ${JSON.stringify(response.body)}`);
    return { id: response.body.id as string, playerId };
  });
}

function wagerOperation(wallet: Wallet, kind: "BET" | "WIN", amount: string, externalTransactionId: string): Operation {
  return {
    key: `${PROVIDER}:${externalTransactionId}`,
    body: {
      providerId: PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${externalTransactionId}`,
      gameId: "load-game",
      kind,
      money: { amount, currency: "BRL" },
    },
  };
}

// ----------------------------------------------------------------- cenários HTTP

async function runHttpScenario(
  name: string,
  description: string,
  nextOperation: (vu: number, i: number) => Operation,
): Promise<ScenarioResult> {
  console.log(`\n▶ ${name}: ${config.concurrency} usuários virtuais, ${config.warmupMs / 1000}s de aquecimento + ${config.durationMs / 1000}s medidos`);
  const before = await scrapeAll();
  const sampler = startOutboxSampler(before);
  const samples: Sample[] = [];

  const start = performance.now();
  const measureFrom = start + config.warmupMs;
  const end = measureFrom + config.durationMs;

  // Modelo fechado: cada usuário virtual envia a próxima requisição assim que a anterior responde.
  await Promise.all(
    Array.from({ length: config.concurrency }, async (_, vu) => {
      for (let i = 0; performance.now() < end; i++) {
        const operation = nextOperation(vu, i);
        const startedAt = performance.now();
        let status = 0;
        let replay = false;
        try {
          const response = await postJson(`${nextTarget()}/wagering/transactions`, operation.body, {
            "Idempotency-Key": operation.key,
          });
          status = response.status;
          replay = response.body?.idempotentReplay === true;
        } catch {
          status = 0;
        }
        if (startedAt >= measureFrom && startedAt < end) {
          samples.push({ latencyMs: performance.now() - startedAt, status, replay });
        }
      }
    }),
  );

  const outbox = await sampler.finish();
  const after = await scrapeAll();
  return summarize(name, description, samples, config.durationMs / 1000, before, after, outbox);
}

function summarize(
  name: string,
  description: string,
  samples: Sample[],
  durationS: number,
  before: string[],
  after: string[],
  outbox: OutboxObservation,
): ScenarioResult {
  const statusCounts: Record<string, number> = {};
  for (const sample of samples) {
    const key = sample.status === 0 ? "rede" : String(sample.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  const errors = samples.filter((sample) => sample.status === 0 || sample.status >= 500 || sample.status === 409).length;
  return {
    name,
    description,
    concurrency: config.concurrency,
    durationS,
    requests: samples.length,
    throughput: samples.length / durationS,
    latency: latencyStats(samples.map((sample) => sample.latencyMs)),
    ok: samples.filter((sample) => sample.status === 200 || sample.status === 202).length,
    replays: samples.filter((sample) => sample.replay).length,
    businessRejections: statusCounts["422"] ?? 0,
    errors,
    errorRate: samples.length ? errors / samples.length : 0,
    statusCounts,
    lockConflicts: sumMetric(after, "wagering_lock_conflicts_total") - sumMetric(before, "wagering_lock_conflicts_total"),
    serverMeanMs: serverMeanMs(before, after, "http"),
    outbox,
  };
}

// ----------------------------------------------------------------- cenário SQS

async function runSqsScenario(wallets: Wallet[]): Promise<ScenarioResult> {
  console.log(`\n▶ sqs: ${config.sqsMessages} mensagens em ${wallets.length} wallets (grupos FIFO)`);
  const sqs = new SQSClient({
    region: "us-east-1",
    endpoint: config.sqsEndpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.sqsQueue }));

  const before = await scrapeAll();
  const baseline = sumMetric(before, "wagering_transactions_total", { source: "sqs" });
  const messages = Array.from({ length: config.sqsMessages }, (_, i) => {
    const wallet = wallets[i % wallets.length]!;
    const operation = wagerOperation(wallet, i % 4 === 3 ? "WIN" : "BET", "1.00", `ld-${runId}-sqs-${i}`);
    return {
      externalTransactionId: operation.body.externalTransactionId as string,
      groupId: wallet.id,
      body: JSON.stringify({
        messageId: `ld-${runId}-msg-${i}`,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: { ...operation.body, idempotencyKey: operation.key },
      }),
    };
  });

  const sampler = startOutboxSampler(before);
  const sentAt = new Map<string, number>();
  const firstSend = Date.now();
  const batches = Array.from({ length: Math.ceil(messages.length / 10) }, (_, i) => messages.slice(i * 10, i * 10 + 10));
  await mapConcurrent(batches, 8, async (batch) => {
    const at = Date.now();
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl,
        Entries: batch.map((message, index) => ({
          Id: String(index),
          MessageBody: message.body,
          MessageGroupId: message.groupId,
          MessageDeduplicationId: message.externalTransactionId,
        })),
      }),
    );
    for (const message of batch) sentAt.set(message.externalTransactionId, at);
  });
  const enqueueMs = Date.now() - firstSend;

  let processed = 0;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    processed = sumMetric(await scrapeAll(), "wagering_transactions_total", { source: "sqs" }) - baseline;
    if (processed >= messages.length) break;
    await Bun.sleep(200);
  }
  const completedAt = Date.now();
  const outbox = await sampler.finish();
  const after = await scrapeAll();
  sqs.destroy();

  // Latência ponta a ponta de cada mensagem: do envio à fila até o processedAt gravado.
  const latencies = (
    await mapConcurrent(messages, 32, async (message) => {
      const response = await fetch(`${nextTarget()}/providers/${PROVIDER}/wagering/transactions/${message.externalTransactionId}`);
      if (response.status !== 200) return undefined;
      const view = (await response.json()) as { processedAt?: string };
      return view.processedAt ? Date.parse(view.processedAt) - sentAt.get(message.externalTransactionId)! : undefined;
    })
  ).filter((latency): latency is number => latency !== undefined);

  const durationS = (completedAt - firstSend) / 1000;
  const missing = messages.length - latencies.length;
  return {
    name: "sqs",
    description: "Ingestão via SQS: mensagens publicadas na fila FIFO e consumidas pelas réplicas",
    concurrency: null,
    durationS,
    requests: messages.length,
    throughput: processed / durationS,
    latency: latencyStats(latencies),
    ok: latencies.length,
    replays: 0,
    businessRejections: 0,
    errors: missing,
    errorRate: messages.length ? missing / messages.length : 0,
    statusCounts: { processadas: latencies.length, "não processadas": missing },
    lockConflicts: sumMetric(after, "wagering_lock_conflicts_total") - sumMetric(before, "wagering_lock_conflicts_total"),
    serverMeanMs: serverMeanMs(before, after, "sqs"),
    outbox,
    extra: { enfileiramentoS: (enqueueMs / 1000).toFixed(1), grupos: wallets.length },
  };
}

// ------------------------------------------------------------- consistência

async function reconcile(wallets: Wallet[]): Promise<{ checked: number; inconsistent: string[] }> {
  const reports = await mapConcurrent(wallets, 16, async (wallet) => {
    const response = await postJson(`${nextTarget()}/wallets/${wallet.id}/reconciliation`, {});
    return { wallet, consistent: response.status === 200 && response.body.consistent === true };
  });
  return { checked: reports.length, inconsistent: reports.filter((report) => !report.consistent).map((report) => report.wallet.id) };
}

// ------------------------------------------------------------------ relatório

function environment() {
  const docker = Bun.spawnSync(["docker", "info", "--format", "{{.NCPU}}|{{.MemTotal}}|{{.OperatingSystem}}|{{.ServerVersion}}"]);
  const [dockerCpus, dockerMemory, dockerOs, dockerVersion] = docker.success ? docker.stdout.toString().trim().split("|") : [];
  return {
    host: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model.trim() ?? "?"} (${cpus().length} threads)`,
    memoria: `${(totalmem() / 1024 ** 3).toFixed(1)} GB`,
    bun: Bun.version,
    docker: dockerVersion ? `${dockerVersion} em ${dockerOs}, ${dockerCpus} CPUs e ${(Number(dockerMemory) / 1024 ** 3).toFixed(1)} GB para a VM` : "não identificado",
    instancias: config.targets.length,
  };
}

const ms = (value: number) => `${value.toFixed(1)} ms`;

function renderMarkdown(env: ReturnType<typeof environment>, results: ScenarioResult[], consistency: { checked: number; inconsistent: string[] }) {
  const lines = [
    `# Resultado do teste de carga (${new Date().toISOString()})`,
    "",
    "## Ambiente",
    "",
    `- Host: ${env.host}; ${env.cpu}; ${env.memoria} de RAM`,
    `- Docker: ${env.docker}`,
    `- Bun ${env.bun}; ${env.instancias} instâncias da aplicação`,
    `- Configuração: ${config.concurrency} usuários virtuais, ${config.warmupMs / 1000} s de aquecimento + ${config.durationMs / 1000} s medidos por cenário HTTP; ${config.wallets} wallets no cenário distribuído; ${config.sqsMessages} mensagens em ${config.sqsWallets} wallets no cenário SQS`,
    "",
    "## Resultados",
    "",
    "### Latência e throughput",
    "",
    "| Cenário | Throughput | p50 | p95 | p99 | máx | Servidor (média) | Requisições | Erros | 422 | Replays | Conflitos de lock |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...results.map(
      (result) =>
        `| ${result.name} | ${result.throughput.toFixed(0)}/s | ${ms(result.latency.p50)} | ${ms(result.latency.p95)} | ${ms(result.latency.p99)} | ${ms(result.latency.max)} | ${ms(result.serverMeanMs)} | ${result.requests} | ${result.errors} (${(result.errorRate * 100).toFixed(2)}%) | ${result.businessRejections} | ${result.replays} | ${result.lockConflicts} |`,
    ),
    "",
    "### Outbox",
    "",
    "| Cenário | Pendente (máx) | Lag (máx) | Drenagem após a carga | Eventos publicados | Vazão média de publicação |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (result) =>
        `| ${result.name} | ${result.outbox.maxPending} | ${result.outbox.maxLagSeconds.toFixed(1)} s | ${result.outbox.drainMs === null ? `não drenou em ${config.drainTimeoutMs / 1000} s` : `${(result.outbox.drainMs / 1000).toFixed(1)} s`} | ${result.outbox.published} | ${result.outbox.publishRate.toFixed(0)}/s |`,
    ),
    "",
    ...results.flatMap((result) => [
      `- **${result.name}**: ${result.description}. Status: ${Object.entries(result.statusCounts).map(([status, count]) => `${status}=${count}`).join(", ")}${result.extra ? `; ${Object.entries(result.extra).map(([key, value]) => `${key}=${value}`).join(", ")}` : ""}.`,
    ]),
    "",
    "## Consistência",
    "",
    `- ${consistency.checked} wallets reconciliadas; ${consistency.inconsistent.length} divergentes${consistency.inconsistent.length ? `: ${consistency.inconsistent.join(", ")}` : ""}.`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------- main

for (const target of config.targets) {
  const response = await fetch(`${target}/health/ready`).catch(() => undefined);
  if (response?.status !== 200) {
    console.error(`${target} não está pronto. Suba a stack com: docker compose up -d --build`);
    process.exit(1);
  }
}

const env = environment();
console.log(`Ambiente: ${JSON.stringify(env)}`);
console.log(`Criando ${config.wallets + 1 + config.sqsWallets} wallets...`);
const distributedWallets = await createWallets(config.wallets);
const [hotWallet] = await createWallets(1);
const sqsWallets = await createWallets(config.sqsWallets);

const results: ScenarioResult[] = [];

// 1. Wallets distribuídas: 70% BET, 20% WIN, 10% replay de uma operação recente do mesmo usuário virtual.
const recent = new Map<number, Operation[]>();
results.push(
  await runHttpScenario(
    "distribuído",
    `${config.wallets} wallets; 70% BET, 20% WIN e 10% replays idempotentes`,
    (vu, i) => {
      const history = recent.get(vu) ?? [];
      const roll = Math.random();
      if (roll < 0.1 && history.length > 0) return history[Math.floor(Math.random() * history.length)]!;
      const wallet = distributedWallets[Math.floor(Math.random() * distributedWallets.length)]!;
      const operation = wagerOperation(wallet, roll < 0.8 ? "BET" : "WIN", "1.00", `ld-${runId}-d-${vu}-${i}`);
      recent.set(vu, [...history.slice(-19), operation]);
      return operation;
    },
  ),
);

// 2. Wallet disputada: todas as requisições na mesma wallet (BET e WIN alternados).
results.push(
  await runHttpScenario("wallet disputada", "uma única wallet recebendo todas as requisições (BET e WIN alternados)", (vu, i) =>
    wagerOperation(hotWallet!, (vu + i) % 2 === 0 ? "BET" : "WIN", "1.00", `ld-${runId}-h-${vu}-${i}`),
  ),
);

// 3. Ingestão via SQS.
results.push(await runSqsScenario(sqsWallets));

console.log("\nReconciliando as wallets usadas...");
const consistency = await reconcile([...distributedWallets, hotWallet!, ...sqsWallets]);

const report = renderMarkdown(env, results, consistency);
mkdirSync("load-results", { recursive: true });
writeFileSync(`load-results/${runId}.md`, `${report}\n`);
writeFileSync(`load-results/${runId}.json`, `${JSON.stringify({ env, config, results, consistency }, null, 2)}\n`);
console.log(`\n${report}\n\nRelatório salvo em load-results/${runId}.md`);

if (consistency.inconsistent.length > 0) process.exitCode = 1;
