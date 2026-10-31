// Pull contract snapshots published by TeamXbot2026's "Electrical snapshots" GitHub
// Action. `source` is the folder URL holding index.json and one <Contract>.json per robot,
// e.g. https://raw.githubusercontent.com/Team488/TeamXbot2026/electrical-snapshots/main
//
// Called on page loads and polls; checks at most once per interval per API instance, and
// imports only when the published commit differs from the last one imported. A claim in
// the table makes sure only one API instance imports a given commit.

import { checkShape } from "./snapshot.ts";
import type { Store } from "./store.ts";
import type { Snapshot } from "./types.ts";

interface Index {
  gitSha: string;
  contracts: { name: string; file: string }[];
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function makePuller(store: Store, source: string | undefined, intervalMs: number, fetchFn: Fetch = fetch): () => Promise<void> {
  let lastCheck = -Infinity;
  let running: Promise<void> | null = null;

  const getJson = async <T>(file: string): Promise<T> => {
    const res = await fetchFn(`${source}/${file}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  const pull = async () => {
    const index = await getJson<Index>("index.json");
    const imported = await store.syncedSha();
    if (imported === index.gitSha) return;
    if (!(await store.claimSync(imported, index.gitSha))) return; // another instance has it
    try {
      for (const c of index.contracts) {
        const snap = await getJson<Snapshot>(c.file);
        checkShape(snap);
        await store.importSnapshot(await store.robotForContract(c.name, snap), snap);
      }
    } catch (e) {
      await store.claimSync(index.gitSha, imported).catch(() => {}); // let the next check retry
      throw e;
    }
  };

  return async () => {
    if (!source || Date.now() - lastCheck < intervalMs) return;
    lastCheck = Date.now();
    running ??= pull()
      .catch((e) => console.error("Snapshot pull failed:", e))
      .finally(() => { running = null; });
    await running;
  };
}
