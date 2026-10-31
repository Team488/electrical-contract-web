import { html, render, useCallback, useEffect, useMemo, useState } from "./vendor/preact-htm.standalone.mjs";
import { api, ConflictError } from "./api.js";
import { POLL_SECONDS } from "./config.js";
import { KIND_LABELS, PDH_PORTS, buildModel, canIdOf, supplyOptions } from "./model.js";
import { runChecks } from "./validate.js";

const TABS = [
  ["checks", "Checks"], ["can", "CAN"], ["chain", "CAN chain"], ["pdh", "PDH"], ["vrm", "VRM"],
  ["devices", "Devices & branches"], ["io", "DIO / PWM"], ["proposals", "Code changes"], ["history", "History"],
];

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "");

// ---------------------------------------------------------------- app shell

function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [tab, setTab] = useState(() => {
    try { return sessionStorage.getItem("ecw.tab") || "checks"; } catch { return "checks"; }
  });
  const [login, setLogin] = useState(api.currentLogin());
  const [dialog, setDialog] = useState(null); // {kind: 'login'|'conflict'|'proposal', ...}
  const [toast, setToast] = useState(null);
  const [robots, setRobots] = useState([]);

  const reload = useCallback(async () => {
    try {
      setState(await api.state());
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message);
    }
  }, []);

  // Load the robot list first, so a remembered robot that no longer exists falls back to the first one.
  useEffect(() => {
    (async () => {
      try {
        const list = await api.robots();
        setRobots(list);
        if (list.length && !list.some((r) => r.id === api.robotId())) api.setRobot(list[0].id);
      } catch { /* reload() reports the error */ }
      reload();
    })();
  }, [reload]);

  const pickRobot = (id) => {
    api.setRobot(id);
    setState(null);
    reload();
  };

  // Poll the cheap revision counter; refetch everything only when it moves.
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible" || !state) return;
      try {
        const { rev } = await api.rev();
        if (rev !== state.robot.rev) reload();
      } catch { /* offline for a moment; try again next tick */ }
    }, POLL_SECONDS * 1000);
    return () => clearInterval(t);
  }, [state, reload]);

  const pickTab = (t) => {
    setTab(t);
    try { sessionStorage.setItem("ecw.tab", t); } catch { /* ignore */ }
  };

  const showToast = (message, isError = false) => {
    setToast({ message, isError });
    setTimeout(() => setToast(null), 4000);
  };

  /**
   * Run a write. `attempt(version)` sends it with the given expected version; on a
   * conflict the user sees the other person's change and can overwrite with theirs.
   */
  const save = useCallback(async (attempt, version, describe) => {
    if (!api.currentLogin()) {
      setDialog({ kind: "login" });
      return false;
    }
    try {
      await attempt(version);
      await reload();
      return true;
    } catch (e) {
      if (e instanceof ConflictError) {
        setDialog({ kind: "conflict", current: e.current, describe, retry: () => attempt(e.current.version) });
      } else {
        if (!api.currentLogin()) setLogin(null);
        showToast(e.message, true);
        await reload();
      }
      return false;
    }
  }, [reload]);

  const model = useMemo(() => (state ? buildModel(state) : null), [state]);
  const checks = useMemo(() => (model ? runChecks(model) : []), [model]);

  if (!state) {
    return html`<main class="loading">${loadError ? html`<p class="error">${loadError}</p><button onClick=${reload}>Retry</button>` : "Loading…"}</main>`;
  }

  const ctx = { model, save, canEdit: !!login, openProposal: (device) => setDialog({ kind: "proposal", device }), showToast, reload };
  const errors = checks.filter((c) => c.level === "error").length;

  return html`
    <header>
      <div class="title">
        <div class="robot-row">
          <h1>${state.robot.name} wiring</h1>
          ${robots.length > 1 && html`
            <label class="robot-picker">Robot
              <select value=${state.robot.id} onChange=${(e) => pickRobot(Number(e.target.value))}>
                ${robots.map((r) => html`<option value=${r.id}>${r.name}</option>`)}
              </select>
            </label>`}
        </div>
        <span class="meta">
          ${state.robot.contract_class ?? ""}${state.robot.contract_name ? ` (ContractToUse = ${state.robot.contract_name})` : ""} ·
          Java ${state.snapshot?.git_sha?.slice(0, 7) ?? "—"} · imported ${fmtTime(state.snapshot?.imported_at)} · rev ${state.robot.rev}
        </span>
      </div>
      <div class="actions">
        <a class="button" href="print.html" target="_blank">Print / PDF</a>
        ${login
          ? html`<span class="who">Editing as <b>${login.name}</b></span>
                 <button class="link" onClick=${() => { api.logout(); setLogin(null); }}>Log out</button>`
          : html`<button class="primary" onClick=${() => setDialog({ kind: "login" })}>Log in to edit</button>`}
      </div>
    </header>
    <nav>
      ${TABS.map(([id, label]) => html`
        <button class=${tab === id ? "tab active" : "tab"} onClick=${() => pickTab(id)}>
          ${label}${id === "checks" && errors ? html` <span class="badge">${errors}</span>` : ""}
        </button>`)}
    </nav>
    <main>
      ${tab === "checks" && html`<${ChecksTab} checks=${checks} />`}
      ${tab === "can" && html`<${CanTab} ...${ctx} />`}
      ${tab === "chain" && html`<${ChainTab} ...${ctx} />`}
      ${tab === "pdh" && html`<${PortTable} ...${ctx} ports=${PDH_PORTS} title="PDH ports" />`}
      ${tab === "vrm" && html`<${VrmTab} ...${ctx} />`}
      ${tab === "devices" && html`<${DevicesTab} ...${ctx} />`}
      ${tab === "io" && html`<${IoTab} ...${ctx} />`}
      ${tab === "proposals" && html`<${ProposalsTab} ...${ctx} />`}
      ${tab === "history" && html`<${HistoryTab} ...${ctx} rev=${state.robot.rev} />`}
    </main>
    ${dialog?.kind === "login" && html`<${LoginDialog} onClose=${() => setDialog(null)} onLogin=${(l) => { setLogin(l); setDialog(null); }} />`}
    ${dialog?.kind === "conflict" && html`<${ConflictDialog} ...${dialog} model=${model}
        onClose=${() => { setDialog(null); reload(); }}
        onOverwrite=${async () => { setDialog(null); await save(dialog.retry, undefined, dialog.describe); }} />`}
    ${dialog?.kind === "proposal" && html`<${ProposalDialog} device=${dialog.device} model=${model} save=${save}
        onClose=${() => setDialog(null)} />`}
    ${toast && html`<div class=${toast.isError ? "toast error" : "toast"}>${toast.message}</div>`}
  `;
}

