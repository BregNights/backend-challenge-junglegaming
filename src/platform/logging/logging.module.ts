import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { AppConfig } from "../config/app-config";

export const CORRELATION_ID_HEADER = "x-correlation-id";
// Qualquer outra coisa é substituída, para que ninguém injete conteúdo arbitrário nos logs.
const CORRELATION_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * Logs JSON estruturados. Corpos de requisição e resposta nunca são logados (levam
 * payloads financeiros); identificadores como walletId e transactionId entram como
 * campos pelos trechos de código que os conhecem.
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
