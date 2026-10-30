// Derived views of the API state shared by the UI, the checks and the printed report.

export const PDH_PORTS = Array.from({ length: 24 }, (_, i) => `PDH${String(i).padStart(2, "0")}`);
export const SOURCE_KINDS = ["vrm", "converter"];
export const KIND_LABELS = {
  motor: "Motor", can_sensor: "CAN sensor", dio: "DIO", pwm: "PWM",
  vrm: "VRM", converter: "Converter", load: "Load",
};

export function buildModel(state) {
  const snap = state.snapshot?.json ?? null;
  const byId = new Map(state.devices.map((d) => [d.id, d]));
  const byCodeKey = new Map(state.devices.filter((d) => d.code_key).map((d) => [d.code_key, d]));

  // Code facts per code_key, straight from the Java snapshot.
  const code = new Map();
  for (const c of snap?.canDevices ?? []) {
    const key = `can:${c.bus}:${c.canId}`;
    if (!code.has(key)) code.set(key, c);
  }
  for (const c of snap?.dio ?? []) code.set(`dio:${c.channel}`, c);
  for (const c of snap?.pwm ?? []) code.set(`pwm:${c.channel}`, c);

  const onSupply = new Map();
  for (const d of state.devices) {
    if (!d.supply) continue;
    if (!onSupply.has(d.supply)) onSupply.set(d.supply, []);
    onSupply.get(d.supply).push(d);
  }

  const ports = new Map(state.ports.map((p) => [p.port, p]));
  const vrmPorts = state.ports.filter((p) => p.port.startsWith("VRM")).map((p) => p.port);
  const buses = [...new Set([...(snap?.canDevices ?? []).map((c) => c.bus), ...state.chains.map((c) => c.bus)])].sort();

  return {
    state, snap, byId, byCodeKey, code, onSupply, ports, vrmPorts, buses,
    devicesOn: (supply) => onSupply.get(supply) ?? [],
    chain: (bus) => state.chains.find((c) => c.bus === bus),
    canDevices: (bus) => state.devices
      .filter((d) => d.code_key?.startsWith(`can:${bus}:`))
      .sort((a, b) => canIdOf(a) - canIdOf(b)),
    sources: () => state.devices.filter((d) => SOURCE_KINDS.includes(d.kind)).sort((a, b) => a.name.localeCompare(b.name)),
    supplyLabel: (supply) => supplyLabel(supply, byId),
  };
}

export function canIdOf(d) {
  return Number(d.code_key?.split(":")[2]);
}

export function supplyLabel(supply, byId) {
  if (!supply) return "—";
  if (supply.startsWith("dev:")) return byId.get(Number(supply.slice(4)))?.name ?? "(missing device)";
  if (supply.startsWith("VRM")) return supply.replace(/_/g, " ");
  return supply;
}

/** Ordered list of things a device can be powered from, for the supply picker. */
export function supplyOptions(model, excludeId) {
  return [
    { group: "PDH", items: PDH_PORTS.map((p) => ({ value: p, label: p })) },
    { group: "VRM", items: model.vrmPorts.map((p) => ({ value: p, label: supplyLabel(p) })) },
    { group: "roboRIO", items: [{ value: "RIO", label: "RIO" }] },
    {
      group: "Converters",
      items: model.sources().filter((d) => d.id !== excludeId).map((d) => ({ value: `dev:${d.id}`, label: d.name })),
    },
  ];
}
