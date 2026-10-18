import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. Toda invariante financeira de que a aplicação depende também é
 * garantida aqui, para que um bug no código da aplicação derrube a transação em vez
 * de corromper saldos. Ver ARCHITECTURE.md ("Schema e constraints") para o porquê
 * de cada garantia.
 */
export class Migration20261018000000InitialSchema extends Migration {
  override name = "Migration20261018000000InitialSchema";

  override up(): void {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      create table wallets (
        id          uuid           primary key,
        player_id   uuid           not null,
        currency    char(3)        not null,
        balance     numeric(20, 2) not null,
        version     integer        not null,
        created_at  timestamptz    not null,
        updated_at  timestamptz    not null,

        constraint wallets_player_currency_uq unique (player_id, currency),
        -- alvo da FK do ledger que prende cada lançamento à moeda da wallet
        constraint wallets_id_currency_uq unique (id, currency),
        constraint wallets_currency_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative_ck check (balance >= 0),
        constraint wallets_version_ck check (version >= 1)
      )
    `);

    // ---------------------------------------------------- wager_transactions
    this.addSql(`
      create table wager_transactions (
        id                                 uuid           primary key,
        kind                               text           not null,
        status                             text           not null,
        wallet_id                          uuid           not null,
        player_id                          uuid           not null,
        amount                             numeric(20, 2) not null,
        currency                           char(3)        not null,
        provider_id                        text,
        external_transaction_id            text,
        idempotency_key                    text,
        payload_hash                       char(64),
        round_id                           text,
        game_id                            text,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid,
        failure_code                       text,
        balance_after                      numeric(20, 2),
        attempts                           integer        not null default 0,
        next_attempt_at                    timestamptz,
        created_at                         timestamptz    not null,
        updated_at                         timestamptz    not null,
        processed_at                       timestamptz,

        constraint wager_tx_kind_ck
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_tx_status_ck
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_tx_currency_ck check (currency ~ '^[A-Z]{3}$'),
        -- só LOSS pode ter valor zero; um lançamento de zero no ledger não faz sentido
        constraint wager_tx_amount_ck check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_tx_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),

        -- OPENING é interno: é o único kind sem identidade de provedor, então um provedor
        -- nunca consegue submetê-lo, e toda operação de provedor é totalmente identificada.
        constraint wager_tx_origin_ck check (
          case when kind = 'OPENING' then
            provider_id is null and external_transaction_id is null and idempotency_key is null
            and payload_hash is null and round_id is null and game_id is null
            and reference_external_transaction_id is null
          else
            provider_id is not null and external_transaction_id is not null and idempotency_key is not null
            and payload_hash is not null and round_id is not null and game_id is not null
          end
        ),

        constraint wager_tx_reference_required_ck
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_reference_allowed_ck
          check (kind in ('WIN', 'REFUND', 'ROLLBACK')
                 or (reference_external_transaction_id is null and reference_transaction_id is null)),
        constraint wager_tx_reference_resolved_ck
          check (reference_transaction_id is null or reference_external_transaction_id is not null),
        constraint wager_tx_reversal_resolved_ck
          check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null),

        constraint wager_tx_failure_code_ck check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at_ck check ((status = 'PROCESSED') = (processed_at is not null)),
        -- replays precisam devolver o saldo observado quando a transação foi decidida
        constraint wager_tx_balance_snapshot_ck
          check (status not in ('PROCESSED', 'REJECTED') or balance_after is not null),
        constraint wager_tx_balance_after_ck check (balance_after >= 0),
        constraint wager_tx_pending_reference_ck check (status <> 'PENDING_REFERENCE' or next_attempt_at is not null),
        constraint wager_tx_attempts_ck check (attempts >= 0),

        constraint wager_tx_idempotency_uq unique (provider_id, idempotency_key),
        constraint wager_tx_external_id_uq unique (provider_id, external_transaction_id),

        -- alvos de FKs compostas (ver wager_tx_reference_fk e ledger_transaction_fk)
        constraint wager_tx_reference_scope_uq unique (id, wallet_id, provider_id, round_id, currency),
        constraint wager_tx_ledger_scope_uq unique (id, wallet_id, currency, amount),

