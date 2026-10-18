export type ProcessingSource = "http" | "sqs" | "worker";
export type DuplicateKind = "idempotency-replay" | "inbox";

export const WAGERING_METRICS = Symbol("WageringMetrics");

/** Port for operational metrics; implemented with Prometheus in the platform layer. */
export interface WageringMetrics {
  transactionDecided(labels: { kind: string; status: string; source: ProcessingSource }): void;
  duplicateDetected(kind: DuplicateKind): void;
  processingObserved(seconds: number, labels: { source: ProcessingSource; outcome: string }): void;
  /** Lock wait timeouts and deadlocks: contention signal on hot wallets. */
  lockConflict(reason: "lock-timeout" | "deadlock"): void;
  reconciliationChecked(consistent: boolean): void;
}
