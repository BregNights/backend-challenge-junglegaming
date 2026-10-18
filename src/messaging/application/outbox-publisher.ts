import { Inject, Injectable, Logger } from "@nestjs/common";
import { WAGERING_METRICS, type WageringMetrics } from "../../shared/application/metrics";
import { CLOCK, type Clock, FAULT_INJECTOR, type FaultInjector } from "../../shared/application/ports";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import type { OutboxMessage } from "../domain/outbox-message";

export interface PublishResult {
  published: ReadonlySet<string>;
  /** Id da mensagem → motivo. */
  failed: ReadonlyMap<string, string>;
}

export const EVENT_PUBLISHER = Symbol("EventPublisher");
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}

/**
 * Publica as mensagens vencidas da outbox. O lote é reivindicado com FOR UPDATE
 * SKIP LOCKED, então publishers concorrentes (um por instância) pegam lotes
 * disjuntos; os locks de linha são liberados pelo commit, ou pelo Postgres quando
 * um publisher morre. A entrega é at-least-once: um crash depois de publicar e
 * antes do commit publica de novo, e os consumidores deduplicam por eventId.
 */
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
    @Inject(FAULT_INJECTOR) private readonly faults: FaultInjector,
  ) {}

  /** Publica um lote; devolve quantas mensagens foram reivindicadas. */
  async publishBatch(limit: number): Promise<number> {
    const claimed = await this.uow.run(async (store) => {
      const now = this.clock.now();
      const messages = await store.outbox.claimDue(now, limit);
      if (messages.length === 0) return 0;

      const result = await this.publisher.publish(messages).catch(
        (error): PublishResult => ({
          published: new Set(),
          failed: new Map(messages.map((message) => [message.id, error instanceof Error ? error.message : String(error)])),
        }),
      );
      this.faults.crashIf("crash-after-publish");

      for (const message of messages) {
        if (result.published.has(message.id)) message.markPublished(now);
        else message.scheduleRetry(now, result.failed.get(message.id) ?? "not acknowledged by the broker");
        await store.outbox.saveDeliveryState(message);
      }

      this.metrics.outboxPublished(result.published.size);
      if (result.failed.size > 0) {
        this.metrics.outboxPublishFailed(messages.length - result.published.size);
        this.logger.warn({ msg: "outbox publication failed", failed: messages.length - result.published.size });
      }
      return messages.length;
    });

    const backlog = await this.uow.run((store) => store.outbox.backlog(this.clock.now()));
    this.metrics.outboxBacklog(backlog.pending, backlog.oldestAgeSeconds);
    return claimed;
  }
}
