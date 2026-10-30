// Send a Java contract snapshot to the API.
// Usage: node scripts/import-snapshot.mjs <snapshot.json> [apiBase]
// Key: SNAPSHOT_KEY env var, else api/.env.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [file, base = "http://localhost:8787"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scripts/import-snapshot.mjs <snapshot.json> [apiBase]");
  process.exit(2);
}

let key = process.env.SNAPSHOT_KEY;
if (!key) {
  const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", "api", ".env");
  key = readFileSync(envFile, "utf8").match(/^SNAPSHOT_KEY=(.*)$/m)?.[1]?.trim();
}

const res = await fetch(`${base}/api/robots/1/snapshot`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-snapshot-key": key },
  body: readFileSync(file, "utf8"),
});
const out = await res.json();
console.log(res.status, out);
process.exit(res.ok ? 0 : 1);
