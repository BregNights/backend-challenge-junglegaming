import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/shared/domain/money";
import { createTestOrm, resetSchema } from "../support/database";

/**
 * O schema é a última linha de defesa das invariantes financeiras, então é testado
 * sozinho, com SQL cru, independente do código da aplicação.
 */

type Statement = readonly [sql: string, params?: readonly unknown[]];
type Direction = "DEBIT" | "CREDIT";

interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
}

interface TransactionRow {
  id: string;
  kind: "OPENING" | "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  status: "PENDING" | "PENDING_REFERENCE" | "PROCESSED" | "REJECTED" | "FAILED";
  walletId: string;
  playerId: string;
  amount: string;
  currency: string;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string | null;
  payloadHash: string | null;
  roundId: string | null;
  gameId: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  balanceAfter: string | null;
  nextAttemptAt: Date | null;
}

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
});

afterAll(async () => {
  await orm?.close(true);
});

// ------------------------------------------------------------------ helpers

async function commit(...statements: Statement[]): Promise<void> {
  await orm.em.fork().transactional(async (em) => {
    for (const [sql, params = []] of statements) await em.execute(sql, [...params]);
  });
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return orm.em.fork().execute<T[]>(sql, params);
}

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const amountOf = (money: Money) => money.toJSON().amount;

