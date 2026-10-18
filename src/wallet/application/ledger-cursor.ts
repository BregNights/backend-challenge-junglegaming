import { ValidationError } from "../../shared/application/errors";

/**
 * Opaque cursor over the wallet version of the last returned entry. Entries are
 * immutable and versions unique per wallet, so pages never shift or repeat.
 */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString("base64url");
}

export function decodeLedgerCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const version = (parsed as { v?: unknown } | null)?.v;
    if (typeof version === "number" && Number.isInteger(version) && version >= 1) return version;
  } catch {
    // fall through to the validation error
  }
  throw new ValidationError("Invalid ledger cursor", [{ path: "cursor", message: "not a cursor returned by this API" }]);
}
