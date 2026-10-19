import { randomUUID } from "node:crypto";
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { provisionQueues, type QueueUrls } from "../../src/platform/messaging/queue-topology";
import type { TestWallet } from "./wagering";

export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: "us-east-1",
    endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

export interface TestQueues {
  urls: QueueUrls;
  /** Variáveis de ambiente que apontam uma instância da aplicação para estas filas. */
  env: Record<string, string>;
}

/** Filas exclusivas de uma suíte de testes, para que nenhuma outra instância (ou suíte) roube mensagens. */
export async function createTestQueues(
  sqs: SQSClient,
  options: { visibilityTimeoutSeconds?: number; maxReceiveCount?: number } = {},
): Promise<TestQueues> {
  const prefix = `t${randomUUID().slice(0, 8)}`;
  const config = {
    region: "us-east-1",
    endpoint: undefined,
    wagerQueueName: `${prefix}-wager.fifo`,
    wagerDlqName: `${prefix}-wager-dlq.fifo`,
    eventsQueueName: `${prefix}-events.fifo`,
    maxReceiveCount: options.maxReceiveCount ?? 3,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds ?? 2,
    receiveWaitSeconds: 1,
    retryBaseSeconds: 1,
    retryMaxSeconds: 4,
    consumerConcurrency: 2,
  };
  const urls = await provisionQueues(sqs, config);
  return {
    urls,
    env: {
      SQS_WAGER_QUEUE: config.wagerQueueName,
      SQS_WAGER_DLQ: config.wagerDlqName,
      SQS_EVENTS_QUEUE: config.eventsQueueName,
      SQS_MAX_RECEIVE_COUNT: String(config.maxReceiveCount),
      SQS_VISIBILITY_TIMEOUT_SECONDS: String(config.visibilityTimeoutSeconds),
      SQS_RECEIVE_WAIT_SECONDS: "1",
      SQS_RETRY_BASE_SECONDS: "1",
      SQS_RETRY_MAX_SECONDS: "4",
    },
  };
}

export async function deleteTestQueues(sqs: SQSClient, queues: TestQueues): Promise<void> {
  await Promise.allSettled(Object.values(queues.urls).map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
}

export function wagerEnvelope(wallet: TestWallet, data: { kind: string; amount: string; externalTransactionId?: string; reference?: string }) {
  const externalTransactionId = data.externalTransactionId ?? `msg-tx-${randomUUID()}`;
  return {
    messageId: `msg-${randomUUID()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: data.kind,
      money: { amount: data.amount, currency: "BRL" },
      ...(data.reference ? { referenceExternalTransactionId: data.reference } : {}),
    },
  };
}

/**
 * Envia um corpo cru. O deduplication id é aleatório por padrão, para que os testes
 * possam entregar o mesmo corpo duas vezes, como uma redelivery faria.
 */
export async function sendRaw(sqs: SQSClient, queueUrl: string, body: string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: randomUUID() }),
  );
}

export async function sendEnvelope(sqs: SQSClient, queueUrl: string, envelope: ReturnType<typeof wagerEnvelope>): Promise<void> {
  await sendRaw(sqs, queueUrl, JSON.stringify(envelope), envelope.data.walletId);
}

/** Recebe (e apaga) tudo o que estiver disponível numa fila. */
export async function drainQueue(sqs: SQSClient, queueUrl: string, idleRounds = 2): Promise<Message[]> {
  const received: Message[] = [];
  let idle = 0;
  while (idle < idleRounds) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ["All"],
      }),
    );
    if (Messages.length === 0) {
      idle++;
      continue;
    }
    idle = 0;
    for (const message of Messages) {
      received.push(message);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return received;
}

/** Mensagens visíveis + em andamento + atrasadas de uma fila. */
export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"],
    }),
  );
  return (
    Number(Attributes.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0) +
    Number(Attributes.ApproximateNumberOfMessagesDelayed ?? 0)
  );
}

export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}
