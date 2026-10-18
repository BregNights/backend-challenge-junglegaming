import { Module } from "@nestjs/common";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { WagerQueries } from "./application/wager-queries";
import { WageringController } from "./http/wagering.controller";

@Module({
  controllers: [WageringController],
  providers: [ProcessWagerTransaction, WagerQueries],
  exports: [ProcessWagerTransaction],
})
export class WageringModule {}
