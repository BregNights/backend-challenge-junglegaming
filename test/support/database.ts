import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "../../src/platform/database/mikro-orm.config";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering_test";

export async function createTestOrm(): Promise<MikroORM> {
  const databaseName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  // resetSchema drops everything: refuse to point it at anything but a test database.
  if (!databaseName.endsWith("_test")) {
    throw new Error(`Refusing to run integration tests against "${databaseName}" (name must end with _test)`);
  }

  return MikroORM.init(
    buildOrmConfig({
      url: TEST_DATABASE_URL,
      poolMax: 20,
      lockTimeoutMs: 3_000,
      statementTimeoutMs: 10_000,
      idleInTransactionTimeoutMs: 30_000,
    }),
  );
}

/** Drops every object and re-applies all migrations, so each test file starts clean. */
export async function resetSchema(orm: MikroORM): Promise<void> {
  await orm.em.execute("drop schema public cascade");
  await orm.em.execute("create schema public");
  await orm.migrator.up();
}
