import { Inject, Injectable, Logger } from "@nestjs/common";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import {
  IdempotencyConflictError,
  UniqueConstraintConflict,
  WalletNotFoundError,
} from "../../shared/application/errors";
import { type ProcessingSource, WAGERING_METRICS, type WageringMetrics } from "../../shared/application/metrics";
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from "../../shared/application/ports";
import { type TransactionalStore, UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { Money, type MoneyProps } from "../../shared/domain/money";
import type { Wallet } from "../../wallet/domain/wallet";
import { settleWagerTransaction } from "../domain/wager-settlement";
import { type ProviderKind, WagerTransaction } from "../domain/wager-transaction";
import { hashWagerPayload } from "./payload-hash";
import { nextReferenceAttemptAt } from "./pending-reference-policy";
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

/** Losing one of these races means a concurrent duplicate committed first. */
const IDEMPOTENCY_CONSTRAINTS: ReadonlySet<string> = new Set(["wager_tx_idempotency_uq", "wager_tx_external_id_uq"]);
const MAX_RACE_ATTEMPTS = 3;

/**
 * The single entry point for provider operations, shared by HTTP and SQS.
 *
 * Inside one SQL transaction: dedupe by idempotency key → lock the wallet row →
 * re-check under the lock → settle → persist transaction, ledger entry, wallet
 * and outbox events together. Nothing is acknowledged before the commit.
 */
@Injectable()
export class ProcessWagerTransaction {
  private readonly logger = new Logger(ProcessWagerTransaction.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const startedAt = performance.now();
    let outcome = "error";
    try {
      const money = Money.from(command.money);
      const payloadHash = hashWagerPayload({ ...command, money });
      const result = await this.executeWithRaceRetry(command, money, payloadHash);
      outcome = result.idempotentReplay ? "replay" : result.status;
      this.record(command, result);
      return result;
    } finally {
      this.metrics.processingObserved((performance.now() - startedAt) / 1_000, { source: command.source, outcome });
    }
  }

  private async executeWithRaceRetry(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<WagerTransactionResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run((store) => this.process(store, command, money, payloadHash));
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
  ): Promise<WagerTransactionResult> {
    // Fast path: a decided duplicate is answered without queueing on the wallet lock.
    const duplicate = await store.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (duplicate) return this.replay(store, duplicate, payloadHash);

    const wallet = await store.wallets.lockById(command.walletId);
    if (!wallet) throw new WalletNotFoundError(command.walletId);

    // Re-check under the lock: a duplicate may have committed while we waited for it.
    const raced = await store.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (raced) return this.replay(store, raced, payloadHash, wallet);

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
      nextAttemptAt: nextReferenceAttemptAt(transaction, now),
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

    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      idempotentReplay: false,
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
  private record(command: ProcessWagerTransactionCommand, result: WagerTransactionResult): void {
    if (result.idempotentReplay) {
      this.metrics.duplicateDetected("idempotency-replay");
    } else {
      this.metrics.transactionDecided({ kind: command.kind, status: result.status, source: command.source });
    }
    this.logger.log({
      msg: result.idempotentReplay ? "wager transaction replayed" : "wager transaction decided",
      correlationId: command.correlationId,
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      kind: command.kind,
      status: result.status,
      failureCode: result.failureCode,
    });
  }
}
