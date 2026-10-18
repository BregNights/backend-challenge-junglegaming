import { Controller, Get, Global, Inject, Module, Res } from "@nestjs/common";
import type { Response } from "express";
import { WAGERING_METRICS } from "../../shared/application/metrics";
import { Public } from "../auth/auth.guard";
import { PrometheusMetrics } from "./prometheus-metrics";

/** Prometheus scrape endpoint; unauthenticated like the health checks. */
@Public()
@Controller("metrics")
class MetricsController {
  constructor(@Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics) {}

  @Get()
  async scrape(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader("Content-Type", this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [PrometheusMetrics, { provide: WAGERING_METRICS, useExisting: PrometheusMetrics }],
  exports: [WAGERING_METRICS, PrometheusMetrics],
})
export class ObservabilityModule {}
