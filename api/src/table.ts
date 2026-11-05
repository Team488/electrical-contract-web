// Table layout (single table, see plan §4) and first-run setup.
// On AWS the table itself is created by the CDK stack; locally by createTableIfMissing.

import { CreateTableCommand, DescribeTableCommand, ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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

/** Season repo that robots created before repo support came from. */
export const DEFAULT_REPO = "Team488/TeamXbot2026";
export const REPO_RE = /^[A-Za-z0-9_.-]{1,40}\/[A-Za-z0-9_.-]{1,60}$/;

export interface RobotInfo {
  /** GitHub "owner/name" of the season repo whose contract this robot is. */
  repo: string;
  name: string;
  season: number | null;
  contract_name: string;
  contract_class: string;
  controller: "roborio";
}

/** Power ports each controller profile starts with (plan §10). Only roboRIO exists so far. */
export function portsForProfile(controller: RobotInfo["controller"]): string[] {
  switch (controller) {
    case "roborio":
      return [...PDH_PORTS, ...VRM1_PORTS];
  }
}

async function batchPut(doc: DynamoDBDocumentClient, tableName: string, items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let request = { [tableName]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
    while (Object.keys(request).length) {
      const out = await doc.send(new BatchWriteCommand({ RequestItems: request }));
      request = (out.UnprocessedItems ?? {}) as typeof request;
    }
  }
}

/** Create a robot record and its empty power ports. Fails if the robot id is taken. */
export async function createRobot(doc: DynamoDBDocumentClient, tableName: string, robotId: number, info: RobotInfo): Promise<void> {
  await doc.send(new PutCommand({
    TableName: tableName,
    Item: { pk: robotPk(robotId), sk: META, id: robotId, ...info, rev: 0, seeded: 0, nextId: 0 },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  const now = new Date().toISOString();
  await batchPut(doc, tableName, portsForProfile(info.controller).map((port) => ({
    pk: robotPk(robotId), sk: `PORT#${port}`, robot_id: robotId, port,
    breaker_a: null, wire_awg: null, notes: "", version: 1, updated_by: null, updated_at: now,
  })));
}

export const COMPETITION_2026: RobotInfo = {
  repo: DEFAULT_REPO, name: "2026 Competition", season: 2026, contract_name: "Competition", contract_class: "Contract2026", controller: "roborio",
};

/**
 * Make sure robot 1 (the 2026 competition robot) exists. Robot records created before
 * multi-robot support lack contract_name/controller; fill those in.
 */
export async function ensureRobot(doc: DynamoDBDocumentClient, tableName: string): Promise<void> {
  const meta = await doc.send(new GetCommand({ TableName: tableName, Key: { pk: robotPk(1), sk: META } }));
  if (!meta.Item) {
    try {
      await createRobot(doc, tableName, 1, COMPETITION_2026);
    } catch (e) {
      if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
    }
  } else if (!meta.Item.contract_name) {
    await doc.send(new UpdateCommand({
      TableName: tableName, Key: { pk: robotPk(1), sk: META },
      UpdateExpression: "SET contract_name = :n, controller = :c",
      ConditionExpression: "attribute_not_exists(contract_name)",
      ExpressionAttributeValues: { ":n": COMPETITION_2026.contract_name, ":c": COMPETITION_2026.controller },
    })).catch((e) => { if (e.name !== "ConditionalCheckFailedException") throw e; });
  }
}
