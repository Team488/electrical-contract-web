// Table layout (single table, see plan §4) and first-run setup.
// On AWS the table itself is created by the CDK stack; locally by createTableIfMissing.

import { CreateTableCommand, DescribeTableCommand, ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const robotPk = (robotId: number) => `ROBOT#${robotId}`;
export const snapPk = (robotId: number) => `SNAP#${robotId}`;
export const auditPk = (robotId: number) => `AUDIT#${robotId}`;
export const META = "META";

export const PDH_PORTS = Array.from({ length: 24 }, (_, i) => `PDH${String(i).padStart(2, "0")}`);
export const VRM1_PORTS = ["12V_2A", "12V_2B", "12V_500MA", "12V_500MB", "5V_2A", "5V_2B", "5V_500MA", "5V_500MB"]
  .map((p) => `VRM1_${p}`);

export async function createTableIfMissing(doc: DynamoDBDocumentClient, tableName: string): Promise<void> {
  try {
    await doc.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
  }
  await doc.send(new CreateTableCommand({
    TableName: tableName,
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
    BillingMode: "PAY_PER_REQUEST",
  }));
}

/** Create the 2026 robot and its power ports if the table doesn't have them yet. */
export async function ensureRobot(doc: DynamoDBDocumentClient, tableName: string, robotId = 1): Promise<void> {
  const meta = await doc.send(new GetCommand({ TableName: tableName, Key: { pk: robotPk(robotId), sk: META } }));
  if (meta.Item) return;
  const now = new Date().toISOString();
  const items = [
    { pk: robotPk(robotId), sk: META, id: robotId, name: "2026 Competition", season: 2026,
      contract_class: "Contract2026", rev: 0, seeded: 0, nextId: 0 },
    ...[...PDH_PORTS, ...VRM1_PORTS].map((port) => ({
      pk: robotPk(robotId), sk: `PORT#${port}`, robot_id: robotId, port,
      breaker_a: null, wire_awg: null, notes: "", version: 1, updated_by: null, updated_at: now,
    })),
  ];
  for (let i = 0; i < items.length; i += 25) {
    let request = { [tableName]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
    while (Object.keys(request).length) {
      const out = await doc.send(new BatchWriteCommand({ RequestItems: request }));
      request = (out.UnprocessedItems ?? {}) as typeof request;
    }
  }
}
