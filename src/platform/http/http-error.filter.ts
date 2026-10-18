import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  IdempotencyConflictError,
  ProviderForbiddenError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  UnauthenticatedError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../shared/application/errors";
import { InvalidMoneyError } from "../../shared/domain/money";
import { InvalidWagerTransactionError } from "../../wagering/domain/wager-transaction";
import { InvalidWalletOperationError } from "../../wallet/domain/wallet";

interface ErrorResponse {
  status: number;
  body: { error: string; message: string; issues?: unknown };
  headers?: Record<string, string>;
}

/** Dica de retry para falhas transitórias; o provedor reenvia com a mesma Idempotency-Key. */
const RETRY_AFTER_SECONDS = "1";

/**
 * Um único mapeamento para todos os endpoints, para que só o status code já diga
 * ao provedor o que fazer: 400 corrigir o payload, 401/403 credenciais, 404
 * recurso inexistente, 409 conflito de idempotência, 422 rejeição de negócio
 * (devolvida pelos controllers, não lançada), 503 tentar de novo com a mesma chave.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const { status, body, headers } = this.map(exception);

    if (status >= 500) {
      this.logger.error({ msg: "request failed", correlationId: request.id, error: describe(exception), status });
    }
    for (const [name, value] of Object.entries(headers ?? {})) response.setHeader(name, value);
    response.status(status).json(body);
  }

  private map(exception: unknown): ErrorResponse {
    if (exception instanceof ValidationError) {
      return { status: 400, body: { error: exception.code, message: exception.message, issues: exception.issues } };
    }
    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof InvalidWagerTransactionError ||
      exception instanceof InvalidWalletOperationError
    ) {
      return { status: 400, body: { error: exception.code, message: exception.message } };
    }
    if (exception instanceof UnauthenticatedError) {
      return {
        status: 401,
        body: { error: exception.code, message: exception.message },
        headers: { "WWW-Authenticate": "Bearer" },
      };
    }
    if (exception instanceof ProviderForbiddenError) {
      return { status: 403, body: { error: exception.code, message: exception.message } };
    }
    if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      return { status: 404, body: { error: exception.code, message: exception.message } };
    }
    if (exception instanceof IdempotencyConflictError || exception instanceof WalletAlreadyExistsError) {
      return { status: 409, body: { error: exception.code, message: exception.message } };
    }
    if (exception instanceof TransientInfrastructureError) {
      return {
        status: 503,
        body: { error: exception.code, message: "Temporarily unavailable, retry with the same Idempotency-Key" },
        headers: { "Retry-After": RETRY_AFTER_SECONDS },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: { error: HttpStatus[status] ?? "HTTP_ERROR", message: exception.message },
      };
    }
    return { status: 500, body: { error: "INTERNAL_ERROR", message: "Unexpected error" } };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