// ---------------------------------------------------------------- dialogs

function Dialog({ title, children, onClose }) {
  return html`
    <div class="overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="dialog" role="dialog" aria-label=${title}>
        <h2>${title}</h2>
        ${children}
      </div>
    </div>`;
}

function LoginDialog({ onClose, onLogin }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    setBusy(true);
    try {
      onLogin(await api.login(f.get("name"), f.get("passcode")));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return html`
    <${Dialog} title="Log in to edit" onClose=${onClose}>
      <form onSubmit=${submit} class="stack">
        <label>Your name<input name="name" required maxlength="40" autocomplete="name" /></label>
        <label>Team passcode<input name="passcode" type="password" required /></label>
        ${error && html`<p class="error">${error}</p>`}
        <div class="row end">
          <button type="button" onClick=${onClose}>Cancel</button>
          <button class="primary" disabled=${busy}>Log in</button>
        </div>
      </form>
    <//>`;
}

function ConflictDialog({ current, describe, model, onClose, onOverwrite }) {
  return html`
    <${Dialog} title="Someone else saved first" onClose=${onClose}>
      <p><b>${current?.updated_by ?? "Someone"}</b> changed this at ${fmtTime(current?.updated_at)}.</p>
      <dl class="compare">
        <dt>Theirs</dt><dd>${describe ? describe(current, model) : ""}</dd>
      </dl>
      <p>Keep their version, or overwrite it with yours?</p>
      <div class="row end">
        <button onClick=${onClose}>Keep theirs</button>
        <button class="danger" onClick=${onOverwrite}>Overwrite with mine</button>
      </div>
    <//>`;
}

const PROPOSAL_FIELDS = {
  can: ["CAN ID", "CAN bus", "Name", "Motor type", "Remove device"],
  io: ["Channel", "Name", "Remove device"],
};

function ProposalDialog({ device, model, save, onClose }) {
  const isCan = device.code_key.startsWith("can:");
  const fields = PROPOSAL_FIELDS[isCan ? "can" : "io"];
  const current = (field) => {
    const c = model.code.get(device.code_key);
    return { "CAN ID": canIdOf(device), "CAN bus": c?.bus, Name: device.name, "Motor type": c?.type, Channel: c?.channel }[field] ?? "";
  };
  const [field, setField] = useState(fields[0]);
  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const ok = await save(() => api.addProposal({
      device_id: device.id, field, from_val: String(current(field)), to_val: f.get("to_val") || "(remove)", note: f.get("note"),
    }));
    if (ok) onClose();
  };
  return html`
    <${Dialog} title=${`Propose a code change: ${device.name}`} onClose=${onClose}>
      <p class="hint">These fields live in the Java contract. Programming makes the change there; the next snapshot updates this page.</p>
      ${model.isShared(device) && html`<p class="warn-box">
        Defined in <b>${device.defined_in}</b>, which other robots' contracts share. Changing it there changes those robots
        too; Programming can instead override it in <b>${model.state.robot.contract_class}</b> for this robot only.
      </p>`}
      <form onSubmit=${submit} class="stack">
        <label>What to change
          <select value=${field} onChange=${(e) => setField(e.target.value)}>
            ${fields.map((x) => html`<option>${x}</option>`)}
          </select>
        </label>
        <label>Current value<input value=${current(field)} disabled /></label>
        ${field !== "Remove device" && html`<label>New value<input name="to_val" required maxlength="60" /></label>`}
        <label>Why (optional)<textarea name="note" maxlength="500" rows="2"></textarea></label>
        <div class="row end">
          <button type="button" onClick=${onClose}>Cancel</button>
          <button class="primary">Propose</button>
        </div>
      </form>
    <//>`;
}

