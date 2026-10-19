import { LockMode, QueryOrder } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxMessage } from "../messaging/domain/inbox-message";
import { OutboxMessage } from "../messaging/domain/outbox-message";
import type {
  InboxRegistration,
  InboxRepository,
  LedgerRepository,
  LedgerSummary,
  OutboxBacklog,
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
 * Repositórios ligados a um fork transacional do EntityManager. As escritas são
 * registradas no Unit of Work e vão juntas no flush do commit; updates só são
 * permitidos para registros carregados por este store.
 */
export class MikroOrmStore implements TransactionalStore {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
  }
}

class MikroOrmWalletRepository implements WalletRepository {
  private readonly loaded = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { id }));
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    // refresh: sempre vai ao banco, mesmo que o identity map já tenha a linha
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

  async claimDuePendingReferences(now: Date, leaseUntil: Date, limit: number): Promise<{ id: string; walletId: string }[]> {
    const rows = await this.em.execute<{ id: string; wallet_id: string }[]>(
      `update wager_transactions t
          set next_attempt_at = ?
         from (select id
                 from wager_transactions
                where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
                order by next_attempt_at
                limit ?
                  for update skip locked) due
        where t.id = due.id
    returning t.id, t.wallet_id`,
      [leaseUntil, now, limit],
    );
    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id }));
  }

  async expediteWaitingFor(providerId: string, externalTransactionId: string, now: Date): Promise<void> {
    await this.em.execute(
      `update wager_transactions
          set next_attempt_at = ?
        where status = 'PENDING_REFERENCE'
          and provider_id = ?
          and reference_external_transaction_id = ?
          and next_attempt_at > ?`,
      [now, providerId, externalTransactionId, now],
    );
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

interface OutboxRow {
  id: string;
  aggregate_id: string;
  message_group_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string;
  published_at: Date | string | null;
  last_error: string | null;
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(outboxToRecord(message, new OutboxMessageRecord()));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // Ordenado pela coluna identity: atribuída no insert, sob o lock da wallet, então
    // segue a ordem de commit por wallet mesmo entre instâncias com relógios defasados.
    const rows = await this.em.execute<OutboxRow[]>(
      `select id, aggregate_id, message_group_id, event_type, payload, occurred_at,
              attempts, next_attempt_at, published_at, last_error
         from outbox_messages
        where published_at is null and next_attempt_at <= ?
        order by sequence
        limit ?
          for update skip locked`,
      [now, limit],
    );
    return rows.map((row) =>
      OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        messageGroupId: row.message_group_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: new Date(row.occurred_at),
        attempts: row.attempts,
        nextAttemptAt: new Date(row.next_attempt_at),
        publishedAt: row.published_at === null ? undefined : new Date(row.published_at),
        lastError: row.last_error ?? undefined,
      }),
    );
  }

  async saveDeliveryState(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `update outbox_messages set attempts = ?, next_attempt_at = ?, published_at = ?, last_error = ? where id = ?`,
      [message.attempts, message.nextAttemptAt, message.publishedAt ?? null, message.lastError ?? null, message.id],
    );
  }

  async markPublished(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.em.execute(
      `update outbox_messages set published_at = ?, last_error = null where id in (${ids.map(() => "?").join(", ")})`,
      [at, ...ids],
    );
  }

  async backlog(now: Date): Promise<OutboxBacklog> {
    // As duas subconsultas usam o índice parcial: a contagem varre só as pendentes, e o
    // evento mais antigo é o primeiro na ordem de sequence.
    const [row] = await this.em.execute<{ pending: number; oldest_age_seconds: number | string | null }[]>(
      `select (select count(*)::int from outbox_messages where published_at is null) as pending,
              coalesce(extract(epoch from (?::timestamptz - (
                select occurred_at from outbox_messages where published_at is null order by sequence limit 1
              ))), 0)::float8 as oldest_age_seconds`,
      [now],
    );
    return { pending: Number(row?.pending ?? 0), oldestAgeSeconds: Math.max(0, Number(row?.oldest_age_seconds ?? 0)) };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async register(message: InboxMessage): Promise<InboxRegistration> {
    const inserted = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    if (inserted.length > 0) return "new";

    // Uma entrega concorrente da mesma mensagem ficou bloqueada no insert acima até a
    // primeira fazer commit; a esta altura a linha dela já está visível.
    const [existing] = await this.em.execute<{ payload_hash: string }[]>(
      `select payload_hash from inbox_messages where consumer_name = ? and message_id = ?`,
      [message.consumerName, message.messageId],
    );
    return existing?.payload_hash === message.payloadHash ? "duplicate" : "conflict";
  }
}
