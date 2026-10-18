import { DomainError } from "./domain-error";

/** Wire format: decimal string with exactly two fractional digits, ISO-4217 code. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const MINOR_UNITS_PER_MAJOR = 10n ** BigInt(SCALE);
/** Mirrors the numeric(20, 2) columns: at most 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;
const MAX_MINOR_UNITS = 10n ** BigInt(MAX_INTEGER_DIGITS + SCALE) - 1n;

/**
 * Non-negative, no leading zeros, exactly two decimals. Rejects by construction:
 * NaN, Infinity, scientific notation, signs, whitespace, empty strings and any
 * other scale — nothing is ever rounded.
 */
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})\\.\\d{${SCALE}}$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * Immutable monetary value. Stored as an integer number of minor units, so
 * arithmetic is exact; `number` is never involved.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Parses an input contract. Negative amounts are rejected here: the sign of a
   * movement is expressed by its direction, never by the amount.
   */
  static from(props: MoneyProps): Money {
    const amount: unknown = props?.amount;
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount ${JSON.stringify(amount)}: expected a non-negative decimal string with exactly ${SCALE} decimals, e.g. "25.00"`,
      );
    }
    const [integerPart = "0", fractionPart = "0"] = amount.split(".");
    return new Money(BigInt(integerPart) * MINOR_UNITS_PER_MAJOR + BigInt(fractionPart), Money.parseCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.ofMinorUnits(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Values in different currencies are simply not equal. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private formatAmount(): string {
    const sign = this.minorUnits < 0n ? "-" : "";
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const integerPart = absolute / MINOR_UNITS_PER_MAJOR;
    const fractionPart = (absolute % MINOR_UNITS_PER_MAJOR).toString().padStart(SCALE, "0");
    return `${sign}${integerPart}.${fractionPart}`;
  }

  private static ofMinorUnits(minorUnits: bigint, currency: string): Money {
    const absolute = minorUnits < 0n ? -minorUnits : minorUnits;
    if (absolute > MAX_MINOR_UNITS) {
      throw new InvalidMoneyError(`Amount exceeds the supported precision of ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return new Money(minorUnits, currency);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency ${JSON.stringify(currency)}: expected an ISO-4217 code, e.g. "BRL"`);
    }
    return currency;
  }
}
