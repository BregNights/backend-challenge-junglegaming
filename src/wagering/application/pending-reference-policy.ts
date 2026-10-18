import { addMs, type BackoffPolicy, backoffDelayMs } from "../../shared/domain/backoff";
import type { WagerTransaction } from "../domain/wager-transaction";

/**
 * Provedores costumam entregar a operação referenciada em segundos ou minutos.
 * As novas tentativas fazem backoff de 1 s até 5 min; depois do TTL (30 min por
 * padrão) a transação dependente para de esperar e é rejeitada
 * (REFERENCE_NOT_FOUND), em vez de ficar no limbo indefinidamente.
 */
export class PendingReferencePolicy {
  constructor(
    readonly retry: BackoffPolicy,
    readonly ttlMs: number,
  ) {}

  nextAttemptAt(transaction: WagerTransaction, now: Date): Date {
    return addMs(now, backoffDelayMs(transaction.attempts + 1, this.retry));
  }

  deadlinePassed(transaction: WagerTransaction, now: Date): boolean {
    return now.getTime() - transaction.createdAt.getTime() >= this.ttlMs;
  }
}

export const PENDING_REFERENCE_RETRY: BackoffPolicy = { baseMs: 1_000, maxMs: 5 * 60_000 };