function insertWallet(wallet: WalletState): Statement {
  return [
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, 'BRL', ?, ?, now(), now())`,
    [wallet.id, wallet.playerId, amountOf(wallet.balance), wallet.version],
  ];
}

function updateWallet(walletId: string, balance: string, version: number): Statement {
  return [`update wallets set balance = ?, version = ?, updated_at = now() where id = ?`, [balance, version, walletId]];
}

function insertTransaction(row: TransactionRow): Statement {
  return [
    `insert into wager_transactions (
       id, kind, status, wallet_id, player_id, amount, currency, provider_id, external_transaction_id,
       idempotency_key, payload_hash, round_id, game_id, reference_external_transaction_id,
       reference_transaction_id, failure_code, balance_after, next_attempt_at, created_at, updated_at, processed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now(), ?)`,
    [
      row.id, row.kind, row.status, row.walletId, row.playerId, row.amount, row.currency, row.providerId,
      row.externalTransactionId, row.idempotencyKey, row.payloadHash, row.roundId, row.gameId,
      row.referenceExternalTransactionId, row.referenceTransactionId, row.failureCode, row.balanceAfter,
      row.nextAttemptAt, row.status === "PROCESSED" ? new Date() : null,
    ],
  ];
}

function insertLedgerEntry(entry: {
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: Direction;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
}): Statement {
  return [
    `insert into wallet_ledger_entries (
       id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
     values (?, ?, ?, ?, ?, ?, 'BRL', ?, ?, now())`,
    [
      randomUUID(), entry.walletId, entry.transactionId, entry.walletVersion, entry.direction,
      entry.amount, entry.balanceBefore, entry.balanceAfter,
    ],
  ];
}

/** Uma transação de provedor com todas as colunas de identidade preenchidas; sobrescreva o que o teste examina. */
function providerTransaction(
  wallet: WalletState,
  overrides: Partial<TransactionRow> & Pick<TransactionRow, "kind" | "amount">,
): TransactionRow {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${randomUUID()}`;
  return {
    id: randomUUID(),
    status: "PROCESSED",
    walletId: wallet.id,
    playerId: wallet.playerId,
    currency: "BRL",
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: "a".repeat(64),
    roundId: "round-1",
    gameId: "fortune-chimp",
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    failureCode: null,
    balanceAfter: null,
    nextAttemptAt: null,
    ...overrides,
  };
}

/** Comandos que aplicam de forma consistente uma transação que mexe no saldo: linha, update da wallet, lançamento. */
function movement(wallet: WalletState, tx: TransactionRow, direction: Direction) {
  const amount = brl(tx.amount);
  const balanceAfter = direction === "CREDIT" ? wallet.balance.add(amount) : wallet.balance.subtract(amount);
  const version = wallet.version + 1;
  const statements: Statement[] = [
    insertTransaction({ ...tx, balanceAfter: amountOf(balanceAfter) }),
    updateWallet(wallet.id, amountOf(balanceAfter), version),
    insertLedgerEntry({
      walletId: wallet.id,
      transactionId: tx.id,
      walletVersion: version,
      direction,
      amount: tx.amount,
      balanceBefore: amountOf(wallet.balance),
      balanceAfter: amountOf(balanceAfter),
    }),
  ];
  return { statements, next: { ...wallet, balance: balanceAfter, version } satisfies WalletState };
}

async function openWallet(initialBalance = "100.00"): Promise<WalletState> {
  const wallet: WalletState = { id: randomUUID(), playerId: randomUUID(), balance: brl(initialBalance), version: 1 };
  const statements: Statement[] = [insertWallet(wallet)];

  if (wallet.balance.isPositive()) {
    const openingId = randomUUID();
    statements.push(
      insertTransaction({
        ...providerTransaction(wallet, { kind: "OPENING", amount: initialBalance }),
        id: openingId,
        providerId: null,
        externalTransactionId: null,
        idempotencyKey: null,
        payloadHash: null,
        roundId: null,
        gameId: null,
        balanceAfter: initialBalance,
      }),
      insertLedgerEntry({
        walletId: wallet.id,
        transactionId: openingId,
        walletVersion: 1,
        direction: "CREDIT",
        amount: initialBalance,
        balanceBefore: "0.00",
        balanceAfter: initialBalance,
      }),
    );
  }

  await commit(...statements);
  return wallet;
}

async function processedBet(wallet: WalletState, amount: string, overrides: Partial<TransactionRow> = {}) {
  const bet = providerTransaction(wallet, { kind: "BET", amount, ...overrides });
  const { statements, next } = movement(wallet, bet, "DEBIT");
  await commit(...statements);
  return { bet, wallet: next };
}

// -------------------------------------------------------------------- testes

describe("migrations", () => {
  test("are reversible: down drops every object, up recreates them", async () => {
    const objects = async () =>
      (
        await query<{ tables: string; functions: string }>(
          `select
             (select count(*) from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations') as tables,
             (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as functions`,
        )
      )[0];

    expect(await objects()).toEqual({ tables: "5", functions: "6" });

    await orm.migrator.down();
    expect(await objects()).toEqual({ tables: "0", functions: "0" });

    await orm.migrator.up();
    expect(await objects()).toEqual({ tables: "5", functions: "6" });
  });
});

describe("wallets", () => {
  test("accepts a wallet opened with its OPENING transaction and ledger entry", async () => {
    const wallet = await openWallet("1000.00");
    const [row] = await query<{ balance: string; version: number }>(
      `select balance, version from wallets where id = ?`,
      [wallet.id],
    );
    expect(row).toEqual({ balance: "1000.00", version: 1 });
  });

  test("accepts a zero-balance wallet without ledger entries", async () => {
    await openWallet("0.00");
  });

  test("rejects a balance with no ledger entry behind it (checked at commit)", async () => {
    const wallet: WalletState = { id: randomUUID(), playerId: randomUUID(), balance: brl("100.00"), version: 1 };
    await expect(commit(insertWallet(wallet))).rejects.toThrow(/has balance 100\.00 at version 1 but no ledger entries/);
  });

  test("rejects a second wallet for the same player and currency", async () => {
    const wallet = await openWallet("0.00");
    const duplicate: WalletState = { ...wallet, id: randomUUID() };
    await expect(commit(insertWallet(duplicate))).rejects.toThrow(/wallets_player_currency_uq/);
  });

  test("rejects a negative balance", async () => {
    const wallet = await openWallet("100.00");
    await expect(commit(updateWallet(wallet.id, "-0.01", 2))).rejects.toThrow(/wallets_balance_non_negative_ck/);
  });

  test("rejects a balance change that does not bump the version by exactly one", async () => {
    const wallet = await openWallet("100.00");
    await expect(commit(updateWallet(wallet.id, "50.00", 1))).rejects.toThrow(/version must increment by exactly 1/);
    await expect(commit(updateWallet(wallet.id, "50.00", 3))).rejects.toThrow(/version must increment by exactly 1/);
    await expect(commit(updateWallet(wallet.id, "100.00", 2))).rejects.toThrow(/version may only change together/);
  });
});

describe("ledger", () => {
  test("is append-only: update, delete and truncate are rejected", async () => {
    const wallet = await openWallet("100.00");
    for (const sql of [
      `update wallet_ledger_entries set amount = 1 where wallet_id = '${wallet.id}'`,
      `delete from wallet_ledger_entries where wallet_id = '${wallet.id}'`,
      `truncate wallet_ledger_entries`,
    ]) {
      await expect(commit([sql])).rejects.toThrow(/append-only/);
    }
  });

  test("rejects an entry whose arithmetic does not balance", async () => {
    const wallet = await openWallet("100.00");
    const bet = providerTransaction(wallet, { kind: "BET", amount: "30.00" });
    const { statements } = movement(wallet, bet, "DEBIT");
    const wrongEntry = insertLedgerEntry({
      walletId: wallet.id,
      transactionId: bet.id,
      walletVersion: 2,
      direction: "DEBIT",
      amount: "30.00",
      balanceBefore: "100.00",
      balanceAfter: "80.00",
    });
    await expect(commit(statements[0]!, statements[1]!, wrongEntry)).rejects.toThrow(/ledger_arithmetic_ck/);
  });

  test("rejects an entry that breaks the balance chain", async () => {
    const wallet = await openWallet("100.00");
    const bet = providerTransaction(wallet, { kind: "BET", amount: "30.00" });
    const { statements } = movement(wallet, bet, "DEBIT");
    const detachedEntry = insertLedgerEntry({
      walletId: wallet.id,
      transactionId: bet.id,
      walletVersion: 2,
      direction: "DEBIT",
      amount: "30.00",
      balanceBefore: "90.00",
      balanceAfter: "60.00",
    });
    await expect(commit(statements[0]!, statements[1]!, detachedEntry)).rejects.toThrow(/breaks the balance chain/);
  });

  test("rejects an entry whose amount differs from its transaction", async () => {
    const wallet = await openWallet("100.00");
    const bet = providerTransaction(wallet, { kind: "BET", amount: "30.00" });
    const entry = insertLedgerEntry({
      walletId: wallet.id,
      transactionId: bet.id,
      walletVersion: 2,
      direction: "DEBIT",
      amount: "20.00",
      balanceBefore: "100.00",
      balanceAfter: "80.00",
    });
    await expect(
      commit(insertTransaction({ ...bet, balanceAfter: "80.00" }), updateWallet(wallet.id, "80.00", 2), entry),
    ).rejects.toThrow(/ledger_transaction_fk/);
  });

  test("rejects a BET recorded as a credit", async () => {
    const wallet = await openWallet("100.00");
    const bet = providerTransaction(wallet, { kind: "BET", amount: "30.00" });
    const { statements } = movement(wallet, bet, "CREDIT");
    await expect(commit(...statements)).rejects.toThrow(/requires a DEBIT ledger entry, got CREDIT/);
  });

  test("two blind read-calculate-update writers on the same wallet: exactly one commits", async () => {
    const wallet = await openWallet("100.00");
    const attempts = [1, 2].map(
      () => movement(wallet, providerTransaction(wallet, { kind: "BET", amount: "80.00" }), "DEBIT").statements,
    );

    const results = await Promise.allSettled(attempts.map((statements) => commit(...statements)));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [state] = await query<{ balance: string; entries: string }>(
      `select w.balance, (select count(*) from wallet_ledger_entries e where e.wallet_id = w.id) as entries
         from wallets w where w.id = ?`,
      [wallet.id],
    );
    expect(state).toEqual({ balance: "20.00", entries: "2" });
  });
});

describe("wager transactions", () => {
  test("a processed balance-moving transaction must have a ledger entry", async () => {
    const wallet = await openWallet("100.00");
    const bet = providerTransaction(wallet, { kind: "BET", amount: "10.00", balanceAfter: "90.00" });
    await expect(commit(insertTransaction(bet))).rejects.toThrow(/processed BET transaction .* has no ledger entry/);
  });

  test("LOSS and rejected transactions must not have a ledger entry", async () => {
    const wallet = await openWallet("100.00");
    const loss = providerTransaction(wallet, { kind: "LOSS", amount: "0.00", balanceAfter: "100.00" });
    await commit(insertTransaction(loss));

    const rejected = providerTransaction(wallet, {
      kind: "BET",
      amount: "50.00",
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
    });
    const { statements } = movement(wallet, rejected, "DEBIT");
    await expect(commit(...statements)).rejects.toThrow(/in status REJECTED must not have a ledger entry/);
  });

  test("one transaction per provider idempotency key and per external id", async () => {
    const { bet, wallet } = await processedBet(await openWallet("100.00"), "10.00");

    const sameKey = providerTransaction(wallet, {
      kind: "LOSS",
      amount: "0.00",
      idempotencyKey: bet.idempotencyKey,
      balanceAfter: "90.00",
    });
    await expect(commit(insertTransaction(sameKey))).rejects.toThrow(/wager_tx_idempotency_uq/);

    const sameExternalId = providerTransaction(wallet, {
      kind: "LOSS",
      amount: "0.00",
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: "another-key",
      balanceAfter: "90.00",
    });
    await expect(commit(insertTransaction(sameExternalId))).rejects.toThrow(/wager_tx_external_id_uq/);
  });

  test("OPENING never carries provider identity, provider kinds always do", async () => {
    const wallet = await openWallet("0.00");
    const forgedOpening = providerTransaction(wallet, { kind: "OPENING", amount: "10.00", status: "PENDING" });
    await expect(commit(insertTransaction(forgedOpening))).rejects.toThrow(/wager_tx_origin_ck/);

    const anonymousBet = { ...providerTransaction(wallet, { kind: "BET", amount: "10.00", status: "PENDING" }), roundId: null };
    await expect(commit(insertTransaction(anonymousBet))).rejects.toThrow(/wager_tx_origin_ck/);
  });

  test("REFUND and ROLLBACK require a reference", async () => {
    const wallet = await openWallet("100.00");
    for (const kind of ["REFUND", "ROLLBACK"] as const) {
      const unreferenced = providerTransaction(wallet, { kind, amount: "10.00", status: "PENDING" });
      await expect(commit(insertTransaction(unreferenced))).rejects.toThrow(/wager_tx_reference_required_ck/);
    }
  });

  test("terminal transactions are immutable", async () => {
    const { bet } = await processedBet(await openWallet("100.00"), "10.00");
    await expect(
      commit([`update wager_transactions set status = 'REJECTED', failure_code = 'X', processed_at = null where id = ?`, [bet.id]]),
    ).rejects.toThrow(/is terminal \(PROCESSED\) and cannot change/);
    await expect(commit([`delete from wager_transactions where id = ?`, [bet.id]])).rejects.toThrow(/cannot be deleted/);
  });

  test("a transaction can be reverted only once, whatever the reversal kind", async () => {
    const { bet, wallet } = await processedBet(await openWallet("100.00"), "10.00");
    const reversal = (kind: "REFUND" | "ROLLBACK") =>
      providerTransaction(wallet, {
        kind,
        amount: "10.00",
        referenceExternalTransactionId: bet.externalTransactionId,
        referenceTransactionId: bet.id,
      });

    const refund = movement(wallet, reversal("REFUND"), "CREDIT");
    await commit(...refund.statements);

    const rollback = movement(refund.next, reversal("ROLLBACK"), "CREDIT");
    await expect(commit(...rollback.statements)).rejects.toThrow(/wager_tx_single_reversal_uq/);
  });

  test("a resolved reference must belong to the same wallet and round", async () => {
    const { bet, wallet } = await processedBet(await openWallet("100.00"), "10.00", { roundId: "round-1" });
    const otherRound = providerTransaction(wallet, {
      kind: "ROLLBACK",
      amount: "10.00",
      status: "PENDING",
      roundId: "round-2",
      referenceExternalTransactionId: bet.externalTransactionId,
      referenceTransactionId: bet.id,
    });
    await expect(commit(insertTransaction(otherRound))).rejects.toThrow(/wager_tx_reference_fk/);

    const otherWallet = await openWallet("100.00");
    const crossWallet = providerTransaction(otherWallet, {
      kind: "ROLLBACK",
      amount: "10.00",
      status: "PENDING",
      referenceExternalTransactionId: bet.externalTransactionId,
      referenceTransactionId: bet.id,
    });
    await expect(commit(insertTransaction(crossWallet))).rejects.toThrow(/wager_tx_reference_fk/);
  });
});
