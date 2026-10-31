// DynamoDB implementation of Store (single table; layout in table.ts and plan §4).
//
// Every user write is one TransactWriteItems call: the row write (conditional on the
// version the client last saw), the audit entry, and the robot's rev bump. If the
// condition fails nothing is written and the caller gets 409 with the current row.

import {
  GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { planImport, SNAPSHOT_USER } from "./snapshot.ts";
import { auditPk, createRobot, META, robotPk, snapPk } from "./table.ts";
import type { Entity, Key, RobotState, Store } from "./store.ts";
import { HttpError, type Row, type Snapshot } from "./types.ts";

const SK_PREFIX: Record<Entity, string> = {
  device: "DEVICE#",
  power_port: "PORT#",
  can_chain: "CHAIN#",
  code_proposal: "PROPOSAL#",
};

const keyValue = (entity: Entity, key: Key): string =>
  String(entity === "power_port" ? key.port : entity === "can_chain" ? key.bus : key.id);

export function entityKey(entity: Entity, row: Row): string {
  return keyValue(entity, row);
}

const now = () => new Date().toISOString();

/** Strip DynamoDB keys and internal fields before returning a row. */
function clean(item: Row | undefined | null): Row | null {
  if (!item) return null;
  const { pk, sk, _seenVersion, ...rest } = item;
  return rest;
}

let auditSeq = 0;

function isConditionFailure(e: unknown): boolean {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  return err.name === "ConditionalCheckFailedException"
    || (err.name === "TransactionCanceledException"
        && (err.CancellationReasons ?? []).some((r) => r.Code === "ConditionalCheckFailed"));
}

export class DynamoStore implements Store {
  constructor(private doc: DynamoDBDocumentClient, private table: string) {}

  private itemKey(entity: Entity, robotId: number, key: Key) {
    return { pk: robotPk(robotId), sk: SK_PREFIX[entity] + keyValue(entity, key) };
  }

  private auditPut(robotId: number, entity: string, key: string, before: Row | null, after: Row | null, user: string) {
    const at = now();
    const sk = `${at}#${String(++auditSeq % 1e6).padStart(6, "0")}${Math.random().toString(36).slice(2, 6)}`;
    return {
      Put: {
        TableName: this.table,
        Item: {
          pk: auditPk(robotId), sk, id: sk, robot_id: robotId, entity, entity_key: key,
          before_json: before && JSON.stringify(before), after_json: after && JSON.stringify(after), user, at,
        },
      },
    };
  }

  private revBump(robotId: number) {
    return {
      Update: {
        TableName: this.table,
        Key: { pk: robotPk(robotId), sk: META },
        UpdateExpression: "ADD #rev :one",
        ExpressionAttributeNames: { "#rev": "rev" },
        ExpressionAttributeValues: { ":one": 1 },
      },
    };
  }

  private async queryAll(pk: string): Promise<Row[]> {
    const items: Row[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk }, ExclusiveStartKey: start,
      }));
      items.push(...(out.Items ?? []));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  /** Reserve n consecutive numeric ids for devices/proposals; returns the first. */
  private async nextIds(robotId: number, n: number): Promise<number> {
    const out = await this.doc.send(new UpdateCommand({
      TableName: this.table, Key: { pk: robotPk(robotId), sk: META },
      UpdateExpression: "ADD nextId :n", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":n": n }, ReturnValues: "UPDATED_NEW",
    }));
    return (out.Attributes!.nextId as number) - n + 1;
  }

  private async robotMeta(robotId: number): Promise<Row> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: robotPk(robotId), sk: META } }));
    if (!out.Item) throw new HttpError(404, "Robot not found");
    return out.Item;
  }

  async listRobots(): Promise<Row[]> {
    const out = await this.doc.send(new ScanCommand({
      TableName: this.table, FilterExpression: "sk = :m", ExpressionAttributeValues: { ":m": META },
    }));
    return (out.Items ?? []).map((m) => ({
      id: m.id, name: m.name, season: m.season, rev: m.rev,
      contract_name: m.contract_name, contract_class: m.contract_class, controller: m.controller ?? "roborio",
    })).sort((a, b) => (a.id as number) - (b.id as number));
  }

  async robotForContract(contractName: string, snap: Snapshot): Promise<number> {
    const robots = await this.listRobots();
    const found = robots.find((r) => r.contract_name === contractName);
    if (found) return found.id as number;
    // Next free id. Two simultaneous first imports of different contracts could pick the
    // same id; createRobot's condition makes the loser retry with the following one.
    let id = Math.max(0, ...robots.map((r) => r.id as number)) + 1;
    for (;; id++) {
      try {
        await createRobot(this.doc, this.table, id, {
          name: snap.robotName ?? contractName,
          season: Number(/\d{4}/.exec(snap.robotName ?? contractName)?.[0]) || null,
          contract_name: contractName,
          contract_class: snap.source.split(".").pop() ?? snap.source,
          controller: "roborio",
        });
        return id;
      } catch (e) {
        if (!isConditionFailure(e)) throw e;
      }
    }
  }

  async state(robotId: number): Promise<RobotState> {
    const [items, snaps] = await Promise.all([
      this.queryAll(robotPk(robotId)),
      this.doc.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": snapPk(robotId) },
        ScanIndexForward: false, Limit: 1,
      })),
    ]);
    const meta = items.find((i) => i.sk === META);
    if (!meta) throw new HttpError(404, "Robot not found");
    const of = (prefix: string) => items.filter((i) => (i.sk as string).startsWith(prefix)).map((i) => clean(i)!);
    const s = snaps.Items?.[0];
    const byStr = (k: string) => (a: Row, b: Row) => String(a[k]).localeCompare(String(b[k]));
    return {
      robot: {
        id: meta.id, name: meta.name, season: meta.season, contract_name: meta.contract_name, contract_class: meta.contract_class,
        controller: meta.controller ?? "roborio", rev: meta.rev, seeded: meta.seeded,
      },
      snapshot: s ? { git_sha: s.git_sha, source: s.source, generated_at: s.generated_at, imported_at: s.imported_at, json: JSON.parse(s.json as string) } : null,
      devices: of(SK_PREFIX.device).sort(byStr("name")),
      ports: of(SK_PREFIX.power_port).sort(byStr("port")),
      chains: of(SK_PREFIX.can_chain).sort(byStr("bus")).map((c) => ({ ...c, order: JSON.parse(c.order_json as string) })),
      proposals: of(SK_PREFIX.code_proposal).sort((a, b) => (b.id as number) - (a.id as number)),
    };
  }

  async rev(robotId: number): Promise<number> {
    return (await this.robotMeta(robotId)).rev as number;
  }

  async audit(robotId: number, limit: number): Promise<Row[]> {
    const out = await this.doc.send(new QueryCommand({
      TableName: this.table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": auditPk(robotId) },
      ScanIndexForward: false, Limit: limit,
    }));
    return (out.Items ?? []).map((i) => clean(i)!);
  }

  async get(entity: Entity, robotId: number, key: Key): Promise<Row | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: this.itemKey(entity, robotId, key) }));
    return clean(out.Item);
  }

  async update(entity: Entity, robotId: number, key: Key, expectedVersion: number, changes: Row, user: string): Promise<Row> {
    const before = await this.get(entity, robotId, key);
    if (!before) throw new HttpError(404, `${entity} not found`);
    if (before.version !== expectedVersion) throw new HttpError(409, "Someone else changed this first", { current: before });
    const after: Row = { ...before, ...changes, version: expectedVersion + 1, updated_by: user, updated_at: now() };
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table, Item: { ...this.itemKey(entity, robotId, key), ...after },
              ConditionExpression: "#v = :seen",
              ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":seen": expectedVersion },
            },
          },
          this.auditPut(robotId, entity, entityKey(entity, after), before, after, user),
          this.revBump(robotId),
        ],
      }));
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      // Lost a race between the read and the write.
      throw new HttpError(409, "Someone else changed this first", { current: await this.get(entity, robotId, key) });
    }
    return after;
  }

  async insert(entity: "device" | "code_proposal", robotId: number, values: Row, user: string): Promise<Row> {
    const id = await this.nextIds(robotId, 1);
    const after: Row = { ...values, id, robot_id: robotId, version: 1, updated_by: user, updated_at: now() };
    await this.doc.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.table, Item: { ...this.itemKey(entity, robotId, after), ...after }, ConditionExpression: "attribute_not_exists(pk)" } },
        this.auditPut(robotId, entity, entityKey(entity, after), null, after, user),
        this.revBump(robotId),
      ],
    }));
    return after;
  }

  async delete(entity: Entity, robotId: number, key: Key, expectedVersion: number, user: string): Promise<void> {
    const before = await this.get(entity, robotId, key);
    if (!before) throw new HttpError(404, `${entity} not found`);
    if (before.version !== expectedVersion) throw new HttpError(409, "Someone else changed this first", { current: before });
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.table, Key: this.itemKey(entity, robotId, key),
              ConditionExpression: "#v = :seen",
              ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":seen": expectedVersion },
            },
          },
          this.auditPut(robotId, entity, entityKey(entity, before), before, null, user),
          this.revBump(robotId),
        ],
      }));
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      throw new HttpError(409, "Someone else changed this first", { current: await this.get(entity, robotId, key) });
    }
  }

  /** Undo one audit entry by writing the "before" values back as a new, audited change. */
  async revert(robotId: number, auditId: string, user: string): Promise<void> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: auditPk(robotId), sk: auditId } }));
    const a = out.Item;
    if (!a) throw new HttpError(404, "History entry not found");
    const entity = a.entity as Entity;
    if (!(entity in SK_PREFIX)) throw new HttpError(400, "This kind of change can't be reverted");
    const before: Row | null = a.before_json ? JSON.parse(a.before_json as string) : null;
    const after: Row | null = a.after_json ? JSON.parse(a.after_json as string) : null;
    const key = (after ?? before)!;
    const current = await this.get(entity, robotId, key);

    if (!before) {
      // Undo a create.
      if (current) await this.delete(entity, robotId, key, current.version as number, user);
      return;
    }
    if (!after || !current) {
      // Undo a delete: put the old row back.
      if (current) throw new HttpError(409, "That row exists again; revert it directly");
      const restored: Row = { ...before, version: (before.version as number) + 1, updated_by: user, updated_at: now() };
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: { ...this.itemKey(entity, robotId, key), ...restored }, ConditionExpression: "attribute_not_exists(pk)" } },
          this.auditPut(robotId, entity, entityKey(entity, restored), null, restored, user),
          this.revBump(robotId),
        ],
      }));
      return;
    }
    const skip = new Set(["version", "updated_by", "updated_at"]);
    const changes: Row = {};
    for (const c of Object.keys(before)) {
      if (!skip.has(c) && JSON.stringify(before[c]) !== JSON.stringify(after[c])) changes[c] = before[c];
    }
    if (Object.keys(changes).length) await this.update(entity, robotId, key, current.version as number, changes, user);
  }

  async importSnapshot(robotId: number, snap: Snapshot): Promise<Row> {
    const meta = await this.robotMeta(robotId);
    const devices = (await this.queryAll(robotPk(robotId)))
      .filter((i) => (i.sk as string).startsWith(SK_PREFIX.device)).map((i) => clean(i)!);
    const t = now();
    const plan = planImport(robotId, devices, meta.seeded === 1, snap, t);

    // Give new devices real ids and fix up converter references to them.
    if (plan.newDevices.length) {
      const first = await this.nextIds(robotId, plan.newDevices.length);
      const ids = new Map(plan.newDevices.map((d, i) => [d.id as string, first + i]));
      for (const d of plan.newDevices) d.id = ids.get(d.id as string);
      for (const d of [...plan.newDevices, ...plan.changedDevices]) {
        const s = d.supply as string | null;
        if (s?.startsWith("dev:tmp:")) d.supply = `dev:${ids.get(s.slice(4))}`;
      }
    }

    await this.doc.send(new PutCommand({
      TableName: this.table,
      Item: { pk: snapPk(robotId), sk: t, git_sha: snap.gitSha, source: snap.source, generated_at: snap.generatedAt, imported_at: t, json: JSON.stringify(snap) },
    }));

    // Device writes are conditional: a student edit that lands mid-import wins, and that
    // device simply keeps its old code fields until the next import.
    const writes: Promise<unknown>[] = [];
    for (const d of plan.newDevices) {
      writes.push(this.doc.send(new PutCommand({
        TableName: this.table, Item: { ...this.itemKey("device", robotId, d), ...d }, ConditionExpression: "attribute_not_exists(pk)",
      })));
    }
    for (const { _seenVersion: seen, ...d } of plan.changedDevices) {
      writes.push(this.doc.send(new PutCommand({
        TableName: this.table, Item: { ...this.itemKey("device", robotId, d), ...d },
        ConditionExpression: "#v = :seen", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":seen": seen },
      })).catch((e) => { if (!isConditionFailure(e)) throw e; }));
    }
    for (const [bus, order] of plan.chains ?? []) {
      writes.push(this.doc.send(new PutCommand({
        TableName: this.table,
        Item: { pk: robotPk(robotId), sk: SK_PREFIX.can_chain + bus, robot_id: robotId, bus, order_json: JSON.stringify(order),
                version: 1, updated_by: SNAPSHOT_USER, updated_at: t },
      })));
    }
    await Promise.all(writes);

    await this.doc.send(new TransactWriteCommand({
      TransactItems: [
        this.auditPut(robotId, "code_snapshot", snap.gitSha ?? "unknown", null, plan.summary, SNAPSHOT_USER),
        {
          Update: {
            TableName: this.table, Key: { pk: robotPk(robotId), sk: META },
            UpdateExpression: plan.summary.seeded ? "ADD #rev :one SET seeded = :one" : "ADD #rev :one",
            ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ":one": 1 },
          },
        },
      ],
    }));
    return plan.summary;
  }
}