// ---------------------------------------------------------------- shared inputs

/** Text/number input that saves on change. Re-mounts when the row's version moves. */
function Cell({ row, field, type = "text", disabled, onSave, placeholder, width }) {
  const value = row[field] ?? "";
  return html`<input key=${`${field}-${row.version}`} type=${type} defaultValue=${value} disabled=${disabled}
    placeholder=${placeholder} style=${width ? `width:${width}` : ""}
    onChange=${(e) => e.target.value !== String(value) && onSave(e.target.value)} />`;
}

function SupplySelect({ model, device, disabled, onChange, name }) {
  return html`
    <select name=${name} value=${device.supply ?? ""} disabled=${disabled} onChange=${(e) => onChange(e.target.value || null)}>
      <option value="">— none —</option>
      ${supplyOptions(model, device.id).map((g) => html`
        <optgroup label=${g.group}>${g.items.map((o) => html`<option value=${o.value}>${o.label}</option>`)}</optgroup>`)}
    </select>`;
}

const describeDevice = (row, model) => `${row.name}: powered from ${model.supplyLabel(row.supply)}${row.notes ? `, notes “${row.notes}”` : ""}`;
const describePort = (row) => `${row.port}: breaker ${row.breaker_a ?? "—"} A, wire ${row.wire_awg ?? "—"} AWG${row.notes ? `, notes “${row.notes}”` : ""}`;

