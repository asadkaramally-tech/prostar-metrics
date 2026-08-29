import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("generated project inventory is current and covers the source-backed contract", async () => {
  const check = spawnSync(process.execPath, ["scripts/generate-project-inventory.mjs", "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const inventory = JSON.parse(await readFile(new URL("../../docs/inventory.generated.json", import.meta.url), "utf8"));
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.pages.length, 7);
  assert.equal(inventory.apis.length, 19);
  assert.equal(inventory.jobs.length, 24);
  assert.deepEqual(inventory.apis.filter((route) => route.auth === "public").map((route) => route.route), ["/api/health"]);
  assert.equal(inventory.apis.find((route) => route.route === "/api/auth/session")?.auth, "authenticated-owner");
  assert.deepEqual(inventory.apis.filter((route) => route.auth === "unknown-review-required"), []);
  assert.equal(inventory.migrations.at(-1).name.startsWith("052_"), true);
  assert.ok(inventory.configuration.sourceReferenced.includes("AZURE_POSTGRES_CONNECTION_STRING"));
});
