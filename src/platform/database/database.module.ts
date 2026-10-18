import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { AppConfig } from "../config/app-config";
import { buildOrmConfig } from "./mikro-orm.config";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => buildOrmConfig(config.database),
    }),
  ],
})
export class DatabaseModule {}
