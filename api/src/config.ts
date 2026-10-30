// Runtime settings. On AWS the secrets come from SSM Parameter Store (SSM_PREFIX set by
// the CDK stack); locally they come from environment variables, loaded from api/.env.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";

export interface Config {
  passcode: string;
  tokenSecret: string;
  snapshotKey: string;
  tableName: string;
  /** Origins the API answers CORS for itself; null when the Function URL handles CORS. */
  corsOrigins: string[] | null;
}

const SECRET_NAMES = ["PASSCODE", "TOKEN_SECRET", "SNAPSHOT_KEY"] as const;

async function readSecrets(): Promise<Record<string, string>> {
  const prefix = process.env.SSM_PREFIX;
  if (!prefix) {
    return Object.fromEntries(SECRET_NAMES.map((n) => [n, process.env[n] ?? ""]));
  }
  const out = await new SSMClient({}).send(new GetParametersCommand({
    Names: SECRET_NAMES.map((n) => `${prefix}${n}`),
    WithDecryption: true,
  }));
  if (out.InvalidParameters?.length) throw new Error(`Missing SSM parameters: ${out.InvalidParameters.join(", ")}`);
  return Object.fromEntries((out.Parameters ?? []).map((p) => [p.Name!.slice(prefix.length), p.Value ?? ""]));
}

export async function loadConfig(): Promise<Config> {
  const s = await readSecrets();
  for (const n of SECRET_NAMES) if (!s[n]) throw new Error(`Secret ${n} is not set`);
  const cors = process.env.CORS_ORIGINS;
  return {
    passcode: s.PASSCODE,
    tokenSecret: s.TOKEN_SECRET,
    snapshotKey: s.SNAPSHOT_KEY,
    tableName: process.env.TABLE_NAME ?? "electrical-contract",
    corsOrigins: cors ? cors.split(",").map((o) => o.trim()) : null,
  };
}

/** DynamoDB client; DYNAMODB_ENDPOINT points it at DynamoDB Local. */
export function makeDocClient(endpoint = process.env.DYNAMODB_ENDPOINT): DynamoDBDocumentClient {
  const client = endpoint
    ? new DynamoDBClient({ endpoint, region: "us-west-2", credentials: { accessKeyId: "local", secretAccessKey: "local" } })
    : new DynamoDBClient({});
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}
