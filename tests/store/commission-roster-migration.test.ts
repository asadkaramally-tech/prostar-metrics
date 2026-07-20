import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../infra/db/migrations/009_commission_roster_seed.sql", import.meta.url),
  "utf8",
);

test("commission roster seed preserves the nine prior-dashboard identities and effective dates", () => {
  const employees = [
    [17, "Rob Sires", "2007-08-23"],
    [134, "Roberto Villalta", "2022-11-21"],
    [168, "Ernie Hernandez", "2023-03-08"],
    [205, "Juan Serrato", "2023-12-06"],
    [209, "Justin Molina", "2024-05-08"],
    [216, "Jeffrey Perry", "2025-04-21"],
    [251, "Erick Eudave", "2025-09-18"],
    [252, "Cole Bender", "2025-10-13"],
    [253, "Victor Contreras", "2025-11-17"],
  ];
  for (const [id, name, date] of employees) {
    assert.match(migration, new RegExp(`\\(${id}::bigint,\\s*'${name}'::text,\\s*'${date}'::date\\)`));
  }
  assert.equal([...migration.matchAll(/::bigint,/g)].length, 9);
});

test("commission roster seed is idempotent, included, and audited", () => {
  assert.match(migration, /where not exists/);
  assert.match(migration, /existing\.employee_id = r\.employee_id/);
  assert.match(migration, /existing\.effective_start = r\.effective_start/);
  assert.match(migration, /select r\.employee_id, r\.display_name, true, 'standard'/);
  assert.match(migration, /insert into metrics\.audit_events/);
  assert.match(migration, /commission_roster_seeded/);
});
