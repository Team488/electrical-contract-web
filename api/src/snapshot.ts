// Plan the effect of importing a Java contract snapshot. Code-owned fields (names, kinds,
// which devices exist) always follow the snapshot. The electrical data (what powers each
// device, CAN order) is seeded from it only once; after that the web DB owns it and
// differences show up as warnings in the UI.
//
// Pure function over the current rows, so the storage layer only has to write the result.

import { HttpError, type Row, type Snapshot } from "./types.ts";

export const SNAPSHOT_USER = "java snapshot";

export function canKey(bus: string, canId: number): string {
  return `can:${bus}:${canId}`;
}

/** Map a Java PowerSource name to a device supply; MOTOR/NONE mean "not specified". */
export function codeSupply(source: string | null | undefined): string | null {
  if (!source || source === "MOTOR" || source === "NONE") return null;
  return source;
}

function guessKind(name: string): string {
  if (/^VRM\d$/.test(name)) return "vrm";
  if (/_Pwr$/.test(name)) return "converter";
  return "load";
}

export function checkShape(s: Snapshot): void {
  const arrays = ["canDevices", "dio", "pwm", "canOrder"] as const;
  const maps = ["additionalPdh", "powerSources", "powerBranches"] as const;
  if (!s || typeof s !== "object" || arrays.some((k) => !Array.isArray(s[k]))
      || maps.some((k) => typeof s[k] !== "object" || s[k] === null)) {
    throw new HttpError(400, "Not an electrical snapshot (run electricalReport with --json)");
  }
}

export interface ImportPlan {
  /** New rows have a temporary string id "tmp:N"; supplies may reference "dev:tmp:N". */
  newDevices: Row[];
  /** Existing rows, already updated, with `_seenVersion` holding the version they were read at. */
  changedDevices: Row[];
  /** Set only when seeding: bus -> ordered code_keys. */
  chains: Map<string, string[]> | null;
  summary: { gitSha: string | null; added: number; changed: number; removed: number; seeded: boolean };
}

export function planImport(robotId: number, devices: Row[], seeded: boolean, snap: Snapshot, now: string): ImportPlan {
  checkShape(snap);
  const rows = devices.map((d) => ({ ...d }));
  const newDevices: Row[] = [];
  const changed = new Set<Row>();
  let tmp = 0;

  const touch = (d: Row) => {
    if (newDevices.includes(d)) return;
    if (!changed.has(d)) {
      d._seenVersion = d.version;
      d.version = (d.version as number) + 1;
      changed.add(d);
    }
    d.updated_by = SNAPSHOT_USER;
    d.updated_at = now;
  };
  const create = (fields: Row): Row => {
    const d: Row = {
      id: `tmp:${++tmp}`, robot_id: robotId, code_key: null, in_code: 0, supply: null, notes: "",
      version: 1, updated_by: SNAPSHOT_USER, updated_at: now, ...fields,
    };
    rows.push(d);
    newDevices.push(d);
    return d;
  };

  // Code devices, keyed by (bus, CAN ID) or channel. Duplicate keys in the snapshot are a
  // code bug; keep the first and let the UI's duplicate-ID check report it.
  const codeDevices = new Map<string, { name: string; kind: string; supply: string | null }>();
  for (const d of snap.canDevices) {
    const k = canKey(d.bus, d.canId);
    if (!codeDevices.has(k)) codeDevices.set(k, { name: d.name, kind: d.kind, supply: codeSupply(d.pdhPort ?? d.powerFrom) });
  }
  for (const d of snap.dio) codeDevices.set(`dio:${d.channel}`, { name: d.name, kind: "dio", supply: codeSupply(d.powerFrom) });
  for (const d of snap.pwm) codeDevices.set(`pwm:${d.channel}`, { name: d.name, kind: "pwm", supply: codeSupply(d.powerFrom) });

  const byCode = new Map(rows.filter((d) => d.code_key).map((d) => [d.code_key as string, d]));
  let added = 0, changedCount = 0, removed = 0;
  for (const [key, d] of codeDevices) {
    const cur = byCode.get(key);
    if (!cur) {
      added++;
      create({ name: d.name, kind: d.kind, code_key: key, in_code: 1, supply: d.supply });
    } else if (cur.name !== d.name || cur.kind !== d.kind || cur.in_code !== 1) {
      changedCount++;
      Object.assign(cur, { name: d.name, kind: d.kind, in_code: 1 });
      touch(cur);
    }
  }
  for (const [key, cur] of byCode) {
    if (!codeDevices.has(key) && cur.in_code === 1) {
      removed++;
      cur.in_code = 0;
      touch(cur);
    }
  }

  let chains: Map<string, string[]> | null = null;
  if (!seeded) {
    const byName = new Map<string, Row>();
    for (const d of rows) if (!byName.has(d.name as string)) byName.set(d.name as string, d);
    const findOrCreate = (name: string, kind: string): Row => {
      let d = byName.get(name);
      if (!d) {
        d = create({ name, kind });
        byName.set(name, d);
      }
      return d;
    };
    const setSupply = (d: Row, supply: string) => {
      if (d.supply !== supply) {
        d.supply = supply;
        touch(d);
      }
    };

    for (const [port, names] of Object.entries(snap.additionalPdh)) {
      for (const name of names) if (name !== "No_Connect") setSupply(findOrCreate(name, guessKind(name)), port);
    }
    for (const [source, names] of Object.entries(snap.powerSources)) {
      if (!source.startsWith("VRM")) continue;
      for (const name of names) if (name !== "No_Connect") setSupply(findOrCreate(name, guessKind(name)), source);
    }
    for (const [parent, children] of Object.entries(snap.powerBranches)) {
      const p = findOrCreate(parent, "converter");
      if (!p.code_key && p.kind !== "converter") {
        p.kind = "converter";
        touch(p);
      }
      for (const child of children) setSupply(findOrCreate(child, "load"), `dev:${p.id}`);
    }

    chains = new Map();
    for (const e of [...snap.canOrder].sort((a, b) => a.busPosition - b.busPosition)) {
      if (!chains.has(e.bus)) chains.set(e.bus, []);
      chains.get(e.bus)!.push(canKey(e.bus, e.canId));
    }
    for (const d of snap.canDevices) if (!chains.has(d.bus)) chains.set(d.bus, []);
  }

  return {
    newDevices,
    changedDevices: [...changed],
    chains,
    summary: { gitSha: snap.gitSha, added, changed: changedCount, removed, seeded: !seeded },
  };
}
