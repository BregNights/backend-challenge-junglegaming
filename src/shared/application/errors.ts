/**
 * Falhas da camada de aplicação. Cada uma corresponde a exatamente um resultado
 * no transporte (ver o filtro de erros HTTP), para que o provedor nunca precise
 * interpretar mensagens para decidir se reenvia.
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

/** Entrada malformada: 400, nada é persistido. */
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

/** Mesma idempotency key (ou id externo) com payload diferente: conflito, nunca replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";
}

/** Credenciais ausentes ou inválidas: 401. */
export class UnauthenticatedError extends ApplicationError {
  readonly code = "UNAUTHENTICATED";
}

/** Provedor autenticado agindo sobre operações de outro provedor: 403. */
export class ProviderForbiddenError extends ApplicationError {
  readonly code = "PROVIDER_FORBIDDEN";
}

/** Mesmo id de mensagem de transporte com outro corpo: bug do produtor, nunca é retentado. */
export class InboxConflictError extends ApplicationError {
  readonly code = "INBOX_CONFLICT";
}

/** Falha de infraestrutura retentável (banco ou broker indisponível, lock timeout): 503 / retry no SQS. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TEMPORARILY_UNAVAILABLE";
}

/**
 * Uma escrita perdeu a corrida numa constraint única. O unit of work a lança com
 * o nome da constraint; os use cases decidem se isso significa conflito ou retry.
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
