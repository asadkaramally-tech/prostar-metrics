import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release build uses the explicit port-independent webpack backend", async () => {
  const source = await readFile(new URL("../../scripts/run-evidence-build.mjs", import.meta.url), "utf8");
  assert.match(source, /"build", "--webpack"/);
});
