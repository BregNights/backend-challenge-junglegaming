import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { apiClient, startTestApp, testEnvironment } from "../support/app";
import { createTestOrm, resetSchema } from "../support/database";
import {
  createTestQueues,
  deleteTestQueues,
  drainQueue,
  queueDepth,
  type TestQueues,
  testSqsClient,
  waitFor,
} from "../support/messaging";
import { createWallet, submitWager, walletsDivergingFromLedger } from "../support/wagering";

/** Transactional outbox against real PostgreSQL and MiniStack. */

let orm: MikroORM;
let sqs: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
});

afterAll(async () => {
  if (orm) expect(await walletsDivergingFromLedger(orm)).toEqual([]);
  if (queues) await deleteTestQueues(sqs, queues);
  await orm?.close(true);
  sqs?.destroy();
});

async function outboxIds(filter: "pending" | "all"): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .execute<{ id: string }[]>(
      `select id from outbox_messages ${filter === "pending" ? "where published_at is null" : ""} order by sequence`,
    );
  return rows.map((row) => row.id);
}

function publishedCount(metrics: string): number {
  const line = metrics.split("\n").find((candidate) => candidate.startsWith('wagering_outbox_deliveries_total{result="published"}'));
  return line ? Number(line.split(" ").at(-1)) : 0;
}

/** Generates outbox traffic through the API: one opening event plus two events per bet. */
async function generateEvents(wallets: number, betsPerWallet: number): Promise<void> {
  const app = await startTestApp({ ...queues.env, APP_ROLES: "api" });
  try {
    const api = apiClient(app.baseUrl);
    await Promise.all(
      Array.from({ length: wallets }, async () => {
        const wallet = await createWallet(api, "100.00");
        for (let i = 0; i < betsPerWallet; i++) await submitWager(api, wallet, { kind: "BET", amount: "1.00" });
      }),
    );
  } finally {
    await app.close();
  }
}

describe("transactional outbox", () => {
  test("events are written with the business change and stay pending until a publisher runs", async () => {
    await generateEvents(2, 3);

    expect(await outboxIds("pending")).toHaveLength(2 * (1 + 3 * 2));
    expect(await queueDepth(sqs, queues.urls.events)).toBe(0);
  });

  test("two concurrent publishers deliver every event exactly once between them", async () => {
    await generateEvents(15, 2);
    const expected = await outboxIds("pending");

    const settings = { ...queues.env, APP_ROLES: "outbox-publisher", OUTBOX_POLL_INTERVAL_MS: "20", OUTBOX_BATCH_SIZE: "3" };
    const publishers = await Promise.all([startTestApp(settings), startTestApp(settings)]);
    try {
      await waitFor("outbox drained", async () => (await outboxIds("pending")).length === 0, 30_000);

      const perPublisher = await Promise.all(
        publishers.map(async (publisher) => publishedCount(await (await fetch(`${publisher.baseUrl}/metrics`)).text())),
      );
      // SKIP LOCKED: disjoint batches, so nothing was published twice...
      expect(perPublisher.reduce((sum, count) => sum + count, 0)).toBe(expected.length);
      // ...and both instances took part.
      expect(perPublisher.every((count) => count > 0)).toBe(true);
    } finally {
      await Promise.all(publishers.map((publisher) => publisher.close()));
    }

    const delivered = await drainQueue(sqs, queues.urls.events);
    const envelopes = delivered.map((message) => JSON.parse(message.Body ?? "{}"));
    expect(new Set(envelopes.map((envelope) => envelope.eventId))).toEqual(new Set(expected));
    expect(envelopes.every((envelope) => envelope.version === 1 && typeof envelope.eventType === "string")).toBe(true);
  }, 60_000);

  test("a publisher that dies after publishing and before committing is replaced; the duplicate is harmless", async () => {
    await generateEvents(1, 2);
    const expected = await outboxIds("pending");
    expect(expected).toHaveLength(5);

    const crashing = Bun.spawn([process.execPath, "run", "src/main.ts"], {
      cwd: `${import.meta.dir}/../..`,
      env: testEnvironment({
        ...queues.env,
        APP_ROLES: "outbox-publisher",
        PORT: "3221",
        OUTBOX_POLL_INTERVAL_MS: "50",
        FAULT_INJECTION: "crash-after-publish",
      }),
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await Promise.race([crashing.exited, Bun.sleep(30_000).then(() => "timeout" as const)]);
    expect(exitCode).not.toBe("timeout");
    expect(exitCode).not.toBe(0);

    // Published, but the commit that marks them as published never happened.
    expect(await outboxIds("pending")).toEqual(expected);

    const replacement = await startTestApp({ ...queues.env, APP_ROLES: "outbox-publisher", OUTBOX_POLL_INTERVAL_MS: "50" });
    try {
      await waitFor("outbox drained by the replacement", async () => (await outboxIds("pending")).length === 0, 20_000);
    } finally {
      await replacement.close();
    }

    const delivered = (await drainQueue(sqs, queues.urls.events)).map((message) => JSON.parse(message.Body ?? "{}"));
    const eventIds = delivered.map((envelope) => envelope.eventId);
    // At-least-once: every event arrived; a republished copy (if SQS did not already drop it
    // by MessageDeduplicationId) carries the same eventId, so consumers can discard it.
    expect(new Set(eventIds)).toEqual(new Set(expected));
    for (const id of expected) {
      const copies = delivered.filter((envelope) => envelope.eventId === id);
      expect(copies.every((copy) => JSON.stringify(copy) === JSON.stringify(copies[0]))).toBe(true);
    }
  }, 60_000);
});
