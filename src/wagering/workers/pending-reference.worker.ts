import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { AppConfig } from "../../platform/config/app-config";
import { PollingLoop } from "../../platform/workers/polling-loop";
import { CLOCK, type Clock } from "../../shared/application/ports";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { addMs } from "../../shared/domain/backoff";
import { ResolvePendingReference } from "../application/resolve-pending-reference";

/** A claim not resolved within this window (worker crashed) becomes due again. */
const CLAIM_LEASE_MS = 30_000;

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private loop: PollingLoop | undefined;

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ResolvePendingReference) private readonly resolve: ResolvePendingReference,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.runs("pending-reference-worker")) return;
    this.loop = new PollingLoop(
      "pending-reference-worker",
      this.config.workers.pendingReferencePollIntervalMs,
      () => this.tick(),
      this.logger,
    );
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }

  /** Claims a batch (short transaction), then resolves each claim in its own transaction. */
  async tick(): Promise<boolean> {
    const now = this.clock.now();
    const batchSize = this.config.workers.pendingReferenceBatchSize;
    const claims = await this.uow.run((store) =>
      store.transactions.claimDuePendingReferences(now, addMs(now, CLAIM_LEASE_MS), batchSize),
    );

    for (const claim of claims) {
      try {
        await this.resolve.execute(claim);
      } catch (error) {
        // The lease expires and the claim is retried on a later tick.
        this.logger.warn({
          msg: "pending reference resolution failed",
          transactionId: claim.id,
          walletId: claim.walletId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return claims.length === batchSize;
  }
}
