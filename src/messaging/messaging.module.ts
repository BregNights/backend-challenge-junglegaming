import { Module } from "@nestjs/common";
import { SqsEventPublisher } from "../platform/messaging/sqs-event-publisher";
import { EVENT_PUBLISHER, OutboxPublisher } from "./application/outbox-publisher";
import { OutboxPublisherWorker } from "./workers/outbox-publisher.worker";

@Module({
  providers: [{ provide: EVENT_PUBLISHER, useClass: SqsEventPublisher }, OutboxPublisher, OutboxPublisherWorker],
})
export class MessagingModule {}
