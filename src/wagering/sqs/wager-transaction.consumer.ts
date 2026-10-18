import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { z } from "zod";
import { AppConfig } from "../../platform/config/app-config";
import { parseInput } from "../../platform/http/validation";
import { canonicalJson } from "../../shared/application/canonical-json";
import {
  IdempotencyConflictError,
  InboxConflictError,
  ValidationError,
  WalletNotFoundError,
} from "../../shared/application/errors";
import { WAGERING_METRICS, type WageringMetrics } from "../../shared/application/metrics";
import { FAULT_INJECTOR, type FaultInjector } from "../../shared/application/ports";
import { InvalidMoneyError } from "../../shared/domain/money";
import { InvalidWagerTransactionError } from "../domain/wager-transaction";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import { idempotencyKeySchema, wagerRequestSchema } from "../wager-request.schema";

export const CONSUMER_NAME = "wager-transactions-consumer";

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.iso.datetime({ offset: true }),
  data: wagerRequestSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});
type Envelope = z.infer<typeof envelopeSchema>;

/** Tentar de novo não resolve estes: a mensagem vai direto para a DLQ. */
const PERMANENT_ERRORS = [
  ValidationError,
  InvalidMoneyError,
  InvalidWagerTransactionError,
  IdempotencyConflictError,
  WalletNotFoundError,
  InboxConflictError,
];

interface QueueUrls {
  wager: string;
  dlq: string;
}

