/**
 * Small in-memory TTL cache for page-level read-model loads.
 *
 * The dashboards are server-rendered and every request was re-running the full
 * read-model queries (10s+ on the quote/today paths), and concurrent requests
 * stampeded the same queries. Read models rebuild on a 15-minute cadence, so a
 * short serving cache cannot make the page meaningfully staler than its data.
 *
 * Semantics:
 * - Keyed lookups with a per-entry TTL.
 * - In-flight dedupe: concurrent callers of the same key share one promise.
 * - Failures are never cached; the next request retries the real load.
 */

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const MAX_SETTLED_ENTRIES = 128;
const settled = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const inFlightTokens = new Map<string, symbol>();
let cacheGeneration = 0;

export async function cachedPageLoad<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  pruneExpired(now);
  const hit = settled.get(key);
  if (hit && hit.expiresAt > now) {
    settled.delete(key);
    settled.set(key, hit);
    return hit.value as T;
  }

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const generation = cacheGeneration;
  const token = Symbol(key);
  inFlightTokens.set(key, token);
  const promise = (async () => {
    try {
      const value = await load();
      if (ttlMs > 0 && generation === cacheGeneration) {
        pruneExpired(Date.now());
        settled.set(key, { value, expiresAt: Date.now() + ttlMs });
        trimSettled();
      }
      return value;
    } finally {
      if (inFlightTokens.get(key) === token) {
        inFlight.delete(key);
        inFlightTokens.delete(key);
      }
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

export function clearPageLoadCache() {
  cacheGeneration += 1;
  settled.clear();
  inFlight.clear();
  inFlightTokens.clear();
}

export function getPageLoadCacheStats() {
  pruneExpired(Date.now());
  return {
    settledEntries: settled.size,
    inFlightEntries: inFlight.size,
  };
}

function pruneExpired(now: number) {
  for (const [key, entry] of settled) {
    if (entry.expiresAt <= now) settled.delete(key);
  }
}

function trimSettled() {
  while (settled.size > MAX_SETTLED_ENTRIES) {
    const oldest = settled.keys().next().value;
    if (oldest === undefined) return;
    settled.delete(oldest);
  }
}