function setSupply(save, device, supply) {
  return save((v) => api.updateDevice(device.id, v, { supply }), device.version, describeDevice);
}

// ---------------------------------------------------------------- tabs

function ChecksTab({ checks }) {
  if (!checks.length) return html`<p class="ok">All checks pass.</p>`;
  return html`
    <ul class="checks">
      ${checks.map((c) => html`<li class=${c.level}><span class="level">${c.level}</span><span class="area">${c.area}</span>${c.message}</li>`)}
    </ul>`;
}

/** Marks a field defined in a class other robots share (see the proposal dialog). */
function SharedTag({ model, device }) {
  return model.isShared(device)
    ? html` <span class="tag" title=${`Defined in ${device.defined_in}; other robots' contracts share it`}>shared</span>`
    : "";
}

function NotOnRobot({ model }) {
  if (!model.disabled.length) return "";
  return html`
    <section>
      <h2>Not on this robot <span class="count">${model.disabled.length}</span></h2>
      <p class="hint">In the code, but this robot's contract turns their mechanism off (readiness set), so the robot doesn't create them.</p>
      <p>${model.disabled.join(", ")}</p>
    </section>`;
}

function CanTab({ model, canEdit, openProposal }) {
  return [...model.buses.map((bus) => {
    const devs = model.canDevices(bus);
    const pos = new Map((model.chain(bus)?.order ?? []).map((k, i) => [k, i + 1]));
    return html`
      <section>
        <h2>CAN bus ${bus} <span class="count">${devs.filter((d) => d.in_code).length} devices</span></h2>
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Chain pos</th><th>Powered from</th><th></th></tr></thead>
          <tbody>
            ${devs.map((d) => {
              const c = model.code.get(d.code_key);
              return html`<tr class=${d.in_code ? "" : "removed"}>
                <td class="num">${canIdOf(d)}</td>
                <td>${d.name}${d.in_code ? "" : html` <em>(removed from code)</em>`}<${SharedTag} model=${model} device=${d} /></td>
                <td>${c?.type ?? ""}</td><td class="num">${pos.get(d.code_key) ?? "—"}</td>
                <td>${model.supplyLabel(d.supply)}</td>
                <td><button class="small" disabled=${!canEdit} onClick=${() => openProposal(d)}>Propose change</button></td>
              </tr>`;
            })}
          </tbody>
        </table>
      </section>`;
  }), html`<${NotOnRobot} model=${model} />`];
}

function ChainTab({ model, save, canEdit }) {
  return model.buses.map((bus) => {
    const chain = model.chain(bus);
    const order = chain?.order ?? [];
    const missing = model.canDevices(bus).filter((d) => d.in_code && !order.includes(d.code_key));
    const write = (next) => save((v) => api.setChain(bus, v, next), chain.version,
      (row) => `${JSON.parse(row.order_json).length} devices, first: ${JSON.parse(row.order_json).slice(0, 3).map((k) => model.byCodeKey.get(k)?.name ?? k).join(", ")}…`);
    const move = (i, delta) => {
      const next = [...order];
      [next[i], next[i + delta]] = [next[i + delta], next[i]];
      write(next);
    };
    return html`
      <section>
        <h2>${bus} daisy chain <span class="count">from the roboRIO / CANivore end</span></h2>
        ${!chain && html`<p class="hint">No chain yet for this bus.</p>`}
        <ol class="chain">
          ${order.map((key, i) => {
            const d = model.byCodeKey.get(key);
            return html`<li class=${d?.in_code ? "" : "removed"}>
              <span class="pos">${i + 1}</span>
              <span class="id">ID ${key.split(":")[2]}</span>
              <span class="name">${d?.name ?? "(not in code)"}</span>
              <span class="type">${model.code.get(key)?.type ?? ""}</span>
              <span class="row">
                <button class="small" title="Move up" disabled=${!canEdit || i === 0} onClick=${() => move(i, -1)}>↑</button>
                <button class="small" title="Move down" disabled=${!canEdit || i === order.length - 1} onClick=${() => move(i, 1)}>↓</button>
                <button class="small" title="Remove from chain" disabled=${!canEdit} onClick=${() => write(order.filter((k) => k !== key))}>✕</button>
              </span>
            </li>`;
          })}
        </ol>
        ${missing.length > 0 && html`
          <h3>Not in the chain yet</h3>
          <ul class="plain">
            ${missing.map((d) => html`<li>ID ${canIdOf(d)} ${d.name}
              <button class="small" disabled=${!canEdit || !chain} onClick=${() => write([...order, d.code_key])}>Add to end</button></li>`)}
          </ul>`}
      </section>`;
  });
}

