// Checks run in the browser on every refresh. The first group ports the Java report's
// conflict checks; the rest are new and only possible now that wiring data lives here.
// Conflicting data is allowed in the DB (a half-finished rewire is a real state); these
// checks are how it gets noticed.

import { PDH_PORTS } from "./model.js";

// REV PDH channel ratings: 0-19 high-current (40 A), 20-23 low-current (15 A).
const PDH_MAX_BREAKER = (port) => (Number(port.slice(3)) <= 19 ? 40 : 15);

// Smallest wire (largest AWG number) allowed per breaker size.
// Check against the current FRC game manual before relying on it.
const MIN_WIRE = [
  { maxAmps: 20, awg: 18 },
  { maxAmps: 30, awg: 14 },
  { maxAmps: 40, awg: 12 },
];

const NEEDS_SUPPLY = ["motor", "vrm", "converter", "load"];

export function runChecks(model) {
  const out = [];
  const add = (level, area, message) => out.push({ level, area, message });
  const { state, snap } = model;

  for (const port of PDH_PORTS) {
    const devs = model.devicesOn(port);
    const motors = devs.filter((d) => d.kind === "motor");
    const others = devs.filter((d) => d.kind !== "motor");
    if (motors.length > 1) add("error", "PDH", `${port} has more than one motor: ${motors.map((d) => d.name).join(", ")}`);
    if (motors.length && others.length) {
      add("error", "PDH", `${port} is shared between a motor and other loads: ${devs.map((d) => d.name).join(", ")}`);
    }
    const p = model.ports.get(port);
    if (p?.breaker_a != null && p.breaker_a > PDH_MAX_BREAKER(port)) {
      add("error", "PDH", `${port} breaker ${p.breaker_a} A is over the channel limit of ${PDH_MAX_BREAKER(port)} A`);
    }
  }

  for (const port of model.vrmPorts) {
    const devs = model.devicesOn(port);
    if (devs.length > 1) add("error", "VRM", `${port} has more than one device: ${devs.map((d) => d.name).join(", ")}`);
  }

  for (const p of state.ports) {
    if (p.breaker_a == null || p.wire_awg == null) continue;
    const rule = MIN_WIRE.find((r) => p.breaker_a <= r.maxAmps);
    if (rule && p.wire_awg > rule.awg) {
      add("warn", "Wiring", `${p.port}: ${p.wire_awg} AWG is too thin for a ${p.breaker_a} A breaker (needs ${rule.awg} AWG or thicker)`);
    }
  }

  const seen = new Map();
  for (const c of snap?.canDevices ?? []) {
    const key = `${c.bus}:${c.canId}`;
    if (seen.has(key)) add("error", "CAN", `CAN ID ${c.canId} on ${c.bus} is used by both ${seen.get(key)} and ${c.name} (fix in Java)`);
    else seen.set(key, c.name);
  }

  for (const bus of model.buses) {
    const order = model.chain(bus)?.order ?? [];
    const inChain = new Set(order);
    for (const d of model.canDevices(bus)) {
      if (d.in_code && !inChain.has(d.code_key)) add("warn", "CAN chain", `${d.name} (ID ${d.code_key.split(":")[2]}) is missing from the ${bus} chain`);
    }
    for (const key of order) {
      const d = model.byCodeKey.get(key);
      if (!d || !d.in_code) add("warn", "CAN chain", `${bus} chain lists ${key.replace("can:", "")}, which isn't in the Java contract`);
    }
  }

  for (const d of state.devices) {
    if (d.code_key && !d.in_code) add("warn", "Code", `${d.name} was removed from the Java contract`);
    if (d.supply?.startsWith("dev:") && !model.byId.has(Number(d.supply.slice(4)))) {
      add("error", "Power", `${d.name} is powered from a device that no longer exists`);
    }
    if (!d.supply && NEEDS_SUPPLY.includes(d.kind) && (d.in_code || !d.code_key)) {
      add("warn", "Power", `${d.name} has no power source`);
    }
    const c = d.code_key && model.code.get(d.code_key);
    if (c && d.kind === "motor" && c.pdhPort && c.pdhPort !== d.supply) {
      add("info", "Code", `${d.name}: Java says ${c.pdhPort}, wiring says ${d.supply ?? "nothing"}`);
    }
  }

  if (model.disabled.length) {
    add("info", "Code", `${model.disabled.length} code device${model.disabled.length > 1 ? "s are" : " is"} not on this robot (mechanism turned off in its contract); see the CAN tab`);
  }

  const open = state.proposals.filter((p) => p.status === "open").length;
  if (open) add("info", "Code", `${open} proposed code change${open > 1 ? "s" : ""} waiting for a programmer`);

  const order = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
