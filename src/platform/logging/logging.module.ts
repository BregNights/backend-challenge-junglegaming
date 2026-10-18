import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { AppConfig } from "../config/app-config";

export const CORRELATION_ID_HEADER = "x-correlation-id";
// Anything else is replaced, so callers cannot inject arbitrary content into logs.
const CORRELATION_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * Structured JSON logs. Request/response bodies are never logged (they carry
 * financial payloads); identifiers such as walletId and transactionId are added
 * as fields by the code paths that know them.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          transport: config.logPretty ? { target: "pino-pretty" } : undefined,
          genReqId: (request, response) => {
            const incoming = request.headers[CORRELATION_ID_HEADER];
            const correlationId =
              typeof incoming === "string" && CORRELATION_ID_PATTERN.test(incoming) ? incoming : randomUUID();
            response.setHeader(CORRELATION_ID_HEADER, correlationId);
            return correlationId;
          },
          customProps: (request) => ({ correlationId: request.id }),
          redact: ["req.headers.authorization", "req.headers.cookie", "req.headers[\"idempotency-key\"]"],
          autoLogging: { ignore: (request) => request.url?.startsWith("/health") ?? false },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
