import "reflect-metadata";
import { Logger as NestLogger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { AppConfig } from "./platform/config/app-config";

const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
// SIGTERM/SIGINT disparam os shutdown hooks (param os consumers, drenam o trabalho em andamento e fecham os pools).
app.enableShutdownHooks();

const config = app.get(AppConfig);
await app.listen(config.port);
new NestLogger("Bootstrap").log({ msg: "wagering-processor started", port: config.port, roles: [...config.roles] });
