import { ValidationError } from "../../shared/application/errors";

/**
 * Cursor opaco sobre a versão da wallet do último lançamento devolvido. Lançamentos
 * são imutáveis e as versões são únicas por wallet, então as páginas nunca se
 * deslocam nem se repetem.
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
    // segue para o erro de validação
  }
  throw new ValidationError("Invalid ledger cursor", [{ path: "cursor", message: "not a cursor returned by this API" }]);
}
