import type { InboxMessage } from "../../messaging/domain/inbox-message";
import type { OutboxMessage } from "../../messaging/domain/outbox-message";
import type { WagerTransaction } from "../../wagering/domain/wager-transaction";
import type { Wallet } from "../../wallet/domain/wallet";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import type { Money } from "../domain/money";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE: serializa toda alteração de saldo desta wallet até o commit. */
  lockById(id: string): Promise<Wallet | undefined>;
  findByPlayer(playerId: string, currency: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): void;
  /** Persiste saldo e versão de uma wallet carregada por este store. */
  update(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Se um REFUND/ROLLBACK PROCESSED já reverte esta transação. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): void;
  update(transaction: WagerTransaction): void;
  /**
   * Reivindica as transações PENDING_REFERENCE vencidas (FOR UPDATE SKIP LOCKED) e
   * as arrenda empurrando next_attempt_at para `leaseUntil`: workers concorrentes
   * pegam conjuntos disjuntos, e o claim de um worker que morreu expira sozinho.
   */
  claimDuePendingReferences(now: Date, leaseUntil: Date, limit: number): Promise<{ id: string; walletId: string }[]>;
  /** Antecipa a próxima tentativa das transações que esperam por esta referência. */
  expediteWaitingFor(providerId: string, externalTransactionId: string, now: Date): Promise<void>;
}

export type InboxRegistration = "new" | "duplicate" | "conflict";

export interface InboxRepository {
  /**
   * Insere a mensagem (ON CONFLICT DO NOTHING). "duplicate": já processada com o
   * mesmo payload; "conflict": mesmo id, payload diferente.
   */
  register(message: InboxMessage): Promise<InboxRegistration>;
}

export interface LedgerSummary {
  storedBalance: Money;
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): void;
  /** Mais recentes primeiro. `beforeVersion` é um cursor exclusivo e estável (lançamentos são imutáveis). */
  page(walletId: string, options: { beforeVersion?: number; limit: number }): Promise<WalletLedgerEntry[]>;
  /** Saldo armazenado e saldo derivado do ledger, lidos num único comando (um snapshot). */
  summarize(walletId: string): Promise<LedgerSummary | undefined>;
}

export interface OutboxBacklog {
  pending: number;
  /** Idade do evento não publicado mais antigo; 0 quando a outbox está vazia. */
  oldestAgeSeconds: number;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
  /** Mensagens vencidas e não publicadas, em ordem de inserção, travadas com SKIP LOCKED até o commit. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persiste o estado de publicação (publicada / agenda de retry) de uma mensagem reivindicada. */
  saveDeliveryState(message: OutboxMessage): Promise<void>;
  backlog(now: Date): Promise<OutboxBacklog>;
}

/** Repositórios ligados a uma transação SQL. */
export interface TransactionalStore {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
}

export const UNIT_OF_WORK = Symbol("UnitOfWork");

export interface UnitOfWork {
  /**
   * Executa `work` numa transação SQL; tudo o que for registrado no store vai junto
   * no flush e no commit, ou nada vai. Falhas do banco aparecem como
   * `TransientInfrastructureError` ou `UniqueConstraintConflict`.
   */
  run<T>(work: (store: TransactionalStore) => Promise<T>): Promise<T>;
}
