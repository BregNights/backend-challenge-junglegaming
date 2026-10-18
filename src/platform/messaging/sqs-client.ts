import { SQSClient } from "@aws-sdk/client-sqs";
import type { SqsConfig } from "../config/app-config";

/** Credentials come from the SDK default provider chain (env vars locally). */
export function createSqsClient(config: SqsConfig): SQSClient {
  return new SQSClient({ region: config.region, endpoint: config.endpoint });
}
