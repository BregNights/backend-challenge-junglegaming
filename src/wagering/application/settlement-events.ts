import type { EventContext, IntegrationEvent } from "../../shared/domain/integration-event";
import type { Wallet } from "../../wallet/domain/wallet";
import { WalletBalanceChanged } from "../../wallet/domain/wallet-balance-changed";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../domain/wager-events";
import type { SettlementOutcome } from "../domain/wager-settlement";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";

/** Integration events produced by one settlement; each gets its own context (and event id). */
export function eventsForSettlement(
  transaction: WagerTransaction,
  wallet: Wallet,
  outcome: SettlementOutcome,
  nextContext: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      return [
        WagerTransactionProcessed.from(transaction, nextContext()),
        ...(outcome.ledgerEntry ? [WalletBalanceChanged.from(wallet, outcome.ledgerEntry, nextContext())] : []),
      ];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, nextContext())];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(transaction, nextContext())];
  }
}
