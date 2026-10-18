export const CLOCK = Symbol("Clock");
export interface Clock {
  now(): Date;
}

export const ID_GENERATOR = Symbol("IdGenerator");
export interface IdGenerator {
  /** Time-ordered unique id (UUIDv7). */
  next(): string;
}

export type CrashPoint = "crash-after-commit" | "crash-after-publish";

export const FAULT_INJECTOR = Symbol("FaultInjector");
/**
 * Test-only crash points used to prove recovery (e.g. a worker killed between
 * commit and ack). Inert unless explicitly enabled by configuration.
 */
export interface FaultInjector {
  crashIf(point: CrashPoint): void;
}
