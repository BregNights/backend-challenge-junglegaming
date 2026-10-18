import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { identifierSchema, parseInput, uuidSchema } from "../../platform/http/validation";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import type { WagerTransactionResult, WagerTransactionView } from "../application/views";
import { WagerQueries } from "../application/wager-queries";
import { WagerTransactionStatus as Status } from "../domain/wager-transaction";
import { idempotencyKeySchema, wagerRequestSchema } from "../wager-request.schema";

/** Decided outcomes are distinguishable by status code alone. */
const STATUS_CODE: Record<Status, number> = {
  [Status.Processed]: 200,
  [Status.PendingReference]: 202,
  [Status.Pending]: 202,
  [Status.Rejected]: 422,
  [Status.Failed]: 422,
};

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWagerTransaction: ProcessWagerTransaction,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerTransactionResult> {
    const key = parseInput(idempotencyKeySchema, idempotencyKey, "Idempotency-Key header");
    const input = parseInput(wagerRequestSchema, body, "request body");

    const result = await this.processWagerTransaction.execute({
      ...input,
      idempotencyKey: key,
      correlationId: String(request.id),
      source: "http",
    });
    response.status(STATUS_CODE[result.status]);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  getById(@Param("transactionId") transactionId: string): Promise<WagerTransactionView> {
    return this.queries.getById(parseInput(uuidSchema, transactionId, "transactionId"));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.queries.getByExternalId(
      parseInput(identifierSchema, providerId, "providerId"),
      parseInput(identifierSchema, externalTransactionId, "externalTransactionId"),
    );
  }
}
