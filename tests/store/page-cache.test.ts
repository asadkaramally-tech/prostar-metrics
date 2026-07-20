import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import {
  cachedPageLoad,
  clearPageLoadCache,
  getPageLoadCacheStats,
} from "../../src/lib/store/page-cache";

test("page cache dedupes concurrent loads for the same key", async () => {
  clearPageLoadCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    await sleep(5);
    return { value: "payload" };
  };

  const [first, second] = await Promise.all([
    cachedPageLoad("same", 1_000, load),
    cachedPageLoad("same", 1_000, load),
  ]);

  assert.equal(loads, 1);
  assert.equal(first, second);
  assert.deepEqual(getPageLoadCacheStats(), { settledEntries: 1, inFlightEntries: 0 });
});

test("page cache does not cache failures", async () => {
  clearPageLoadCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    throw new Error("temporary failure");
  };

  await assert.rejects(() => cachedPageLoad("fails", 1_000, load), /temporary failure/);
  await assert.rejects(() => cachedPageLoad("fails", 1_000, load), /temporary failure/);

  assert.equal(loads, 2);
  assert.deepEqual(getPageLoadCacheStats(), { settledEntries: 0, inFlightEntries: 0 });
});

test("page cache prunes expired and excess settled entries", async () => {
  clearPageLoadCache();
  await cachedPageLoad("expired", 1, async () => "old");
  await sleep(5);
  await cachedPageLoad("current", 1_000, async () => "new");

  assert.deepEqual(getPageLoadCacheStats(), { settledEntries: 1, inFlightEntries: 0 });

  for (let index = 0; index < 140; index += 1) {
    await cachedPageLoad(`key-${index}`, 1_000, async () => index);
  }

  assert.deepEqual(getPageLoadCacheStats(), { settledEntries: 128, inFlightEntries: 0 });
});

test("page cache invalidation prevents older in-flight loads from repopulating stale values", async () => {
  clearPageLoadCache();
  let release!: (value: string) => void;
  const first = cachedPageLoad("race", 1_000, () => new Promise<string>((resolve) => {
    release = resolve;
  }));

  assert.deepEqual(getPageLoadCacheStats(), { settledEntries: 0, inFlightEntries: 1 });
  clearPageLoadCache();
  release("old");
  assert.equal(await first, "old");
  assert.deepEqual(getPageLoadCacheStats(), { settledEntries: 0, inFlightEntries: 0 });

  const fresh = await cachedPageLoad("race", 1_000, async () => "new");
  assert.equal(fresh, "new");
  assert.deepEqual(getPageLoadCacheStats(), { settledEntries: 1, inFlightEntries: 0 });
});
