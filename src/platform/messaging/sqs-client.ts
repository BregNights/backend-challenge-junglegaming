import { SQSClient } from "@aws-sdk/client-sqs";
import type { SqsConfig } from "../config/app-config";

/** As credenciais vêm da cadeia padrão de providers do SDK (variáveis de ambiente, localmente). */
export function createSqsClient(config: SqsConfig): SQSClient {
  return new SQSClient({ region: config.region, endpoint: config.endpoint });
}
