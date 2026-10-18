import { MikroORM } from "@mikro-orm/postgresql";
import { AppConfig } from "../config/app-config";
import { buildOrmConfig } from "./mikro-orm.config";

/**
 * Runner de migrations, usado no lugar da CLI do MikroORM (que depende de detectar
 * ts-node/tsx) para que as migrations rodem com um simples `bun run`.
 *
 *   bun run src/platform/database/migrate.ts up     # aplica todas as pendentes
 *   bun run src/platform/database/migrate.ts down   # reverte a última
 *   bun run src/platform/database/migrate.ts list   # executadas + pendentes
 */
const command = process.argv[2] ?? "up";
const orm = await MikroORM.init(buildOrmConfig(AppConfig.fromEnv().database));

try {
  switch (command) {
    case "up": {
      const applied = await orm.migrator.up();
      console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(", ")}` : "Schema is up to date.");
      break;
    }
    case "down": {
      const reverted = await orm.migrator.down();
      console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(", ")}` : "Nothing to revert.");
      break;
    }
    case "list": {
      const [executed, pending] = await Promise.all([orm.migrator.getExecuted(), orm.migrator.getPending()]);
      for (const migration of executed) console.log(`[x] ${migration.name}`);
      for (const migration of pending) console.log(`[ ] ${migration.name}`);
      break;
    }
    default:
      console.error(`Unknown command "${command}". Use: up | down | list`);
      process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
