import { Injectable } from "@nestjs/common";
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";
import type { DuplicateKind, ProcessingSource, WageringMetrics } from "../../shared/application/metrics";

@Injectable()
export class PrometheusMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Wager transactions decided, by kind, final status and entry point",
    labelNames: ["kind", "status", "source"],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: "wagering_duplicates_detected_total",
    help: "Duplicates absorbed: idempotent replays and inbox redeliveries",
    labelNames: ["kind"],
    registers: [this.registry],
  });

  private readonly processing = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "End-to-end processing latency of a wager operation",
    labelNames: ["source", "outcome"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Wallet lock wait timeouts and deadlocks",
    labelNames: ["reason"],
    registers: [this.registry],
  });

  private readonly reconciliations = new Counter({
    name: "wagering_reconciliations_total",
    help: "Reconciliation checks, by result (consistent | divergent)",
    labelNames: ["result"],
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: "wagering_messages_retried_total",
    help: "SQS messages handed back to the queue after a transient failure",
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: "wagering_messages_dead_lettered_total",
    help: "SQS messages sent to the DLQ by the consumer (redrive by maxReceiveCount is counted by SQS)",
    labelNames: ["reason"],
    registers: [this.registry],
  });

  private readonly outboxDeliveries = new Counter({
    name: "wagering_outbox_deliveries_total",
    help: "Outbox publication attempts, by result",
    labelNames: ["result"],
    registers: [this.registry],
  });

  private readonly outboxPending = new Gauge({
    name: "wagering_outbox_pending",
    help: "Unpublished outbox events",
    registers: [this.registry],
  });

  private readonly outboxLag = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox event",
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  messageRetried(): void {
    this.retries.inc();
  }

  messageDeadLettered(reason: "invalid-message" | "permanent-error"): void {
    this.deadLetters.inc({ reason });
  }

  outboxPublished(count: number): void {
    this.outboxDeliveries.inc({ result: "published" }, count);
  }

  outboxPublishFailed(count: number): void {
    this.outboxDeliveries.inc({ result: "failed" }, count);
  }

  outboxBacklog(pending: number, oldestAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(oldestAgeSeconds);
  }

  transactionDecided(labels: { kind: string; status: string; source: ProcessingSource }): void {
    this.transactions.inc(labels);
  }

  duplicateDetected(kind: DuplicateKind): void {
    this.duplicates.inc({ kind });
  }

  processingObserved(seconds: number, labels: { source: ProcessingSource; outcome: string }): void {
    this.processing.observe(labels, seconds);
  }

  lockConflict(reason: "lock-timeout" | "deadlock"): void {
    this.lockConflicts.inc({ reason });
  }

  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? "consistent" : "divergent" });
  }
}
