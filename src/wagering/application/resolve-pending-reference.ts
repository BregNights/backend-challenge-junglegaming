import { Inject, Injectable, Logger } from "@nestjs/common";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { WAGERING_METRICS, type WageringMetrics } from "../../shared/application/metrics";
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from "../../shared/application/ports";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { settleWagerTransaction } from "../domain/wager-settlement";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import { PendingReferencePolicy } from "./pending-reference-policy";
import { eventsForSettlement } from "./settlement-events";

export type ResolutionResult = WagerTransactionStatus | "skipped";

/**
 * Retries one PENDING_REFERENCE transaction: same lock order (wallet first) and
 * same settlement rules as a fresh submission. Once the waiting window is over,
 * a still-missing reference becomes REJECTED / REFERENCE_NOT_FOUND.
 */
@Injectable()
export class ResolvePendingReference {
  private readonly logger = new Logger(ResolvePendingReference.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
    @Inject(PendingReferencePolicy) private readonly policy: PendingReferencePolicy,
  ) {}

  async execute(claim: { id: string; walletId: string }): Promise<ResolutionResult> {
    const result = await this.uow.run(async (store): Promise<ResolutionResult> => {
      const wallet = await store.wallets.lockById(claim.walletId);
      const transaction = wallet ? await store.transactions.findById(claim.id) : undefined;
      // Decided meanwhile by another worker (or it was never ours to decide).
      if (!wallet || !transaction || transaction.status !== WagerTransactionStatus.PendingReference) return "skipped";
      const { providerId, externalTransactionId, referenceExternalTransactionId } = transaction;
      if (!providerId || !externalTransactionId || !referenceExternalTransactionId) return "skipped";

      const now = this.clock.now();
      const reference = await store.transactions.findByExternalId(providerId, referenceExternalTransactionId);
      const referenceAlreadyReversed =
        reference !== undefined && transaction.isReversal() && (await store.transactions.hasProcessedReversal(reference.id));

      const outcome = settleWagerTransaction({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed,
        referenceDeadlinePassed: this.policy.deadlinePassed(transaction, now),
        ledgerEntryId: this.ids.next(),
        now,
        nextAttemptAt: this.policy.nextAttemptAt(transaction, now),
      });

      store.transactions.update(transaction);
      if ("ledgerEntry" in outcome && outcome.ledgerEntry) {
        store.ledger.insert(outcome.ledgerEntry);
        store.wallets.update(wallet);
      }
      // Still waiting: the PendingReference event was emitted on the first attempt only.
      if (outcome.status !== WagerTransactionStatus.PendingReference) {
        const nextContext = () => ({
          eventId: this.ids.next(),
          correlationId: transaction.id,
          causationId: transaction.id,
          occurredAt: now,
        });
        for (const event of eventsForSettlement(transaction, wallet, outcome, nextContext)) {
          store.outbox.add(OutboxMessage.enqueue(event));
        }
      }
      // Chains (ROLLBACK of a REFUND of a late BET) unblock one link at a time.
      if (outcome.status === WagerTransactionStatus.Processed) {
        await store.transactions.expediteWaitingFor(providerId, externalTransactionId, now);
      }

      this.logger.log({
        msg: "pending reference retried",
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId,
        status: transaction.status,
        failureCode: transaction.failureCode,
        attempts: transaction.attempts,
      });
      return transaction.status;
    });

    if (result === WagerTransactionStatus.Processed || result === WagerTransactionStatus.Rejected) {
      this.metrics.transactionDecided({ kind: "pending-reference", status: result, source: "worker" });
    }
    return result;
  }
}