        constraint wager_tx_wallet_fk foreign key (wallet_id)
          references wallets (id) deferrable initially deferred,
        -- uma referência resolvida precisa estar na mesma wallet, provedor, rodada e moeda
        constraint wager_tx_reference_fk
          foreign key (reference_transaction_id, wallet_id, provider_id, round_id, currency)
          references wager_transactions (id, wallet_id, provider_id, round_id, currency)
          deferrable initially deferred
      )
    `);

    this.addSql(`create unique index wager_tx_opening_uq on wager_transactions (wallet_id) where kind = 'OPENING'`);
    // uma transação pode ser revertida no máximo uma vez, qualquer que seja o tipo de reversão (ver ARCHITECTURE.md)
    this.addSql(`
      create unique index wager_tx_single_reversal_uq on wager_transactions (reference_transaction_id)
      where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
    `);
    this.addSql(`
      create index wager_tx_pending_reference_due_idx on wager_transactions (next_attempt_at)
      where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      create index wager_tx_awaiting_reference_idx on wager_transactions (provider_id, reference_external_transaction_id)
      where status = 'PENDING_REFERENCE'
    `);

    // ------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid           primary key,
        wallet_id       uuid           not null,
        transaction_id  uuid           not null,
        wallet_version  integer        not null,
        direction       text           not null,
        amount          numeric(20, 2) not null,
        currency        char(3)        not null,
        balance_before  numeric(20, 2) not null,
        balance_after   numeric(20, 2) not null,
        created_at      timestamptz    not null,

        constraint ledger_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        constraint ledger_amount_ck check (amount > 0),
        constraint ledger_balance_before_ck check (balance_before >= 0),
        constraint ledger_balance_after_ck check (balance_after >= 0),
        constraint ledger_arithmetic_ck check (
          balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end
        ),
        constraint ledger_wallet_version_ck check (wallet_version >= 1),

        constraint ledger_transaction_wallet_uq unique (transaction_id, wallet_id),
        -- um lançamento por versão da wallet: um lost update colide aqui em vez de passar em silêncio;
        -- é também o cursor estável da paginação do ledger
        constraint ledger_wallet_version_uq unique (wallet_id, wallet_version),

        constraint ledger_wallet_fk foreign key (wallet_id, currency)
          references wallets (id, currency) deferrable initially deferred,
        -- valor e moeda do lançamento são exatamente os da transação, na mesma wallet
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id, currency, amount)
          references wager_transactions (id, wallet_id, currency, amount) deferrable initially deferred
      )
    `);

    // ---------------------------------------------------------- inbox/outbox
    this.addSql(`
      create table inbox_messages (
        consumer_name  text        not null,
        message_id     text        not null,
        payload_hash   char(64)    not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,

        constraint inbox_messages_pk primary key (consumer_name, message_id),
        constraint inbox_messages_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$')
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id                uuid        primary key,
        sequence          bigint      generated always as identity,
        aggregate_id      uuid        not null,
        message_group_id  text        not null,
        event_type        text        not null,
        payload           jsonb       not null,
        occurred_at       timestamptz not null,
        attempts          integer     not null default 0,
        next_attempt_at   timestamptz not null,
        published_at      timestamptz,
        last_error        text,

        constraint outbox_messages_sequence_uq unique (sequence),
        constraint outbox_messages_attempts_ck check (attempts >= 0)
      )
    `);
    this.addSql(`
      create index outbox_messages_pending_idx on outbox_messages (next_attempt_at, sequence)
      where published_at is null
    `);

    // -------------------------------------------------------------- triggers
    this.addSql(`
      create function wallets_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wallets cannot be deleted (wallet %)', old.id;
        end if;
        if (new.id, new.player_id, new.currency, new.created_at)
           is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet % identity columns are immutable', old.id;
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallet % version must increment by exactly 1 when the balance changes', old.id;
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet % version may only change together with the balance', old.id;
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger wallets_guard before update or delete on wallets
      for each row execute function wallets_guard()
    `);

    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager transactions cannot be deleted (transaction %)', old.id;
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%) and cannot change', old.id, old.status;
        end if;
        if (new.id, new.kind, new.wallet_id, new.player_id, new.amount, new.currency, new.provider_id,
            new.external_transaction_id, new.idempotency_key, new.payload_hash, new.round_id, new.game_id,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.kind, old.wallet_id, old.player_id, old.amount, old.currency, old.provider_id,
            old.external_transaction_id, old.idempotency_key, old.payload_hash, old.round_id, old.game_id,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % identity columns are immutable', old.id;
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger wager_transactions_guard before update or delete on wager_transactions
      for each row execute function wager_transactions_guard()
    `);

    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op;
      end
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_append_only before update or delete or truncate on wallet_ledger_entries
      for each statement execute function wallet_ledger_entries_append_only()
    `);

    // Cada lançamento continua o anterior: mesma wallet, próxima versão, balance_before
    // igual ao balance_after anterior. O primeiro lançamento de uma wallet parte de zero,
    // na versão 1 (OPENING) ou 2 (primeiro crédito de uma wallet aberta com saldo zero).
    this.addSql(`
      create function wallet_ledger_entries_chain() returns trigger language plpgsql as $$
      declare
        previous wallet_ledger_entries%rowtype;
      begin
        select * into previous from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by wallet_version desc
         limit 1;

        if not found then
          if new.balance_before <> 0 or new.wallet_version > 2 then
            raise exception 'first ledger entry of wallet % must start from zero at version 1 or 2', new.wallet_id;
          end if;
        elsif new.wallet_version <> previous.wallet_version + 1 or new.balance_before <> previous.balance_after then
          raise exception 'ledger entry breaks the balance chain of wallet % (version %, expected %; balance_before %, expected %)',
            new.wallet_id, new.wallet_version, previous.wallet_version + 1, new.balance_before, previous.balance_after;
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_chain before insert on wallet_ledger_entries
      for each row execute function wallet_ledger_entries_chain()
    `);

    // No commit, toda wallet tocada precisa ser igual à cauda do seu ledger: mesmo saldo
    // e mesma versão. Diferido para que o update da wallet e o insert no ledger possam
    // acontecer em qualquer ordem dentro da transação.
    this.addSql(`
      create function assert_wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        target_wallet_id uuid;
        current_wallet wallets%rowtype;
        last_entry wallet_ledger_entries%rowtype;
      begin
        if tg_table_name = 'wallets' then
          target_wallet_id := new.id;
        else
          target_wallet_id := new.wallet_id;
        end if;

        select * into current_wallet from wallets where id = target_wallet_id;
        select * into last_entry from wallet_ledger_entries
         where wallet_id = target_wallet_id
         order by wallet_version desc
         limit 1;

        if not found then
          if current_wallet.balance <> 0 or current_wallet.version <> 1 then
            raise exception 'wallet % has balance % at version % but no ledger entries',
              target_wallet_id, current_wallet.balance, current_wallet.version;
          end if;
        elsif last_entry.wallet_version <> current_wallet.version or last_entry.balance_after <> current_wallet.balance then
          raise exception 'wallet % (balance %, version %) diverges from its ledger (balance %, version %)',
            target_wallet_id, current_wallet.balance, current_wallet.version,
            last_entry.balance_after, last_entry.wallet_version;
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger wallets_match_ledger after insert or update on wallets
      deferrable initially deferred
      for each row execute function assert_wallet_matches_ledger()
    `);
    this.addSql(`
      create constraint trigger ledger_matches_wallet after insert on wallet_ledger_entries
      deferrable initially deferred
      for each row execute function assert_wallet_matches_ledger()
    `);

    // No commit, uma transação tem lançamento se e somente se está PROCESSED e mexe no
    // saldo (tudo menos LOSS), e a direção do lançamento decorre do kind.
    this.addSql(`
      create function assert_transaction_matches_ledger() returns trigger language plpgsql as $$
      declare
        target_transaction_id uuid;
        tx wager_transactions%rowtype;
        entry wallet_ledger_entries%rowtype;
        has_entry boolean;
        expected_direction text;
      begin
        if tg_table_name = 'wager_transactions' then
          target_transaction_id := new.id;
        else
          target_transaction_id := new.transaction_id;
        end if;

        select * into tx from wager_transactions where id = target_transaction_id;
        select * into entry from wallet_ledger_entries where transaction_id = target_transaction_id;
        has_entry := found;

        if tx.status = 'PROCESSED' and tx.kind <> 'LOSS' then
          if not has_entry then
            raise exception 'processed % transaction % has no ledger entry', tx.kind, tx.id;
          end if;
          if tx.kind = 'BET' then
            expected_direction := 'DEBIT';
          elsif tx.kind = 'ROLLBACK' then
            select case kind when 'BET' then 'CREDIT' else 'DEBIT' end into expected_direction
              from wager_transactions where id = tx.reference_transaction_id;
          else
            expected_direction := 'CREDIT';
          end if;
          if entry.direction is distinct from expected_direction then
            raise exception '% transaction % requires a % ledger entry, got %',
              tx.kind, tx.id, expected_direction, entry.direction;
          end if;
        elsif has_entry then
          raise exception '% transaction % in status % must not have a ledger entry', tx.kind, tx.id, tx.status;
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger wager_transactions_match_ledger after insert or update on wager_transactions
      deferrable initially deferred
      for each row execute function assert_transaction_matches_ledger()
    `);
    this.addSql(`
      create constraint trigger ledger_matches_transaction after insert on wallet_ledger_entries
      deferrable initially deferred
      for each row execute function assert_transaction_matches_ledger()
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop table if exists wallets`);
    this.addSql(`drop function if exists assert_transaction_matches_ledger()`);
    this.addSql(`drop function if exists assert_wallet_matches_ledger()`);
    this.addSql(`drop function if exists wallet_ledger_entries_chain()`);
    this.addSql(`drop function if exists wallet_ledger_entries_append_only()`);
    this.addSql(`drop function if exists wager_transactions_guard()`);
    this.addSql(`drop function if exists wallets_guard()`);
  }
}
