import { describe, expect, test } from "bun:test";
import { Money } from "../../shared/domain/money";
import { Wallet } from "../../wallet/domain/wallet";
import { WalletBalanceChanged } from "../../wallet/domain/wallet-balance-changed";
import { OutboxMessage } from "./outbox-message";

const at = new Date("2026-10-18T12:00:00.000Z");

function balanceChanged() {
  const { wallet, openingEntry } = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    at,
    opening: { transactionId: "opening-1", entryId: "entry-1" },
  });
  return WalletBalanceChanged.from(wallet, openingEntry!, {
    eventId: "event-1",
    correlationId: "corr-1",
    occurredAt: at,
  });
}

describe("IntegrationEvent envelope", () => {
  test("serializes type and version from the class, money as decimal strings", () => {
    expect(JSON.parse(JSON.stringify(balanceChanged()))).toEqual({
      eventId: "event-1",
      eventType: "WalletBalanceChanged",
      aggregateId: "wallet-1",
      correlationId: "corr-1",
      occurredAt: "2026-10-18T12:00:00.000Z",
      version: 1,
      data: {
        walletId: "wallet-1",
        transactionId: "opening-1",
        direction: "CREDIT",
        money: { amount: "100.00", currency: "BRL" },
        balanceBefore: { amount: "0.00", currency: "BRL" },
        balanceAfter: { amount: "100.00", currency: "BRL" },
        walletVersion: 1,
      },
    });
  });
});

describe("OutboxMessage", () => {
  test("enqueue uses the event id as message id and the wallet as ordering group", () => {
    const message = OutboxMessage.enqueue(balanceChanged());
    expect(message.id).toBe("event-1");
    expect(message.messageGroupId).toBe("wallet-1");
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at)).toBe(true);
  });

  test("scheduleRetry backs off exponentially up to a cap", () => {
    const message = OutboxMessage.enqueue(balanceChanged());
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
      message.scheduleRetry(at, "broker unavailable");
      delays.push(message.nextAttemptAt.getTime() - at.getTime());
    }
    expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(delays.at(-1)).toBe(300_000);
    expect(message.attempts).toBe(12);
    expect(message.lastError).toBe("broker unavailable");
    expect(message.isDue(at)).toBe(false);
  });

  test("markPublished takes it out of the pending set", () => {
    const message = OutboxMessage.enqueue(balanceChanged());
    message.markPublished(at);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 60_000))).toBe(false);
  });
});
