import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import type { EventPublisher, PublishResult } from "../../messaging/application/outbox-publisher";
import type { OutboxMessage } from "../../messaging/domain/outbox-message";
import { AppConfig } from "../config/app-config";

/**
 * Publishes outbox messages to the events FIFO queue: MessageGroupId keeps the
 * events of one wallet in order, MessageDeduplicationId (the event id) lets SQS
 * drop republished duplicates within its deduplication window.
 */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(AppConfig) private readonly config: AppConfig,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const response = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.resolveQueueUrl(),
        Entries: messages.map((message, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.messageGroupId,
          MessageDeduplicationId: message.id,
          MessageAttributes: { eventType: { DataType: "String", StringValue: message.eventType } },
        })),
      }),
    );

    const published = new Set<string>();
    const failed = new Map<string, string>();
    for (const entry of response.Successful ?? []) {
      const message = messages[Number(entry.Id)];
      if (message) published.add(message.id);
    }
    for (const entry of response.Failed ?? []) {
      const message = messages[Number(entry.Id)];
      if (message) failed.set(message.id, `${entry.Code}: ${entry.Message ?? ""}`);
    }
    return { published, failed };
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.config.sqs.eventsQueueName }))
      .then(({ QueueUrl }) => {
        if (!QueueUrl) throw new Error(`Queue ${this.config.sqs.eventsQueueName} not found`);
        return QueueUrl;
      })
      .catch((error) => {
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }
}
