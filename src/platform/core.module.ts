import { Global, Module } from "@nestjs/common";
import { CLOCK, ID_GENERATOR } from "../shared/application/ports";
import { SystemClock, UuidV7Generator } from "../shared/infrastructure/runtime";

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [CLOCK, ID_GENERATOR],
})
export class CoreModule {}
