import { Injectable } from "@nestjs/common";
import type { Clock, IdGenerator } from "../application/ports";

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: ordenado no tempo, então os inserts na chave primária continuam sequenciais para a btree. */
@Injectable()
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
