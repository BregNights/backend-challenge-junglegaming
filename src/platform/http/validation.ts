import { z } from "zod";
import { ValidationError } from "../../shared/application/errors";

/** Identificadores do lado do provedor (ids de provedor, transação, rodada e jogo). */
export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "only letters, digits and . _ : - are allowed");

export const uuidSchema = z.uuid();

/** Só a forma: o formato de amount/currency é garantido pelo Money.from, no domínio. */
export const moneySchema = z.object({ amount: z.string(), currency: z.string() });

export function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(
    `Invalid ${label}`,
    result.error.issues.map((issue) => ({ path: issue.path.join(".") || label, message: issue.message })),
  );
}
