import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/application/canonical-json";
import type { Money } from "../../shared/domain/money";

/** The business fields of a wager operation: exactly what defines "the same request". */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * SHA-256 (hex) of the canonical JSON of the business fields. The idempotency
 * key and transport metadata (messageId, occurredAt, headers) are deliberately
 * excluded; money is hashed in its canonical two-decimal form.
 */
export function hashWagerPayload(payload: WagerPayload): string {
  const canonical = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money.toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
