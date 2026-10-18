import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { type ApiClient, apiClient, startTestApp, type TestApp } from "../support/app";
import { createTestOrm, resetSchema } from "../support/database";
import {
  createWallet,
  ledgerOf,
  outboxEventTypes,
  submitWager,
  type TestWallet,
  wagerBody,
  walletsDivergingFromLedger,
} from "../support/wagering";

/** Ponta a ponta via HTTP, com a aplicação Nest e o PostgreSQL reais. */

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
  // Invariante final da suíte: toda wallet é igual ao saldo reconstruído pelo seu ledger.
  if (orm) expect(await walletsDivergingFromLedger(orm)).toEqual([]);
  await testApp?.close();
  await orm?.close(true);
});

describe("wallets", () => {
  test("opening with a balance books an OPENING credit in the same transaction", async () => {
    const playerId = Bun.randomUUIDv7();
    const response = await api.post("/wallets", { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    expect(await ledgerOf(orm, response.body.id)).toEqual([
      { direction: "CREDIT", amount: "1000.00", balance_after: "1000.00", wallet_version: 1 },
    ]);
    expect(await outboxEventTypes(orm, [response.body.id])).toEqual(["WalletBalanceChanged"]);
  });

  test("a zero-balance wallet has no ledger entry", async () => {
    const wallet = await createWallet(api, "0.00");
    expect((await api.get(`/wallets/${wallet.id}`)).body).toMatchObject({ balance: { amount: "0.00" }, version: 1 });
    expect(await ledgerOf(orm, wallet.id)).toEqual([]);
  });

  test("one wallet per player and currency", async () => {
    const wallet = await createWallet(api, "10.00", "BRL");
    const duplicate = await api.post("/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "5.00", currency: "BRL" },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe("WALLET_ALREADY_EXISTS");

    const otherCurrency = await api.post("/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "5.00", currency: "USD" },
    });
    expect(otherCurrency.status).toBe(201);
  });

  test.each([
    ["one decimal", { amount: "10.5", currency: "BRL" }, "INVALID_MONEY"],
    ["negative", { amount: "-1.00", currency: "BRL" }, "INVALID_MONEY"],
    ["number instead of string", { amount: 10, currency: "BRL" }, "VALIDATION_ERROR"],
    ["lowercase currency", { amount: "1.00", currency: "brl" }, "INVALID_MONEY"],
  ])("rejects an initial balance with %s (400)", async (_, initialBalance, error) => {
    const response = await api.post("/wallets", { playerId: Bun.randomUUIDv7(), initialBalance });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(error);
  });

  test("404 for an unknown wallet, 400 for a malformed id", async () => {
    expect((await api.get(`/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await api.get("/wallets/not-a-uuid")).status).toBe(400);
  });
});

describe("POST /wagering/transactions", () => {
  test("a BET is processed, debited and announced", async () => {
    const wallet = await createWallet(api, "100.00");
    const response = await submitWager(api, wallet, { kind: "BET", amount: "25.00" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" },
      idempotentReplay: false,
    });
    expect(await outboxEventTypes(orm, [response.body.transactionId, wallet.id])).toEqual([
      "WalletBalanceChanged", // abertura
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("an identical retry replays the original result, including the balance seen back then", async () => {
    const wallet = await createWallet(api, "100.00");
    const original = await submitWager(api, wallet, { externalTransactionId: "replay-bet", kind: "BET", amount: "30.00" });
    await submitWager(api, wallet, { kind: "WIN", amount: "50.00" });

    const replay = await submitWager(api, wallet, { externalTransactionId: "replay-bet", kind: "BET", amount: "30.00" });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe("70.00");
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("120.00");
  });

  test("same key with a different payload is a conflict, not a replay", async () => {
    const wallet = await createWallet(api, "100.00");
    await submitWager(api, wallet, { externalTransactionId: "conflict-bet", kind: "BET", amount: "10.00" });

    const different = await submitWager(api, wallet, { externalTransactionId: "conflict-bet", kind: "BET", amount: "11.00" });
    expect(different.status).toBe(409);
    expect(different.body.error).toBe("IDEMPOTENCY_CONFLICT");

    const sameExternalIdOtherKey = await submitWager(api, wallet, {
      externalTransactionId: "conflict-bet",
      kind: "BET",
      amount: "10.00",
      idempotencyKey: "another-key",
    });
    expect(sameExternalIdOtherKey.status).toBe(409);
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("90.00");
  });

  test("input problems are 400 and never persisted", async () => {
    const wallet = await createWallet(api, "100.00");
    const { body } = wagerBody(wallet, { kind: "BET", amount: "10.00" });

    const missingKey = await api.post("/wagering/transactions", body);
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.issues[0].message).toContain("Idempotency-Key");

    const opening = await submitWager(api, wallet, { kind: "OPENING", amount: "10.00" });
    expect(opening.status).toBe(400);
    expect(opening.body.issues[0].message).toContain("OPENING is internal");

    expect((await submitWager(api, wallet, { kind: "BET", amount: "10.001" })).status).toBe(400);
    expect((await submitWager(api, wallet, { kind: "BET", amount: "1e3" })).status).toBe(400);
    expect((await submitWager(api, wallet, { kind: "REFUND", amount: "10.00" })).body.error).toBe("INVALID_WAGER_TRANSACTION");

    const malformed = await api.post("/wagering/transactions", "{not json", { "Idempotency-Key": "k" });
    expect(malformed.status).toBe(400);

    expect(await ledgerOf(orm, wallet.id)).toHaveLength(1);
  });

  test("an unknown wallet is 404", async () => {
    const response = await submitWager(api, { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() }, { kind: "BET", amount: "1.00" });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("WALLET_NOT_FOUND");
  });

  test("business rejections are 422, auditable and replayable", async () => {
    const wallet = await createWallet(api, "10.00");
    const tooBig = await submitWager(api, wallet, { externalTransactionId: "too-big", kind: "BET", amount: "10.01" });

    expect(tooBig.status).toBe(422);
    expect(tooBig.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "10.00" } });

    const replay = await submitWager(api, wallet, { externalTransactionId: "too-big", kind: "BET", amount: "10.01" });
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...tooBig.body, idempotentReplay: true });

    const stored = await api.get(`/providers/provider-a/wagering/transactions/too-big`);
    expect(stored.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    expect(await outboxEventTypes(orm, [tooBig.body.transactionId])).toEqual(["WagerTransactionRejected"]);
  });

  test("currency and player must match the wallet (422)", async () => {
    const wallet = await createWallet(api, "10.00");
    const usd = await submitWager(api, wallet, { kind: "BET", amount: "1.00", currency: "USD" });
    expect(usd.body).toMatchObject({ status: "REJECTED", failureCode: "CURRENCY_MISMATCH" });

    const stranger = await submitWager(api, wallet, { kind: "BET", amount: "1.00", playerId: Bun.randomUUIDv7() });
    expect(stranger.body).toMatchObject({ status: "REJECTED", failureCode: "PLAYER_WALLET_MISMATCH" });
  });

  test("LOSS is recorded without moving the balance or the version", async () => {
    const wallet = await createWallet(api, "10.00");
    const loss = await submitWager(api, wallet, { kind: "LOSS", amount: "0.00" });

    expect(loss.status).toBe(200);
    expect(loss.body).toMatchObject({ status: "PROCESSED", balance: { amount: "10.00" } });
    expect((await api.get(`/wallets/${wallet.id}`)).body.version).toBe(1);
    expect(await outboxEventTypes(orm, [loss.body.transactionId])).toEqual(["WagerTransactionProcessed"]);
  });

  test("REFUND credits a BET back exactly once", async () => {
    const wallet = await createWallet(api, "100.00");
    await submitWager(api, wallet, { externalTransactionId: "refund-bet", kind: "BET", amount: "40.00" });

    const refund = await submitWager(api, wallet, { kind: "REFUND", amount: "40.00", reference: "refund-bet" });
    expect(refund.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });

    const again = await submitWager(api, wallet, { kind: "REFUND", amount: "40.00", reference: "refund-bet" });
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");

    const rollbackToo = await submitWager(api, wallet, { kind: "ROLLBACK", amount: "40.00", reference: "refund-bet" });
    expect(rollbackToo.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
  });

  test("reversal rules: kind, amount and scope of the reference", async () => {
    const wallet = await createWallet(api, "100.00");
    await submitWager(api, wallet, { externalTransactionId: "rules-bet", kind: "BET", amount: "20.00", roundId: "round-9" });
    await submitWager(api, wallet, { externalTransactionId: "rules-win", kind: "WIN", amount: "20.00", roundId: "round-9" });

    const refundOfWin = await submitWager(api, wallet, { kind: "REFUND", amount: "20.00", reference: "rules-win", roundId: "round-9" });
    expect(refundOfWin.body.failureCode).toBe("REFERENCE_KIND_NOT_ALLOWED");

    const partial = await submitWager(api, wallet, { kind: "REFUND", amount: "19.99", reference: "rules-bet", roundId: "round-9" });
    expect(partial.body.failureCode).toBe("AMOUNT_MISMATCH");

    const otherRound = await submitWager(api, wallet, { kind: "REFUND", amount: "20.00", reference: "rules-bet", roundId: "round-1" });
    expect(otherRound.body.failureCode).toBe("REFERENCE_MISMATCH");
  });

  test("ROLLBACK of a WIN debits it, and an overdrawing reversal has its own failure code", async () => {
    const wallet = await createWallet(api, "0.00");
    await submitWager(api, wallet, { externalTransactionId: "rb-win", kind: "WIN", amount: "30.00" });
    const rollback = await submitWager(api, wallet, { kind: "ROLLBACK", amount: "30.00", reference: "rb-win" });
    expect(rollback.body).toMatchObject({ status: "PROCESSED", balance: { amount: "0.00" } });

    await submitWager(api, wallet, { externalTransactionId: "rb-win-2", kind: "WIN", amount: "30.00" });
    await submitWager(api, wallet, { kind: "BET", amount: "25.00" });
    const overdraw = await submitWager(api, wallet, { kind: "ROLLBACK", amount: "30.00", reference: "rb-win-2" });
    expect(overdraw.status).toBe(422);
    expect(overdraw.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe("5.00");
  });

  test("a ROLLBACK that arrives before its BET waits as PENDING_REFERENCE (202)", async () => {
    const wallet = await createWallet(api, "100.00");
    const early = await submitWager(api, wallet, {
      externalTransactionId: "early-rollback",
      kind: "ROLLBACK",
      amount: "15.00",
      reference: "late-bet",
    });

    expect(early.status).toBe(202);
    expect(early.body).toMatchObject({ status: "PENDING_REFERENCE", balance: { amount: "100.00" } });

    const stored = await api.get(`/wagering/transactions/${early.body.transactionId}`);
    expect(stored.body).toMatchObject({ status: "PENDING_REFERENCE", attempts: 1, referenceExternalTransactionId: "late-bet" });
    expect(stored.body.nextAttemptAt).toBeString();
    expect(await outboxEventTypes(orm, [early.body.transactionId])).toEqual(["WagerTransactionPendingReference"]);
  });
});

describe("queries", () => {
  test("transactions by internal id and by provider id", async () => {
    const wallet = await createWallet(api, "100.00");
    const bet = await submitWager(api, wallet, { externalTransactionId: "query-bet", kind: "BET", amount: "1.00" });

    const byId = await api.get(`/wagering/transactions/${bet.body.transactionId}`);
    const byExternal = await api.get(`/providers/provider-a/wagering/transactions/query-bet`);
    expect(byId.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({ kind: "BET", status: "PROCESSED", money: { amount: "1.00" }, balanceAfter: { amount: "99.00" } });

    expect((await api.get(`/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await api.get(`/providers/provider-a/wagering/transactions/nope`)).status).toBe(404);
  });

  test("the ledger pages newest first with a stable opaque cursor", async () => {
    const wallet = await createWallet(api, "100.00");
    for (let i = 1; i <= 7; i++) await submitWager(api, wallet, { kind: "BET", amount: "1.00" });

    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { status: number; body: { items: { walletVersion: number }[]; nextCursor: string | null } } =
        await api.get(`/wallets/${wallet.id}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.status).toBe(200);
      versions.push(...page.body.items.map((item) => item.walletVersion));
      cursor = page.body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(versions).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect((await api.get(`/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await api.get(`/wallets/${wallet.id}/ledger?limit=500`)).status).toBe(400);
  });

  test("reconciliation compares the stored balance with the ledger", async () => {
    const wallet = await createWallet(api, "100.00");
    await submitWager(api, wallet, { kind: "BET", amount: "30.00" });
    await submitWager(api, wallet, { kind: "WIN", amount: "12.50" });

    const report = await api.post(`/wallets/${wallet.id}/reconciliation`);
    expect(report.status).toBe(200);
    expect(report.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "82.50", currency: "BRL" },
      calculatedBalance: { amount: "82.50", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 3,
    });
  });
});

describe("observability", () => {
  test("correlation ids flow from the request header into the outbox", async () => {
    const wallet: TestWallet = await createWallet(api, "10.00");
    const { idempotencyKey, body } = wagerBody(wallet, { kind: "BET", amount: "1.00" });
    const response = await api.post("/wagering/transactions", body, {
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": "corr-test-123",
    });

    expect(response.headers.get("x-correlation-id")).toBe("corr-test-123");
    const [row] = await orm.em
      .fork()
      .execute<{ correlation_id: string }[]>(
        `select payload->>'correlationId' as correlation_id from outbox_messages where aggregate_id = ?`,
        [response.body.transactionId],
      );
    expect(row?.correlation_id).toBe("corr-test-123");
  });

  test("metrics are exposed for Prometheus", async () => {
    const response = await fetch(`${testApp.baseUrl}/metrics`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('wagering_transactions_total{kind="BET",status="PROCESSED",source="http"}');
    expect(text).toContain("wagering_duplicates_detected_total");
    expect(text).toContain("wagering_processing_duration_seconds_bucket");
  });
});
