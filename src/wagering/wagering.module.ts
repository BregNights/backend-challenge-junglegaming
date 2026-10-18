import { Module } from "@nestjs/common";
import { AppConfig } from "../platform/config/app-config";
import { PENDING_REFERENCE_RETRY, PendingReferencePolicy } from "./application/pending-reference-policy";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { ResolvePendingReference } from "./application/resolve-pending-reference";
import { WagerQueries } from "./application/wager-queries";
import { WageringController } from "./http/wagering.controller";
import { WagerTransactionConsumer } from "./sqs/wager-transaction.consumer";
import { PendingReferenceWorker } from "./workers/pending-reference.worker";

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: PendingReferencePolicy,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new PendingReferencePolicy(PENDING_REFERENCE_RETRY, config.workers.pendingReferenceTtlMs),
    },
    ProcessWagerTransaction,
    ResolvePendingReference,
    WagerQueries,
    WagerTransactionConsumer,
    PendingReferenceWorker,
  ],
})
export class WageringModule {}
