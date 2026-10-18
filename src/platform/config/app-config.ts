export const APP_ROLES = ["api", "sqs-consumer", "outbox-publisher", "pending-reference-worker"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

export interface SqsConfig {
  readonly region: string;
  /** Unset in real AWS; points to MiniStack locally. */
  readonly endpoint: string | undefined;
  readonly wagerQueueName: string;
  readonly wagerDlqName: string;
  readonly eventsQueueName: string;
  readonly maxReceiveCount: number;
  readonly visibilityTimeoutSeconds: number;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Typed, validated view over environment variables. Built once at bootstrap so a
 * misconfigured instance fails fast instead of at the first request.
 */
export class AppConfig {
  private constructor(
    readonly port: number,
    readonly logLevel: string,
    readonly logPretty: boolean,
    readonly roles: ReadonlySet<AppRole>,
    readonly database: DatabaseConfig,
    readonly sqs: SqsConfig,
  ) {}

  static fromEnv(env: Env = process.env): AppConfig {
    const reader = new EnvReader(env);

    const config = new AppConfig(
      reader.int("PORT", 3000),
      reader.string("LOG_LEVEL", "info"),
      reader.bool("LOG_PRETTY", false),
      reader.roles("APP_ROLES"),
      {
        url: reader.required("DATABASE_URL"),
        poolMax: reader.int("DATABASE_POOL_MAX", 10),
        lockTimeoutMs: reader.int("DATABASE_LOCK_TIMEOUT_MS", 3_000),
        statementTimeoutMs: reader.int("DATABASE_STATEMENT_TIMEOUT_MS", 10_000),
        idleInTransactionTimeoutMs: reader.int("DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", 30_000),
      },
      {
        region: reader.string("AWS_REGION", "us-east-1"),
        endpoint: reader.optional("AWS_ENDPOINT_URL"),
        wagerQueueName: reader.string("SQS_WAGER_QUEUE", "wager-transactions.fifo"),
        wagerDlqName: reader.string("SQS_WAGER_DLQ", "wager-transactions-dlq.fifo"),
        eventsQueueName: reader.string("SQS_EVENTS_QUEUE", "wallet-events.fifo"),
        maxReceiveCount: reader.int("SQS_MAX_RECEIVE_COUNT", 5),
        visibilityTimeoutSeconds: reader.int("SQS_VISIBILITY_TIMEOUT_SECONDS", 30),
      },
    );

    reader.assertValid();
    return config;
  }

  runs(role: AppRole): boolean {
    return this.roles.has(role);
  }
}

class EnvReader {
  private readonly problems: string[] = [];

  constructor(private readonly env: Env) {}

  optional(name: string): string | undefined {
    const value = this.env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  }

  required(name: string): string {
    const value = this.optional(name);
    if (value === undefined) {
      this.problems.push(`${name} is required`);
      return "";
    }
    return value;
  }

  string(name: string, fallback: string): string {
    return this.optional(name) ?? fallback;
  }

  int(name: string, fallback: number): number {
    const raw = this.optional(name);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) {
      this.problems.push(`${name} must be a non-negative integer, got "${raw}"`);
      return fallback;
    }
    return Number(raw);
  }

  bool(name: string, fallback: boolean): boolean {
    const raw = this.optional(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    this.problems.push(`${name} must be true or false, got "${raw}"`);
    return fallback;
  }

  roles(name: string): ReadonlySet<AppRole> {
    const raw = this.optional(name);
    if (raw === undefined) return new Set(APP_ROLES);

    const roles = new Set<AppRole>();
    for (const candidate of raw.split(",").map((role) => role.trim()).filter(Boolean)) {
      if ((APP_ROLES as readonly string[]).includes(candidate)) {
        roles.add(candidate as AppRole);
      } else {
        this.problems.push(`${name} contains unknown role "${candidate}" (expected: ${APP_ROLES.join(", ")})`);
      }
    }
    return roles;
  }

  assertValid(): void {
    if (this.problems.length > 0) throw new ConfigError(this.problems);
  }
}
