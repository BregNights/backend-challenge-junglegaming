import { EntitySchema } from "@mikro-orm/core";

/**
 * Modelos de persistência, separados do domínio de propósito: o ORM hidrata estes
 * registros simples, e os mappers reconstroem os objetos de domínio via
 * `rehydrate`, então o ORM nunca passa por cima das factories do domínio. O schema
 * em si pertence às migrations escritas à mão, não a estas definições.
 */

const money = { type: "decimal", precision: 20, scale: 2, runtimeType: "string" } as const;
const currency = { type: "string", length: 3 } as const;
const timestamp = { type: "datetime" } as const;

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency,
    balance: money,
    version: { type: "integer" },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

export class WagerTransactionRecord {
  id!: string;
  kind!: string;
  status!: string;
  walletId!: string;
  playerId!: string;
  amount!: string;
  currency!: string;
  providerId!: string | null;
  externalTransactionId!: string | null;
  idempotencyKey!: string | null;
  payloadHash!: string | null;
  roundId!: string | null;
  gameId!: string | null;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: string | null;
  balanceAfter!: string | null;
  attempts!: number;
  nextAttemptAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    kind: { type: "string" },
    status: { type: "string" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    amount: money,
    currency,
    providerId: { type: "string", nullable: true },
    externalTransactionId: { type: "string", nullable: true },
    idempotencyKey: { type: "string", nullable: true },
    payloadHash: { type: "string", length: 64, nullable: true },
    roundId: { type: "string", nullable: true },
    gameId: { type: "string", nullable: true },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    failureCode: { type: "string", nullable: true },
    balanceAfter: { ...money, nullable: true },
    attempts: { type: "integer" },
    nextAttemptAt: { ...timestamp, nullable: true },
    createdAt: timestamp,
    updatedAt: timestamp,
    processedAt: { ...timestamp, nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: number;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    walletVersion: { type: "integer" },
    direction: { type: "string" },
    amount: money,
    currency,
    balanceBefore: money,
    balanceAfter: money,
    createdAt: timestamp,
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  messageGroupId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
  lastError!: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    messageGroupId: { type: "string" },
    eventType: { type: "string" },
    payload: { type: "json" },
    occurredAt: timestamp,
    attempts: { type: "integer" },
    nextAttemptAt: timestamp,
    publishedAt: { ...timestamp, nullable: true },
    lastError: { type: "text", nullable: true },
  },
});

export const entitySchemas = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, OutboxMessageSchema];
