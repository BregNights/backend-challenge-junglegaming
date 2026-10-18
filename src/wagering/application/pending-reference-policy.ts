import { addMs, type BackoffPolicy, backoffDelayMs } from "../../shared/domain/backoff";
import type { WagerTransaction } from "../domain/wager-transaction";

/**
 * Providers usually deliver the referenced operation within seconds or minutes.
 * Retries back off from 1 s up to 5 min; after 30 min the dependant transaction
 * stops waiting and is rejected (REFERENCE_NOT_FOUND), instead of staying in
 * limbo indefinitely.
 */
export const PENDING_REFERENCE_RETRY: BackoffPolicy = { baseMs: 1_000, maxMs: 5 * 60_000 };
export const PENDING_REFERENCE_TTL_MS = 30 * 60_000;

export function nextReferenceAttemptAt(transaction: WagerTransaction, now: Date): Date {
  return addMs(now, backoffDelayMs(transaction.attempts + 1, PENDING_REFERENCE_RETRY));
}

export function referenceDeadlinePassed(transaction: WagerTransaction, now: Date): boolean {
  return now.getTime() - transaction.createdAt.getTime() >= PENDING_REFERENCE_TTL_MS;
}
