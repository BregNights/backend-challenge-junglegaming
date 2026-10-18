import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentCaller } from "../../platform/auth/auth.guard";
import { identifierSchema, parseInput, uuidSchema } from "../../platform/http/validation";
import { assertCallerMayActAs, type Caller } from "../../shared/application/provider-identity";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import type { WagerTransactionResult, WagerTransactionView } from "../application/views";
import { WagerQueries } from "../application/wager-queries";
import { WagerTransactionStatus as Status } from "../domain/wager-transaction";
import { idempotencyKeySchema, wagerRequestSchema } from "../wager-request.schema";

/** Resultados decididos se distinguem só pelo status code. */
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
    @CurrentCaller() caller: Caller | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerTransactionResult> {
    const key = parseInput(idempotencyKeySchema, idempotencyKey, "Idempotency-Key header");
    const input = parseInput(wagerRequestSchema, body, "request body");
    assertCallerMayActAs(caller, input.providerId);

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
  async getById(
    @Param("transactionId") transactionId: string,
    @CurrentCaller() caller: Caller | undefined,
  ): Promise<WagerTransactionView> {
    const transaction = await this.queries.getById(parseInput(uuidSchema, transactionId, "transactionId"));
    assertCallerMayActAs(caller, transaction.providerId);
    return transaction;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @CurrentCaller() caller: Caller | undefined,
  ): Promise<WagerTransactionView> {
    const provider = parseInput(identifierSchema, providerId, "providerId");
    assertCallerMayActAs(caller, provider);
    return this.queries.getByExternalId(
      provider,
      parseInput(identifierSchema, externalTransactionId, "externalTransactionId"),
    );
  }
}
