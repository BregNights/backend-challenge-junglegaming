import { type EventContext, IntegrationEvent } from "../../shared/domain/integration-event";
import type { MoneyProps } from "../../shared/domain/money";
import type { FailureCode } from "./failure-code";
import type { WagerTransaction } from "./wager-transaction";

interface TransactionIdentity {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

function identityOf(transaction: WagerTransaction): TransactionIdentity {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId ?? "",
    externalTransactionId: transaction.externalTransactionId ?? "",
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? "",
    gameId: transaction.gameId ?? "",
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

function requireBalanceAfter(transaction: WagerTransaction): MoneyProps {
  if (transaction.balanceAfter === undefined) throw new Error(`Transaction ${transaction.id} has no balance snapshot`);
  return transaction.balanceAfter.toJSON();
}

export interface WagerTransactionProcessedData extends TransactionIdentity {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Any applied provider transaction, LOSS included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        ...(transaction.referenceTransactionId ? { referenceTransactionId: transaction.referenceTransactionId } : {}),
        balanceAfter: requireBalanceAfter(transaction),
        processedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }

  get partitionKey(): string {
    return this.data.walletId;
  }
}

export interface WagerTransactionRejectedData extends TransactionIdentity {
  failureCode: FailureCode;
  balanceAfter: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (transaction.failureCode === undefined) throw new Error(`Transaction ${transaction.id} has no failure code`);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        failureCode: transaction.failureCode,
        balanceAfter: requireBalanceAfter(transaction),
      },
    });
  }

  get partitionKey(): string {
    return this.data.walletId;
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionIdentity {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (transaction.referenceExternalTransactionId === undefined || transaction.nextAttemptAt === undefined) {
      throw new Error(`Transaction ${transaction.id} is not waiting for a reference`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        attempts: transaction.attempts,
        nextAttemptAt: transaction.nextAttemptAt.toISOString(),
      },
    });
  }

  get partitionKey(): string {
    return this.data.walletId;
  }
}
