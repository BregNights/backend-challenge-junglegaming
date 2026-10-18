import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import type { DatabaseConfig } from "../config/app-config";
import { migrations } from "./migrations";

/**
 * Single source of ORM configuration, shared by the Nest module, the migration
 * runner and the integration tests.
 *
 * Entities and migrations are listed explicitly instead of discovered by glob:
 * discovery depends on file layout and transpiler detection, which is fragile
 * under Bun and gives nothing in return here.
 */
export function buildOrmConfig(database: DatabaseConfig) {
  return defineConfig({
    clientUrl: database.url,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: migrations,
      tableName: "schema_migrations",
      transactional: true,
      allOrNothing: true,
      // Migrations are hand-written SQL; the ORM never diffs or generates the schema.
      snapshot: false,
      snapshotOnMigrate: false,
    },
    pool: { min: 0, max: database.poolMax },
    // Passed straight to the `pg` pool, applied to every session.
    driverOptions: {
      // A wallet lock that cannot be acquired quickly becomes a transient error
      // (503 / SQS retry) instead of an unbounded wait.
      lock_timeout: database.lockTimeoutMs,
      statement_timeout: database.statementTimeoutMs,
      // A crashed or stuck worker must not hold row locks forever.
      idle_in_transaction_session_timeout: database.idleInTransactionTimeoutMs,
      application_name: "wagering-processor",
    },
    debug: false,
  });
}
