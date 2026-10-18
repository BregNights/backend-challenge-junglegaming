import { DomainError } from "../../shared/domain/domain-error";
import { CurrencyMismatchError, Money } from "../../shared/domain/money";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identifica o lançamento que uma movimentação de saldo produz e a transação por trás dela. */
export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = "INVALID_WALLET_OPERATION";
}

/**
 * Aggregate root. O saldo só muda por `debit`/`credit`, e cada mudança devolve
 * exatamente um lançamento no ledger, então saldo e ledger não têm como divergir.
 * `version` começa em 1 e só incrementa quando o saldo muda.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Um saldo inicial positivo é creditado pelo caminho normal, produzindo o
   * lançamento OPENING na versão 1. Um saldo zero abre na versão 1 sem
   * lançamento.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
    opening: { transactionId: string; entryId: string };
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError(`Initial balance cannot be negative, got ${initialBalance}`);
    }

    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, Money.zero(initialBalance.currency), 0, at, at);
    if (initialBalance.isZero()) {
      wallet._version = 1;
      return { wallet, openingEntry: undefined };
    }
    const openingEntry = wallet.credit({ ...props.opening, money: initialBalance, at });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência; não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: MovementProps): WalletLedgerEntry {
    this.assertMovable(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(`Wallet ${this.id} balance ${this._balance} cannot cover ${movement.money}`);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: MovementProps): WalletLedgerEntry {
    this.assertMovable(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, { entryId, transactionId, money, at }: MovementProps): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter = direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);

    // Montado antes de mutar: se o lançamento for inválido, a wallet fica intacta.
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      walletVersion: this._version + 1,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError(`Balance movements must be positive, got ${money}`);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
