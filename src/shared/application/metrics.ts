export type ProcessingSource = "http" | "sqs" | "worker";
export type DuplicateKind = "idempotency-replay" | "inbox";

export const WAGERING_METRICS = Symbol("WageringMetrics");

/** Porta para métricas operacionais; implementada com Prometheus na camada de plataforma. */
export interface WageringMetrics {
  transactionDecided(labels: { kind: string; status: string; source: ProcessingSource }): void;
  duplicateDetected(kind: DuplicateKind): void;
  processingObserved(seconds: number, labels: { source: ProcessingSource; outcome: string }): void;
  /** Lock timeouts e deadlocks: sinal de contenção em wallets disputadas. */
  lockConflict(reason: "lock-timeout" | "deadlock"): void;
  reconciliationChecked(consistent: boolean): void;
  /** Mensagem devolvida à fila depois de uma falha transitória. */
  messageRetried(): void;
  messageDeadLettered(reason: "invalid-message" | "permanent-error"): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(count: number): void;
  outboxBacklog(pending: number, oldestAgeSeconds: number): void;
}
