import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { type ApiClient, apiClient, startTestApp, type TestApp, testEnvironment } from "../support/app";
import { createTestOrm, resetSchema } from "../support/database";
import {
  createTestQueues,
  deleteTestQueues,
  drainQueue,
  queueDepth,
  sendEnvelope,
  sendRaw,
  type TestQueues,
  testSqsClient,
  waitFor,
  wagerEnvelope,
} from "../support/messaging";
import { createWallet, ledgerOf, type TestWallet, walletsDivergingFromLedger } from "../support/wagering";

/** The SQS consumer against real MiniStack queues and PostgreSQL. */

let orm: MikroORM;
let sqs: SQSClient;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  sqs = testSqsClient();
});

afterAll(async () => {
  if (orm) expect(await walletsDivergingFromLedger(orm)).toEqual([]);
  await orm?.close(true);
  sqs?.destroy();
});

async function transactionsFor(externalTransactionId: string) {
  return orm.em
    .fork()
    .execute<{ id: string; status: string; failure_code: string | null }[]>(
      `select id, status, failure_code from wager_transactions where provider_id = 'provider-a' and external_transaction_id = ?`,
      [externalTransactionId],
    );
}

async function inboxRows(messageId: string) {
  return orm.em
    .fork()
    .execute<{ consumer_name: string; processed_at: string | null }[]>(
      `select consumer_name, processed_at from inbox_messages where message_id = ?`,
      [messageId],
    );
}

async function metricsOf(baseUrl: string): Promise<string> {
  return (await fetch(`${baseUrl}/metrics`)).text();
}

function metricValue(metrics: string, series: string): number {
  const line = metrics.split("\n").find((candidate) => candidate.startsWith(`${series} `));
  return line ? Number(line.split(" ").at(-1)) : 0;
}