function PortTable({ model, save, canEdit, ports, title, sourceNote }) {
  const assignable = [...model.state.devices].sort((a, b) => (a.supply ? 1 : 0) - (b.supply ? 1 : 0) || a.name.localeCompare(b.name));
  return html`
    <section>
      <h2>${title}${sourceNote && html` <span class="count">${sourceNote}</span>`}</h2>
      <table class="ports">
        <thead><tr><th>Port</th><th>Connected devices</th><th>Breaker (A)</th><th>Wire (AWG)</th><th>Notes</th></tr></thead>
        <tbody>
          ${ports.map((port) => {
            const row = model.ports.get(port);
            const devs = model.devicesOn(port);
            const savePort = (changes) => save((v) => api.updatePort(port, v, changes), row.version, describePort);
            return html`<tr>
              <td class="port">${port.replace(/^VRM\d_/, "")}</td>
              <td>
                <div class="chips">
                  ${devs.map((d) => html`<span class=${d.kind === "motor" ? "chip motor" : "chip"}>${d.name}
                    ${canEdit && html`<button class="x" title="Disconnect" onClick=${() => setSupply(save, d, null)}>×</button>`}</span>`)}
                  ${canEdit && html`<select class="add" value="" onChange=${(e) => {
                      const d = model.byId.get(Number(e.target.value));
                      if (d) setSupply(save, d, port);
                    }}>
                    <option value="">+ connect…</option>
                    ${assignable.filter((d) => d.supply !== port).map((d) => html`<option value=${d.id}>${d.name}${d.supply ? ` (now ${model.supplyLabel(d.supply)})` : ""}</option>`)}
                  </select>`}
                </div>
              </td>
              <td>${row && html`<${Cell} row=${row} field="breaker_a" type="number" width="5em" disabled=${!canEdit} onSave=${(v) => savePort({ breaker_a: v === "" ? null : Number(v) })} />`}</td>
              <td>${row && html`<${Cell} row=${row} field="wire_awg" type="number" width="5em" disabled=${!canEdit} onSave=${(v) => savePort({ wire_awg: v === "" ? null : Number(v) })} />`}</td>
              <td>${row && html`<${Cell} row=${row} field="notes" disabled=${!canEdit} onSave=${(v) => savePort({ notes: v })} />`}</td>
            </tr>`;
          })}
        </tbody>
      </table>
    </section>`;
}

function VrmTab(props) {
  const { model } = props;
  const vrms = model.state.devices.filter((d) => d.kind === "vrm").sort((a, b) => a.name.localeCompare(b.name));
  if (!vrms.length) return html`<p class="hint">No VRM on this robot. Add one under Devices & branches with kind “VRM”.</p>`;
  return vrms.map((vrm) => html`<${PortTable} ...${props} title=${vrm.name}
    sourceNote=${`powered from ${model.supplyLabel(vrm.supply)}`}
    ports=${model.vrmPorts.filter((p) => p.startsWith(`${vrm.name}_`))} />`);
}

