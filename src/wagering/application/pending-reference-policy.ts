import { addMs, type BackoffPolicy, backoffDelayMs } from "../../shared/domain/backoff";
import type { WagerTransaction } from "../domain/wager-transaction";

/**
 * Providers usually deliver the referenced operation within seconds or minutes.
 * Retries back off from 1 s up to 5 min; after the TTL (30 min by default) the
 * dependant transaction stops waiting and is rejected (REFERENCE_NOT_FOUND),
 * instead of staying in limbo indefinitely.
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
