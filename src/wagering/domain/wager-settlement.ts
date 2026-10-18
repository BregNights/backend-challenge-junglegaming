import type { Wallet } from "../../wallet/domain/wallet";
import { LedgerDirection } from "../../wallet/domain/ledger-direction";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import {
  InvalidTransactionStateError,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";

/** Kinds que cada operação pode referenciar. ROLLBACK reverte uma movimentação de saldo; REFUND, só uma BET. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface SettlementInput {
  /** Uma transação não terminal da `wallet`. */
  transaction: WagerTransaction;
  /** Travada por quem chama durante toda a liquidação. */
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined quando ausente. */
  reference: WagerTransaction | undefined;
  /** Se um REFUND/ROLLBACK PROCESSED já reverte a `reference`. */
  referenceAlreadyReversed: boolean;
  /** A janela de espera pela referência acabou: parar de esperar e rejeitar. */
  referenceDeadlinePassed: boolean;
  /** Id do lançamento no ledger, se algum for produzido. */
  ledgerEntryId: string;
  now: Date;
  /** Quando tentar de novo, se a transação tiver de esperar pela referência. */
  nextAttemptAt: Date;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; ledgerEntry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

type ReferenceResolution =
  | { kind: "resolved"; reference: WagerTransaction }
  | { kind: "wait"; reason: "missing" | "unsettled" }
  | { kind: "reject"; code: FailureCode };

/**
 * Aplica as regras de negócio de uma operação de aposta a uma wallet travada.
 * Lógica de domínio pura: muta a transação e a wallet pelas transições delas e
 * devolve o que quem chama precisa persistir.
 */
export function settleWagerTransaction(input: SettlementInput): SettlementOutcome {
  const { transaction, wallet, now } = input;

  if (transaction.walletId !== wallet.id) {
    throw new InvalidTransactionStateError(`Transaction ${transaction.id} does not belong to wallet ${wallet.id}`);
  }

  const reject = (code: FailureCode): SettlementOutcome => {
    transaction.reject(code, wallet.balance, now);
    return { status: WagerTransactionStatus.Rejected, failureCode: code };
  };

  if (transaction.playerId !== wallet.playerId) return reject(FailureCode.PlayerWalletMismatch);
  if (transaction.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

  let reference: WagerTransaction | undefined;
  if (transaction.referenceExternalTransactionId !== undefined) {
    const resolution = resolveReference(transaction, input.reference, input.referenceAlreadyReversed);
    switch (resolution.kind) {
      case "reject":
        return reject(resolution.code);
      case "wait":
        if (input.referenceDeadlinePassed) {
          return reject(resolution.reason === "missing" ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessed);
        }
        transaction.markPendingReference(input.nextAttemptAt, now);
        return { status: WagerTransactionStatus.PendingReference };
      case "resolved":
        reference = resolution.reference;
    }
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === undefined) {
    transaction.markProcessed(reference?.id, wallet.balance, now);
    return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined };
  }

  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    return reject(
      transaction.kind === WagerTransactionKind.Rollback ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds,
    );
  }

  const movement = { entryId: input.ledgerEntryId, transactionId: transaction.id, money: transaction.money, at: now };
  const ledgerEntry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  transaction.markProcessed(reference?.id, wallet.balance, now);
  return { status: WagerTransactionStatus.Processed, ledgerEntry };
}

function resolveReference(
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
  alreadyReversed: boolean,
): ReferenceResolution {
  if (reference === undefined) return { kind: "wait", reason: "missing" };

  const sameScope =
    reference.providerId === transaction.providerId &&
    reference.walletId === transaction.walletId &&
    reference.playerId === transaction.playerId &&
    reference.roundId === transaction.roundId &&
    reference.money.currency === transaction.money.currency;
  if (!sameScope) return { kind: "reject", code: FailureCode.ReferenceMismatch };

  if (!ALLOWED_REFERENCE_KINDS[transaction.kind]?.includes(reference.kind)) {
    return { kind: "reject", code: FailureCode.ReferenceKindNotAllowed };
  }

  if (!reference.isTerminal()) return { kind: "wait", reason: "unsettled" };
  if (reference.status !== WagerTransactionStatus.Processed) {
    return { kind: "reject", code: FailureCode.ReferenceNotProcessed };
  }

  if (transaction.isReversal()) {
    // Reversão parcial está fora do escopo: a reversão precisa espelhar a referência exatamente.
    if (!reference.money.equals(transaction.money)) return { kind: "reject", code: FailureCode.AmountMismatch };
    if (alreadyReversed) return { kind: "reject", code: FailureCode.ReferenceAlreadyReversed };
  }

  return { kind: "resolved", reference };
}