function DevicesTab({ model, save, canEdit, showToast }) {
  const devices = [...model.state.devices].sort((a, b) => a.name.localeCompare(b.name));
  const addDevice = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const ok = await save(() => api.addDevice({ name: f.get("name"), kind: f.get("kind"), supply: f.get("supply") || null, notes: f.get("notes") }));
    if (ok) e.target.reset();
  };
  const remove = (d) => save((v) => api.deleteDevice(d.id, v), d.version, describeDevice)
    .then((ok) => ok && showToast(`Removed ${d.name}. Undo from History.`));

  const roots = [...PDH_PORTS, ...model.vrmPorts, "RIO"].filter((p) => model.devicesOn(p).length);
  const Tree = ({ supply }) => model.devicesOn(supply).map((d) => html`
    <li>${d.name} <span class="kind">${KIND_LABELS[d.kind]}</span>
      ${model.devicesOn(`dev:${d.id}`).length > 0 && html`<ul><${Tree} supply=${`dev:${d.id}`} /></ul>`}
    </li>`);

  return html`
    <section>
      <h2>Power tree</h2>
      <ul class="tree">
        ${roots.map((p) => html`<li><b>${model.supplyLabel(p)}</b><ul><${Tree} supply=${p} /></ul></li>`)}
      </ul>
    </section>
    <section>
      <h2>All devices <span class="count">${devices.length}</span></h2>
      <table>
        <thead><tr><th>Name</th><th>Kind</th><th>From</th><th>Powered from</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          ${devices.map((d) => html`<tr class=${d.code_key && !d.in_code ? "removed" : ""}>
            <td>${d.code_key ? d.name : html`<${Cell} row=${d} field="name" disabled=${!canEdit}
                onSave=${(v) => save((ver) => api.updateDevice(d.id, ver, { name: v }), d.version, describeDevice)} />`}</td>
            <td>${d.code_key ? KIND_LABELS[d.kind] : html`
              <select value=${d.kind} disabled=${!canEdit}
                onChange=${(e) => save((ver) => api.updateDevice(d.id, ver, { kind: e.target.value }), d.version, describeDevice)}>
                ${["vrm", "converter", "load"].map((k) => html`<option value=${k}>${KIND_LABELS[k]}</option>`)}
              </select>`}</td>
            <td>${d.code_key ? (d.in_code ? "Java" : "Java (removed)") : "Web"}</td>
            <td><${SupplySelect} model=${model} device=${d} disabled=${!canEdit} onChange=${(s) => setSupply(save, d, s)} /></td>
            <td><${Cell} row=${d} field="notes" disabled=${!canEdit}
                onSave=${(v) => save((ver) => api.updateDevice(d.id, ver, { notes: v }), d.version, describeDevice)} /></td>
            <td>${(!d.code_key || !d.in_code) && html`<button class="small" disabled=${!canEdit} onClick=${() => remove(d)}>Delete</button>`}</td>
          </tr>`)}
        </tbody>
      </table>
    </section>
    <section>
      <h2>Add a device</h2>
      <p class="hint">For things the robot code doesn't know about: radio, switch, coprocessors, converters, fans. Motors and sensors come from the Java contract.</p>
      <form class="row wrap" onSubmit=${addDevice}>
        <input name="name" placeholder="Name" required maxlength="60" disabled=${!canEdit} />
        <select name="kind" disabled=${!canEdit}>
          <option value="load">Load</option><option value="converter">Converter</option><option value="vrm">VRM</option>
        </select>
        <${SupplySelect} name="supply" model=${model} device=${{ id: null, supply: null }} disabled=${!canEdit} onChange=${() => {}} />
        <input name="notes" placeholder="Notes" maxlength="500" disabled=${!canEdit} />
        <button class="primary" disabled=${!canEdit}>Add</button>
      </form>
    </section>`;
}

