import { Inject, Injectable } from "@nestjs/common";
import type { CrashPoint, FaultInjector } from "../shared/application/ports";
import { AppConfig } from "./config/app-config";

@Injectable()
export class ConfiguredFaultInjector implements FaultInjector {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  /** Simula um crash bruto: sem shutdown hooks, sem ack, sem commit de transação aberta. */
  crashIf(point: CrashPoint): void {
    if (this.config.workers.faultInjection !== point) return;
    process.kill(process.pid, "SIGKILL");
    process.exit(137);
  }
}
