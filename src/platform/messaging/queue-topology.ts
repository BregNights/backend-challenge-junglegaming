import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { SqsConfig } from "../config/app-config";

export interface QueueUrls {
  readonly wager: string;
  readonly wagerDlq: string;
  readonly events: string;
}

/**
 * Creates (or converges) the queues the service depends on. Idempotent: queues
 * are created with only the immutable `FifoQueue` attribute, and every mutable
 * attribute is applied afterwards, so re-running never fails on drift.
 *
 * In a real AWS account this belongs to infrastructure-as-code; locally it runs
 * as the one-shot `bootstrap` service in docker-compose.
 */
export async function provisionQueues(client: SQSClient, config: SqsConfig): Promise<QueueUrls> {
  const wagerDlq = await ensureFifoQueue(client, config.wagerDlqName, {
    MessageRetentionPeriod: String(14 * 24 * 60 * 60),
  });
  const dlqArn = await getQueueArn(client, wagerDlq);

  const wager = await ensureFifoQueue(client, config.wagerQueueName, {
    VisibilityTimeout: String(config.visibilityTimeoutSeconds),
    ReceiveMessageWaitTimeSeconds: "20",
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: config.maxReceiveCount }),
  });

  const events = await ensureFifoQueue(client, config.eventsQueueName, {
    ReceiveMessageWaitTimeSeconds: "20",
  });

  return { wager, wagerDlq, events };
}

async function ensureFifoQueue(
  client: SQSClient,
  queueName: string,
  attributes: Record<string, string>,
): Promise<string> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: "true" } }),
  );
  if (!QueueUrl) throw new Error(`SQS did not return a URL for queue ${queueName}`);

  await client.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: attributes }));
  return QueueUrl;
}

async function getQueueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
  );
  const arn = Attributes?.QueueArn;
  if (!arn) throw new Error(`SQS did not return an ARN for ${queueUrl}`);
  return arn;
}
