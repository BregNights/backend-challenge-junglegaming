import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { entitySchemas } from "../../persistence/records";
import type { DatabaseConfig } from "../config/app-config";
import { migrations } from "./migrations";

/**
 * Fonte única da configuração do ORM, compartilhada pelo módulo Nest, pelo runner
 * de migrations e pelos testes de integração.
 *
 * Entidades e migrations são listadas explicitamente em vez de descobertas por glob:
 * a descoberta depende do layout de arquivos e da detecção do transpilador, o que é
 * frágil sob o Bun e não traz nada em troca aqui.
 */
export function buildOrmConfig(database: DatabaseConfig) {
  return defineConfig({
    clientUrl: database.url,
    entities: entitySchemas,
    extensions: [Migrator],
    migrations: {
      migrationsList: migrations,
      tableName: "schema_migrations",
      transactional: true,
      allOrNothing: true,
      // As migrations são SQL escrito à mão; o ORM nunca compara nem gera o schema.
      snapshot: false,
      snapshotOnMigrate: false,
    },
    pool: { min: 0, max: database.poolMax },
    // Repassado direto ao pool do `pg`, aplicado a toda sessão.
    driverOptions: {
      // Um lock de wallet que não sai rápido vira erro transitório
      // (503 / retry no SQS) em vez de uma espera sem limite.
      lock_timeout: database.lockTimeoutMs,
      statement_timeout: database.statementTimeoutMs,
      // Um worker que travou ou morreu não pode segurar locks de linha para sempre.
      idle_in_transaction_session_timeout: database.idleInTransactionTimeoutMs,
      application_name: "wagering-processor",
    },
    debug: false,
  });
}
