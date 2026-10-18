import { z } from "zod";
import { ValidationError } from "../../shared/application/errors";

/** Provider-side identifiers (provider, transaction, round, game ids). */
export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "only letters, digits and . _ : - are allowed");

export const uuidSchema = z.uuid();

/** Shape only: the amount/currency format is enforced by Money.from in the domain. */
export const moneySchema = z.object({ amount: z.string(), currency: z.string() });

export function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(
    `Invalid ${label}`,
    result.error.issues.map((issue) => ({ path: issue.path.join(".") || label, message: issue.message })),
  );
}
