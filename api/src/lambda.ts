// AWS Lambda entry point, invoked through a Lambda Function URL. The Function URL
// handles CORS (configured in the CDK stack), so the handler doesn't add CORS headers.

import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from "aws-lambda";
import { loadConfig, makeDocClient } from "./config.ts";
import { DynamoStore } from "./dynamo-store.ts";
import { createHandler } from "./handlers.ts";
import { makePuller, parseSources } from "./pull.ts";
import { ensureRobot } from "./table.ts";

let ready: Promise<(req: Request) => Promise<Response>> | undefined;

async function init() {
  const config = { ...(await loadConfig()), corsOrigins: null };
  const doc = makeDocClient();
  await ensureRobot(doc, config.tableName);
  const store = new DynamoStore(doc, config.tableName);
  const pullMinutes = Number(process.env.SNAPSHOT_PULL_MINUTES ?? 2);
  return createHandler({ store, config, pull: makePuller(store, parseSources(process.env.SNAPSHOT_SOURCES), pullMinutes * 60_000) });
}

export async function handler(event: LambdaFunctionURLEvent): Promise<APIGatewayProxyStructuredResultV2> {
  ready ??= init().catch((e) => { ready = undefined; throw e; });
  const handle = await ready;
  const method = event.requestContext.http.method;
  const url = `https://${event.requestContext.domainName}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const body = event.body && !["GET", "HEAD"].includes(method)
    ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body)
    : undefined;
  const res = await handle(new Request(url, { method, headers: event.headers as Record<string, string>, body }));
  return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}
