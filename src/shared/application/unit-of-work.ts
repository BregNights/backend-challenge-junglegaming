import type { OutboxMessage } from "../../messaging/domain/outbox-message";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import type { Wallet } from "../../wallet/domain/wallet";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import type { Money } from "../domain/money";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE: serializes every balance change of this wallet until commit. */
  lockById(id: string): Promise<Wallet | undefined>;
  findByPlayer(playerId: string, currency: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): void;
  /** Persists balance/version of a wallet loaded through this store. */
  update(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND/ROLLBACK already reverts this transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): void;
  update(transaction: WagerTransaction): void;
}

export interface LedgerSummary {
  storedBalance: Money;
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): void;
  /** Newest first. `beforeVersion` is an exclusive, stable cursor (entries are immutable). */
  page(walletId: string, options: { beforeVersion?: number; limit: number }): Promise<WalletLedgerEntry[]>;
  /** Stored balance and ledger-derived balance, read in a single statement (one snapshot). */
  summarize(walletId: string): Promise<LedgerSummary | undefined>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
}

/** Repositories bound to one SQL transaction. */
export interface TransactionalStore {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
}

export const UNIT_OF_WORK = Symbol("UnitOfWork");

export interface UnitOfWork {
  /**
   * Runs `work` in one SQL transaction; everything registered on the store is
   * flushed and committed together, or nothing is. Database failures surface as
   * `TransientInfrastructureError` or `UniqueConstraintConflict`.
   */
  run<T>(work: (store: TransactionalStore) => Promise<T>): Promise<T>;
}
