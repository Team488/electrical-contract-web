// HTTP API for the electrical contract web tool, on standard Request/Response so the
// same code runs in Lambda (lambda.ts) and in the local demo server (local.ts).
// Reads are public; writes need a token from POST /api/auth (team passcode), except
// snapshot import (CI key).

import { checkPasscode, checkSnapshotKey, issueToken, verifyToken } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { checkShape } from "./snapshot.ts";
import { HttpError, type Row, type Snapshot } from "./types.ts";

const KINDS = ["motor", "can_sensor", "dio", "pwm", "vrm", "converter", "load"];
const SUPPLY_RE = /^(PDH(0\d|1\d|2[0-3])|VRM[12]_(12V|5V)_(2A|2B|500MA|500MB)|RIO|dev:\d+)$/;
const PROPOSAL_STATUS = ["open", "done", "rejected"];

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

function corsHeaders(origins: string[] | null, req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origins || !origin || !origins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-snapshot-key",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

async function body(req: Request): Promise<Row> {
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Row;
  } catch { /* fall through */ }
  throw new HttpError(400, "Expected a JSON object body");
}

function needVersion(v: unknown): number {
  if (!Number.isInteger(v)) throw new HttpError(400, "Missing version");
  return v as number;
}

function text(v: unknown, field: string, max: number, allowEmpty = true): string {
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
  const s = v.trim();
  if (s.length > max || (!allowEmpty && !s)) throw new HttpError(400, `${field} must be ${allowEmpty ? "" : "1-"}${max} characters`);
  return s;
}

function numOrNull(v: unknown, field: string, min: number, max: number, integer: boolean): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new HttpError(400, `${field} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}`);
  }
  return n;
}

export interface Deps {
  store: Store;
  config: Config;
  /** Pulls newly published contract snapshots (pull.ts); run before page-load reads. */
  pull?: () => Promise<void>;
}

/** A supply may name a port or another device; reject unknown devices and loops. */
async function checkSupply(store: Store, robotId: number, deviceId: number | null, v: unknown): Promise<string | null> {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !SUPPLY_RE.test(v)) throw new HttpError(400, `Unknown power source ${String(v)}`);
  let next: string | null = v;
  for (let hops = 0; next?.startsWith("dev:"); hops++) {
    const id = Number(next.slice(4));
    if (id === deviceId || hops > 20) throw new HttpError(400, "That would make a power loop");
    const parent = await store.get("device", robotId, { id });
    if (!parent) throw new HttpError(400, "Power source device not found");
    next = parent.supply as string | null;
  }
  return v;
}

type Handler = (req: Request, deps: Deps, m: RegExpMatchArray) => Promise<unknown>;

