import { Global, Module } from "@nestjs/common";
import { CLOCK, FAULT_INJECTOR, ID_GENERATOR } from "../shared/application/ports";
import { SystemClock, UuidV7Generator } from "../shared/infrastructure/runtime";
import { ConfiguredFaultInjector } from "./fault-injector";

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: FAULT_INJECTOR, useClass: ConfiguredFaultInjector },
  ],
  exports: [CLOCK, ID_GENERATOR, FAULT_INJECTOR],
})
export class CoreModule {}
