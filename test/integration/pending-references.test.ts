import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { type ApiClient, apiClient, startTestApp, type TestApp } from "../support/app";
import { createTestOrm, resetSchema } from "../support/database";
import { waitFor } from "../support/messaging";
import { createWallet, ledgerOf, outboxEventTypes, submitWager, walletsDivergingFromLedger } from "../support/wagering";

/** Referências fora de ordem resolvidas pelo worker agendado (duas instâncias). */

let orm: MikroORM;
let workers: TestApp[];
let api: ApiClient;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  const settings = {
    APP_ROLES: "api,pending-reference-worker",
    PENDING_REFERENCE_POLL_INTERVAL_MS: "100",
    PENDING_REFERENCE_TTL_MS: "4000",
  };
  workers = await Promise.all([startTestApp(settings), startTestApp(settings)]);
  api = apiClient(workers[0]!.baseUrl);
});

afterAll(async () => {
  if (orm) expect(await walletsDivergingFromLedger(orm)).toEqual([]);
  await Promise.all((workers ?? []).map((worker) => worker.close()));
  await orm?.close(true);
});

async function statusOf(transactionId: string) {
  return (await api.get(`/wagering/transactions/${transactionId}`)).body as { status: string; failureCode?: string };
}

describe("pending references", () => {
  test("a ROLLBACK that arrived before its BET is applied once the BET arrives", async () => {
    const wallet = await createWallet(api, "100.00");
    const rollback = await submitWager(api, wallet, { kind: "ROLLBACK", amount: "15.00", reference: "late-bet" });
    expect(rollback.status).toBe(202);

    const bet = await submitWager(api, wallet, { externalTransactionId: "late-bet", kind: "BET", amount: "15.00" });
    expect(bet.body.balance.amount).toBe("85.00");

    await waitFor("rollback processed", async () => (await statusOf(rollback.body.transactionId)).status === "PROCESSED");
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
    expect((await ledgerOf(orm, wallet.id)).map((entry) => entry.direction)).toEqual(["CREDIT", "DEBIT", "CREDIT"]);
    expect(await outboxEventTypes(orm, [rollback.body.transactionId])).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
    ]);
  }, 15_000);

  test("a reference that never arrives is rejected once the waiting window is over", async () => {
    const wallet = await createWallet(api, "100.00");
    const request = { externalTransactionId: `orphan-${wallet.id}`, kind: "REFUND", amount: "10.00", reference: "never-sent" };
    const refund = await submitWager(api, wallet, request);
    expect(refund.status).toBe(202);

    await waitFor("rejected after the TTL", async () => (await statusOf(refund.body.transactionId)).status === "REJECTED", 15_000);
    expect((await statusOf(refund.body.transactionId)).failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(await outboxEventTypes(orm, [refund.body.transactionId])).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);

    // Um replay da requisição original agora reflete a decisão final.
    const replay = await submitWager(api, wallet, request);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_NOT_FOUND", idempotentReplay: true });
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
  }, 20_000);

  test("a chain delivered backwards (ROLLBACK → REFUND → BET) resolves link by link", async () => {
    const wallet = await createWallet(api, "100.00");
    const suffix = wallet.id.slice(-8);
    const rollback = await submitWager(api, wallet, { kind: "ROLLBACK", amount: "20.00", reference: `refund-${suffix}` });
    const refund = await submitWager(api, wallet, {
      externalTransactionId: `refund-${suffix}`,
      kind: "REFUND",
      amount: "20.00",
      reference: `bet-${suffix}`,
    });
    expect([rollback.status, refund.status]).toEqual([202, 202]);

    await submitWager(api, wallet, { externalTransactionId: `bet-${suffix}`, kind: "BET", amount: "20.00" });

    await waitFor("both links processed", async () => {
      const [refundStatus, rollbackStatus] = await Promise.all([
        statusOf(refund.body.transactionId),
        statusOf(rollback.body.transactionId),
      ]);
      return refundStatus.status === "PROCESSED" && rollbackStatus.status === "PROCESSED";
    });
    expect((await ledgerOf(orm, wallet.id)).map((entry) => `${entry.direction} ${entry.balance_after}`)).toEqual([
      "CREDIT 100.00",
      "DEBIT 80.00",
      "CREDIT 100.00",
      "DEBIT 80.00",
    ]);
  }, 15_000);

  test("two workers racing over the same backlog resolve each transaction exactly once", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(api, "50.00")));
    const rollbacks = await Promise.all(
      wallets.map((wallet) => submitWager(api, wallet, { kind: "ROLLBACK", amount: "5.00", reference: `race-bet-${wallet.id}` })),
    );
    expect(rollbacks.every((response) => response.status === 202)).toBe(true);

    await Promise.all(
      wallets.map((wallet) => submitWager(api, wallet, { externalTransactionId: `race-bet-${wallet.id}`, kind: "BET", amount: "5.00" })),
    );

    await waitFor("all rollbacks processed", async () => {
      const statuses = await Promise.all(rollbacks.map((response) => statusOf(response.body.transactionId)));
      return statuses.every((status) => status.status === "PROCESSED");
    });
    for (const wallet of wallets) {
      expect((await ledgerOf(orm, wallet.id)).map((entry) => entry.direction)).toEqual(["CREDIT", "DEBIT", "CREDIT"]);
      expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("50.00");
    }
  }, 20_000);
});
