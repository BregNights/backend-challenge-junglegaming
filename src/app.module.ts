import { Module } from "@nestjs/common";
import { ConfigModule } from "./platform/config/config.module";
import { DatabaseModule } from "./platform/database/database.module";
import { HealthModule } from "./platform/health/health.module";
import { LoggingModule } from "./platform/logging/logging.module";
import { SqsModule } from "./platform/messaging/sqs.module";

@Module({
  imports: [ConfigModule, LoggingModule, DatabaseModule, SqsModule, HealthModule],
})
export class AppModule {}
