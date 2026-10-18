import { z } from "zod";
import { identifierSchema, moneySchema, uuidSchema } from "../platform/http/validation";
import { PROVIDER_KINDS } from "./domain/wager-transaction";

/** Payload de negócio de uma operação de provedor, idêntico em HTTP e SQS. */
export const wagerRequestSchema = z.object({
  providerId: identifierSchema,
  externalTransactionId: identifierSchema,
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: identifierSchema,
  gameId: identifierSchema,
  kind: z.enum(PROVIDER_KINDS, { error: `kind must be one of ${PROVIDER_KINDS.join(", ")} (OPENING is internal)` }),
  money: moneySchema,
  referenceExternalTransactionId: identifierSchema.optional(),
});

export const idempotencyKeySchema = z
  .string({ error: "Idempotency-Key is required" })
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7E]+$/, "printable ASCII without spaces");
