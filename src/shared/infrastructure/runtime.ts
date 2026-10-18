import { Injectable } from "@nestjs/common";
import type { Clock, IdGenerator } from "../application/ports";

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: time-ordered, so primary-key inserts stay append-friendly for the btree. */
@Injectable()
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
