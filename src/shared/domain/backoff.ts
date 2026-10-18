export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

/**
 * Backoff exponencial sem jitter: base * 2^(attempt - 1), com teto. É
 * determinístico para que os agendamentos sejam testáveis; quem disputa o mesmo
 * recurso adiciona jitter por conta própria.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  return Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs);
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
