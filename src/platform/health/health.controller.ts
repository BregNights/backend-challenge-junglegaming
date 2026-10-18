import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/core";
import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/auth.guard";
import { AppConfig } from "../config/app-config";

const CHECK_TIMEOUT_MS = 2_000;

interface DependencyCheck {
  status: "up" | "down";
  error?: string;
}

/** Os endpoints de health são sem autenticação de propósito (ver ARCHITECTURE.md). */
@Public()
@Controller("health")
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(AppConfig) private readonly config: AppConfig,
  ) {}

  /** O processo está vivo e atendendo; as dependências não são verificadas. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** PostgreSQL e SQS estão acessíveis; 503 diz ao orquestrador para parar de rotear tráfego. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    const [database, sqs] = await Promise.all([this.checkDatabase(), this.checkSqs()]);
    const ready = database.status === "up" && sqs.status === "up";
    response.status(ready ? 200 : 503);
    return { status: ready ? "ok" : "unavailable", checks: { database, sqs } };
  }

  /** Uma ida e volta real: as conexões são preguiçosas, então checkConnection() sozinho não diz nada antes do primeiro uso. */
  private async checkDatabase(): Promise<DependencyCheck> {
    try {
      await withTimeout(this.orm.em.getConnection().execute("select 1"), CHECK_TIMEOUT_MS);
      return { status: "up" };
    } catch (error) {
      return { status: "down", error: describe(error) };
    }
  }

  private async checkSqs(): Promise<DependencyCheck> {
    try {
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueueName }), {
        abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      return { status: "up" };
    } catch (error) {
      return { status: "down", error: describe(error) };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
