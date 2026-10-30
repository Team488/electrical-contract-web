import { API_BASE, ROBOT_ID } from "./config.js";

const TOKEN_KEY = "ecw.token";

export class ConflictError extends Error {
  constructor(message, current) {
    super(message);
    this.current = current;
  }
}

export function getLogin() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    return saved && saved.exp > Date.now() ? saved : null;
  } catch {
    return null;
  }
}

function saveLogin(login) {
  try {
    if (login) localStorage.setItem(TOKEN_KEY, JSON.stringify(login));
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode: login lasts for this page only */ }
}

let memoryLogin = getLogin();

async function call(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (memoryLogin) headers.authorization = `Bearer ${memoryLogin.token}`;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Can't reach the server. Is it running?");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) throw new ConflictError(data.error, data.current);
  if (res.status === 401) {
    memoryLogin = null;
    saveLogin(null);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const r = (p = "") => `/api/robots/${ROBOT_ID}${p}`;

export const api = {
  login: async (name, passcode) => {
    memoryLogin = await call("POST", "/api/auth", { name, passcode });
    saveLogin(memoryLogin);
    return memoryLogin;
  },
  logout: () => {
    memoryLogin = null;
    saveLogin(null);
  },
  currentLogin: () => memoryLogin,
  state: () => call("GET", r()),
  rev: () => call("GET", r("/rev")),
  audit: () => call("GET", r("/audit")),
  updateDevice: (id, version, changes) => call("PATCH", r(`/devices/${id}`), { version, changes }),
  addDevice: (device) => call("POST", r("/devices"), device),
  deleteDevice: (id, version) => call("DELETE", r(`/devices/${id}?version=${version}`)),
  updatePort: (port, version, changes) => call("PATCH", r(`/ports/${port}`), { version, changes }),
  setChain: (bus, version, order) => call("PUT", r(`/chains/${bus}`), { version, order }),
  addProposal: (p) => call("POST", r("/proposals"), p),
  updateProposal: (id, version, changes) => call("PATCH", r(`/proposals/${id}`), { version, changes }),
  revert: (auditId) => call("POST", r(`/audit/${encodeURIComponent(auditId)}/revert`)),
};