describe("SQS consumer", () => {
  let queues: TestQueues;
  let app: TestApp;
  let api: ApiClient;

  beforeAll(async () => {
    queues = await createTestQueues(sqs);
    app = await startTestApp({ ...queues.env, APP_ROLES: "api,sqs-consumer", DATABASE_LOCK_TIMEOUT_MS: "500" });
    api = apiClient(app.baseUrl);
  });

  afterAll(async () => {
    await app?.close();
    if (queues) await deleteTestQueues(sqs, queues);
  });

  test("processes a message with the same use case as HTTP and acks it after commit", async () => {
    const wallet = await createWallet(api, "100.00");
    const envelope = wagerEnvelope(wallet, { kind: "BET", amount: "30.00" });
    await sendEnvelope(sqs, queues.urls.wager, envelope);

    const stored = await waitFor("transaction processed", async () => {
      const response = await api.get(`/providers/provider-a/wagering/transactions/${envelope.data.externalTransactionId}`);
      return response.status === 200 && response.body;
    });
    expect(stored).toMatchObject({ status: "PROCESSED", balanceAfter: { amount: "70.00" } });
    expect(await inboxRows(envelope.messageId)).toEqual([
      { consumer_name: "wager-transactions-consumer", processed_at: expect.any(String) },
    ]);
    await waitFor("message deleted", async () => (await queueDepth(sqs, queues.urls.wager)) === 0);
  }, 20_000);

  test("a redelivered message is absorbed by the inbox", async () => {
    const wallet = await createWallet(api, "100.00");
    const envelope = wagerEnvelope(wallet, { kind: "BET", amount: "10.00" });
    const before = metricValue(await metricsOf(app.baseUrl), 'wagering_duplicates_detected_total{kind="inbox"}');

    await sendEnvelope(sqs, queues.urls.wager, envelope);
    await sendEnvelope(sqs, queues.urls.wager, envelope);
    await waitFor("both deliveries handled", async () =>
      metricValue(await metricsOf(app.baseUrl), 'wagering_duplicates_detected_total{kind="inbox"}') > before,
    );

    expect(await transactionsFor(envelope.data.externalTransactionId)).toHaveLength(1);
    expect(await inboxRows(envelope.messageId)).toHaveLength(1);
    expect((await ledgerOf(orm, wallet.id)).filter((entry) => entry.direction === "DEBIT")).toHaveLength(1);
  }, 20_000);

  test("another message carrying the same idempotency key is an idempotent replay", async () => {
    const wallet = await createWallet(api, "100.00");
    const first = wagerEnvelope(wallet, { kind: "BET", amount: "10.00" });
    const second = { ...first, messageId: `${first.messageId}-resent` };

    await sendEnvelope(sqs, queues.urls.wager, first);
    await sendEnvelope(sqs, queues.urls.wager, second);
    await waitFor("both messages recorded", async () => (await inboxRows(second.messageId)).length === 1);

    expect(await inboxRows(first.messageId)).toHaveLength(1);
    expect(await transactionsFor(first.data.externalTransactionId)).toHaveLength(1);
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("90.00");
  }, 20_000);

  test("a business rejection is a decision: persisted and acked, never retried", async () => {
    const wallet = await createWallet(api, "10.00");
    const envelope = wagerEnvelope(wallet, { kind: "BET", amount: "50.00" });
    await sendEnvelope(sqs, queues.urls.wager, envelope);

    const [rejected] = await waitFor("rejection stored", async () => {
      const rows = await transactionsFor(envelope.data.externalTransactionId);
      return rows.length > 0 && rows;
    });
    expect(rejected).toMatchObject({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    await waitFor("message deleted", async () => (await queueDepth(sqs, queues.urls.wager)) === 0);
    expect(await queueDepth(sqs, queues.urls.wagerDlq)).toBe(0);
  }, 20_000);

  test("invalid and permanently failing messages go straight to the DLQ", async () => {
    const wallet = await createWallet(api, "10.00");
    const unknownWallet: TestWallet = { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() };

    await sendRaw(sqs, queues.urls.wager, "{ this is not json", "poison");
    await sendEnvelope(sqs, queues.urls.wager, wagerEnvelope(wallet, { kind: "OPENING", amount: "1.00" }));
    await sendEnvelope(sqs, queues.urls.wager, wagerEnvelope(unknownWallet, { kind: "BET", amount: "1.00" }));

    await waitFor("three messages dead-lettered", async () => (await queueDepth(sqs, queues.urls.wagerDlq)) >= 3);
    const deadLetters = await drainQueue(sqs, queues.urls.wagerDlq);
    expect(deadLetters.map((message) => message.MessageAttributes?.failureReason?.StringValue).sort()).toEqual([
      "invalid-message",
      "invalid-message",
      "permanent-error",
    ]);
    expect(deadLetters.find((m) => m.Body === "{ this is not json")).toBeDefined();
    await waitFor("main queue drained", async () => (await queueDepth(sqs, queues.urls.wager)) === 0);
  }, 20_000);

  test("transient failures are retried with backoff until they succeed", async () => {
    const wallet = await createWallet(api, "100.00");
    const envelope = wagerEnvelope(wallet, { kind: "BET", amount: "10.00" });
    const retriesBefore = metricValue(await metricsOf(app.baseUrl), "wagering_messages_retried_total");

    // Hold the wallet lock longer than the consumer's lock_timeout (500 ms).
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holding = orm.em.fork().transactional(async (em) => {
      await em.execute("select id from wallets where id = ? for update", [wallet.id]);
      await released;
    });
    await Bun.sleep(100);
    await sendEnvelope(sqs, queues.urls.wager, envelope);

    await waitFor("first attempt failed", async () =>
      metricValue(await metricsOf(app.baseUrl), "wagering_messages_retried_total") > retriesBefore,
    );
    release();
    await holding;

    const [processed] = await waitFor("processed on retry", async () => {
      const rows = await transactionsFor(envelope.data.externalTransactionId);
      return rows.length > 0 && rows;
    });
    expect(processed?.status).toBe("PROCESSED");
    expect(await queueDepth(sqs, queues.urls.wagerDlq)).toBe(0);
  }, 30_000);

  test("a message that keeps failing transiently is moved to the DLQ after maxReceiveCount", async () => {
    const wallet = await createWallet(api, "100.00");
    const envelope = wagerEnvelope(wallet, { kind: "BET", amount: "10.00" });

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holding = orm.em.fork().transactional(async (em) => {
      await em.execute("select id from wallets where id = ? for update", [wallet.id]);
      await released;
    });
    await Bun.sleep(100);
    await sendEnvelope(sqs, queues.urls.wager, envelope);

    try {
      await waitFor("redriven to the DLQ", async () => (await queueDepth(sqs, queues.urls.wagerDlq)) >= 1, 30_000, 500);
    } finally {
      release();
      await holding;
    }
    const [deadLetter] = await drainQueue(sqs, queues.urls.wagerDlq);
    expect(JSON.parse(deadLetter?.Body ?? "{}").messageId).toBe(envelope.messageId);
    expect(await transactionsFor(envelope.data.externalTransactionId)).toHaveLength(0);
  }, 45_000);
});

describe("crash between commit and ack", () => {
  let queues: TestQueues;
  let apiApp: TestApp;

  beforeAll(async () => {
    queues = await createTestQueues(sqs, { visibilityTimeoutSeconds: 2 });
    apiApp = await startTestApp({ ...queues.env, APP_ROLES: "api" });
  });

  afterAll(async () => {
    await apiApp?.close();
    if (queues) await deleteTestQueues(sqs, queues);
  });

  test("the redelivered message is absorbed by the inbox: one transaction, one debit", async () => {
    const api = apiClient(apiApp.baseUrl);
    const wallet = await createWallet(api, "100.00");
    const envelope = wagerEnvelope(wallet, { kind: "BET", amount: "10.00" });

    const crashing = Bun.spawn([process.execPath, "run", "src/main.ts"], {
      cwd: `${import.meta.dir}/../..`,
      env: testEnvironment({
        ...queues.env,
        APP_ROLES: "sqs-consumer",
        PORT: "3211",
        FAULT_INJECTION: "crash-after-commit",
      }),
      stdout: "ignore",
      stderr: "ignore",
    });
    await sendEnvelope(sqs, queues.urls.wager, envelope);

    const exitCode = await Promise.race([crashing.exited, Bun.sleep(30_000).then(() => "timeout" as const)]);
    expect(exitCode).not.toBe("timeout");
    expect(exitCode).not.toBe(0);

    // Committed, but never acknowledged.
    expect(await transactionsFor(envelope.data.externalTransactionId)).toMatchObject([{ status: "PROCESSED" }]);
    expect(await queueDepth(sqs, queues.urls.wager)).toBe(1);

    const recovered = await startTestApp({ ...queues.env, APP_ROLES: "sqs-consumer" });
    try {
      await waitFor("redelivered and acked", async () => (await queueDepth(sqs, queues.urls.wager)) === 0, 20_000);
      expect(metricValue(await metricsOf(recovered.baseUrl), 'wagering_duplicates_detected_total{kind="inbox"}')).toBe(1);
    } finally {
      await recovered.close();
    }

    expect(await transactionsFor(envelope.data.externalTransactionId)).toHaveLength(1);
    expect((await ledgerOf(orm, wallet.id)).filter((entry) => entry.direction === "DEBIT")).toHaveLength(1);
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("90.00");
  }, 60_000);
});

describe("graceful shutdown and restart", () => {
  let queues: TestQueues;

  beforeAll(async () => {
    // A long visibility timeout: if shutdown did not hand messages back, the restarted
    // instance would only see them after 30 s and the test would time out.
    queues = await createTestQueues(sqs, { visibilityTimeoutSeconds: 30 });
  });

  afterAll(async () => {
    if (queues) await deleteTestQueues(sqs, queues);
  });

  test("stopping mid-stream loses nothing and a restarted instance processes every message exactly once", async () => {
    const first = await startTestApp({ ...queues.env, APP_ROLES: "api,sqs-consumer", SHUTDOWN_GRACE_MS: "5000" });
    const wallet = await createWallet(apiClient(first.baseUrl), "100.00");
    const envelopes = Array.from({ length: 20 }, (_, i) => wagerEnvelope(wallet, { kind: "BET", amount: "1.00", externalTransactionId: `stream-${wallet.id}-${i}` }));
    for (const envelope of envelopes) await sendEnvelope(sqs, queues.urls.wager, envelope);

    await waitFor("consumption started", async () => (await ledgerOf(orm, wallet.id)).length > 1, 10_000, 50);
    await first.close(); // what SIGTERM triggers through enableShutdownHooks

    const second = await startTestApp({ ...queues.env, APP_ROLES: "api,sqs-consumer" });
    try {
      await waitFor("all 20 bets processed", async () => (await ledgerOf(orm, wallet.id)).length === 21, 20_000);
      await waitFor("queue drained", async () => (await queueDepth(sqs, queues.urls.wager)) === 0, 10_000);

      const api = apiClient(second.baseUrl);
      expect((await api.get(`/wallets/${wallet.id}`)).body).toMatchObject({ balance: { amount: "80.00" }, version: 21 });
      expect((await api.post(`/wallets/${wallet.id}/reconciliation`)).body).toMatchObject({ consistent: true, checkedEntries: 21 });
    } finally {
      await second.close();
    }
    for (const envelope of envelopes) {
      expect(await transactionsFor(envelope.data.externalTransactionId)).toHaveLength(1);
    }
  }, 60_000);
});
