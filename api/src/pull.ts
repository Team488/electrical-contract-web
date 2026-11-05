// Pull contract snapshots published by each season repo's "Electrical snapshots" GitHub
// Action. A source is the folder URL holding index.json and one <Contract>.json per robot,
// e.g. https://raw.githubusercontent.com/Team488/TeamXbot2026/electrical-snapshots/main
//
// Called on page loads and polls; checks at most once per interval per API instance, and
// imports a repo's snapshots only when its published commit differs from the last one
// imported. A claim in the table makes sure only one API instance imports a given commit.
// Each repo is pulled on its own, so one broken repo doesn't hold up the others.

import { checkShape } from "./snapshot.ts";
import type { Store } from "./store.ts";
import { REPO_RE } from "./table.ts";
import type { Snapshot } from "./types.ts";

interface Index {
  gitSha: string;
  contracts: { name: string; file: string }[];
}

export interface Source {
  /** GitHub "owner/name" the robots belong to. */
  repo: string;
  url: string;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const RAW_GITHUB = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//;

/**
 * Parse SNAPSHOT_SOURCES: comma-separated folder URLs. A raw.githubusercontent.com URL
 * names its own repo; anything else needs "owner/name=url".
 */
export function parseSources(text: string | undefined): Source[] {
  return (text ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const eq = entry.indexOf("=");
    const [repo, url] = eq > 0 && !entry.slice(0, eq).includes(":")
      ? [entry.slice(0, eq), entry.slice(eq + 1)]
      : [RAW_GITHUB.exec(entry)?.slice(1, 3).join("/") ?? "", entry];
    if (!REPO_RE.test(repo)) throw new Error(`Snapshot source needs a repo ("owner/name=url"): ${entry}`);
    return { repo, url: url.replace(/\/+$/, "") };
  });
}

export function makePuller(store: Store, sources: Source[], intervalMs: number, fetchFn: Fetch = fetch): () => Promise<void> {
  let lastCheck = -Infinity;
  let running: Promise<void> | null = null;

  const getJson = async <T>(source: Source, file: string): Promise<T> => {
    const res = await fetchFn(`${source.url}/${file}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${source.repo} ${file}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  const pullOne = async (source: Source) => {
    const index = await getJson<Index>(source, "index.json");
    const imported = await store.syncedSha(source.repo);
    if (imported === index.gitSha) return;
    if (!(await store.claimSync(source.repo, imported, index.gitSha))) return; // another instance has it
    try {
      for (const c of index.contracts) {
        const snap = await getJson<Snapshot>(source, c.file);
        checkShape(snap);
        await store.importSnapshot(await store.robotForContract(source.repo, c.name, snap), snap);
      }
    } catch (e) {
      await store.claimSync(source.repo, index.gitSha, imported).catch(() => {}); // let the next check retry
      throw e;
    }
  };

  const pullAll = async () => {
    const results = await Promise.allSettled(sources.map(pullOne));
    results.forEach((r, i) => {
      if (r.status === "rejected") console.error(`Snapshot pull from ${sources[i].repo} failed:`, r.reason);
    });
  };

  return async () => {
    if (!sources.length || Date.now() - lastCheck < intervalMs) return;
    lastCheck = Date.now();
    running ??= pullAll().finally(() => { running = null; });
    await running;
  };
}
