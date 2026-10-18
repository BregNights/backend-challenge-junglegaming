import type { MoneyProps } from "../../shared/domain/money";
import type { FailureCode } from "../domain/failure-code";
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";

/** Resposta de uma submissão, idêntica para a requisição original e seus replays. */
export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado quando a transação foi decidida (o saldo atual, enquanto pendente). */
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface WagerTransactionView {
  transactionId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  walletId: string;
  playerId: string;
  money: MoneyProps;
  providerId?: string;
  externalTransactionId?: string;
  roundId?: string;
  gameId?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balanceAfter?: MoneyProps;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  processedAt?: string;
}

export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    transactionId: transaction.id,
    kind: transaction.kind,
    status: transaction.status,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    money: transaction.money.toJSON(),
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    balanceAfter: transaction.balanceAfter?.toJSON(),
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt?.toISOString(),
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString(),
  };
}
