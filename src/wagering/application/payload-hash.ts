import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/application/canonical-json";
import type { Money } from "../../shared/domain/money";

/** Os campos de negócio de uma operação de aposta: exatamente o que define "a mesma requisição". */
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
 * SHA-256 (hex) do JSON canônico dos campos de negócio. A idempotency key e os
 * metadados de transporte (messageId, occurredAt, headers) ficam de fora de
 * propósito; o dinheiro entra na forma canônica de duas casas.
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
