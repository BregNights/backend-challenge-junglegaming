import { AppConfig } from "../config/app-config";
import { provisionQueues } from "./queue-topology";
import { createSqsClient } from "./sqs-client";

const config = AppConfig.fromEnv();
const client = createSqsClient(config.sqs);

try {
  const urls = await provisionQueues(client, config.sqs);
  console.log(`Queues ready:\n  wager:     ${urls.wager}\n  wager-dlq: ${urls.wagerDlq}\n  events:    ${urls.events}`);
} finally {
  client.destroy();
}
