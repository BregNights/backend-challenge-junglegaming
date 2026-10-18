import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MessagingModule } from "./messaging/messaging.module";
import { PersistenceModule } from "./persistence/persistence.module";
import { ConfigModule } from "./platform/config/config.module";
import { CoreModule } from "./platform/core.module";
import { DatabaseModule } from "./platform/database/database.module";
import { HealthModule } from "./platform/health/health.module";
import { HttpErrorFilter } from "./platform/http/http-error.filter";
import { LoggingModule } from "./platform/logging/logging.module";
import { SqsModule } from "./platform/messaging/sqs.module";
import { ObservabilityModule } from "./platform/observability/observability.module";
import { WageringModule } from "./wagering/wagering.module";
import { WalletModule } from "./wallet/wallet.module";

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    CoreModule,
    ObservabilityModule,
    DatabaseModule,
    PersistenceModule,
    SqsModule,
    HealthModule,
    WalletModule,
    WageringModule,
    MessagingModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
})
export class AppModule {}
