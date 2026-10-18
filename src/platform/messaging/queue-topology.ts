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
 * Cria (ou converge) as filas de que o serviço depende. Idempotente: as filas são
 * criadas só com o atributo imutável `FifoQueue`, e todo atributo mutável é
 * aplicado depois, então rodar de novo nunca falha por divergência.
 *
 * Numa conta AWS real isso pertence à infraestrutura como código; localmente roda
 * no serviço one-shot `bootstrap` do docker-compose.
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
