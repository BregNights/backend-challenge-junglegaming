import { Global, Module } from "@nestjs/common";
import { UNIT_OF_WORK } from "../shared/application/unit-of-work";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work";

@Global()
@Module({
  providers: [{ provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork }],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
