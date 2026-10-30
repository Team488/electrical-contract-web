// What the HTTP handlers need from storage. DynamoStore is the only implementation; the
// interface keeps the handlers free of DynamoDB details.

import type { Row, Snapshot } from "./types.ts";

export type Entity = "device" | "power_port" | "can_chain" | "code_proposal";

/** Identifies one row within a robot: {id} for devices/proposals, {port}, or {bus}. */
export type Key = Row;

export interface RobotState {
  robot: Row;
  snapshot: Row | null;
  devices: Row[];
  ports: Row[];
  chains: Row[];
  proposals: Row[];
}

export interface Store {
  listRobots(): Promise<Row[]>;
  state(robotId: number): Promise<RobotState>;
  rev(robotId: number): Promise<number>;
  audit(robotId: number, limit: number): Promise<Row[]>;
  get(entity: Entity, robotId: number, key: Key): Promise<Row | null>;
  /** Throws HttpError 404, or 409 with {current} if the version moved. */
  update(entity: Entity, robotId: number, key: Key, expectedVersion: number, changes: Row, user: string): Promise<Row>;
  insert(entity: "device" | "code_proposal", robotId: number, values: Row, user: string): Promise<Row>;
  delete(entity: Entity, robotId: number, key: Key, expectedVersion: number, user: string): Promise<void>;
  revert(robotId: number, auditId: string, user: string): Promise<void>;
  importSnapshot(robotId: number, snap: Snapshot): Promise<Row>;
}
