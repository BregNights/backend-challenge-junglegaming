import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { WAGERING_METRICS, type WageringMetrics } from "../shared/application/metrics";
import type { TransactionalStore, UnitOfWork } from "../shared/application/unit-of-work";
import { translateDatabaseError } from "./database-errors";
import { MikroOrmStore } from "./mikro-orm-store";

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
  ) {}

  async run<T>(work: (store: TransactionalStore) => Promise<T>): Promise<T> {
    try {
      // A fresh fork per unit of work: an empty identity map, so nothing read in
      // a previous attempt (or request) can leak stale state into this one.
      return await this.em.fork().transactional((em) => work(new MikroOrmStore(em)));
    } catch (error) {
      throw translateDatabaseError(error, this.metrics);
    }
  }
}