function requireUser({ config }: Deps, req: Request): string {
  const user = verifyToken(config, req.headers.get("authorization"));
  if (!user) throw new HttpError(401, "Log in with the team passcode to edit");
  return user;
}

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/robots$/, async (_r, { store }) => store.listRobots()],

  ["GET", /^\/api\/robots\/(\d+)$/, async (_r, { store }, m) => store.state(+m[1])],

  ["GET", /^\/api\/robots\/(\d+)\/rev$/, async (_r, { store }, m) => ({ rev: await store.rev(+m[1]) })],

  ["GET", /^\/api\/robots\/(\d+)\/audit$/, async (_r, { store }, m) => store.audit(+m[1], 300)],

  ["POST", /^\/api\/auth$/, async (req, { config }) => {
    const b = await body(req);
    const name = text(b.name, "Name", 40, false);
    if (typeof b.passcode !== "string" || !checkPasscode(config, b.passcode)) throw new HttpError(403, "Wrong passcode");
    return { name, ...issueToken(config, name) };
  }],

  ["POST", /^\/api\/robots\/(\d+)\/snapshot$/, async (req, { store, config }, m) => {
    if (!checkSnapshotKey(config, req.headers.get("x-snapshot-key"))) throw new HttpError(403, "Bad snapshot key");
    return store.importSnapshot(+m[1], (await req.json()) as Snapshot);
  }],

  // CI/import entry point: picks (or creates) the robot by its ContractToUse name.
  ["POST", /^\/api\/contracts\/([A-Za-z0-9_-]{1,30})\/snapshot$/, async (req, { store, config }, m) => {
    if (!checkSnapshotKey(config, req.headers.get("x-snapshot-key"))) throw new HttpError(403, "Bad snapshot key");
    const snap = (await req.json()) as Snapshot;
    checkShape(snap);
    const robotId = await store.robotForContract(m[1], snap);
    return { robotId, ...(await store.importSnapshot(robotId, snap)) };
  }],

  ["POST", /^\/api\/robots\/(\d+)\/devices$/, async (req, deps, m) => {
    const user = requireUser(deps, req);
    const robotId = +m[1];
    const b = await body(req);
    const kind = text(b.kind ?? "load", "Kind", 20);
    if (!["vrm", "converter", "load"].includes(kind)) throw new HttpError(400, "New devices must be vrm, converter or load; code devices come from Java");
    return deps.store.insert("device", robotId, {
      name: text(b.name, "Name", 60, false), kind, code_key: null, in_code: 0,
      supply: await checkSupply(deps.store, robotId, null, b.supply ?? null),
      notes: text(b.notes ?? "", "Notes", 500),
    }, user);
  }],

  ["PATCH", /^\/api\/robots\/(\d+)\/devices\/(\d+)$/, async (req, deps, m) => {
    const user = requireUser(deps, req);
    const robotId = +m[1], id = +m[2];
    const b = await body(req);
    const cur = await deps.store.get("device", robotId, { id });
    if (!cur) throw new HttpError(404, "Device not found");
    const c = (b.changes ?? {}) as Row;
    const changes: Row = {};
    if ("supply" in c) changes.supply = await checkSupply(deps.store, robotId, id, c.supply);
    if ("notes" in c) changes.notes = text(c.notes, "Notes", 500);
    if ("name" in c || "kind" in c) {
      if (cur.code_key) throw new HttpError(400, "Name and kind come from the Java contract; propose a change instead");
      if ("name" in c) changes.name = text(c.name, "Name", 60, false);
      if ("kind" in c) {
        if (!KINDS.includes(c.kind as string)) throw new HttpError(400, "Unknown kind");
        changes.kind = c.kind;
      }
    }
    if (!Object.keys(changes).length) throw new HttpError(400, "Nothing to change");
    return deps.store.update("device", robotId, { id }, needVersion(b.version), changes, user);
  }],

  ["DELETE", /^\/api\/robots\/(\d+)\/devices\/(\d+)$/, async (req, deps, m) => {
    const user = requireUser(deps, req);
    const robotId = +m[1], id = +m[2];
    const cur = await deps.store.get("device", robotId, { id });
    if (!cur) throw new HttpError(404, "Device not found");
    if (cur.code_key && cur.in_code) throw new HttpError(400, "This device is in the Java contract; remove it there");
    const { devices } = await deps.store.state(robotId);
    const child = devices.find((d) => d.supply === `dev:${id}`);
    if (child) throw new HttpError(400, `${child.name} is powered from this device; move it first`);
    const version = needVersion(Number(new URL(req.url).searchParams.get("version")));
    await deps.store.delete("device", robotId, { id }, version, user);
    return { ok: true };
  }],

  ["PATCH", /^\/api\/robots\/(\d+)\/ports\/([A-Z0-9_]+)$/, async (req, deps, m) => {
    const user = requireUser(deps, req);
    const b = await body(req);
    const c = (b.changes ?? {}) as Row;
    const changes: Row = {};
    if ("breaker_a" in c) changes.breaker_a = numOrNull(c.breaker_a, "Breaker", 1, 120, false);
    if ("wire_awg" in c) changes.wire_awg = numOrNull(c.wire_awg, "Wire gauge", 4, 30, true);
    if ("notes" in c) changes.notes = text(c.notes, "Notes", 500);
    if (!Object.keys(changes).length) throw new HttpError(400, "Nothing to change");
    return deps.store.update("power_port", +m[1], { port: m[2] }, needVersion(b.version), changes, user);
  }],

  ["PUT", /^\/api\/robots\/(\d+)\/chains\/([A-Za-z0-9_]+)$/, async (req, deps, m) => {
    const user = requireUser(deps, req);
    const b = await body(req);
    const order = b.order;
    if (!Array.isArray(order) || !order.every((k) => typeof k === "string" && k.startsWith("can:"))
        || new Set(order).size !== order.length) {
      throw new HttpError(400, "Order must be a list of distinct CAN device keys");
    }
    return deps.store.update("can_chain", +m[1], { bus: m[2] }, needVersion(b.version), { order_json: JSON.stringify(order) }, user);
  }],

  ["POST", /^\/api\/robots\/(\d+)\/proposals$/, async (req, deps, m) => {
    const user = requireUser(deps, req);
    const robotId = +m[1];
    const b = await body(req);
    const dev = await deps.store.get("device", robotId, { id: Number(b.device_id) });
    if (!dev) throw new HttpError(400, "Pick a device");
    return deps.store.insert("code_proposal", robotId, {
      device_id: dev.id,
      field: text(b.field, "Field", 40, false),
      from_val: b.from_val == null ? null : text(String(b.from_val), "Current value", 60),
      to_val: text(String(b.to_val ?? ""), "New value", 60, false),
      note: text(b.note ?? "", "Note", 500),
      status: "open",
      created_by: user,
      created_at: new Date().toISOString(),
    }, user);
  }],

  ["PATCH", /^\/api\/robots\/(\d+)\/proposals\/(\d+)$/, async (req, deps, m) => {
    const user = requireUser(deps, req);
    const b = await body(req);
    const status = (b.changes as Row | undefined)?.status;
    if (!PROPOSAL_STATUS.includes(status as string)) throw new HttpError(400, "Status must be open, done or rejected");
    return deps.store.update("code_proposal", +m[1], { id: +m[2] }, needVersion(b.version), { status }, user);
  }],

  ["POST", /^\/api\/robots\/(\d+)\/audit\/([^/]+)\/revert$/, async (req, deps, m) => {
    const user = requireUser(deps, req);
    await deps.store.revert(+m[1], decodeURIComponent(m[2]), user);
    return { ok: true };
  }],
];

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const cors = corsHeaders(deps.config.corsOrigins, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname;
    try {
      if (req.method === "GET" && deps.pull && /^\/api\/robots(\/\d+(\/rev)?)?$/.test(path)) await deps.pull();
      for (const [method, re, handler] of routes) {
        const m = path.match(re);
        if (m && method === req.method) return json(await handler(req, deps, m), 200, cors);
      }
      throw new HttpError(404, "No such endpoint");
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.body }, e.status, cors);
      console.error(e);
      return json({ error: "Server error" }, 500, cors);
    }
  };
}
