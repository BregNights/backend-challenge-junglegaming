import { describe, expect, test } from "bun:test";
import { Money } from "../../shared/domain/money";
import { LedgerDirection } from "../../wallet/domain/ledger-direction";
import { FailureCode } from "./failure-code";
import {
  type CreateWagerTransactionProps,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "./wager-transaction";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-18T12:00:00.000Z");

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "a".repeat(64),
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: brl("25.00"),
    createdAt: at,
    ...overrides,
  };
}

describe("WagerTransaction.create", () => {
  test("is born PENDING with no attempts", () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe(Status.Pending);
    expect(tx.attempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
  });

  test("OPENING cannot be submitted", () => {
    expect(() => WagerTransaction.create(props({ kind: Kind.Opening }))).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s requires a reference", (kind) => {
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(/requires referenceExternalTransactionId/);
    expect(WagerTransaction.create(props({ kind, referenceExternalTransactionId: "bet-1" })).requiresReference()).toBe(true);
  });

  test.each([Kind.Bet, Kind.Loss])("%s cannot carry a reference", (kind) => {
    expect(() => WagerTransaction.create(props({ kind, referenceExternalTransactionId: "x" }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("WIN may or may not reference a BET", () => {
    expect(WagerTransaction.create(props({ kind: Kind.Win })).referenceExternalTransactionId).toBeUndefined();
    expect(
      WagerTransaction.create(props({ kind: Kind.Win, referenceExternalTransactionId: "bet-1" })).referenceExternalTransactionId,
    ).toBe("bet-1");
  });

  test("a transaction cannot reference itself", () => {
    expect(() =>
      WagerTransaction.create(props({ kind: Kind.Refund, referenceExternalTransactionId: "ext-1" })),
    ).toThrow(/cannot reference itself/);
  });

  test("only LOSS accepts a zero amount", () => {
    expect(WagerTransaction.create(props({ kind: Kind.Loss, money: brl("0.00") })).status).toBe(Status.Pending);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(() => WagerTransaction.create(props({ kind, money: brl("0.00") }))).toThrow(/greater than zero/);
    }
  });
});

describe("transitions", () => {
  test("PENDING → PROCESSED records the reference and the balance snapshot", () => {
    const tx = WagerTransaction.create(props({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" }));
    tx.markProcessed("bet-internal-id", brl("100.00"), at);

    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe("bet-internal-id");
    expect(tx.balanceAfter?.toJSON().amount).toBe("100.00");
    expect(tx.processedAt).toEqual(at);
  });

  test("a reversal cannot be processed without its reference", () => {
    const tx = WagerTransaction.create(props({ kind: Kind.Rollback, referenceExternalTransactionId: "bet-1" }));
    expect(() => tx.markProcessed(undefined, brl("1.00"), at)).toThrow(InvalidTransactionStateError);
  });

  test("PENDING_REFERENCE counts attempts and can still be decided", () => {
    const tx = WagerTransaction.create(props({ kind: Kind.Rollback, referenceExternalTransactionId: "bet-1" }));
    const later = new Date(at.getTime() + 1_000);
    tx.markPendingReference(later, at);
    tx.markPendingReference(later, at);

    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.attempts).toBe(2);
    expect(tx.nextAttemptAt).toEqual(later);

    tx.reject(FailureCode.ReferenceNotFound, brl("10.00"), later);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test("only transactions with a reference can wait for one", () => {
    expect(() => WagerTransaction.create(props()).markPendingReference(at, at)).toThrow(InvalidTransactionStateError);
  });

  test.each([
    ["PROCESSED", (tx: WagerTransaction) => tx.markProcessed(undefined, brl("1.00"), at)],
    ["REJECTED", (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, brl("1.00"), at)],
    ["FAILED", (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed, at)],
  ])("%s is terminal: every further transition throws", (_, decide) => {
    const tx = WagerTransaction.create(props({ kind: Kind.Win, referenceExternalTransactionId: "bet-1" }));
    decide(tx);
    expect(tx.isTerminal()).toBe(true);

    expect(() => tx.markProcessed(undefined, brl("1.00"), at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(at, at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, brl("1.00"), at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingFailed, at)).toThrow(InvalidTransactionStateError);
  });
});

describe("domain queries", () => {
  test("matchesPayload compares the business payload hash", () => {
    const tx = WagerTransaction.create(props());
    expect(tx.matchesPayload("a".repeat(64))).toBe(true);
    expect(tx.matchesPayload("b".repeat(64))).toBe(false);
  });

  test("affectsBalance is false only for LOSS", () => {
    expect(WagerTransaction.create(props({ kind: Kind.Loss, money: brl("0.00") })).affectsBalance()).toBe(false);
    expect(WagerTransaction.create(props()).affectsBalance()).toBe(true);
  });

  test("ledger direction per kind; ROLLBACK inverts its reference", () => {
    const bet = WagerTransaction.create(props());
    const win = WagerTransaction.create(props({ kind: Kind.Win }));
    const refund = WagerTransaction.create(props({ kind: Kind.Refund, referenceExternalTransactionId: "b" }));
    const loss = WagerTransaction.create(props({ kind: Kind.Loss, money: brl("0.00") }));
    const rollback = WagerTransaction.create(props({ kind: Kind.Rollback, referenceExternalTransactionId: "b" }));

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(loss.ledgerDirectionFor()).toBeUndefined();
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor(loss)).toThrow(InvalidTransactionStateError);
  });

  test("the internal OPENING transaction is born processed", () => {
    const opening = WagerTransaction.opening({ id: "o", walletId: "w", playerId: "p", money: brl("10.00"), at });
    expect(opening.status).toBe(Status.Processed);
    expect(opening.providerId).toBeUndefined();
    expect(opening.balanceAfter?.toJSON().amount).toBe("10.00");
  });
});
