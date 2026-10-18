import { OutboxMessage } from "../messaging/domain/outbox-message";
import { Money } from "../shared/domain/money";
import type { FailureCode } from "../wagering/domain/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../wagering/domain/wager-transaction";
import type { LedgerDirection } from "../wallet/domain/ledger-direction";
import { Wallet } from "../wallet/domain/wallet";
import { WalletLedgerEntry } from "../wallet/domain/wallet-ledger-entry";
import type { LedgerEntryRecord, OutboxMessageRecord, WagerTransactionRecord, WalletRecord } from "./records";

/** numeric(20, 2) arrives as an exact decimal string; it never goes through `number`. */
const money = (amount: string, currency: string) => Money.rehydrate({ amount, currency });
const optional = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecord(wallet: Wallet, record: WalletRecord): WalletRecord {
  record.id = wallet.id;
  record.playerId = wallet.playerId;
  record.currency = wallet.currency;
  record.balance = wallet.balance.toJSON().amount;
  record.version = wallet.version;
  record.createdAt = wallet.createdAt;
  record.updatedAt = wallet.updatedAt;
  return record;
}

export function transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    kind: record.kind as WagerTransactionKind,
    status: record.status as WagerTransactionStatus,
    walletId: record.walletId,
    playerId: record.playerId,
    money: money(record.amount, record.currency),
    providerId: optional(record.providerId),
    externalTransactionId: optional(record.externalTransactionId),
    idempotencyKey: optional(record.idempotencyKey),
    payloadHash: optional(record.payloadHash),
    roundId: optional(record.roundId),
    gameId: optional(record.gameId),
    referenceExternalTransactionId: optional(record.referenceExternalTransactionId),
    referenceTransactionId: optional(record.referenceTransactionId),
    failureCode: optional(record.failureCode) as FailureCode | undefined,
    balanceAfter: record.balanceAfter === null ? undefined : money(record.balanceAfter, record.currency),
    attempts: record.attempts,
    nextAttemptAt: optional(record.nextAttemptAt),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    processedAt: optional(record.processedAt),
  });
}

export function transactionToRecord(transaction: WagerTransaction, record: WagerTransactionRecord): WagerTransactionRecord {
  record.id = transaction.id;
  record.kind = transaction.kind;
  record.status = transaction.status;
  record.walletId = transaction.walletId;
  record.playerId = transaction.playerId;
  record.amount = transaction.money.toJSON().amount;
  record.currency = transaction.money.currency;
  record.providerId = transaction.providerId ?? null;
  record.externalTransactionId = transaction.externalTransactionId ?? null;
  record.idempotencyKey = transaction.idempotencyKey ?? null;
  record.payloadHash = transaction.payloadHash ?? null;
  record.roundId = transaction.roundId ?? null;
  record.gameId = transaction.gameId ?? null;
  record.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
  record.referenceTransactionId = transaction.referenceTransactionId ?? null;
  record.failureCode = transaction.failureCode ?? null;
  record.balanceAfter = transaction.balanceAfter?.toJSON().amount ?? null;
  record.attempts = transaction.attempts;
  record.nextAttemptAt = transaction.nextAttemptAt ?? null;
  record.createdAt = transaction.createdAt;
  record.updatedAt = transaction.updatedAt;
  record.processedAt = transaction.processedAt ?? null;
  return record;
}

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    walletVersion: record.walletVersion,
    direction: record.direction as LedgerDirection,
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    createdAt: record.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry, record: LedgerEntryRecord): LedgerEntryRecord {
  record.id = entry.id;
  record.walletId = entry.walletId;
  record.transactionId = entry.transactionId;
  record.walletVersion = entry.walletVersion;
  record.direction = entry.direction;
  record.amount = entry.money.toJSON().amount;
  record.currency = entry.money.currency;
  record.balanceBefore = entry.balanceBefore.toJSON().amount;
  record.balanceAfter = entry.balanceAfter.toJSON().amount;
  record.createdAt = entry.createdAt;
  return record;
}

export function outboxToDomain(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    messageGroupId: record.messageGroupId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    publishedAt: optional(record.publishedAt),
    lastError: optional(record.lastError),
  });
}

export function outboxToRecord(message: OutboxMessage, record: OutboxMessageRecord): OutboxMessageRecord {
  record.id = message.id;
  record.aggregateId = message.aggregateId;
  record.messageGroupId = message.messageGroupId;
  record.eventType = message.eventType;
  record.payload = { ...message.payload };
  record.occurredAt = message.occurredAt;
  record.attempts = message.attempts;
  record.nextAttemptAt = message.nextAttemptAt;
  record.publishedAt = message.publishedAt ?? null;
  record.lastError = message.lastError ?? null;
  return record;
}
