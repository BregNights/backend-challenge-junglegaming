import { SQSClient } from "@aws-sdk/client-sqs";
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { AppConfig } from "../config/app-config";
import { createSqsClient } from "./sqs-client";

@Global()
@Module({
  providers: [{ provide: SQSClient, inject: [AppConfig], useFactory: (config: AppConfig) => createSqsClient(config.sqs) }],
  exports: [SQSClient],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
