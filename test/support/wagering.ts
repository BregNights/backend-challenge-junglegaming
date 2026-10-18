import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { ApiClient, ApiResponse } from "./app";

export interface TestWallet {
  id: string;
  playerId: string;
}

export async function createWallet(api: ApiClient, initialBalance = "100.00", currency = "BRL"): Promise<TestWallet> {
  const playerId = Bun.randomUUIDv7();
  const response = await api.post("/wallets", { playerId, initialBalance: { amount: initialBalance, currency } });
  if (response.status !== 201) throw new Error(`wallet creation failed: ${response.status} ${JSON.stringify(response.body)}`);
  return { id: response.body.id, playerId };
}

export interface WagerRequest {
  externalTransactionId?: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK" | string;
  amount: string;
  currency?: string;
  roundId?: string;
  providerId?: string;
  reference?: string;
  idempotencyKey?: string;
  playerId?: string;
}

export function wagerBody(wallet: TestWallet, request: WagerRequest) {
  const providerId = request.providerId ?? "provider-a";
  const externalTransactionId = request.externalTransactionId ?? `tx-${randomUUID()}`;
  return {
    idempotencyKey: request.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    body: {
      providerId,
      externalTransactionId,
      playerId: request.playerId ?? wallet.playerId,
      walletId: wallet.id,
      roundId: request.roundId ?? "round-1",
      gameId: "fortune-chimp",
      kind: request.kind,
      money: { amount: request.amount, currency: request.currency ?? "BRL" },
      ...(request.reference ? { referenceExternalTransactionId: request.reference } : {}),
    },
  };
}

export function submitWager(api: ApiClient, wallet: TestWallet, request: WagerRequest): Promise<ApiResponse> {
  const { idempotencyKey, body } = wagerBody(wallet, request);
  return api.post("/wagering/transactions", body, { "Idempotency-Key": idempotencyKey });
}

interface InvariantRow {
  wallet_id: string;
  balance: string;
  ledger_balance: string;
  version: number;
  ledger_tail_version: number | null;
}

/**
 * The final invariant of every test: wallet.balance == balance rebuilt from the
 * ledger, for every wallet in the database. Returns the offending wallets.
 */
export async function walletsDivergingFromLedger(orm: MikroORM): Promise<InvariantRow[]> {
  return orm.em.fork().execute<InvariantRow[]>(
    `select w.id as wallet_id, w.balance, w.version,
            coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20, 2) as ledger_balance,
            max(e.wallet_version) as ledger_tail_version
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      group by w.id
     having w.balance <> coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)
         or (max(e.wallet_version) is not null and max(e.wallet_version) <> w.version)`,
  );
}

export async function ledgerOf(orm: MikroORM, walletId: string) {
  return orm.em
    .fork()
    .execute<{ direction: string; amount: string; balance_after: string; wallet_version: number }[]>(
      `select direction, amount, balance_after, wallet_version from wallet_ledger_entries where wallet_id = ? order by wallet_version`,
      [walletId],
    );
}

export async function outboxEventTypes(orm: MikroORM, aggregateIds: string[]): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .execute<{ event_type: string }[]>(
      `select event_type from outbox_messages where aggregate_id in (${aggregateIds.map(() => "?").join(", ")}) order by sequence`,
      aggregateIds,
    );
  return rows.map((row) => row.event_type);
}
