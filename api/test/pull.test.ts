import { randomUUID } from "node:crypto";
import { beforeEach, expect, inject, it } from "vitest";
import { makeDocClient } from "../src/config.ts";
import { DynamoStore } from "../src/dynamo-store.ts";
import { makePuller, parseSources, type Source } from "../src/pull.ts";
import { createTableIfMissing, ensureRobot } from "../src/table.ts";
import snapshot from "./fixtures/snapshot-2026.json" with { type: "json" };
import snapshot2023 from "./fixtures/snapshot-2023.json" with { type: "json" };

let store: DynamoStore;

beforeEach(async () => {
  const doc = makeDocClient(inject("ddbEndpoint"));
  const table = `t-${randomUUID()}`;
  await createTableIfMissing(doc, table);
  await ensureRobot(doc, table);
  store = new DynamoStore(doc, table);
});

/** A fake raw.githubusercontent.com folder; counts requests. */
function fakeGitHub(files: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    const name = url.split("/").pop()!;
    return name in files ? new Response(JSON.stringify(files[name])) : new Response("missing", { status: 404 });
  };
  return { calls, fetchFn, files };
}

const R26 = "Team488/TeamXbot2026";
const src = (repo = R26, url = "https://example/snaps"): Source[] => [{ repo, url }];

const index = (gitSha: string) => ({
  gitSha, contracts: [{ name: "Competition", file: "Competition.json" }, { name: "2023", file: "2023.json" }],
});

it("imports every published contract once per commit", async () => {
  const gh = fakeGitHub({
    "index.json": index("aaa"),
    "Competition.json": { ...snapshot, contractName: "Competition" },
    "2023.json": snapshot2023,
  });
  const pull = makePuller(store, src(), 0, gh.fetchFn);

  await pull();
  expect((await store.listRobots()).map((r) => r.contract_name)).toEqual(["Competition", "2023"]);
  expect(await store.syncedSha(R26)).toBe("aaa");
  const rev = await store.rev(1);

  // Same commit again: only index.json is fetched, nothing re-imported.
  gh.calls.length = 0;
  await pull();
  expect(gh.calls).toEqual(["https://example/snaps/index.json"]);
  expect(await store.rev(1)).toBe(rev);

  // New commit: imported.
  gh.files["index.json"] = index("bbb");
  await pull();
  expect(await store.syncedSha(R26)).toBe("bbb");
  expect(await store.rev(1)).toBe(rev + 1);
});

it("checks at most once per interval", async () => {
  const gh = fakeGitHub({ "index.json": index("aaa"), "Competition.json": snapshot, "2023.json": snapshot2023 });
  const pull = makePuller(store, src(), 60_000, gh.fetchFn);
  await pull();
  await pull();
  expect(gh.calls.filter((u) => u.endsWith("index.json"))).toHaveLength(1);
});

it("retries a commit whose import failed", async () => {
  const gh = fakeGitHub({ "index.json": index("aaa"), "Competition.json": snapshot }); // 2023.json missing
  const pull = makePuller(store, src(), 0, gh.fetchFn);
  await pull();
  expect(await store.syncedSha(R26)).toBeNull();
  gh.files["2023.json"] = snapshot2023;
  await pull();
  expect(await store.syncedSha(R26)).toBe("aaa");
});

it("does nothing without a source", async () => {
  const gh = fakeGitHub({});
  await makePuller(store, [], 0, gh.fetchFn)();
  expect(gh.calls).toHaveLength(0);
});

it("keeps each repo's robots apart, and one broken repo doesn't stop the others", async () => {
  const calls: string[] = [];
  const repos: Record<string, Record<string, unknown>> = {
    a: { "index.json": index("aaa"), "Competition.json": snapshot, "2023.json": snapshot2023 },
    b: { "index.json": index("bbb"), "Competition.json": snapshot, "2023.json": snapshot2023 },
  };
  const fetchFn = async (url: string) => {
    calls.push(url);
    const [, folder, name] = /example\/(\w+)\/(.+)$/.exec(url)!;
    const f = repos[folder]?.[name];
    return f ? new Response(JSON.stringify(f)) : new Response("missing", { status: 404 });
  };
  const sources: Source[] = [
    { repo: "Team488/TeamXbot2026", url: "https://example/a" },
    { repo: "Team488/TeamXbot2027", url: "https://example/b" },
    { repo: "Team488/Broken", url: "https://example/none" },
  ];
  await makePuller(store, sources, 0, fetchFn)();

  const robots = await store.listRobots();
  expect(robots.map((r) => [r.repo, r.contract_name]).sort()).toEqual([
    ["Team488/TeamXbot2026", "2023"], ["Team488/TeamXbot2026", "Competition"],
    ["Team488/TeamXbot2027", "2023"], ["Team488/TeamXbot2027", "Competition"],
  ]);
  expect(await store.syncedSha("Team488/TeamXbot2026")).toBe("aaa");
  expect(await store.syncedSha("Team488/TeamXbot2027")).toBe("bbb");
  expect(await store.syncedSha("Team488/Broken")).toBeNull();
});

it("reads the repo from a raw GitHub URL, or from owner/name=url", () => {
  expect(parseSources(
    "https://raw.githubusercontent.com/Team488/TeamXbot2026/electrical-snapshots/main/, Team488/Other=http://localhost:9/x",
  )).toEqual([
    { repo: "Team488/TeamXbot2026", url: "https://raw.githubusercontent.com/Team488/TeamXbot2026/electrical-snapshots/main" },
    { repo: "Team488/Other", url: "http://localhost:9/x" },
  ]);
  expect(parseSources(undefined)).toEqual([]);
  expect(() => parseSources("https://example/snaps")).toThrow(/needs a repo/);
});