/**
 * Consome `wager-transactions.fifo` com o mesmo use case da API HTTP.
 *
 * - ack (delete) só depois do commit da transação SQL;
 * - rejeições de negócio são decisões: persistidas e com ack, nunca retentadas;
 * - falhas transitórias: a mensagem é devolvida com backoff exponencial de
 *   visibilidade; o SQS a move para a DLQ depois de maxReceiveCount (redrive policy);
 * - falhas permanentes (mensagem inválida, wallet inexistente, payload em conflito):
 *   enviadas explicitamente para a DLQ, depois ack;
 * - mensagens de um grupo (wallet) são tratadas em ordem, grupos em paralelo;
 * - no shutdown, as mensagens em andamento terminam dentro de um prazo de graça e
 *   o que não foi liquidado é devolvido na hora (visibilidade 0).
 */
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private poll: AbortController | undefined;
  private queueUrls: Promise<QueueUrls> | undefined;
  /** Recebidas e ainda não liquidadas com a fila (ack, retry ou DLQ), por receipt handle. */
  private readonly unsettled = new Map<string, Message>();

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(ProcessWagerTransaction) private readonly processWagerTransaction: ProcessWagerTransaction,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
    @Inject(FAULT_INJECTOR) private readonly faults: FaultInjector,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.runs("sqs-consumer")) return;
    this.running = true;
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.loop) return;
    this.running = false;
    this.poll?.abort();

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      this.loop.then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), this.config.workers.shutdownGraceMs);
      }),
    ]);
    // Um timer pendente manteria o processo vivo durante todo o prazo de graça.
    clearTimeout(graceTimer);
    const handedBack = [...this.unsettled.values()];
    await Promise.allSettled(handedBack.map((message) => this.release(message)));
    this.logger.log({ msg: "consumer stopped", drained, handedBack: handedBack.length });
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const { wager } = await this.urls();
        this.poll = new AbortController();
        const { Messages = [] } = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: wager,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.sqs.receiveWaitSeconds,
            // As duas grafias: a legada é a que alguns emuladores ainda respeitam.
            AttributeNames: ["All"],
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
          { abortSignal: this.poll.signal },
        );
        for (const message of Messages) {
          if (message.ReceiptHandle) this.unsettled.set(message.ReceiptHandle, message);
        }
        await this.handleBatch(Messages);
      } catch (error) {
        if (!this.running) break; // long polling abortado pelo shutdown
        this.logger.error({ msg: "receive failed", error: describe(error) });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  /** Semântica FIFO: um grupo (wallet) em ordem, grupos diferentes em paralelo. */
  private async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (!this.running) return; // não iniciada: devolvida no shutdown
          await this.handle(message);
        }
      }),
    );
  }

  private async handle(message: Message): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = parseInput(envelopeSchema, JSON.parse(message.Body ?? ""), "message");
    } catch (error) {
      return this.deadLetter(message, "invalid-message", describe(error), {});
    }

    const { idempotencyKey, ...data } = envelope.data;
    const context = { messageId: envelope.messageId, providerId: data.providerId, walletId: data.walletId };
    try {
      await this.processWagerTransaction.executeFromMessage(
        { ...data, idempotencyKey, correlationId: envelope.messageId, causationId: envelope.messageId, source: "sqs" },
        {
          consumerName: CONSUMER_NAME,
          messageId: envelope.messageId,
          payloadHash: createHash("sha256").update(canonicalJson(envelope)).digest("hex"),
        },
      );
      this.faults.crashIf("crash-after-commit");
      await this.ack(message, context);
    } catch (error) {
      if (PERMANENT_ERRORS.some((type) => error instanceof type)) {
        return this.deadLetter(message, "permanent-error", describe(error), context);
      }
      // Transitório ou inesperado: mantém a mensagem; a redrive policy limita as tentativas.
      await this.retryLater(message, error, context);
    }
  }

  private async ack(message: Message, context: Record<string, string>): Promise<void> {
    try {
      const { wager } = await this.urls();
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: wager, ReceiptHandle: message.ReceiptHandle }));
      this.settled(message);
    } catch (error) {
      // Commit já feito: uma redelivery é absorvida pela inbox.
      this.logger.warn({ msg: "ack failed after commit; redelivery will be deduplicated", ...context, error: describe(error) });
    }
  }

  private async retryLater(message: Message, error: unknown, context: Record<string, string>): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const { retryBaseSeconds, retryMaxSeconds } = this.config.sqs;
    const delaySeconds = Math.min(retryBaseSeconds * 2 ** (receiveCount - 1), retryMaxSeconds);
    try {
      const { wager } = await this.urls();
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: wager,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      );
    } catch (visibilityError) {
      // Fica valendo o visibility timeout da fila.
      this.logger.warn({ msg: "could not reschedule message", ...context, error: describe(visibilityError) });
    }
    this.settled(message);
    this.metrics.messageRetried();
    this.logger.warn({ msg: "message processing failed, will retry", ...context, receiveCount, delaySeconds, error: describe(error) });
  }

  private async deadLetter(
    message: Message,
    reason: "invalid-message" | "permanent-error",
    detail: string,
    context: Record<string, string>,
  ): Promise<void> {
    try {
      const { wager, dlq } = await this.urls();
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: dlq,
          MessageBody: message.Body ?? "",
          MessageGroupId: message.Attributes?.MessageGroupId ?? "invalid",
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            failureReason: { DataType: "String", StringValue: reason },
            failureDetail: { DataType: "String", StringValue: detail.slice(0, 1_000) },
          },
        }),
      );
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: wager, ReceiptHandle: message.ReceiptHandle }));
      this.settled(message);
      this.metrics.messageDeadLettered(reason);
      this.logger.error({ msg: "message sent to DLQ", ...context, reason, detail });
    } catch (error) {
      // Não foi possível movê-la: melhor mantê-la na fila do que perdê-la.
      await this.retryLater(message, error, context);
    }
  }

  private async release(message: Message): Promise<void> {
    const { wager } = await this.urls();
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: wager, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
    );
    this.settled(message);
  }

  private settled(message: Message): void {
    if (message.ReceiptHandle) this.unsettled.delete(message.ReceiptHandle);
  }

  private urls(): Promise<QueueUrls> {
    this.queueUrls ??= Promise.all([
      this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueueName })),
      this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerDlqName })),
    ])
      .then(([wager, dlq]) => {
        if (!wager.QueueUrl || !dlq.QueueUrl) throw new Error("Wager queues not found");
        return { wager: wager.QueueUrl, dlq: dlq.QueueUrl };
      })
      .catch((error) => {
        this.queueUrls = undefined;
        throw error;
      });
    return this.queueUrls;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
