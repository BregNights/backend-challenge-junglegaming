import { ConnectionException } from "@mikro-orm/core";
import {
  ApplicationError,
  TransientInfrastructureError,
  UniqueConstraintConflict,
} from "../shared/application/errors";
import type { WageringMetrics } from "../shared/application/metrics";
import { DomainError } from "../shared/domain/domain-error";

const SQLSTATE = {
  uniqueViolation: "23505",
  lockNotAvailable: "55P03",
  deadlockDetected: "40P01",
  serializationFailure: "40001",
  queryCanceled: "57014",
  adminShutdown: "57P01",
  crashShutdown: "57P02",
  cannotConnectNow: "57P03",
  tooManyConnections: "53300",
} as const;

const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  SQLSTATE.lockNotAvailable,
  SQLSTATE.deadlockDetected,
  SQLSTATE.serializationFailure,
  SQLSTATE.queryCanceled,
  SQLSTATE.adminShutdown,
  SQLSTATE.crashShutdown,
  SQLSTATE.cannotConnectNow,
  SQLSTATE.tooManyConnections,
]);

const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
}

/**
 * Transforma erros do driver nos dois tipos de falha com que os use cases
 * raciocinam: problema de infraestrutura retentável e corrida perdida numa
 * constraint única. Erros de domínio e de aplicação lançados dentro do unit of
 * work passam intactos.
 */
export function translateDatabaseError(error: unknown, metrics: WageringMetrics): unknown {
  if (error instanceof DomainError || error instanceof ApplicationError || error instanceof UniqueConstraintConflict) {
    return error;
  }

  const { code, constraint } = (error ?? {}) as PgLikeError;

  if (code === SQLSTATE.uniqueViolation) {
    return new UniqueConstraintConflict(typeof constraint === "string" ? constraint : undefined, { cause: error });
  }

  if (code === SQLSTATE.lockNotAvailable) metrics.lockConflict("lock-timeout");
  if (code === SQLSTATE.deadlockDetected) metrics.lockConflict("deadlock");

  const transient =
    error instanceof ConnectionException ||
    (typeof code === "string" &&
      (TRANSIENT_SQLSTATES.has(code) || code.startsWith("08") || TRANSIENT_NETWORK_CODES.has(code)));

  if (transient) {
    return new TransientInfrastructureError(`Database temporarily unavailable (${String(code ?? "connection")})`, {
      cause: error,
    });
  }
  return error;
}
