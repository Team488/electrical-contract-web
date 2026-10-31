import { randomUUID } from "node:crypto";
import { beforeEach, expect, inject, it } from "vitest";
import { makeDocClient } from "../src/config.ts";
import { DynamoStore } from "../src/dynamo-store.ts";
import { makePuller } from "../src/pull.ts";
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

const index = (gitSha: string) => ({
  gitSha, contracts: [{ name: "Competition", file: "Competition.json" }, { name: "2023", file: "2023.json" }],
});

it("imports every published contract once per commit", async () => {
  const gh = fakeGitHub({
    "index.json": index("aaa"),
    "Competition.json": { ...snapshot, contractName: "Competition" },
    "2023.json": snapshot2023,
  });
  const pull = makePuller(store, "https://example/snaps", 0, gh.fetchFn);

  await pull();
  expect((await store.listRobots()).map((r) => r.contract_name)).toEqual(["Competition", "2023"]);
  expect(await store.syncedSha()).toBe("aaa");
  const rev = await store.rev(1);

  // Same commit again: only index.json is fetched, nothing re-imported.
  gh.calls.length = 0;
  await pull();
  expect(gh.calls).toEqual(["https://example/snaps/index.json"]);
  expect(await store.rev(1)).toBe(rev);

  // New commit: imported.
  gh.files["index.json"] = index("bbb");
  await pull();
  expect(await store.syncedSha()).toBe("bbb");
  expect(await store.rev(1)).toBe(rev + 1);
});

it("checks at most once per interval", async () => {
  const gh = fakeGitHub({ "index.json": index("aaa"), "Competition.json": snapshot, "2023.json": snapshot2023 });
  const pull = makePuller(store, "https://example/snaps", 60_000, gh.fetchFn);
  await pull();
  await pull();
  expect(gh.calls.filter((u) => u.endsWith("index.json"))).toHaveLength(1);
});

it("retries a commit whose import failed", async () => {
  const gh = fakeGitHub({ "index.json": index("aaa"), "Competition.json": snapshot }); // 2023.json missing
  const pull = makePuller(store, "https://example/snaps", 0, gh.fetchFn);
  await pull();
  expect(await store.syncedSha()).toBeNull();
  gh.files["2023.json"] = snapshot2023;
  await pull();
  expect(await store.syncedSha()).toBe("aaa");
});

it("does nothing without a source", async () => {
  const gh = fakeGitHub({});
  await makePuller(store, undefined, 0, gh.fetchFn)();
  expect(gh.calls).toHaveLength(0);
});
