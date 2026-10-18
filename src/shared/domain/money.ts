import { DomainError } from "./domain-error";

/** Formato no contrato: string decimal com exatamente duas casas e código ISO-4217. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const MINOR_UNITS_PER_MAJOR = 10n ** BigInt(SCALE);
/** Espelha as colunas numeric(20, 2): no máximo 18 dígitos inteiros. */
const MAX_INTEGER_DIGITS = 18;
const MAX_MINOR_UNITS = 10n ** BigInt(MAX_INTEGER_DIGITS + SCALE) - 1n;

/**
 * Não negativo, sem zeros à esquerda, exatamente duas casas. Rejeita por
 * construção: NaN, Infinity, notação científica, sinais, espaços, string vazia e
 * qualquer outra escala — nada é arredondado.
 */
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})\\.\\d{${SCALE}}$`);
/** Mesmo formato, com sinal opcional: valores confiáveis, como diferenças calculadas. */
const SIGNED_AMOUNT_PATTERN = new RegExp(`^-?(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})\\.\\d{${SCALE}}$`);
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
 * Valor monetário imutável. Guardado como um número inteiro de unidades menores
 * (centavos), então a aritmética é exata; `number` nunca entra no caminho.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Interpreta um contrato de entrada. Valores negativos são rejeitados aqui: o
   * sinal de uma movimentação é dado pela direção, nunca pelo valor.
   */
  static from(props: MoneyProps): Money {
    const amount: unknown = props?.amount;
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount ${JSON.stringify(amount)}: expected a non-negative decimal string with exactly ${SCALE} decimals, e.g. "25.00"`,
      );
    }
    return new Money(Money.parseMinorUnits(amount), Money.parseCurrency(props.currency));
  }

  /**
   * Reconstrução a partir da persistência ou de outras fontes confiáveis (colunas
   * numeric(20, 2), diferenças calculadas): mesmo formato estrito, sinal permitido.
   */
  static rehydrate(props: MoneyProps): Money {
    const amount: unknown = props?.amount;
    if (typeof amount !== "string" || !SIGNED_AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Invalid stored amount ${JSON.stringify(amount)}`);
    }
    return new Money(Money.parseMinorUnits(amount), Money.parseCurrency(props.currency));
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

  /** Valores em moedas diferentes simplesmente não são iguais. */
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

  /** Espera um valor já validado contra um dos padrões de valor. */
  private static parseMinorUnits(amount: string): bigint {
    const negative = amount.startsWith("-");
    const [integerPart = "0", fractionPart = "0"] = (negative ? amount.slice(1) : amount).split(".");
    const minorUnits = BigInt(integerPart) * MINOR_UNITS_PER_MAJOR + BigInt(fractionPart);
    return negative ? -minorUnits : minorUnits;
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
