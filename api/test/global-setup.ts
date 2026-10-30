// Start an in-memory DynamoDB Local for the test run (needs tools/dynamodb-local; run
// scripts/get-dynamodb-local.ps1 once). Uses port 8002 so it doesn't clash with the demo.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

const PORT = 8002;

function findJava(): string {
  try {
    const script = resolve(import.meta.dirname, "../../scripts/find-java.ps1");
    return execFileSync("pwsh", ["-NoProfile", "-File", script], { encoding: "utf8" }).trim();
  } catch {
    return "java";
  }
}

async function waitForPort(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`DynamoDB Local did not start on ${url}`);
}

export default async function setup(project: TestProject) {
  const dir = resolve(import.meta.dirname, "../../tools/dynamodb-local");
  if (!existsSync(join(dir, "DynamoDBLocal.jar"))) {
    throw new Error("DynamoDB Local not found. Run scripts/get-dynamodb-local.ps1 first.");
  }
  const proc: ChildProcess = spawn(findJava(), [
    `-Djava.library.path=${join(dir, "DynamoDBLocal_lib")}`, "-jar", join(dir, "DynamoDBLocal.jar"),
    "-inMemory", "-port", String(PORT),
  ], { cwd: dir, stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${PORT}`;
  await waitForPort(endpoint, 30000);
  project.provide("ddbEndpoint", endpoint);
  return () => { proc.kill(); };
}

declare module "vitest" {
  export interface ProvidedContext {
    ddbEndpoint: string;
  }
}
