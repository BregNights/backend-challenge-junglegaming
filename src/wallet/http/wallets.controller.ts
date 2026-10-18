import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { moneySchema, parseInput, uuidSchema } from "../../platform/http/validation";
import { OpenWallet } from "../application/open-wallet";
import type { LedgerPage, ReconciliationReport, WalletView } from "../application/views";
import { WalletQueries } from "../application/wallet-queries";

const openWalletSchema = z.object({ playerId: uuidSchema, initialBalance: moneySchema });

const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() request: Request): Promise<WalletView> {
    const input = parseInput(openWalletSchema, body, "request body");
    return this.openWallet.execute({ ...input, correlationId: String(request.id) });
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string): Promise<WalletView> {
    return this.queries.getWallet(parseInput(uuidSchema, walletId, "walletId"));
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId") walletId: string, @Query() query: unknown): Promise<LedgerPage> {
    const { cursor, limit } = parseInput(ledgerQuerySchema, query, "query");
    return this.queries.getLedger(parseInput(uuidSchema, walletId, "walletId"), { cursor, limit });
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string, @Req() request: Request): Promise<ReconciliationReport> {
    return this.queries.reconcile(parseInput(uuidSchema, walletId, "walletId"), String(request.id));
  }
}
