/**
 * Application-level failures. Each one maps to exactly one transport outcome
 * (see the HTTP error filter), so providers never have to parse messages to
 * decide whether to resend.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Malformed input: 400, nothing persisted. */
export class ValidationError extends ApplicationError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

/** Same idempotency key (or external id) with a different payload: a conflict, never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";
}

/** Same transport message id with a different body: a producer bug, never retried. */
export class InboxConflictError extends ApplicationError {
  readonly code = "INBOX_CONFLICT";
}

/** Retryable infrastructure failure (database/broker unavailable, lock timeout): 503 / SQS retry. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TEMPORARILY_UNAVAILABLE";
}

/**
 * A write lost a race on a unique constraint. The unit of work raises it with
 * the constraint name; use cases decide whether it means conflict or retry.
 */
export class UniqueConstraintConflict extends Error {
  constructor(
    readonly constraint: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`Unique constraint violated: ${constraint ?? "unknown"}`, options);
    this.name = "UniqueConstraintConflict";
  }
}
