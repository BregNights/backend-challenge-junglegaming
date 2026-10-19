import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageBatchCommand,
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
 * - mensagens de um grupo (wallet) são tratadas em ordem, grupos em paralelo, com
 *   vários loops de recebimento por réplica (SQS_CONSUMER_CONCURRENCY) e ack em lote;
 * - no shutdown, os long pollings em andamento terminam (em vez de serem abortados),
 *   as mensagens em andamento terminam dentro de um prazo de graça e o que não foi
 *   liquidado é devolvido na hora (visibilidade 0).
 */
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private running = false;
  private loops: Promise<void>[] = [];
  /** Long pollings em andamento, um por loop, para o shutdown abortar. */
  private readonly polls = new Set<AbortController>();
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
    // Vários loops por réplica: mais grupos FIFO (wallets) em andamento ao mesmo tempo. O
    // SQS não entrega mensagens de um grupo com mensagem em voo a outro receptor.
    this.loops = Array.from({ length: this.config.sqs.consumerConcurrency }, () => this.run());
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.loops.length === 0) return;
    // Os long pollings em andamento terminam sozinhos (SQS_RECEIVE_WAIT_SECONDS fica abaixo
    // do prazo de graça) e o que eles trouxerem é devolvido abaixo. Abortar um polling não
    // é seguro: o servidor pode já ter entregado mensagens a ele, que ficariam invisíveis
    // até o visibility timeout sem que tivéssemos os receipt handles para devolvê-las.
    this.running = false;

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.all(this.loops).then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), this.config.workers.shutdownGraceMs);
      }),
    ]);
    // Um timer pendente manteria o processo vivo durante todo o prazo de graça.
    clearTimeout(graceTimer);
    // Último recurso, só se o prazo estourou: o que um polling abortado tiver recebido volta
    // à fila depois do visibility timeout (atrasa, mas não se perde).
    if (!drained) for (const poll of this.polls) poll.abort();
    const handedBack = [...this.unsettled.values()];
    await Promise.allSettled(handedBack.map((message) => this.release(message)));
    this.logger.log({ msg: "consumer stopped", drained, handedBack: handedBack.length });
  }

  private async run(): Promise<void> {
    while (this.running) {
      const poll = new AbortController();
      this.polls.add(poll);
      try {
        const { wager } = await this.urls();
        const { Messages = [] } = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: wager,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.sqs.receiveWaitSeconds,
            // As duas grafias: a legada é a que alguns emuladores ainda respeitam.
            AttributeNames: ["All"],
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
          { abortSignal: poll.signal },
        );
        for (const message of Messages) {
          if (message.ReceiptHandle) this.unsettled.set(message.ReceiptHandle, message);
        }
        await this.handleBatch(Messages);
      } catch (error) {
        if (!this.running) break; // long polling abortado pelo shutdown
        this.logger.error({ msg: "receive failed", error: describe(error) });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      } finally {
        this.polls.delete(poll);
      }
    }
  }

  /**
   * Semântica FIFO: um grupo (wallet) em ordem, grupos diferentes em paralelo. As
   * mensagens cujo commit aconteceu recebem ack juntas, num DeleteMessageBatch.
   */
  private async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    const committed: Message[] = [];
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (!this.running) return; // não iniciada: devolvida no shutdown
          if ((await this.handle(message)) === "committed") committed.push(message);
        }
      }),
    );
    await this.ackBatch(committed);
  }

  /** "committed": processada e aguardando ack; "settled": já resolvida com a fila (retry ou DLQ). */
  private async handle(message: Message): Promise<"committed" | "settled"> {
    let envelope: Envelope;
    try {
      envelope = parseInput(envelopeSchema, JSON.parse(message.Body ?? ""), "message");
    } catch (error) {
      await this.deadLetter(message, "invalid-message", describe(error), {});
      return "settled";
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
      return "committed";
    } catch (error) {
      if (PERMANENT_ERRORS.some((type) => error instanceof type)) {
        await this.deadLetter(message, "permanent-error", describe(error), context);
        return "settled";
      }
      // Transitório ou inesperado: mantém a mensagem; a redrive policy limita as tentativas.
      await this.retryLater(message, error, context);
      return "settled";
    }
  }

  /** Ack em lote, só de mensagens com commit feito. Uma falha aqui vira redelivery, absorvida pela inbox. */
  private async ackBatch(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    try {
      const { wager } = await this.urls();
      const response = await this.sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: wager,
          Entries: messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
        }),
      );
      for (const entry of response.Failed ?? []) {
        this.logger.warn({ msg: "ack failed after commit; redelivery will be deduplicated", code: entry.Code, detail: entry.Message });
      }
    } catch (error) {
      this.logger.warn({ msg: "ack failed after commit; redelivery will be deduplicated", count: messages.length, error: describe(error) });
    }
    for (const message of messages) this.settled(message);
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