function IoTab({ model, canEdit, openProposal }) {
  return [["dio", "RIO digital I/O"], ["pwm", "PWM"]].map(([kind, title]) => {
    const devs = model.state.devices.filter((d) => d.kind === kind)
      .sort((a, b) => Number(a.code_key.split(":")[1]) - Number(b.code_key.split(":")[1]));
    return html`
      <section>
        <h2>${title} <span class="count">${devs.length}</span></h2>
        <table>
          <thead><tr><th>Channel</th><th>Name</th><th></th></tr></thead>
          <tbody>${devs.map((d) => html`<tr class=${d.in_code ? "" : "removed"}>
            <td class="num">${d.code_key.split(":")[1]}</td><td>${d.name}<${SharedTag} model=${model} device=${d} /></td>
            <td><button class="small" disabled=${!canEdit} onClick=${() => openProposal(d)}>Propose change</button></td>
          </tr>`)}</tbody>
        </table>
      </section>`;
  });
}

function ProposalsTab({ model, save, canEdit }) {
  const props = model.state.proposals;
  if (!props.length) return html`<p class="hint">No proposed code changes. Use “Propose change” on the CAN or DIO / PWM tabs.</p>`;
  return html`
    <section><table>
      <thead><tr><th>Device</th><th>Change</th><th>Why</th><th>By</th><th>Status</th></tr></thead>
      <tbody>${props.map((p) => html`<tr class=${p.status}>
        <td>${model.byId.get(p.device_id)?.name ?? "(deleted)"}</td>
        <td>${p.field}: ${p.from_val} → <b>${p.to_val}</b></td>
        <td>${p.note}</td>
        <td>${p.created_by}<br /><span class="meta">${fmtTime(p.created_at)}</span></td>
        <td><select value=${p.status} disabled=${!canEdit}
            onChange=${(e) => save((v) => api.updateProposal(p.id, v, { status: e.target.value }), p.version, (row) => `status ${row.status}`)}>
          <option value="open">Open</option><option value="done">Done in Java</option><option value="rejected">Rejected</option>
        </select></td>
      </tr>`)}</tbody>
    </table></section>`;
}

function summarizeAudit(a) {
  const before = a.before_json ? JSON.parse(a.before_json) : null;
  const after = a.after_json ? JSON.parse(a.after_json) : null;
  if (a.entity === "code_snapshot") {
    return `Imported Java snapshot ${after.gitSha?.slice(0, 7) ?? ""}: ${after.added} added, ${after.changed} changed, ${after.removed} removed${after.seeded ? ", seeded wiring" : ""}`;
  }
  const name = (after ?? before).name ?? (after ?? before).port ?? (after ?? before).bus ?? a.entity_key;
  if (!before) return `Added ${a.entity.replace("_", " ")} ${name}`;
  if (!after) return `Deleted ${name}`;
  const skip = new Set(["version", "updated_by", "updated_at"]);
  const diffs = Object.keys(after).filter((k) => !skip.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const fmt = (k, v) => (k === "order_json" ? `${JSON.parse(v).length} devices` : v ?? "—");
  return `${name}: ${diffs.map((k) => `${k.replace("_json", "")} ${fmt(k, before[k])} → ${fmt(k, after[k])}`).join("; ")}`;
}

function HistoryTab({ save, canEdit, rev, showToast }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.audit().then(setRows).catch((e) => showToast(e.message, true)); }, [rev]);
  if (!rows) return html`<p>Loading…</p>`;
  return html`
    <section><table>
      <thead><tr><th>When</th><th>Who</th><th>What</th><th></th></tr></thead>
      <tbody>${rows.map((a) => html`<tr>
        <td class="nowrap">${fmtTime(a.at)}</td><td>${a.user}</td><td>${summarizeAudit(a)}</td>
        <td>${a.entity !== "code_snapshot" && html`<button class="small" disabled=${!canEdit}
            onClick=${() => save(() => api.revert(a.id)).then((ok) => ok && showToast("Reverted"))}>Undo</button>`}</td>
      </tr>`)}</tbody>
    </table></section>`;
}

render(html`<${App} />`, document.getElementById("app"));
