import { Inject, Injectable, Logger } from "@nestjs/common";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import {
  IdempotencyConflictError,
  InboxConflictError,
  UniqueConstraintConflict,
  WalletNotFoundError,
} from "../../shared/application/errors";
import { type ProcessingSource, WAGERING_METRICS, type WageringMetrics } from "../../shared/application/metrics";
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from "../../shared/application/ports";
import { type TransactionalStore, UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { Money, type MoneyProps } from "../../shared/domain/money";
import type { Wallet } from "../../wallet/domain/wallet";
import { settleWagerTransaction } from "../domain/wager-settlement";
import { type ProviderKind, WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import { hashWagerPayload } from "./payload-hash";
import { PendingReferencePolicy } from "./pending-reference-policy";
import { eventsForSettlement } from "./settlement-events";
import type { WagerTransactionResult } from "./views";

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ProviderKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
  source: ProcessingSource;
}

/** Transport message being consumed; recorded in the inbox inside the same SQL transaction. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export type MessageProcessingOutcome =
  | { duplicateMessage: true }
  | { duplicateMessage: false; result: WagerTransactionResult };

type ProcessOutcome = { kind: "duplicate-message" } | { kind: "result"; result: WagerTransactionResult };

/** Losing one of these races means a concurrent duplicate committed first. */
const IDEMPOTENCY_CONSTRAINTS: ReadonlySet<string> = new Set(["wager_tx_idempotency_uq", "wager_tx_external_id_uq"]);
const MAX_RACE_ATTEMPTS = 3;

/**
 * The single entry point for provider operations, shared by HTTP and SQS.
 *
 * Inside one SQL transaction: [inbox] → dedupe by idempotency key → lock the
 * wallet row → re-check under the lock → settle → persist transaction, ledger
 * entry, wallet and outbox events together. Nothing is acknowledged before the
 * commit.
 */
@Injectable()
export class ProcessWagerTransaction {
  private readonly logger = new Logger(ProcessWagerTransaction.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
    @Inject(PendingReferencePolicy) private readonly pendingReferences: PendingReferencePolicy,
  ) {}

  /** HTTP entry point. */
  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const outcome = await this.run(command, undefined);
    if (outcome.kind !== "result") throw new Error("Unreachable: duplicate message without an inbox");
    return outcome.result;
  }

  /** SQS entry point: same use case, plus inbox deduplication by (consumerName, messageId). */
  async executeFromMessage(command: ProcessWagerTransactionCommand, inbox: InboxContext): Promise<MessageProcessingOutcome> {
    const outcome = await this.run(command, inbox);
    return outcome.kind === "result" ? { duplicateMessage: false, result: outcome.result } : { duplicateMessage: true };
  }

  private async run(command: ProcessWagerTransactionCommand, inbox: InboxContext | undefined): Promise<ProcessOutcome> {
    const startedAt = performance.now();
    let label = "error";
    try {
      const money = Money.from(command.money);
      const payloadHash = hashWagerPayload({ ...command, money });
      const outcome = await this.runWithRaceRetry(command, money, payloadHash, inbox);
      label = outcome.kind === "duplicate-message" ? "duplicate-message" : outcome.result.idempotentReplay ? "replay" : outcome.result.status;
      this.record(command, outcome);
      return outcome;
    } finally {
      this.metrics.processingObserved((performance.now() - startedAt) / 1_000, { source: command.source, outcome: label });
    }
  }

  private async runWithRaceRetry(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    inbox: InboxContext | undefined,
  ): Promise<ProcessOutcome> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run((store) => this.process(store, command, money, payloadHash, inbox));
      } catch (error) {
        // Same key, different wallet lock: the unique constraint picked a winner.
        // The next attempt finds it and answers with a replay or a conflict.
        const lostIdempotencyRace =
          error instanceof UniqueConstraintConflict && IDEMPOTENCY_CONSTRAINTS.has(error.constraint ?? "");
        if (lostIdempotencyRace && attempt < MAX_RACE_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  private async process(
    store: TransactionalStore,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    inbox: InboxContext | undefined,
  ): Promise<ProcessOutcome> {
    if (inbox) {
      const now = this.clock.now();
      const message = InboxMessage.receive({ ...inbox, receivedAt: now });
      message.markProcessed(now);
      const registration = await store.inbox.register(message);
      if (registration === "duplicate") return { kind: "duplicate-message" };
      if (registration === "conflict") {
        throw new InboxConflictError(`Message ${inbox.messageId} was already consumed with a different body`);
      }
    }

    // Fast path: a decided duplicate is answered without queueing on the wallet lock.
    const duplicate = await store.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (duplicate) return { kind: "result", result: await this.replay(store, duplicate, payloadHash) };

    const wallet = await store.wallets.lockById(command.walletId);
    if (!wallet) throw new WalletNotFoundError(command.walletId);

    // Re-check under the lock: a duplicate may have committed while we waited for it.
    const raced = await store.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (raced) return { kind: "result", result: await this.replay(store, raced, payloadHash, wallet) };

    if (await store.transactions.findByExternalId(command.providerId, command.externalTransactionId)) {
      throw new IdempotencyConflictError(
        `externalTransactionId ${command.externalTransactionId} is already registered under a different Idempotency-Key`,
      );
    }

    const now = this.clock.now();
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    // The reference, if valid, lives in this wallet: the lock we hold keeps it stable.
    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await store.transactions.findByExternalId(command.providerId, transaction.referenceExternalTransactionId);
    const referenceAlreadyReversed =
      reference !== undefined && transaction.isReversal() && (await store.transactions.hasProcessedReversal(reference.id));

    const outcome = settleWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      referenceDeadlinePassed: false,
      ledgerEntryId: this.ids.next(),
      now,
      nextAttemptAt: this.pendingReferences.nextAttemptAt(transaction, now),
    });

    store.transactions.insert(transaction);
    if ("ledgerEntry" in outcome && outcome.ledgerEntry) {
      store.ledger.insert(outcome.ledgerEntry);
      store.wallets.update(wallet);
    }
    const nextContext = () => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    });
    for (const event of eventsForSettlement(transaction, wallet, outcome, nextContext)) {
      store.outbox.add(OutboxMessage.enqueue(event));
    }
    // Anything parked waiting for this transaction can be retried right away.
    if (transaction.status === WagerTransactionStatus.Processed) {
      await store.transactions.expediteWaitingFor(command.providerId, command.externalTransactionId, now);
    }

    return {
      kind: "result",
      result: {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
        idempotentReplay: false,
      },
    };
  }

  /** Same key: identical payload → the original result; anything else → conflict, never a replay. */
  private async replay(
    store: TransactionalStore,
    existing: WagerTransaction,
    payloadHash: string,
    lockedWallet?: Wallet,
  ): Promise<WagerTransactionResult> {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(`Idempotency-Key ${existing.idempotencyKey} was already used with a different payload`);
    }
    // Decided transactions answer with the balance observed back then; pending ones with today's.
    const balance =
      existing.balanceAfter ?? (lockedWallet ?? (await store.wallets.findById(existing.walletId)))?.balance;
    if (!balance) throw new Error(`Wallet ${existing.walletId} of transaction ${existing.id} not found`);

    return {
      transactionId: existing.id,
      status: existing.status,
      balance: balance.toJSON(),
      ...(existing.failureCode ? { failureCode: existing.failureCode } : {}),
      idempotentReplay: true,
    };
  }

  /** Metrics and logs only after commit, so they never describe a rolled-back decision. */
  private record(command: ProcessWagerTransactionCommand, outcome: ProcessOutcome): void {
    if (outcome.kind === "duplicate-message") {
      this.metrics.duplicateDetected("inbox");
      this.logger.log({ msg: "duplicate message ignored", messageId: command.causationId, providerId: command.providerId });
      return;
    }
    const { result } = outcome;
    if (result.idempotentReplay) {
      this.metrics.duplicateDetected("idempotency-replay");
    } else {
      this.metrics.transactionDecided({ kind: command.kind, status: result.status, source: command.source });
    }
    this.logger.log({
      msg: result.idempotentReplay ? "wager transaction replayed" : "wager transaction decided",
      correlationId: command.correlationId,
      ...(command.source === "sqs" ? { messageId: command.causationId } : {}),
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      kind: command.kind,
      status: result.status,
      failureCode: result.failureCode,
    });
  }
}
