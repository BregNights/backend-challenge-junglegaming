import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AddressInfo } from "node:net";
import { AppModule } from "../../src/app.module";
import { TEST_DATABASE_URL } from "./database";

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Environment for an application instance under test. Only the API role runs
 * unless a test asks for workers, so no instance ever polls queues it does not own.
 */
export function testEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_POOL_MAX: "20",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    APP_ROLES: "api",
    AWS_REGION: "us-east-1",
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    ...overrides,
  };
}

/** Boots the real application (all modules, real Postgres) on a random port. */
export async function startTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  Object.assign(process.env, testEnvironment(overrides));
  // Variables a previous test file may have set must not leak into this instance.
  for (const name of ["FAULT_INJECTION"]) if (!(name in overrides)) delete process.env[name];

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;

  return { app, baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export function apiClient(baseUrl: string) {
  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers } as ApiResponse<T>;
  }

  return {
    get: <T = any>(path: string) => request<T>("GET", path),
    post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>("POST", path, body, headers),
  };
}

export type ApiClient = ReturnType<typeof apiClient>;
