import { LockMode, QueryOrder } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { OutboxMessage } from "../messaging/domain/outbox-message";
import type {
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  TransactionalStore,
  WagerTransactionRepository,
  WalletRepository,
} from "../shared/application/unit-of-work";
import { Money } from "../shared/domain/money";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../wagering/domain/wager-transaction";
import type { Wallet } from "../wallet/domain/wallet";
import type { WalletLedgerEntry } from "../wallet/domain/wallet-ledger-entry";
import {
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  outboxToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from "./mappers";
import { LedgerEntryRecord, OutboxMessageRecord, WagerTransactionRecord, WalletRecord } from "./records";

/**
 * Repositories bound to one transactional EntityManager fork. Writes are
 * registered in the Unit of Work and flushed together when the transaction
 * commits; updates are only allowed for records loaded through this store.
 */
export class MikroOrmStore implements TransactionalStore {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }
}

class MikroOrmWalletRepository implements WalletRepository {
  private readonly loaded = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { id }));
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    // refresh: always hit the database, even if the identity map already holds the row
    return this.track(
      await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true }),
    );
  }

  async findByPlayer(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { playerId, currency }));
  }

  insert(wallet: Wallet): void {
    const record = walletToRecord(wallet, new WalletRecord());
    this.em.persist(record);
    this.loaded.set(wallet.id, record);
  }

  update(wallet: Wallet): void {
    const record = this.loaded.get(wallet.id);
    if (!record) throw new Error(`Wallet ${wallet.id} was not loaded in this unit of work`);
    this.em.persist(walletToRecord(wallet, record));
  }

  private track(record: WalletRecord | null): Wallet | undefined {
    if (!record) return undefined;
    this.loaded.set(record.id, record);
    return walletToDomain(record);
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly loaded = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { id }));
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey }));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }));
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  insert(transaction: WagerTransaction): void {
    const record = transactionToRecord(transaction, new WagerTransactionRecord());
    this.em.persist(record);
    this.loaded.set(transaction.id, record);
  }

  update(transaction: WagerTransaction): void {
    const record = this.loaded.get(transaction.id);
    if (!record) throw new Error(`Transaction ${transaction.id} was not loaded in this unit of work`);
    this.em.persist(transactionToRecord(transaction, record));
  }

  private track(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    if (!record) return undefined;
    this.loaded.set(record.id, record);
    return transactionToDomain(record);
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  insert(entry: WalletLedgerEntry): void {
    this.em.persist(ledgerEntryToRecord(entry, new LedgerEntryRecord()));
  }

  async page(walletId: string, options: { beforeVersion?: number; limit: number }): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      options.beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: options.beforeVersion } },
      { orderBy: { walletVersion: QueryOrder.DESC }, limit: options.limit },
    );
    return records.map(ledgerEntryToDomain);
  }

  async summarize(walletId: string): Promise<LedgerSummary | undefined> {
    const [row] = await this.em.execute<
      { stored_balance: string; calculated_balance: string; currency: string; entries: number }[]
    >(
      `select w.balance as stored_balance,
              w.currency,
              coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20, 2)
                as calculated_balance,
              count(e.id)::int as entries
         from wallets w
         left join wallet_ledger_entries e on e.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!row) return undefined;
    return {
      storedBalance: Money.rehydrate({ amount: row.stored_balance, currency: row.currency }),
      calculatedBalance: Money.rehydrate({ amount: row.calculated_balance, currency: row.currency }),
      entries: Number(row.entries),
    };
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(outboxToRecord(message, new OutboxMessageRecord()));
  }
}
