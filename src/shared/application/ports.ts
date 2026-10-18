export const CLOCK = Symbol("Clock");
export interface Clock {
  now(): Date;
}

export const ID_GENERATOR = Symbol("IdGenerator");
export interface IdGenerator {
  /** Id único ordenado no tempo (UUIDv7). */
  next(): string;
}

export type CrashPoint = "crash-after-commit" | "crash-after-publish";

export const FAULT_INJECTOR = Symbol("FaultInjector");
/**
 * Pontos de crash usados só em testes para provar a recuperação (por exemplo, um
 * worker morto entre o commit e o ack). Inertes sem a configuração explícita.
 */
export interface FaultInjector {
  crashIf(point: CrashPoint): void;
}
