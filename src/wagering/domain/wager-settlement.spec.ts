import { describe, expect, test } from "bun:test";
import { Money } from "../../shared/domain/money";
import { LedgerDirection } from "../../wallet/domain/ledger-direction";
import { Wallet } from "../../wallet/domain/wallet";
import { FailureCode } from "./failure-code";
import { settleWagerTransaction, type SettlementInput } from "./wager-settlement";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "./wager-transaction";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-18T12:00:00.000Z");
const retryAt = new Date(at.getTime() + 1_000);
let sequence = 0;

function wallet(balance: string): Wallet {
  return Wallet.rehydrate({
    id: "wallet-1",
    playerId: "player-1",
    currency: "BRL",
    balance: brl(balance),
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
}

function tx(kind: Kind, amount: string, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${++sequence}`;
  return WagerTransaction.create({
    id: `tx-${sequence}`,
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: "a".repeat(64),
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl(amount),
    createdAt: at,
    ...overrides,
  });
}

/** A transaction that already went through settlement successfully. */
function processed(kind: Kind, amount: string, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const transaction = tx(kind, amount, overrides);
  transaction.markProcessed(overrides.referenceExternalTransactionId ? "ref-id" : undefined, brl("0.00"), at);
  return transaction;
}

function settle(transaction: WagerTransaction, target: Wallet, overrides: Partial<SettlementInput> = {}) {
  return settleWagerTransaction({
    transaction,
    wallet: target,
    reference: undefined,
    referenceAlreadyReversed: false,
    referenceDeadlinePassed: false,
    ledgerEntryId: `entry-${++sequence}`,
    now: at,
    nextAttemptAt: retryAt,
    ...overrides,
  });
}

function expectRejected(outcome: ReturnType<typeof settle>, transaction: WagerTransaction, code: FailureCode) {
  expect(outcome).toEqual({ status: Status.Rejected, failureCode: code });
  expect(transaction.status).toBe(Status.Rejected);
  expect(transaction.failureCode).toBe(code);
}

describe("BET", () => {
  test("debits the wallet and produces one DEBIT entry", () => {
    const target = wallet("100.00");
    const bet = tx(Kind.Bet, "80.00");
    const outcome = settle(bet, target);

    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) return;
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(target.balance.toJSON().amount).toBe("20.00");
    expect(bet.balanceAfter?.toJSON().amount).toBe("20.00");
  });

  test("is rejected with INSUFFICIENT_FUNDS and leaves the wallet untouched", () => {
    const target = wallet("100.00");
    const bet = tx(Kind.Bet, "100.01");
    expectRejected(settle(bet, target), bet, FailureCode.InsufficientFunds);
    expect(target.balance.toJSON().amount).toBe("100.00");
    expect(target.version).toBe(1);
    expect(bet.balanceAfter?.toJSON().amount).toBe("100.00");
  });

  test("currency and player must match the wallet", () => {
    const usdBet = tx(Kind.Bet, "1.00", { money: Money.from({ amount: "1.00", currency: "USD" }) });
    expectRejected(settle(usdBet, wallet("100.00")), usdBet, FailureCode.CurrencyMismatch);

    const foreignBet = tx(Kind.Bet, "1.00", { playerId: "someone-else" });
    expectRejected(settle(foreignBet, wallet("100.00")), foreignBet, FailureCode.PlayerWalletMismatch);
  });
});

describe("WIN and LOSS", () => {
  test("WIN credits the wallet", () => {
    const target = wallet("10.00");
    const outcome = settle(tx(Kind.Win, "15.00"), target);
    expect(outcome.status).toBe(Status.Processed);
    expect(target.balance.toJSON().amount).toBe("25.00");
  });

  test("WIN referencing a processed BET of the same round resolves it", () => {
    const bet = processed(Kind.Bet, "10.00");
    const win = tx(Kind.Win, "30.00", { referenceExternalTransactionId: bet.externalTransactionId });
    settle(win, wallet("0.00"), { reference: bet });
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test("LOSS records the result without moving the balance or the version", () => {
    const target = wallet("10.00");
    const loss = tx(Kind.Loss, "0.00");
    const outcome = settle(loss, target);

    expect(outcome).toEqual({ status: Status.Processed, ledgerEntry: undefined });
    expect(target.balance.toJSON().amount).toBe("10.00");
    expect(target.version).toBe(1);
    expect(loss.balanceAfter?.toJSON().amount).toBe("10.00");
  });
});

describe("REFUND", () => {
  test("credits back a processed BET", () => {
    const bet = processed(Kind.Bet, "40.00");
    const target = wallet("60.00");
    const refund = tx(Kind.Refund, "40.00", { referenceExternalTransactionId: bet.externalTransactionId });

    const outcome = settle(refund, target, { reference: bet });
    expect(outcome.status).toBe(Status.Processed);
    expect(target.balance.toJSON().amount).toBe("100.00");
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test("only once", () => {
    const bet = processed(Kind.Bet, "40.00");
    const refund = tx(Kind.Refund, "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expectRejected(
      settle(refund, wallet("60.00"), { reference: bet, referenceAlreadyReversed: true }),
      refund,
      FailureCode.ReferenceAlreadyReversed,
    );
  });

  test("only of a BET", () => {
    const win = processed(Kind.Win, "40.00");
    const refund = tx(Kind.Refund, "40.00", { referenceExternalTransactionId: win.externalTransactionId });
    expectRejected(settle(refund, wallet("60.00"), { reference: win }), refund, FailureCode.ReferenceKindNotAllowed);
  });

  test("for exactly the referenced amount", () => {
    const bet = processed(Kind.Bet, "40.00");
    const refund = tx(Kind.Refund, "39.99", { referenceExternalTransactionId: bet.externalTransactionId });
    expectRejected(settle(refund, wallet("60.00"), { reference: bet }), refund, FailureCode.AmountMismatch);
  });

  test("within the same round, wallet and player", () => {
    const bet = processed(Kind.Bet, "40.00", { roundId: "round-1" });
    for (const overrides of [{ roundId: "round-2" }, { playerId: "player-2" }, { providerId: "provider-b" }]) {
      const refund = tx(Kind.Refund, "40.00", { referenceExternalTransactionId: bet.externalTransactionId, ...overrides });
      const target = Wallet.rehydrate({
        id: "wallet-1",
        playerId: refund.playerId,
        currency: "BRL",
        balance: brl("0.00"),
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      expectRejected(settle(refund, target, { reference: bet }), refund, FailureCode.ReferenceMismatch);
    }
  });

  test("of a rejected BET is rejected as REFERENCE_NOT_PROCESSED", () => {
    const bet = tx(Kind.Bet, "40.00");
    bet.reject(FailureCode.InsufficientFunds, brl("0.00"), at);
    const refund = tx(Kind.Refund, "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expectRejected(settle(refund, wallet("0.00"), { reference: bet }), refund, FailureCode.ReferenceNotProcessed);
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits it back", () => {
    const bet = processed(Kind.Bet, "25.00");
    const target = wallet("75.00");
    const rollback = tx(Kind.Rollback, "25.00", { referenceExternalTransactionId: bet.externalTransactionId });

    const outcome = settle(rollback, target, { reference: bet });
    expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(target.balance.toJSON().amount).toBe("100.00");
  });

  test.each([Kind.Win, Kind.Refund])("of a %s debits it back", (kind) => {
    const reference = processed(kind, "30.00", kind === Kind.Refund ? { referenceExternalTransactionId: "bet" } : {});
    const target = wallet("50.00");
    const rollback = tx(Kind.Rollback, "30.00", { referenceExternalTransactionId: reference.externalTransactionId });

    const outcome = settle(rollback, target, { reference });
    expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(target.balance.toJSON().amount).toBe("20.00");
  });

  test("that would overdraw is rejected with a code distinct from a BET without funds", () => {
    const win = processed(Kind.Win, "30.00");
    const target = wallet("10.00");
    const rollback = tx(Kind.Rollback, "30.00", { referenceExternalTransactionId: win.externalTransactionId });

    expectRejected(settle(rollback, target, { reference: win }), rollback, FailureCode.ReversalInsufficientFunds);
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(target.balance.toJSON().amount).toBe("10.00");
  });

  test("of a LOSS or of another ROLLBACK is not allowed", () => {
    const loss = processed(Kind.Loss, "0.00");
    const rollbackOfLoss = tx(Kind.Rollback, "1.00", { referenceExternalTransactionId: loss.externalTransactionId });
    expectRejected(settle(rollbackOfLoss, wallet("10.00"), { reference: loss }), rollbackOfLoss, FailureCode.ReferenceKindNotAllowed);

    const previous = processed(Kind.Rollback, "5.00", { referenceExternalTransactionId: "bet" });
    const rollbackOfRollback = tx(Kind.Rollback, "5.00", { referenceExternalTransactionId: previous.externalTransactionId });
    expectRejected(
      settle(rollbackOfRollback, wallet("10.00"), { reference: previous }),
      rollbackOfRollback,
      FailureCode.ReferenceKindNotAllowed,
    );
  });
});

describe("out-of-order references", () => {
  test("a missing reference parks the transaction as PENDING_REFERENCE without touching the wallet", () => {
    const target = wallet("10.00");
    const rollback = tx(Kind.Rollback, "5.00", { referenceExternalTransactionId: "not-arrived-yet" });

    expect(settle(rollback, target)).toEqual({ status: Status.PendingReference });
    expect(rollback.status).toBe(Status.PendingReference);
    expect(rollback.attempts).toBe(1);
    expect(rollback.nextAttemptAt).toEqual(retryAt);
    expect(target.version).toBe(1);
  });

  test("a reference that is itself still waiting keeps the dependant waiting", () => {
    const refund = tx(Kind.Refund, "5.00", { referenceExternalTransactionId: "bet-not-arrived" });
    refund.markPendingReference(retryAt, at);
    const rollback = tx(Kind.Rollback, "5.00", { referenceExternalTransactionId: refund.externalTransactionId });

    expect(settle(rollback, wallet("10.00"), { reference: refund })).toEqual({ status: Status.PendingReference });
  });

  test("once the waiting window is over, a missing reference is REFERENCE_NOT_FOUND", () => {
    const rollback = tx(Kind.Rollback, "5.00", { referenceExternalTransactionId: "never-arrived" });
    rollback.markPendingReference(retryAt, at);
    expectRejected(settle(rollback, wallet("10.00"), { referenceDeadlinePassed: true }), rollback, FailureCode.ReferenceNotFound);
  });

  test("a parked transaction is processed once its reference arrives", () => {
    const rollback = tx(Kind.Rollback, "25.00", { referenceExternalTransactionId: "late-bet" });
    settle(rollback, wallet("75.00"));
    expect(rollback.status).toBe(Status.PendingReference);

    const bet = processed(Kind.Bet, "25.00", { externalTransactionId: "late-bet" });
    const target = wallet("75.00");
    expect(settle(rollback, target, { reference: bet }).status).toBe(Status.Processed);
    expect(target.balance.toJSON().amount).toBe("100.00");
  });
});
