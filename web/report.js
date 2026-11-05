// Plain-text report laid out like TeamXbot2026's electrical-report.txt, built from the
// web data. Used by the print page and the .txt download.

import { PDH_PORTS, canIdOf } from "./model.js";
import { runChecks } from "./validate.js";

const RULE = "=".repeat(80);
const LINE = "-".repeat(80);
const pad = (s, n) => String(s).padEnd(n);
const num = (n) => String(n).padStart(2);

export function reportText(model) {
  const { state, snap } = model;
  const out = [];
  const p = (s = "") => out.push(s);
  const section = (title) => { p(LINE); p(title); p(LINE); };
  const total = (s) => { p(); p(RULE); p(s); p(RULE); p(); };
  const portExtras = (port) => {
    const x = model.ports.get(port);
    const bits = [x?.breaker_a != null && `${x.breaker_a} A`, x?.wire_awg != null && `${x.wire_awg} AWG`].filter(Boolean);
    return bits.length ? `   [${bits.join(", ")}]` : "";
  };

  p(RULE); p("Electrical Contract Report"); p(RULE); p();
  p(`Repository: ${state.robot.repo ?? ""}`);
  p(`Robot: ${state.robot.name}${state.robot.contract_name ? ` (ContractToUse = ${state.robot.contract_name})` : ""}`);
  p(`Java source: ${snap?.source ?? "(no snapshot)"} @ ${state.snapshot?.git_sha?.slice(0, 7) ?? "?"}`);
  p(`Wiring data revision: ${state.robot.rev}`);
  p(`Printed: ${new Date().toLocaleString()}`);
  p();

  let canTotal = 0;
  for (const bus of model.buses) {
    const devs = model.canDevices(bus).filter((d) => d.in_code);
    canTotal += devs.length;
    section(`CAN bus ${bus} (${devs.length} devices)`);
    if (!devs.length) p("  (No devices)");
    for (const d of devs) p(`  ID ${num(canIdOf(d))}: ${pad(d.name, 40)} [${model.code.get(d.code_key)?.type ?? "?"}]`);
    p();
  }
  total(`Total CAN devices: ${canTotal}`);

  section("CAN Bus Connection Order");
  for (const bus of model.buses) {
    p(`  ${bus}:`);
    (model.chain(bus)?.order ?? []).forEach((key, i) => {
      const d = model.byCodeKey.get(key);
      p(`    Pos ${num(i + 1)}: ID ${num(key.split(":")[2])}  ${pad(d?.name ?? "(not in code)", 40)} [${model.code.get(key)?.type ?? "?"}]`);
    });
  }
  p(); p();

  for (const [title, kind] of [["RIO Digital I/O Devices", "dio"], ["PWM Devices", "pwm"]]) {
    const devs = state.devices.filter((d) => d.kind === kind && d.in_code)
      .sort((a, b) => Number(a.code_key.split(":")[1]) - Number(b.code_key.split(":")[1]));
    section(`${title} (${devs.length} devices)`);
    for (const d of devs) p(`  ${kind.toUpperCase()} ${num(d.code_key.split(":")[1])}: ${d.name}`);
    p();
  }

  section("PDH Port Assignments");
  let used = 0;
  for (const port of PDH_PORTS) {
    const names = model.devicesOn(port).map((d) => d.name);
    if (names.length) used++;
    p(`  ${port}: ${names.length ? names.join(", ") : "(No Connect)"}${portExtras(port)}`);
  }
  total(`Total PDH ports used: ${used} / 24`);

  for (const vrm of state.devices.filter((d) => d.kind === "vrm").sort((a, b) => a.name.localeCompare(b.name))) {
    const ports = model.vrmPorts.filter((x) => x.startsWith(`${vrm.name}_`));
    if (!ports.length) continue;
    section(`${vrm.name} Port Assignments (power source = ${model.supplyLabel(vrm.supply)})`);
    let n = 0;
    for (const port of ports) {
      const names = model.devicesOn(port).map((d) => d.name);
      if (names.length) n++;
      p(`  ${vrm.name}-${port.slice(vrm.name.length + 1).toLowerCase()}: ${names.join(", ") || "No_Connect"}${portExtras(port)}`);
    }
    total(`Total ${vrm.name} ports used: ${n}`);
  }

  section("Power Branch Assignments (Intermediate Converters)");
  let branches = 0;
  for (const conv of state.devices.filter((d) => d.kind === "converter").sort((a, b) => a.name.localeCompare(b.name))) {
    for (const child of model.devicesOn(`dev:${conv.id}`)) {
      p(`  ${conv.name} (${model.supplyLabel(conv.supply)}) -> ${child.name}`);
      branches++;
    }
  }
  total(`Total power branches: ${branches}`);

  if (model.disabled.length) {
    section("Not on this robot (mechanism not in the contract's readiness set)");
    for (const name of [...model.disabled].sort()) p(`  ${name}`);
    p();
  }

  const checks = runChecks(model);
  section(`Checks (${checks.filter((c) => c.level === "error").length} errors, ${checks.filter((c) => c.level === "warn").length} warnings)`);
  if (!checks.length) p("  All checks pass.");
  for (const c of checks) p(`  ${c.level.toUpperCase().padEnd(5)} [${c.area}] ${c.message}`);
  p();
  return out.join("\n");
}
