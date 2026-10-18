import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Subprocess } from "bun";
import { type ApiClient, apiClient, startTestApp, type TestApp } from "../support/app";
import { createTestOrm, resetSchema, TEST_DATABASE_URL } from "../support/database";
import { createWallet, ledgerOf, submitWager, walletsDivergingFromLedger } from "../support/wagering";

/**
 * Real parallelism, no sequential mocks: concurrent HTTP requests against the
 * real application and PostgreSQL, and several independent OS processes
 * competing for the same wallet.
 */

let orm: MikroORM;
let testApp: TestApp;
let api: ApiClient;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  testApp = await startTestApp();
  api = apiClient(testApp.baseUrl);
});

afterAll(async () => {
  if (orm) expect(await walletsDivergingFromLedger(orm)).toEqual([]);
  await testApp?.close();
  await orm?.close(true);
});

const debits = async (walletId: string) => (await ledgerOf(orm, walletId)).filter((entry) => entry.direction === "DEBIT");

describe("same wallet", () => {
  test("mandatory scenario: 100.00 balance, two concurrent 80.00 bets", async () => {
    const wallet = await createWallet(api, "100.00");

    const results = await Promise.all([
      submitWager(api, wallet, { kind: "BET", amount: "80.00" }),
      submitWager(api, wallet, { kind: "BET", amount: "80.00" }),
    ]);

    const statuses = results.map((result) => result.body.status).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    expect(results.find((result) => result.body.status === "REJECTED")?.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("20.00");
    expect(await debits(wallet.id)).toHaveLength(1);

    // Retrying both requests changes nothing.
    const retries = await Promise.all(
      results.map((result) =>
        api.get(`/wagering/transactions/${result.body.transactionId}`).then((stored) =>
          submitWager(api, wallet, { kind: "BET", amount: "80.00", externalTransactionId: stored.body.externalTransactionId }),
        ),
      ),
    );
    expect(retries.every((retry) => retry.body.idempotentReplay)).toBe(true);
    expect(await debits(wallet.id)).toHaveLength(1);
  });

  test("the same bet sent 50 times in parallel debits exactly once", async () => {
    const wallet = await createWallet(api, "100.00");
    const request = { kind: "BET", amount: "10.00", externalTransactionId: `parallel-${Bun.randomUUIDv7()}` };

    const results = await Promise.all(Array.from({ length: 50 }, () => submitWager(api, wallet, request)));

    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(new Set(results.map((result) => result.body.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.body.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.body.balance.amount === "90.00")).toBe(true);
    expect(await debits(wallet.id)).toHaveLength(1);
    expect((await api.get(`/wallets/${wallet.id}`)).body).toMatchObject({ balance: { amount: "90.00" }, version: 2 });
  });

  test("a hot wallet under 100 concurrent mixed operations never overdraws and matches its ledger", async () => {
    const wallet = await createWallet(api, "20.00");
    const operations = [
      ...Array.from({ length: 60 }, () => ({ kind: "BET", amount: "1.00" })),
      ...Array.from({ length: 40 }, () => ({ kind: "WIN", amount: "0.50" })),
    ].sort(() => Math.random() - 0.5);

    const results = await Promise.all(operations.map((operation) => submitWager(api, wallet, operation)));

    expect(results.every((result) => [200, 422].includes(result.status))).toBe(true);
    const processedBets = results.filter((r, i) => operations[i]!.kind === "BET" && r.body.status === "PROCESSED").length;
    const rejected = results.filter((r) => r.body.status === "REJECTED");
    expect(rejected.every((r) => r.body.failureCode === "INSUFFICIENT_FUNDS")).toBe(true);

    // 20.00 + 40 × 0.50 − processedBets × 1.00, computed in cents to stay exact.
    const expectedCents = 2_000 + 40 * 50 - processedBets * 100;
    const finalBalance = (await api.get(`/wallets/${wallet.id}`)).body.balance.amount as string;
    expect(finalBalance).toBe(`${Math.floor(expectedCents / 100)}.${String(expectedCents % 100).padStart(2, "0")}`);
    expect((await ledgerOf(orm, wallet.id)).every((entry) => !entry.balance_after.startsWith("-"))).toBe(true);
  });
});

describe("distinct wallets", () => {
  test("are processed in parallel without interfering", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(api, "50.00")));

    const results = await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 10 }, () => submitWager(api, wallet, { kind: "BET", amount: "5.00" }))),
    );

    expect(results.every((result) => result.body.status === "PROCESSED")).toBe(true);
    for (const wallet of wallets) {
      expect((await api.get(`/wallets/${wallet.id}`)).body).toMatchObject({ balance: { amount: "0.00" }, version: 11 });
    }
  });
});

describe("multiple instances", () => {
  const PORTS = [3201, 3202, 3203];
  let instances: Subprocess[] = [];

  beforeAll(async () => {
    instances = PORTS.map((port) =>
      Bun.spawn([process.execPath, "run", "src/main.ts"], {
        cwd: `${import.meta.dir}/../..`,
        env: {
          ...process.env,
          PORT: String(port),
          DATABASE_URL: TEST_DATABASE_URL,
          DATABASE_POOL_MAX: "10",
          APP_ROLES: "api",
          LOG_LEVEL: "silent",
        },
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
    await Promise.all(PORTS.map((port) => waitUntilLive(`http://127.0.0.1:${port}`)));
  }, 60_000);

  afterAll(async () => {
    for (const instance of instances) instance.kill();
    await Promise.all(instances.map((instance) => instance.exited));
  });

  test("three processes competing for one wallet: no duplicate debit, no overdraft", async () => {
    const clients = PORTS.map((port) => apiClient(`http://127.0.0.1:${port}`));
    const wallet = await createWallet(clients[0]!, "100.00");

    // 30 distinct bets of 10.00, each delivered to all three instances at once.
    const bets = Array.from({ length: 30 }, (_, i) => ({ kind: "BET", amount: "10.00", externalTransactionId: `multi-${i}` }));
    const results = await Promise.all(bets.flatMap((bet) => clients.map((client) => submitWager(client, wallet, bet))));

    for (let i = 0; i < bets.length; i++) {
      const copies = results.slice(i * 3, i * 3 + 3);
      expect(new Set(copies.map((copy) => copy.body.transactionId)).size).toBe(1);
      expect(new Set(copies.map((copy) => copy.body.status)).size).toBe(1);
      expect(copies.filter((copy) => !copy.body.idempotentReplay)).toHaveLength(1);
    }

    const decided = results.filter((result) => !result.body.idempotentReplay);
    expect(decided.filter((result) => result.body.status === "PROCESSED")).toHaveLength(10);
    expect(decided.filter((result) => result.body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(20);
    expect(await debits(wallet.id)).toHaveLength(10);
    expect((await clients[2]!.get(`/wallets/${wallet.id}`)).body).toMatchObject({ balance: { amount: "0.00" }, version: 11 });
  });
});

async function waitUntilLive(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/health/live`)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`${baseUrl} did not become live within ${timeoutMs}ms`);
}
