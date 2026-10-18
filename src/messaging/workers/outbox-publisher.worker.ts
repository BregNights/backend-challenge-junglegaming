import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { AppConfig } from "../../platform/config/app-config";
import { PollingLoop } from "../../platform/workers/polling-loop";
import { OutboxPublisher } from "../application/outbox-publisher";

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private loop: PollingLoop | undefined;

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.runs("outbox-publisher")) return;
    const { outboxBatchSize, outboxPollIntervalMs } = this.config.workers;
    this.loop = new PollingLoop(
      "outbox-publisher",
      outboxPollIntervalMs,
      async () => (await this.publisher.publishBatch(outboxBatchSize)) === outboxBatchSize,
      this.logger,
    );
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }
}
