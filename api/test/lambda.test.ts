import { randomUUID } from "node:crypto";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { beforeAll, expect, inject, it } from "vitest";

// The Lambda entry point reads its settings from the environment at cold start.
beforeAll(() => {
  Object.assign(process.env, {
    DYNAMODB_ENDPOINT: inject("ddbEndpoint"), TABLE_NAME: `t-${randomUUID()}`,
    PASSCODE: "p", TOKEN_SECRET: "s", SNAPSHOT_KEY: "k",
  });
});

function event(method: string, path: string, body?: unknown): LambdaFunctionURLEvent {
  return {
    rawPath: path, rawQueryString: "", headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
    requestContext: { domainName: "example.lambda-url.us-west-2.on.aws", http: { method } },
  } as unknown as LambdaFunctionURLEvent;
}

it("serves the API through a Function URL event", async () => {
  const { createTableIfMissing } = await import("../src/table.ts");
  const { makeDocClient } = await import("../src/config.ts");
  await createTableIfMissing(makeDocClient(), process.env.TABLE_NAME!);
  const { handler } = await import("../src/lambda.ts");

  const robots = await handler(event("GET", "/api/robots"));
  expect(robots.statusCode).toBe(200);
  expect(JSON.parse(robots.body!)[0]).toMatchObject({ id: 1, name: "2026 Competition" });
  expect(robots.headers?.["access-control-allow-origin"]).toBeUndefined();

  const auth = await handler(event("POST", "/api/auth", { name: "Alex", passcode: "p" }));
  expect(auth.statusCode).toBe(200);
});
