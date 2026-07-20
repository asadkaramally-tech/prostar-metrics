import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_GATE_ASSERTION_EVENT_PREFIX,
  UNDERLYING_GATE_COMMANDS,
  extractReleaseGateAssertionEvents,
  releaseGateAssertionEvent,
} from "../../scripts/lib/release-gate-assertions.mjs";
import { validateEvidenceRunnerWhatIf } from "../../scripts/deploy-evidence-runners.mjs";
import { evidenceRunnerWhatIfFixture } from "./evidence-runner-test-fixture.mjs";

test("expanded reviewer evidence-runner adversarial matrix", async (t) => {
  const baseline = evidenceRunnerWhatIfFixture();
  const cases = [];
  const resourceChanges = baseline.document.changes.slice(0, 11);
  const assignmentChanges = baseline.document.changes.slice(11);

  cases.push(syncCase("non-success SDK envelope", (document) => {
    document.status = "Running";
  }, /successful SDK envelope/));
  cases.push(syncCase("SDK envelope with an operation error", (document) => {
    document.error = { code: "DeploymentWhatIfFailed" };
  }, /successful SDK envelope/));
  cases.push(syncCase("REST-style nested changes instead of the Azure CLI SDK envelope", (document) => {
    document.properties = { changes: document.changes };
    delete document.changes;
  }, /missing changes/));

  resourceChanges.forEach((change, index) => {
    cases.push(syncCase(`missing resource ${change.after.type} ${change.after.name}`, (document) => {
      document.changes.splice(index, 1);
    }, /exactly 30 concrete resources/));
  });
  assignmentChanges.forEach((change, index) => {
    cases.push(syncCase(`missing assignment ${index + 1} ${assignmentLabel(change)}`, (document) => {
      document.changes.splice(11 + index, 1);
    }, /exactly 30 concrete resources/));
  });

  for (const [name, sourceIndex, replacedIndex] of [
    ["duplicate job", 0, 3],
    ["duplicate container", 1, 4],
    ["duplicate queue", 2, 5],
    ["duplicate custom role", 9, 10],
    ["duplicate assignment", 11, 12],
  ]) {
    cases.push(syncCase(name, (document) => {
      document.changes[replacedIndex] = structuredClone(document.changes[sourceIndex]);
    }, /resource IDs must be concrete and unique/));
  }

  for (const [name, index] of [
    ["mistyped job resource", 0],
    ["mistyped container resource", 1],
    ["mistyped queue resource", 2],
    ["mistyped custom role resource", 9],
    ["mistyped lifecycle resource", 10],
    ["mistyped assignment resource", 11],
  ]) {
    cases.push(syncCase(name, (document) => {
      document.changes[index].after.type = "Microsoft.Example/wrongType";
    }, /resource type mismatch/));
  }

  for (const [name, index] of [
    ["wrong gate job ID", 0], ["wrong browser job ID", 3], ["wrong reviewer job ID", 6],
    ["wrong gate container ID", 1], ["wrong browser container ID", 4], ["wrong reviewer container ID", 7],
    ["wrong gate queue ID", 2], ["wrong browser queue ID", 5], ["wrong reviewer queue ID", 8],
  ]) {
    cases.push(syncCase(name, (document) => {
      document.changes[index].resourceId = `${document.changes[index].resourceId}-wrong`;
    }, /unexpected resourceId/));
  }

  const classRepresentatives = [0, 1, 2, 9, 10, 11];
  for (const index of classRepresentatives) {
    const label = baseline.document.changes[index].after.type;
    cases.push(syncCase(`wrong after.id ${label}`, (document) => {
      document.changes[index].after.id = `${document.changes[index].after.id}-wrong`;
    }, /ARM resource identity mismatch/));
    cases.push(syncCase(`missing after.id ${label}`, (document) => {
      delete document.changes[index].after.id;
    }, /ARM resource identity mismatch/));
    cases.push(syncCase(`missing after.type ${label}`, (document) => {
      delete document.changes[index].after.type;
    }, /resource type mismatch/));
    cases.push(syncCase(`wrong apiVersion ${label}`, (document) => {
      document.changes[index].after.apiVersion = "1900-01-01";
    }, /API version mismatch/));
    cases.push(syncCase(`missing after.apiVersion ${label}`, (document) => {
      delete document.changes[index].after.apiVersion;
    }, /API version mismatch/));
    cases.push(syncCase(`wrong after.name ${label}`, (document) => {
      document.changes[index].after.name = `${document.changes[index].after.name}-wrong`;
    }, /resource name mismatch/));
    cases.push(syncCase(`missing after.name ${label}`, (document) => {
      delete document.changes[index].after.name;
    }, /resource name mismatch/));
    cases.push(syncCase(`resourceId casing ${label}`, (document) => {
      document.changes[index].resourceId = document.changes[index].resourceId.replace("/providers/", "/Providers/");
    }, /resourceId casing or spelling drifted/));
  }

  cases.push(syncCase("fabricated top-level resourceType", (document) => {
    document.changes[0].resourceType = document.changes[0].after.type;
  }, /fabricated top-level resource type or API version/));
  cases.push(syncCase("fabricated top-level apiVersion", (document) => {
    document.changes[0].apiVersion = document.changes[0].after.apiVersion;
  }, /fabricated top-level resource type or API version/));

  assignmentChanges.forEach((change, index) => {
    cases.push(syncCase(`wrong deterministic assignment ID ${index + 1}`, (document) => {
      const candidate = document.changes[11 + index];
      const wrongName = `ffffffff-ffff-5fff-8fff-${String(index + 1).padStart(12, "0")}`;
      candidate.resourceId = `${roleScope(candidate.resourceId)}/providers/Microsoft.Authorization/roleAssignments/${wrongName}`;
      candidate.after.id = candidate.resourceId;
      candidate.after.name = wrongName;
    }, /unexpected resourceId/));
  });

  assignmentChanges.forEach((change, index) => {
    cases.push(syncCase(`wrong principal assignment ${index + 1} ${assignmentLabel(change)}`, (document) => {
      document.changes[11 + index].after.properties.principalId = "923e4567-e89b-42d3-a456-426614174099";
    }, /unexpected role assignment/));
  });

  const roleRepresentatives = distinctRepresentativeIndexes(assignmentChanges, ({ after }) => after.properties.roleDefinitionId);
  roleRepresentatives.forEach((index) => {
    cases.push(syncCase(`wrong role definition family ${index + 1}`, (document) => {
      document.changes[11 + index].after.properties.roleDefinitionId = `${baseline.policy.subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/923e4567-e89b-42d3-a456-426614174099`;
    }, /unexpected role assignment/));
  });

  const scopeRepresentatives = distinctRepresentativeIndexes(assignmentChanges, (change) => scopeFamily(roleScope(change.resourceId)));
  scopeRepresentatives.forEach((index) => {
    cases.push(syncCase(`wrong assignment scope family ${index + 1}`, (document) => {
      const change = document.changes[11 + index];
      change.resourceId = change.resourceId.replace("/resourceGroups/prostar-payroll/", "/resourceGroups/wrong-scope/");
    }, /unexpected resourceId/));
  });

  for (const [name, mutate] of [
    ["custom role actions expanded", (permission) => permission.actions.push("Microsoft.KeyVault/vaults/read")],
    ["custom role notActions changed", (permission) => permission.notActions.push("Microsoft.KeyVault/vaults/delete")],
    ["custom role dataActions expanded", (permission) => permission.dataActions.push("Microsoft.KeyVault/vaults/keys/sign/action")],
    ["custom role notDataActions changed", (permission) => permission.notDataActions.push("Microsoft.KeyVault/vaults/keys/read")],
  ]) {
    cases.push(syncCase(name, (document) => {
      mutate(document.changes[9].after.properties.permissions[0]);
    }, /actions\/dataActions\/notActions\/notDataActions drifted/));
  }

  cases.push(syncCase("lifecycle rule omitted", (document) => {
    document.changes[10].after.properties.policy.rules.pop();
  }, /exactly the merged commission\/orphan\/replay rules/));
  cases.push(syncCase("lifecycle rule added", (document) => {
    document.changes[10].after.properties.policy.rules.push(structuredClone(
      document.changes[10].after.properties.policy.rules[1],
    ));
  }, /exactly the merged commission\/orphan\/replay rules/));
  cases.push(syncCase("commission lifecycle drift", (document) => {
    document.changes[10].after.properties.policy.rules[0].definition.actions.baseBlob.delete.daysAfterModificationGreaterThan = 30;
  }, /exactly the merged commission\/orphan\/replay rules/));

  cases.push(producerCase("zero-exit stub emits zero claims", {
    stdout: "stub succeeded\n",
  }, /emitted zero concrete assertion claims/));
  const validEvent = releaseGateAssertionEvent({
    category: "unit",
    outcome: "PASS",
    provenance: { runner: "node-test", source: "tests/routes.test.ts", assertion: "renders all routes" },
    counts: { total: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
  });
  cases.push(producerCase("duplicate assertion event", {
    stdout: `${validEvent}${validEvent}`,
  }, /duplicate assertion IDs/));
  cases.push(producerCase("unsafe assertion provenance", {
    stdout: releaseGateAssertionEvent({
      category: "unit",
      outcome: "PASS",
      provenance: { runner: "node-test", source: "../forged.test.ts", assertion: "forged traversal" },
      counts: { total: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
    }),
  }, /provenance is unsafe/));
  cases.push(producerCase("hardcoded PASS ID is not derived from observed provenance", {
    stdout: `${RELEASE_GATE_ASSERTION_EVENT_PREFIX}${JSON.stringify({
      schemaVersion: 2,
      category: "unit",
      id: "UNIT-F-01-contract",
      outcome: "PASS",
      provenance: { runner: "node-test", source: "tests/routes.test.ts:1:1", assertion: "renders all routes" },
      counts: { total: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
    })}\n`,
  }, /ID is not derived from its observed provenance/));
  cases.push(producerCase("PASS outcome cannot disagree with observed counts", {
    stdout: releaseGateAssertionEvent({
      category: "unit",
      outcome: "PASS",
      provenance: { runner: "node-test", source: "tests/routes.test.ts:1:1", assertion: "renders all routes" },
      counts: { total: 1, passed: 0, failed: 1, skipped: 0, cancelled: 0, todo: 0 },
    }),
  }, /outcome disagrees with its counts/));

  assert.equal(roleRepresentatives.length, 6, "matrix must attack all six built-in/custom role families");
  assert.equal(scopeRepresentatives.length, 5, "matrix must attack all five assignment scope families");
  assert.equal(cases.length, 164, "the expanded checked-in adversarial matrix must retain every original and added mutation");

  for (const entry of cases) {
    await t.test(entry.name, entry.run);
  }
});

function syncCase(name, mutate, expected) {
  return {
    name,
    run() {
      const fixture = evidenceRunnerWhatIfFixture();
      mutate(fixture.document);
      assert.throws(() => validateEvidenceRunnerWhatIf(fixture.document, fixture.options), expected);
    },
  };
}

function producerCase(name, { stdout }, expected) {
  return {
    name,
    run() {
      assert.throws(() => extractReleaseGateAssertionEvents({
        category: "unit",
        suiteExecution: {
          command: UNDERLYING_GATE_COMMANDS.unit,
          exitCode: 0,
          signal: null,
          stdout: Buffer.from(stdout),
          stderr: Buffer.alloc(0),
        },
      }), expected);
    },
  };
}

function distinctRepresentativeIndexes(values, key) {
  const seen = new Set();
  const indexes = [];
  values.forEach((value, index) => {
    const candidate = key(value).toLowerCase();
    if (seen.has(candidate)) return;
    seen.add(candidate);
    indexes.push(index);
  });
  return indexes;
}

function roleScope(resourceId) {
  return resourceId.split(/\/providers\/Microsoft\.Authorization\/roleAssignments\//i)[0];
}

function scopeFamily(scope) {
  for (const family of ["/containers/", "/queues/", "/registries/", "/vaults/"]) {
    if (scope.toLowerCase().includes(family)) {
      if (family === "/vaults/" && scope.toLowerCase().includes("/secrets/")) return "secret";
      return family;
    }
  }
  return scope;
}

function assignmentLabel(change) {
  return `${scopeFamily(roleScope(change.resourceId))}:${change.after.properties.principalType}`;
}
