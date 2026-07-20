import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReviewedQuoteExclusionSeeds,
} from "../../src/lib/store/reviewed-quote-exclusions";
import type { PostgresQuery } from "../../src/lib/store/postgres";

test("pre-034 prior images keep quote ingestion compatible without calling a missing seed function", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const query: PostgresQuery = async <T>(text: string, values?: unknown[]) => {
    calls.push({ text, values });
    return { rows: [{ available: false } as T], rowCount: 1 };
  };

  assert.equal(await applyReviewedQuoteExclusionSeeds([470], query), 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /to_regprocedure/);
  assert.doesNotMatch(calls[0]!.text, /select applied_count from metrics\.apply_reviewed/);
});

test("post-034 schemas invoke the durable seed function with exact quote IDs", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const query: PostgresQuery = async <T>(text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes("to_regprocedure")) {
      return { rows: [{ available: true } as T], rowCount: 1 };
    }
    return { rows: [{ applied_count: 2 } as T], rowCount: 1 };
  };

  assert.equal(await applyReviewedQuoteExclusionSeeds([757, 757, 762], query), 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.text, /metrics\.apply_reviewed_quote_exclusion_seeds/);
  assert.deepEqual(calls[1]!.values, [[757, 762]]);
});
