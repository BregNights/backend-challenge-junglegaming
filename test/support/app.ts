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

/** Boots the real application (all modules, real Postgres) on a random port. */
export async function startTestApp(): Promise<TestApp> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "silent";
  process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  process.env.DATABASE_POOL_MAX ??= "20";

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
