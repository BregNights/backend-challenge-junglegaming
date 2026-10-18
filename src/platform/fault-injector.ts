import { Inject, Injectable } from "@nestjs/common";
import type { CrashPoint, FaultInjector } from "../shared/application/ports";
import { AppConfig } from "./config/app-config";

@Injectable()
export class ConfiguredFaultInjector implements FaultInjector {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  /** Simulates a hard crash: no shutdown hooks, no ack, no commit of an open transaction. */
  crashIf(point: CrashPoint): void {
    if (this.config.workers.faultInjection !== point) return;
    process.kill(process.pid, "SIGKILL");
    process.exit(137);
  }
}
