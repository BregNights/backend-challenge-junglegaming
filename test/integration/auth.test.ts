import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "../../src/app.module";
import { UnauthenticatedError } from "../../src/shared/application/errors";
import { type Caller, PROVIDER_IDENTITY, type ProviderIdentityPort } from "../../src/shared/application/provider-identity";
import { type ApiClient, apiClient, testEnvironment } from "../support/app";
import { createTestOrm, resetSchema } from "../support/database";
import { ledgerOf, wagerBody } from "../support/wagering";

/**
 * Authentication is not implemented, but its extension point is real: swapping
 * the no-op ProviderIdentityPort for an OIDC-like adapter is enough to enforce
 * credentials and provider identity, with health and metrics left public.
 */

class FakeOidcIdentity implements ProviderIdentityPort {
  async authenticate({ authorization }: { authorization?: string }): Promise<Caller> {
    if (authorization === "Bearer provider-a-token") return { kind: "provider", providerId: "provider-a" };
    if (authorization === "Bearer operator-token") return { kind: "unrestricted" };
    throw new UnauthenticatedError("Missing or invalid bearer token");
  }
}

const asProviderA = { Authorization: "Bearer provider-a-token" };
const asOperator = { Authorization: "Bearer operator-token" };

let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;
let api: ApiClient;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  Object.assign(process.env, testEnvironment());

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PROVIDER_IDENTITY)
    .useClass(FakeOidcIdentity)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  api = apiClient(baseUrl);
});

afterAll(async () => {
  await app?.close();
  await orm?.close(true);
});

async function openWallet() {
  const playerId = Bun.randomUUIDv7();
  const response = await api.post("/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } }, asOperator);
  expect(response.status).toBe(201);
  return { id: response.body.id as string, playerId };
}

describe("authentication extension point", () => {
  test("health checks and metrics stay public", async () => {
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(200);
  });

  test("missing or invalid credentials are 401 everywhere else", async () => {
    const anonymous = await api.post("/wallets", { playerId: Bun.randomUUIDv7(), initialBalance: { amount: "1.00", currency: "BRL" } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe("UNAUTHENTICATED");
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");

    expect((await api.get(`/wallets/${Bun.randomUUIDv7()}`, { Authorization: "Bearer forged" })).status).toBe(401);
  });

  test("a provider submits only its own operations", async () => {
    const wallet = await openWallet();

    const own = wagerBody(wallet, { kind: "BET", amount: "10.00", providerId: "provider-a" });
    const accepted = await api.post("/wagering/transactions", own.body, { ...asProviderA, "Idempotency-Key": own.idempotencyKey });
    expect(accepted.status).toBe(200);

    const foreign = wagerBody(wallet, { kind: "BET", amount: "10.00", providerId: "provider-b" });
    const forbidden = await api.post("/wagering/transactions", foreign.body, { ...asProviderA, "Idempotency-Key": foreign.idempotencyKey });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe("PROVIDER_FORBIDDEN");

    // Nothing was persisted for the forbidden attempt.
    expect((await ledgerOf(orm, wallet.id)).filter((entry) => entry.direction === "DEBIT")).toHaveLength(1);
  });

  test("a provider reads only its own transactions", async () => {
    const wallet = await openWallet();
    const mine = wagerBody(wallet, { kind: "WIN", amount: "1.00", providerId: "provider-a" });
    const theirs = wagerBody(wallet, { kind: "WIN", amount: "1.00", providerId: "provider-b" });
    const myTransaction = await api.post("/wagering/transactions", mine.body, { ...asOperator, "Idempotency-Key": mine.idempotencyKey });
    const theirTransaction = await api.post("/wagering/transactions", theirs.body, { ...asOperator, "Idempotency-Key": theirs.idempotencyKey });

    expect((await api.get(`/wagering/transactions/${myTransaction.body.transactionId}`, asProviderA)).status).toBe(200);
    expect((await api.get(`/wagering/transactions/${theirTransaction.body.transactionId}`, asProviderA)).status).toBe(403);
    expect((await api.get(`/providers/provider-b/wagering/transactions/${theirs.body.externalTransactionId}`, asProviderA)).status).toBe(403);
    expect((await api.get(`/providers/provider-b/wagering/transactions/${theirs.body.externalTransactionId}`, asOperator)).status).toBe(200);
  });
});
