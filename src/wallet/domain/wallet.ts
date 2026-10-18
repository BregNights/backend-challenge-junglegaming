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

/** Identifies the ledger entry a balance movement produces and the transaction behind it. */
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
 * Aggregate root. The balance only changes through `debit`/`credit`, and each
 * change returns exactly one ledger entry, so balance and ledger cannot drift
 * apart. `version` starts at 1 and increments only when the balance changes.
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
   * A positive initial balance is credited through the regular path, producing
   * the OPENING ledger entry at version 1. A zero balance opens at version 1
   * without an entry.
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

  /** Reconstruction from persistence; does not re-validate transitions. */
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

    // Built before mutating: if the entry is invalid, the wallet is left untouched.
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
