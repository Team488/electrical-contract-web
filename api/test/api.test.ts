import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { makeDocClient, type Config } from "../src/config.ts";
import { DynamoStore } from "../src/dynamo-store.ts";
import { createHandler } from "../src/handlers.ts";
import { createTableIfMissing, ensureRobot } from "../src/table.ts";
import snapshot from "./fixtures/snapshot-2026.json" with { type: "json" };

const BASE = "http://local";
const config: Config = {
  passcode: "test-pass", tokenSecret: "test-secret", snapshotKey: "test-key",
  tableName: "", corsOrigins: null,
};
let handle: (req: Request) => Promise<Response>;

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return handle(new Request(BASE + path, { ...init, headers: { ...headers, ...(init.headers as object) } }));
}

async function login(name = "Alex"): Promise<string> {
  const r = await api("/api/auth", { method: "POST", body: JSON.stringify({ name, passcode: "test-pass" }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

async function importSnap() {
  const r = await api("/api/robots/1/snapshot", {
    method: "POST", body: JSON.stringify(snapshot), headers: { "x-snapshot-key": "test-key" },
  });
  expect(r.status).toBe(200);
  return r.json() as Promise<Record<string, unknown>>;
}

async function state(): Promise<any> {
  return (await api("/api/robots/1")).json();
}

beforeEach(async () => {
  // A fresh table per test keeps tests independent.
  const doc = makeDocClient(inject("ddbEndpoint"));
  const tableName = `t-${randomUUID()}`;
  await createTableIfMissing(doc, tableName);
  await ensureRobot(doc, tableName);
  handle = createHandler({ store: new DynamoStore(doc, tableName), config: { ...config, tableName } });
});

describe("snapshot import", () => {
  it("seeds devices, power and CAN order from the 2026 contract", async () => {
    const summary = await importSnap();
    expect(summary.seeded).toBe(true);
    const s = await state();
    const code = s.devices.filter((d: any) => d.code_key);
    expect(code.filter((d: any) => d.code_key.startsWith("can:"))).toHaveLength(25);
    expect(code.filter((d: any) => d.kind === "dio")).toHaveLength(2);
    expect(code.filter((d: any) => d.kind === "pwm")).toHaveLength(2);

    const onPdh = new Set(s.devices.filter((d: any) => d.supply?.startsWith("PDH")).map((d: any) => d.supply));
    expect(onPdh.size).toBe(23); // PDH07 is No_Connect
    const byName = (n: string) => s.devices.find((d: any) => d.name === n);
    expect(byName("CANdle").supply).toBe("VRM1_5V_500MA");
    expect(byName("VRM1").supply).toBe("PDH21");
    expect(byName("FrontOrangePi").supply).toBe(`dev:${byName("FrontBuck_Pwr").id}`);
    expect(s.chains[0].order).toHaveLength(25);
    expect(s.chains[0].order[0]).toBe("can:Canivore:30");
  });

  it("re-import keeps web edits and flags devices removed from code", async () => {
    await importSnap();
    const token = await login();
    const s = await state();
    const shooter = s.devices.find((d: any) => d.name === "ShooterLeftMotor");
    await api(`/api/robots/1/devices/${shooter.id}`, {
      method: "PATCH", token, body: JSON.stringify({ version: shooter.version, changes: { supply: "PDH07" } }),
    });
    const trimmed = { ...snapshot, canDevices: snapshot.canDevices.filter((d) => d.canId !== 26) };
    const r = await api("/api/robots/1/snapshot", {
      method: "POST", body: JSON.stringify(trimmed), headers: { "x-snapshot-key": "test-key" },
    });
    expect(((await r.json()) as any).removed).toBe(1);
    const after = await state();
    expect(after.devices.find((d: any) => d.name === "ShooterLeftMotor").supply).toBe("PDH07");
    expect(after.devices.find((d: any) => d.code_key === "can:Canivore:26").in_code).toBe(0);
  });

  it("rejects a bad snapshot key", async () => {
    const r = await api("/api/robots/1/snapshot", { method: "POST", body: "{}", headers: { "x-snapshot-key": "nope" } });
    expect(r.status).toBe(403);
  });
});

describe("auth", () => {
  it("rejects a wrong passcode", async () => {
    const r = await api("/api/auth", { method: "POST", body: JSON.stringify({ name: "A", passcode: "x" }) });
    expect(r.status).toBe(403);
  });

  it("requires a token to edit but not to read", async () => {
    await importSnap();
    expect((await api("/api/robots/1")).status).toBe(200);
    const r = await api("/api/robots/1/ports/PDH05", {
      method: "PATCH", body: JSON.stringify({ version: 1, changes: { breaker_a: 40 } }),
    });
    expect(r.status).toBe(401);
  });
});

describe("simultaneous edits", () => {
  it("returns 409 with the current row when the version is stale", async () => {
    await importSnap();
    const alex = await login("Alex");
    const sam = await login("Sam");
    const r1 = await api("/api/robots/1/ports/PDH05", {
      method: "PATCH", token: sam, body: JSON.stringify({ version: 1, changes: { breaker_a: 40, wire_awg: 12 } }),
    });
    expect(r1.status).toBe(200);
    const r2 = await api("/api/robots/1/ports/PDH05", {
      method: "PATCH", token: alex, body: JSON.stringify({ version: 1, changes: { breaker_a: 30 } }),
    });
    expect(r2.status).toBe(409);
    const conflict = (await r2.json()) as any;
    expect(conflict.current.breaker_a).toBe(40);
    expect(conflict.current.updated_by).toBe("Sam");
  });

  it("edits to different rows don't collide", async () => {
    await importSnap();
    const t = await login();
    for (const port of ["PDH01", "PDH02"]) {
      const r = await api(`/api/robots/1/ports/${port}`, {
        method: "PATCH", token: t, body: JSON.stringify({ version: 1, changes: { breaker_a: 40 } }),
      });
      expect(r.status).toBe(200);
    }
  });

  it("every write bumps rev and adds an audit row", async () => {
    await importSnap();
    const t = await login();
    const rev0 = ((await (await api("/api/robots/1/rev")).json()) as any).rev;
    await api("/api/robots/1/ports/PDH03", {
      method: "PATCH", token: t, body: JSON.stringify({ version: 1, changes: { notes: "hi" } }),
    });
    const rev1 = ((await (await api("/api/robots/1/rev")).json()) as any).rev;
    expect(rev1).toBe(rev0 + 1);
    const audit = (await (await api("/api/robots/1/audit")).json()) as any[];
    expect(audit[0]).toMatchObject({ entity: "power_port", entity_key: "PDH03", user: "Alex" });
  });
});

describe("validation and revert", () => {
  it("rejects power loops and bad values", async () => {
    await importSnap();
    const t = await login();
    const s = await state();
    const buck = s.devices.find((d: any) => d.name === "FrontBuck_Pwr");
    const pi = s.devices.find((d: any) => d.name === "FrontOrangePi");
    const loop = await api(`/api/robots/1/devices/${buck.id}`, {
      method: "PATCH", token: t, body: JSON.stringify({ version: buck.version, changes: { supply: `dev:${pi.id}` } }),
    });
    expect(loop.status).toBe(400);
    const awg = await api("/api/robots/1/ports/PDH00", {
      method: "PATCH", token: t, body: JSON.stringify({ version: 1, changes: { wire_awg: 3.5 } }),
    });
    expect(awg.status).toBe(400);
  });

  it("revert restores the previous value", async () => {
    await importSnap();
    const t = await login();
    await api("/api/robots/1/ports/PDH04", {
      method: "PATCH", token: t, body: JSON.stringify({ version: 1, changes: { breaker_a: 40 } }),
    });
    const audit = (await (await api("/api/robots/1/audit")).json()) as any[];
    const r = await api(`/api/robots/1/audit/${encodeURIComponent(audit[0].id)}/revert`, { method: "POST", token: t });
    expect(r.status).toBe(200);
    const s = await state();
    expect(s.ports.find((p: any) => p.port === "PDH04").breaker_a).toBeNull();
  });

  it("adds and deletes an electrical-only device, and undoes the delete", async () => {
    await importSnap();
    const t = await login();
    const add = await api("/api/robots/1/devices", {
      method: "POST", token: t, body: JSON.stringify({ name: "LimeLight", kind: "load", supply: "PDH07" }),
    });
    const dev = (await add.json()) as any;
    const del = await api(`/api/robots/1/devices/${dev.id}?version=${dev.version}`, { method: "DELETE", token: t });
    expect(del.status).toBe(200);
    const audit = (await (await api("/api/robots/1/audit")).json()) as any[];
    await api(`/api/robots/1/audit/${encodeURIComponent(audit[0].id)}/revert`, { method: "POST", token: t });
    const s = await state();
    expect(s.devices.find((d: any) => d.name === "LimeLight").supply).toBe("PDH07");
  });

  it("does not let the web rename a code device", async () => {
    await importSnap();
    const t = await login();
    const s = await state();
    const m = s.devices.find((d: any) => d.code_key === "can:Canivore:22");
    const r = await api(`/api/robots/1/devices/${m.id}`, {
      method: "PATCH", token: t, body: JSON.stringify({ version: m.version, changes: { name: "X" } }),
    });
    expect(r.status).toBe(400);
  });
});

describe("DynamoDB specifics", () => {
  it("exactly one of two simultaneous saves wins", async () => {
    await importSnap();
    const [alex, sam] = [await login("Alex"), await login("Sam")];
    const send = (token: string, amps: number) => api("/api/robots/1/ports/PDH06", {
      method: "PATCH", token, body: JSON.stringify({ version: 1, changes: { breaker_a: amps } }),
    });
    const statuses = (await Promise.all([send(alex, 30), send(sam, 40)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const audit = (await (await api("/api/robots/1/audit")).json()) as any[];
    expect(audit.filter((a) => a.entity_key === "PDH06")).toHaveLength(1);
  });

  it("new converters get real ids that their loads point at", async () => {
    await importSnap();
    const s = await state();
    const ids = s.devices.map((d: any) => d.id);
    expect(ids.every((id: unknown) => Number.isInteger(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(s.devices.some((d: any) => String(d.supply).includes("tmp"))).toBe(false);
  });
});
