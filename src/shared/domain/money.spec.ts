import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError, Money, type MoneyProps } from "./money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money.from", () => {
  test.each(["0.00", "0.01", "25.00", "1000.50", "999999999999999999.99"])("accepts %p", (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: "BRL" });
  });

  test.each([
    ["empty string", ""],
    ["no decimals", "25"],
    ["one decimal", "25.5"],
    ["three decimals (never rounded)", "10.005"],
    ["trailing zero beyond scale", "10.000"],
    ["negative", "-1.00"],
    ["explicit plus sign", "+1.00"],
    ["leading zero", "01.00"],
    ["scientific notation", "1e3"],
    ["scientific notation with decimals", "1.00e2"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["surrounding whitespace", " 1.00 "],
    ["comma separator", "1,00"],
    ["thousands separator", "1,000.00"],
    ["missing integer part", ".50"],
    ["non-ASCII digits", "١.٠٠"],
    ["more than 18 integer digits", "1000000000000000000.00"],
  ])("rejects %s", (_, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejects non-string amounts that bypass the type system", () => {
    for (const amount of [25, 25.5, null, undefined, {}, Number.NaN]) {
      expect(() => Money.from({ amount, currency: "BRL" } as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    }
  });

  test.each(["", "brl", "BR", "BRLL", "R$", 986])("rejects currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency } as MoneyProps)).toThrow(InvalidMoneyError);
  });
});

describe("Money.rehydrate", () => {
  test("accepts stored values, including negative computed differences", () => {
    expect(Money.rehydrate({ amount: "975.00", currency: "BRL" }).toJSON().amount).toBe("975.00");
    expect(Money.rehydrate({ amount: "-0.01", currency: "BRL" }).isNegative()).toBe(true);
  });

  test("keeps the strict format", () => {
    for (const amount of ["", "1", "1.5", "--1.00", "1e3", "-01.00"]) {
      expect(() => Money.rehydrate({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    }
  });
});

describe("arithmetic", () => {
  test("adds and subtracts exactly where binary floats would drift", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.00")).toJSON().amount).toBe("20.00");
    expect(brl("999999999999999999.98").add(brl("0.01")).toJSON().amount).toBe("999999999999999999.99");
  });

  test("subtraction can produce a negative value, negate flips the sign", () => {
    const difference = brl("20.00").subtract(brl("80.00"));
    expect(difference.toJSON().amount).toBe("-60.00");
    expect(difference.isNegative()).toBe(true);
    expect(difference.negate().toJSON().amount).toBe("60.00");
    expect(brl("0.00").negate().toJSON().amount).toBe("0.00");
  });

  test("rejects results beyond the persisted precision", () => {
    expect(() => brl("999999999999999999.99").add(brl("0.01"))).toThrow(InvalidMoneyError);
  });

  test("is immutable: operations return new instances", () => {
    const original = brl("50.00");
    const sum = original.add(brl("10.00"));
    original.subtract(brl("5.00"));
    original.negate();

    expect(sum).not.toBe(original);
    expect(original.toJSON().amount).toBe("50.00");
    expect(Object.isFrozen(original)).toBe(true);
  });
});

describe("comparisons", () => {
  test("sign predicates", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("0.00").isNegative()).toBe(false);
  });

  test("isLessThan and equals", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
    expect(brl("80.00").equals(brl("80.00"))).toBe(true);
    expect(brl("80.00").equals(usd("80.00"))).toBe(false);
  });
});

describe("currency conflicts", () => {
  test.each([
    ["add", (a: Money, b: Money) => a.add(b)],
    ["subtract", (a: Money, b: Money) => a.subtract(b)],
    ["isLessThan", (a: Money, b: Money) => a.isLessThan(b)],
  ])("%s across currencies throws CurrencyMismatchError", (_, operation) => {
    expect(() => operation(brl("1.00"), usd("1.00"))).toThrow(CurrencyMismatchError);
  });

  test("error carries a stable machine-readable code", () => {
    try {
      brl("1.00").add(usd("1.00"));
      throw new Error("expected a CurrencyMismatchError");
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).code).toBe("CURRENCY_MISMATCH");
    }
  });
});

describe("serialization", () => {
  test("toJSON keeps a fixed scale of two decimals", () => {
    expect(JSON.stringify({ money: brl("7.50") })).toBe('{"money":{"amount":"7.50","currency":"BRL"}}');
    expect(Money.zero("USD").toJSON()).toEqual({ amount: "0.00", currency: "USD" });
  });

  test("round-trips through its own wire format", () => {
    const money = brl("1234.05");
    expect(Money.from(money.toJSON()).equals(money)).toBe(true);
  });

  test("toString is human readable", () => {
    expect(brl("975.00").toString()).toBe("975.00 BRL");
  });
});
