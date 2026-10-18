export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

/**
 * Exponential backoff without jitter: base * 2^(attempt - 1), capped. Kept
 * deterministic so schedules are testable; callers that compete for the same
 * resource add jitter themselves.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  return Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs);
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
