// Local demo server: the same handlers as Lambda, over Node's HTTP server, against
// DynamoDB Local. Settings come from api/.env (see .env.example).

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { loadConfig, makeDocClient } from "./config.ts";
import { DynamoStore } from "./dynamo-store.ts";
import { createHandler } from "./handlers.ts";
import { createTableIfMissing, ensureRobot } from "./table.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const config = await loadConfig();
const doc = makeDocClient();
// DynamoDB Local may still be starting; retry for up to a minute.
for (let attempt = 1; ; attempt++) {
  try {
    await createTableIfMissing(doc, config.tableName);
    break;
  } catch (e) {
    if (attempt >= 60) throw e;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await ensureRobot(doc, config.tableName);
const handle = createHandler({ store: new DynamoStore(doc, config.tableName), config });

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const method = req.method ?? "GET";
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method, headers, body: ["GET", "HEAD"].includes(method) ? undefined : Buffer.concat(chunks),
  });
  const started = Date.now();
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  console.log(`${method} ${req.url} ${response.status} (${Date.now() - started}ms)`);
}).listen(port, host, () => console.log(`API ready on http://${host}:${port}`));
