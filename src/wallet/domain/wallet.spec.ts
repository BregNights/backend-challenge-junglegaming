import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "../../shared/domain/money";
import { LedgerDirection } from "./ledger-direction";
import { InsufficientFundsError, InvalidWalletOperationError, Wallet } from "./wallet";
import { InvalidLedgerEntryError, WalletLedgerEntry } from "./wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-18T12:00:00.000Z");
let sequence = 0;
const movement = (amount: string) => ({ entryId: `entry-${++sequence}`, transactionId: `tx-${sequence}`, money: brl(amount), at });

function openWallet(initialBalance: string) {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initialBalance),
    at,
    opening: { transactionId: "opening-1", entryId: "entry-opening" },
  });
}

describe("Wallet.open", () => {
  test("a positive initial balance produces the OPENING credit at version 1", () => {
    const { wallet, openingEntry } = openWallet("1000.00");

    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe("opening-1");
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe("1000.00");
  });

  test("a zero initial balance opens at version 1 without a ledger entry", () => {
    const { wallet, openingEntry } = openWallet("0.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test("the wallet currency is the initial balance currency", () => {
    const { wallet } = Wallet.open({
      id: "w",
      playerId: "p",
      initialBalance: Money.from({ amount: "5.00", currency: "USD" }),
      at,
      opening: { transactionId: "t", entryId: "e" },
    });
    expect(wallet.currency).toBe("USD");
  });
});

describe("balance movements", () => {
  test("each movement returns exactly one balanced entry and bumps the version by one", () => {
    const { wallet } = openWallet("100.00");

    const debit = wallet.debit(movement("80.00"));
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(debit).toBeInstanceOf(WalletLedgerEntry);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.walletVersion).toBe(2);
    expect(debit.balanceBefore.toJSON().amount).toBe("100.00");
    expect(debit.balanceAfter.toJSON().amount).toBe("20.00");
    expect(debit.isBalanced()).toBe(true);

    const credit = wallet.credit(movement("5.50"));
    expect(wallet.balance.toJSON().amount).toBe("25.50");
    expect(wallet.version).toBe(3);
    expect(credit.balanceBefore.equals(debit.balanceAfter)).toBe(true);
  });

  test("a debit can consume the whole balance but never more", () => {
    const { wallet } = openWallet("100.00");
    wallet.debit(movement("100.00"));
    expect(wallet.balance.isZero()).toBe(true);

    expect(() => wallet.debit(movement("0.01"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test("rejects movements in another currency without changing state", () => {
    const { wallet } = openWallet("100.00");
    const usd = { ...movement("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) };

    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd.money)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects zero movements: a balance change always has a positive ledger amount", () => {
    const { wallet } = openWallet("100.00");
    expect(() => wallet.credit(movement("0.00"))).toThrow(InvalidWalletOperationError);
    expect(() => wallet.debit(movement("0.00"))).toThrow(InvalidWalletOperationError);
    expect(wallet.version).toBe(1);
  });

  test("rehydrate restores persisted state as is", () => {
    const wallet = Wallet.rehydrate({
      id: "w",
      playerId: "p",
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe("42.00");
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "e",
    walletId: "w",
    transactionId: "t",
    walletVersion: 2,
    direction: LedgerDirection.Debit,
    money: brl("30.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("70.00"),
    createdAt: at,
  };

  test("create verifies the arithmetic of the entry", () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("80.00") })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(InvalidLedgerEntryError);
  });

  test("create rejects zero amounts, negative balances and invalid versions", () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: brl("0.00"), balanceAfter: brl("100.00") })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl("10.00"), balanceAfter: brl("10.00").subtract(brl("30.00")) }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, walletVersion: 0 })).toThrow(InvalidLedgerEntryError);
  });

  test("is structurally immutable", () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { money: Money }).money = brl("1.00");
    }).toThrow(TypeError);
  });
});
