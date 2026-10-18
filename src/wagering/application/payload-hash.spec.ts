import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../shared/application/canonical-json";
import { Money } from "../../shared/domain/money";
import { hashWagerPayload, type WagerPayload } from "./payload-hash";

const payload: WagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: Money.from({ amount: "25.00", currency: "BRL" }),
};

describe("canonicalJson", () => {
  test("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  test("is insensitive to key order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("hashWagerPayload", () => {
  test("is a stable SHA-256 hex digest", () => {
    const hash = hashWagerPayload(payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWagerPayload({ ...payload })).toBe(hash);
  });

  test.each([
    ["amount", { money: Money.from({ amount: "25.01", currency: "BRL" }) }],
    ["currency", { money: Money.from({ amount: "25.00", currency: "USD" }) }],
    ["kind", { kind: "WIN" }],
    ["wallet", { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" }],
    ["round", { roundId: "round-988" }],
    ["reference", { referenceExternalTransactionId: "bet-1" }],
  ])("changes when the %s changes: same key + different payload is a conflict", (_, change) => {
    expect(hashWagerPayload({ ...payload, ...change })).not.toBe(hashWagerPayload(payload));
  });

  test("an absent optional reference hashes like an omitted one", () => {
    expect(hashWagerPayload({ ...payload, referenceExternalTransactionId: undefined })).toBe(hashWagerPayload(payload));
  });
});
