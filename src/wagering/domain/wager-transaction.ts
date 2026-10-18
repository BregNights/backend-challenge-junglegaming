import { DomainError } from "../../shared/domain/domain-error";
import type { Money } from "../../shared/domain/money";
import { LedgerDirection, oppositeDirection } from "../../wallet/domain/ledger-direction";
import type { FailureCode } from "./failure-code";

export enum WagerTransactionKind {
  /** Interno: crédito de abertura de uma wallet. Nunca aceito de provedores. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = "PENDING",
  /** Aguardando a transação referenciada chegar. */
  PendingReference = "PENDING_REFERENCE",
  /** Aplicada (terminal). */
  Processed = "PROCESSED",
  /** Violação de regra de negócio (terminal). */
  Rejected = "REJECTED",
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = "FAILED",
}

export const PROVIDER_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id da transação referenciada no provedor, não o id interno. */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  walletId: string;
  playerId: string;
  money: Money;
  /** Identidade do provedor: ausente só no OPENING. */
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  roundId?: string;
  gameId?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  /** Saldo observado quando a transação foi decidida; devolvido tal qual nos replays. */
  balanceAfter?: Money;
  attempts: number;
  nextAttemptAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date;
}

/** Entrada inválida para uma transação nova (vira 400, nada é persistido). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
}

/** Tentativa de transição a partir de um estado terminal: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}

/**
 * Transições válidas:
 *
 *   PENDING ──────────────┬──► PROCESSED
 *      │                  ├──► REJECTED
 *      ▼                  └──► FAILED
 *   PENDING_REFERENCE ────┘    (e PENDING_REFERENCE → PENDING_REFERENCE a cada nova tentativa)
 *
 * PROCESSED, REJECTED e FAILED são terminais.
 */
export class WagerTransaction {
  readonly id: string;
  readonly kind: WagerTransactionKind;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly payloadHash: string | undefined;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _balanceAfter: Money | undefined;
  private _attempts: number;
  private _nextAttemptAt: Date | undefined;
  private _updatedAt: Date;
  private _processedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.kind = state.kind;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.money = state.money;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._balanceAfter = state.balanceAfter;
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt;
    this._updatedAt = state.updatedAt;
    this._processedAt = state.processedAt;
  }

  /** Uma operação de provedor. Nasce PENDING; valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId } = props;

    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if ((kind === WagerTransactionKind.Bet || kind === WagerTransactionKind.Loss) && referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${kind} cannot reference another transaction`);
    }
    if (referenceExternalTransactionId !== undefined && referenceExternalTransactionId === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("A transaction cannot reference itself");
    }
    if (money.isNegative() || (kind !== WagerTransactionKind.Loss && money.isZero())) {
      throw new InvalidWagerTransactionError(
        kind === WagerTransactionKind.Loss ? "LOSS amount cannot be negative" : `${kind} amount must be greater than zero`,
      );
    }

    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      attempts: 0,
      updatedAt: props.createdAt,
    });
  }

  /** Crédito interno de abertura, aplicado na mesma transação SQL que cria a wallet. */
  static opening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    return new WagerTransaction({
      id: props.id,
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Processed,
      walletId: props.walletId,
      playerId: props.playerId,
      money: props.money,
      balanceAfter: props.money,
      attempts: 0,
      createdAt: props.at,
      updatedAt: props.at,
      processedAt: props.at,
    });
  }

  /** Reconstrução a partir da persistência; não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transições (lançam InvalidTransactionStateError a partir de um estado terminal)

  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal("markProcessed");
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidTransactionStateError(`${this.kind} ${this.id} cannot be processed without its reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._nextAttemptAt = undefined;
    this._processedAt = at;
    this._updatedAt = at;
  }

  /** Registra mais uma tentativa frustrada de resolver a referência e quando tentar de novo. */
  markPendingReference(nextAttemptAt: Date, at: Date): void {
    this.assertNotTerminal("markPendingReference");
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`${this.kind} ${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    this._updatedAt = at;
  }

  reject(code: FailureCode, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.isReversal();
  }

  isReversal(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Undefined para LOSS (sem efeito no saldo). ROLLBACK é o inverso da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        const referenceDirection = reference?.ledgerDirectionFor();
        if (referenceDirection === undefined) {
          throw new InvalidTransactionStateError(`ROLLBACK ${this.id} direction requires a balance-moving reference`);
        }
        return oppositeDirection(referenceDirection);
      }
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${transition}: transaction ${this.id} is already ${this._status}`);
    }
  }
}
