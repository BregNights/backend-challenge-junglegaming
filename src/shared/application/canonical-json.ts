type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * JSON determinístico: chaves dos objetos ordenadas recursivamente, sem espaços e
 * sem propriedades `undefined`. Dois payloads com o mesmo conteúdo sempre geram a
 * mesma string, qualquer que seja a ordem em que as chaves chegaram.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): Json | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson does not accept non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item) ?? null);
  if (typeof value === "object") {
    const result: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = normalize((value as Record<string, unknown>)[key]);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  if (value === undefined) return undefined;
  throw new TypeError(`canonicalJson does not accept values of type ${typeof value}`);
}
