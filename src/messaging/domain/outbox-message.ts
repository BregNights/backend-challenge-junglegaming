import { addMs, type BackoffPolicy, backoffDelayMs } from "../../shared/domain/backoff";
import type { IntegrationEvent } from "../../shared/domain/integration-event";

export const OUTBOX_RETRY_POLICY: BackoffPolicy = { baseMs: 1_000, maxMs: 5 * 60_000 };

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  messageGroupId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

/**
 * An integration event waiting to be published. Written in the same SQL
 * transaction as the change it describes; published afterwards by a worker.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly messageGroupId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  /** The outbox id is the event id, so consumers can deduplicate redeliveries by it. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.partitionKey,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.messageGroupId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
    this._lastError = undefined;
  }

  /** Increments attempts and computes the next attempt with exponential backoff. */
  scheduleRetry(now: Date, error?: string): void {
    this._attempts += 1;
    this._nextAttemptAt = addMs(now, backoffDelayMs(this._attempts, OUTBOX_RETRY_POLICY));
    this._lastError = error;
  }
}
