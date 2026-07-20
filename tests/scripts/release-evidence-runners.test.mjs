import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../../scripts/lib/release-evidence-bundle.mjs";
import { releaseGateAssertionEvent } from "../../scripts/lib/release-gate-assertions.mjs";
import { createManagedIdentityReceiptDependencies } from "../../scripts/lib/release-evidence-managed-identity.mjs";
import { validateReviewerRunnerInputs } from "../../scripts/lib/release-evidence-runner-validation.mjs";
import { createEvidenceStorageClient } from "../../scripts/lib/release-evidence-storage.mjs";
import {
  handoffReceiptBinding,
  validateHandoffReceiptBinding,
  validateHandoffRequest,
} from "../../scripts/lib/release-evidence-trust.mjs";
import { orchestrateReleaseEvidenceJob } from "../../scripts/orchestrate-release-evidence-job.mjs";
import { runReleaseEvidenceJob } from "../../scripts/run-release-evidence-job.mjs";
import { runStructuredGateCommand } from "../../scripts/run-structured-gate-command.mjs";
import {
  hasStorageBlobOrQueueDataActions,
  parseAzureCliJsonOutput,
  runEvidenceRunnerWhatIf,
  validateEvidenceRunnerJob,
  validateEvidenceRunnerLiveResources,
  validateEvidenceRunnerWhatIf,
} from "../../scripts/deploy-evidence-runners.mjs";
import { validateBrowserArtifacts } from "../../scripts/validate-browser-artifacts.mjs";
import {
  createReleaseFixture,
  validationNow,
} from "./release-evidence-fixture.mjs";
import {
  evidencePinnedImage,
  evidenceRunnerWhatIfFixture,
  runnerJob,
} from "./evidence-runner-test-fixture.mjs";

const runId = "123e4567-e89b-42d3-a456-426614174000";
const sourceSha256 = "a".repeat(64);

test("bounded handoff rejects credential content, traversal, and byte/hash tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-bundle-test-"));
  try {
    const path = "docs/prostar-metrics/verification/input.json";
    await writeAt(root, path, "{\"safe\":true}\n");
    const bundle = await createEvidenceBundle({
      root, kind: "browser", runId, sourceSha256, files: [path], request: { schemaVersion: 1 },
    });
    const parsed = parseEvidenceBundle(bundle.bytes, {
      expectedKind: "browser", expectedDirection: "input", expectedRunId: runId,
      expectedSha256: bundle.sha256, expectedSourceSha256: sourceSha256,
    });
    assert.equal(parsed.files.get(path).toString("utf8"), "{\"safe\":true}\n");
    const changed = Buffer.from(bundle.bytes);
    changed[changed.length - 2] ^= 1;
    assert.throws(() => parseEvidenceBundle(changed, {
      expectedKind: "browser", expectedDirection: "input", expectedRunId: runId,
      expectedSha256: bundle.sha256, expectedSourceSha256: sourceSha256,
    }), /SHA-256 mismatch/);
    await assert.rejects(createEvidenceBundle({
      root, kind: "browser", runId, sourceSha256, files: ["../outside"], request: {},
    }), /escapes the project root/);
    await writeAt(root, path, "Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.private.signature\n");
    await assert.rejects(createEvidenceBundle({
      root, kind: "browser", runId, sourceSha256, files: [path], request: {},
    }), /credential material/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structured producer preserves only concrete emitted assertion claims and never synthesizes from exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "structured-gate-test-"));
  try {
    const resultPath = join(root, "unit.results.json");
    const env = {
      RELEASE_PROJECT_ROOT: root,
      RELEASE_GATE_CATEGORY: "unit",
      RELEASE_GATE_EXECUTION_ID: runId,
      RELEASE_GATE_RESULT_PATH: resultPath,
      RELEASE_GATE_RESULTS: JSON.stringify([{ id: "FORGED-ID", outcome: "PASS" }]),
    };
    const events = [
      releaseGateAssertionEvent({
        category: "unit",
        outcome: "PASS",
        provenance: { runner: "node-test", source: "tests/routes.test.ts", assertion: "renders all four routes" },
        counts: { total: 4, passed: 4, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
      }),
      releaseGateAssertionEvent({
        category: "unit",
        outcome: "PASS",
        provenance: { runner: "node-test", source: "tests/auth.test.ts", assertion: "rejects unauthorized users" },
        counts: { total: 3, passed: 3, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
      }),
    ].join("");
    const passed = await runStructuredGateCommand({
      category: "unit",
      env,
      now: sequence("2026-07-13T20:00:00.000Z"),
      commandExecutor: async () => ({ exitCode: 0, signal: null, stdout: Buffer.from(events), stderr: Buffer.alloc(0) }),
    });
    assert.equal(passed.results.length, 2);
    assert.deepEqual(passed.results.map(({ outcome, counts }) => ({ outcome, counts })), [
      { outcome: "PASS", counts: { total: 4, passed: 4, failed: 0, skipped: 0, cancelled: 0, todo: 0 } },
      { outcome: "PASS", counts: { total: 3, passed: 3, failed: 0, skipped: 0, cancelled: 0, todo: 0 } },
    ]);
    assert.equal(passed.results.some(({ id }) => id === "FORGED-ID"), false);

    const emptyPath = join(root, "integration.results.json");
    await assert.rejects(runStructuredGateCommand({
      category: "integration",
      env: { ...env, RELEASE_GATE_CATEGORY: "integration", RELEASE_GATE_RESULT_PATH: emptyPath },
      now: sequence("2026-07-13T20:02:00.000Z"),
      commandExecutor: async () => ({ exitCode: 0, signal: null, stdout: Buffer.from("zero-exit stub\n"), stderr: Buffer.alloc(0) }),
    }), /emitted zero concrete assertion claims/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage handoff authenticates with OAuth, create-only writes, TTL queues, and immutable hashes", async () => {
  const calls = [];
  const credential = { getToken: async () => ({ token: "opaque-test-token", expiresOnTimestamp: Date.now() + 300_000 }) };
  const bytes = Buffer.from("{}\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const client = createEvidenceStorageClient({
    accountName: "storageacct",
    credential,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "PUT") return new Response(null, { status: 201, headers: { etag: "etag-input" } });
      return new Response(null, { status: 201 });
    },
  });
  await client.putBlob({ container: "release-evidence-gate", name: `runs/${runId}/input.json`, bytes, sha256 });
  await client.enqueue({ queue: "release-evidence-gate", message: { schemaVersion: 1 } });
  await client.createReplayClaim({
    container: "release-evidence-gate",
    messageId: runId,
    record: {
      schemaVersion: 1,
      kind: "gate",
      runId,
      messageId: runId,
      inputSha256: sha256,
      nonceSha256: "1".repeat(64),
      issuedAt: "2026-07-13T20:00:00.000Z",
      expiresAt: "2026-07-13T21:00:00.000Z",
      claimedAt: "2026-07-13T20:01:00.000Z",
    },
  });
  assert.equal(calls[0].options.headers["if-none-match"], "*");
  assert.equal(calls[0].options.headers.authorization, "Bearer opaque-test-token");
  assert.match(calls[1].url, /messagettl=3600$/);
  assert.match(calls[2].url, /replay-ledger/);
  assert.equal(calls[2].options.headers["if-none-match"], "*");
  await assert.rejects(client.putBlob({
    container: "release-evidence-gate", name: `runs/${runId}/input.json`, bytes, sha256: "0".repeat(64),
  }), /hash does not match/);

  const tampered = createEvidenceStorageClient({
    accountName: "storageacct",
    credential,
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { etag: "etag-output", "x-ms-meta-sha256": "0".repeat(64) },
    }),
  });
  await assert.rejects(tampered.getBlob({
    container: "release-evidence-gate", name: `runs/${runId}/output.json`,
  }), /immutable metadata hash/);
});

test("handoff freshness and signed nonce bindings reject future, expired, widened, and mutated variants", () => {
  const nowMs = Date.parse("2026-07-13T20:30:00.000Z");
  const handoff = {
    messageId: runId,
    nonce: "1".repeat(64),
    issuedAt: "2026-07-13T20:00:00.000Z",
    expiresAt: "2026-07-13T21:00:00.000Z",
  };
  assert.deepEqual(validateHandoffRequest(handoff, { nowMs }), handoff);
  const signed = handoffReceiptBinding(handoff, sourceSha256);
  assert.deepEqual(validateHandoffReceiptBinding(signed, { nowMs }), signed);
  for (const mutate of [
    (value) => { value.messageId = "not-a-uuid"; },
    (value) => { value.nonce = "short"; },
    (value) => { value.issuedAt = "2026-07-13T20:31:00.000Z"; },
    (value) => { value.expiresAt = "2026-07-13T20:30:00.000Z"; },
    (value) => { value.expiresAt = "2026-07-14T00:01:00.000Z"; },
  ]) {
    const changed = structuredClone(handoff);
    mutate(changed);
    assert.throws(() => validateHandoffRequest(changed, { nowMs }), /handoff/);
  }
  for (const field of ["messageId", "nonceSha256", "inputSha256", "issuedAt", "expiresAt"]) {
    const changed = structuredClone(signed);
    changed[field] = field.endsWith("Sha256") ? "0".repeat(63) : "changed";
    assert.throws(() => validateHandoffReceiptBinding(changed, { nowMs }), /handoff/);
  }
});

test("durable create-only replay rejection blocks execution before a workspace or signer is used", async () => {
  const fixture = await createReleaseFixture();
  try {
    const handoff = {
      messageId: runId,
      nonce: "1".repeat(64),
      issuedAt: "2026-07-13T20:00:00.000Z",
      expiresAt: "2026-07-13T21:00:00.000Z",
    };
    const input = await createEvidenceBundle({
      root: fixture.root,
      kind: "browser",
      runId,
      sourceSha256: fixture.deployment.buildSourceSha256,
      files: [fixture.paths.deploymentManifestPath],
      request: { schemaVersion: 1, handoff },
      createdAt: handoff.issuedAt,
    });
    let signerUsed = false;
    const result = await runReleaseEvidenceJob({
      kind: "browser",
      sourceRoot: fixture.root,
      env: evidenceJobEnvironment("browser", fixture.deployment.buildSourceSha256),
      now: () => new Date("2026-07-13T20:30:00.000Z"),
      storageClient: {
        receive: async () => ({
          id: "azure-message-id",
          popReceipt: "pop-receipt-value",
          value: {
            schemaVersion: 1,
            kind: "browser",
            runId,
            inputSha256: input.sha256,
            sourceSha256: fixture.deployment.buildSourceSha256,
            ...handoff,
          },
        }),
        getBlob: async () => ({ bytes: input.bytes, etag: "input-etag", metadataSha256: input.sha256 }),
        createReplayClaim: async () => { throw new Error("evidence handoff message was already claimed"); },
        putBlob: async () => ({ etag: "failure-etag" }),
        deleteMessage: async () => undefined,
      },
      receiptDependencies: new Proxy({}, { get() { signerUsed = true; return undefined; } }),
    });
    assert.equal(result.status, "FAIL");
    assert.equal(signerUsed, false);
  } finally {
    await fixture.cleanup();
  }
});

test("runner preserves operation and every CLI/workspace cleanup failure after partial initialization", async () => {
  const fixture = await createReleaseFixture();
  try {
    const handoff = {
      messageId: runId,
      nonce: "1".repeat(64),
      issuedAt: "2026-07-13T20:00:00.000Z",
      expiresAt: "2026-07-13T21:00:00.000Z",
    };
    const input = await createEvidenceBundle({
      root: fixture.root,
      kind: "gate",
      runId,
      sourceSha256: fixture.deployment.buildSourceSha256,
      files: [fixture.paths.deploymentManifestPath],
      request: { schemaVersion: 1, handoff },
      createdAt: handoff.issuedAt,
    });
    const events = [];
    let caught;
    try {
      await runReleaseEvidenceJob({
        kind: "gate",
        sourceRoot: fixture.root,
        env: evidenceJobEnvironment("gate", fixture.deployment.buildSourceSha256),
        now: sequence("2026-07-13T20:30:00.000Z"),
        storageClient: {
          receive: async () => ({
            id: "azure-message-id",
            popReceipt: "pop-receipt-value",
            value: {
              schemaVersion: 1,
              kind: "gate",
              runId,
              inputSha256: input.sha256,
              sourceSha256: fixture.deployment.buildSourceSha256,
              ...handoff,
            },
          }),
          getBlob: async () => ({ bytes: input.bytes, etag: "input-etag", metadataSha256: input.sha256 }),
          createReplayClaim: async () => undefined,
          putBlob: async () => {
            events.push("failure-report");
            throw new Error("failure reporting failed");
          },
          deleteMessage: async () => undefined,
        },
        receiptDependencies: {},
        azureCliInitializer: async ({ registerCleanup }) => {
          events.push("azure-init");
          registerCleanup(() => {
            events.push("cli-cleanup");
            throw new AggregateError([
              new Error("CLI cleanup first failure"),
              new Error("CLI cleanup second failure"),
            ], "CLI cleanup failed");
          });
          throw new Error("Azure CLI initialization failed");
        },
        kindExecutor: async () => { throw new Error("kind executor must not run"); },
        workspaceRemover: async (path) => {
          events.push("workspace-cleanup");
          await rm(path, { recursive: true, force: true });
          throw new AggregateError([
            new Error("workspace cleanup first failure"),
            new Error("workspace cleanup second failure"),
          ], "workspace cleanup failed");
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AggregateError);
    assert.deepEqual(caught.errors.map(({ message }) => message), [
      "Azure CLI initialization failed",
      "failure reporting failed",
      "CLI cleanup first failure",
      "CLI cleanup second failure",
      "workspace cleanup first failure",
      "workspace cleanup second failure",
    ]);
    assert.deepEqual(events, ["azure-init", "failure-report", "cli-cleanup", "workspace-cleanup"]);
  } finally {
    await fixture.cleanup();
  }
});

test("client finally cleanup attempts both blobs after enqueue failure even without returned ETags", async () => {
  const fixture = await createReleaseFixture();
  try {
    const deleted = [];
    await assert.rejects(orchestrateReleaseEvidenceJob({
      root: fixture.root,
      kind: "browser",
      paths: {
        deploymentManifestPath: fixture.paths.deploymentManifestPath,
        e2eReportPath: fixture.paths.e2eReportPath,
        a11yReportPath: fixture.paths.a11yReportPath,
        producerResultPath: fixture.browserRunnerResultPath,
      },
      now: () => validationNow.getTime(),
      storageClient: {
        putBlob: async () => ({}),
        enqueue: async () => { throw new Error("injected enqueue failure"); },
        deleteBlob: async ({ name }) => { deleted.push(name); },
      },
    }), /injected enqueue failure/);
    assert.equal(deleted.length, 2);
    assert.equal(deleted.some((name) => name.endsWith("/input.json")), true);
    assert.equal(deleted.some((name) => name.endsWith("/output.json")), true);
  } finally {
    await fixture.cleanup();
  }
});

test("client cleanup preserves the primary error and both synchronous delete failures", async () => {
  const fixture = await createReleaseFixture();
  try {
    const attempted = [];
    let caught;
    try {
      await orchestrateReleaseEvidenceJob({
        root: fixture.root,
        kind: "browser",
        paths: {
          deploymentManifestPath: fixture.paths.deploymentManifestPath,
          e2eReportPath: fixture.paths.e2eReportPath,
          a11yReportPath: fixture.paths.a11yReportPath,
          producerResultPath: fixture.browserRunnerResultPath,
        },
        now: () => validationNow.getTime(),
        storageClient: {
          putBlob: async () => ({}),
          enqueue: async () => { throw new Error("PRIMARY"); },
          deleteBlob: ({ name }) => {
            attempted.push(name);
            throw new Error(name.endsWith("/input.json") ? "INPUT_CLEANUP" : "OUTPUT_CLEANUP");
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AggregateError);
    assert.deepEqual(caught.errors.map(({ message }) => message), [
      "PRIMARY",
      "INPUT_CLEANUP",
      "OUTPUT_CLEANUP",
    ]);
    assert.equal(attempted.length, 2);
    assert.equal(attempted.some((name) => name.endsWith("/input.json")), true);
    assert.equal(attempted.some((name) => name.endsWith("/output.json")), true);
  } finally {
    await fixture.cleanup();
  }
});

test("job kind binding rejects a caller trying to route browser material through the gate signer", async () => {
  const env = {
    RELEASE_EVIDENCE_KIND: "gate",
    AZURE_CLIENT_ID: "123e4567-e89b-42d3-a456-426614174001",
    AZURE_SUBSCRIPTION_ID: "123e4567-e89b-42d3-a456-426614174002",
    AZURE_RESOURCE_GROUP: "prostar-payroll",
    RELEASE_EVIDENCE_STORAGE_ACCOUNT: "storageacct",
    RELEASE_EVIDENCE_CONTAINER: "release-evidence-gate",
    RELEASE_EVIDENCE_QUEUE: "release-evidence-gate",
    RELEASE_EVIDENCE_SOURCE_SHA256: sourceSha256,
  };
  await assert.rejects(runReleaseEvidenceJob({
    kind: "gate",
    env,
    storageClient: {
      receive: async () => ({
        id: "message-id", popReceipt: "pop-receipt-value",
        value: {
          schemaVersion: 1, kind: "browser", runId, inputSha256: sourceSha256, sourceSha256,
          messageId: runId, nonce: "1".repeat(64),
          issuedAt: "2026-07-13T20:00:00.000Z", expiresAt: "2026-07-13T21:00:00.000Z",
        },
      }),
    },
    receiptDependencies: {},
    azureCliInitializer: async () => { throw new Error("must not initialize"); },
  }), /binding mismatch/);
});

test("managed signer adapter rejects cross-key signing before any network operation", async () => {
  let fetched = false;
  const dependencies = createManagedIdentityReceiptDependencies({
    kind: "gate",
    clientId: "123e4567-e89b-42d3-a456-426614174001",
    subscriptionId: "123e4567-e89b-42d3-a456-426614174002",
    resourceGroup: "prostar-payroll",
    credential: { getToken: async () => { throw new Error("must not request token"); } },
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
  });
  await assert.rejects(dependencies.digestSigner({
    keyId: `https://kv-prostar-metrics-prod.vault.azure.net/keys/prostar-release-browser-evidence/${"b".repeat(32)}`,
    digest: "a".repeat(43),
  }), /gate managed identity cannot use/);
  assert.equal(fetched, false);
});

test("what-if guard requires the exact complete resource and 19-assignment policy", () => {
  const fixture = evidenceRunnerWhatIfFixture();
  assert.equal(fixture.document.changes.length, 30);
  assert.equal(fixture.policy.assignments.length, 19);
  assert.equal(validateEvidenceRunnerWhatIf(fixture.document, fixture.options), true);
  const missing = structuredClone(fixture.document);
  missing.changes.pop();
  assert.throws(() => validateEvidenceRunnerWhatIf(missing, fixture.options), /exactly 30 concrete resources/);
  const destructive = structuredClone(fixture.document);
  destructive.changes[0].changeType = "Delete";
  assert.throws(() => validateEvidenceRunnerWhatIf(destructive, fixture.options), /destructive or unsupported/);
  const expandedRole = structuredClone(fixture.document);
  const custom = expandedRole.changes.find(({ after }) => after?.properties?.roleName === "ProStar Evidence Public Key Reader");
  custom.after.properties.permissions[0].dataActions.push("Microsoft.KeyVault/vaults/keys/sign/action");
  assert.throws(() => validateEvidenceRunnerWhatIf(expandedRole, fixture.options), /actions\/dataActions/);
});

test("what-if guard rejects unsupported fields at every nested after payload level", async (t) => {
  const cases = [
    ["SDK envelope", (document) => { document.injected = null; }],
    ["change", (document) => { document.changes[0].injected = null; }],
    ["root after", (document) => { document.changes[0].after.injected = null; }],
    ["job", (document) => { document.changes[0].after.properties.configuration.injected = null; }],
    ["job container", (document) => {
      document.changes[0].after.properties.template.containers[0].injected = null;
    }],
    ["handoff container", (document) => { document.changes[1].after.properties.injected = null; }],
    ["custom role", (document) => {
      document.changes[9].after.properties.permissions[0].injected = null;
    }],
    ["role assignment", (document) => { document.changes[11].after.properties.injected = null; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const fixture = evidenceRunnerWhatIfFixture();
      mutate(fixture.document);
      assert.throws(
        () => validateEvidenceRunnerWhatIf(fixture.document, fixture.options),
        /contains unsupported fields: injected/,
      );
    });
  }
});

test("Azure CLI what-if command parses the installed SDK envelope without synthetic identity fields", async () => {
  const fixtureBytes = await readFile(new URL("./fixtures/azure-cli-2.79.0-what-if-sdk-envelope.json", import.meta.url));
  const command = [
    "deployment", "group", "what-if", "--resource-group", "prostar-payroll",
    "--result-format", "FullResourcePayloads", "--no-pretty-print", "--output", "json",
  ];
  const captured = parseAzureCliJsonOutput(fixtureBytes.toString("utf8"), command);
  assert.equal(captured.status, "Succeeded");
  assert.deepEqual(Object.keys(captured).sort(), ["changes", "status"]);
  assert.equal(captured.changes[0].after.apiVersion, "2023-05-01");
  assert.equal(Object.hasOwn(captured.changes[0], "resourceType"), false);
  assert.equal(Object.hasOwn(captured.changes[0], "apiVersion"), false);
  assert.throws(() => parseAzureCliJsonOutput("Resource and property changes are indicated with symbols\n+ Create", command), /invalid JSON/);
  assert.throws(() => parseAzureCliJsonOutput(fixtureBytes.toString("utf8"), command.filter((arg) => arg !== "--no-pretty-print")), /must disable human pretty printing/);
  assert.throws(() => parseAzureCliJsonOutput(JSON.stringify({
    status: "Succeeded",
    error: null,
    properties: { changes: captured.changes },
  }), command), /missing changes/);

  const baseline = evidenceRunnerWhatIfFixture();
  baseline.document.changes[1].after = captured.changes[0].after;
  assert.equal(validateEvidenceRunnerWhatIf(baseline.document, baseline.options), true);
  const invocations = [];
  const parsed = parseAzureCliJsonOutput(JSON.stringify(baseline.document), command);
  assert.deepEqual(await runEvidenceRunnerWhatIf({
    runAzJson: async (args, root) => {
      invocations.push({ args, root });
      return parsed;
    },
    projectRoot: process.cwd(),
    deploymentArgs: ["--resource-group", "prostar-payroll", "--template-file", "infra/azure/evidence-runners.bicep"],
    validationOptions: baseline.options,
  }), parsed);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].args.includes("--no-pretty-print"), true);
  assert.equal(invocations[0].args.includes("FullResourcePayloads"), true);
});

test("effective Blob and Queue DataActions honor wildcard intersections and notDataActions", () => {
  const grants = (dataActions, notDataActions = []) => hasStorageBlobOrQueueDataActions({
    permissions: [{ dataActions, notDataActions }],
  });
  for (const action of [
    "Microsoft.Storage/storageAccounts/*/read",
    "Microsoft.Storage/*/read",
    "*/read",
    "Microsoft.Storage/*/write",
    "*/delete",
    "*/action",
    "*/process/action",
    "Microsoft.Storage/storageAccounts/*",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
    "Microsoft.Storage/storageAccounts/queueServices/queues/messages/process/action",
  ]) assert.equal(grants([action]), true, action);
  assert.equal(grants(["Microsoft.Compute/*/read"]), false);
  assert.equal(grants(["Microsoft.Storage/*/read"], ["*/read"]), false);
  assert.equal(grants(["*"], [
    "Microsoft.Storage/storageAccounts/blobServices/*",
    "Microsoft.Storage/storageAccounts/queueServices/*",
  ]), false);
  assert.equal(grants(["Microsoft.Storage/*"], [
    "Microsoft.Storage/storageAccounts/blobServices/*",
    "Microsoft.Storage/storageAccounts/queueServices/*",
  ]), false);
  assert.equal(grants(["Microsoft.Storage/storageAccounts/**/read?"]), true, "ambiguous allow patterns fail closed");

  const fixture = evidenceRunnerWhatIfFixture();
  const blobScope = fixture.policy.runners.gate.containerId;
  const queueScope = fixture.policy.runners.gate.queueId;
  const blobExcluded = {
    permissions: [{
      dataActions: ["*/read"],
      notDataActions: ["Microsoft.Storage/storageAccounts/blobServices/*/read"],
    }],
  };
  assert.equal(hasStorageBlobOrQueueDataActions(blobExcluded, { targetScope: blobScope }), false);
  assert.equal(hasStorageBlobOrQueueDataActions(blobExcluded, { targetScope: queueScope }), true);
});

test("postdeploy independently enumerates jobs, handoffs, lifecycle, role definition, and all 19 RBAC tuples", async () => {
  const fixture = evidenceRunnerWhatIfFixture();
  const calls = [];
  const runAzJson = evidenceLiveReader(fixture, { calls });
  assert.equal(await validateEvidenceRunnerLiveResources({
    runAzJson,
    projectRoot: process.cwd(),
    ...fixture.options,
  }), true);
  assert.equal(calls.some((args) => args[0] === "deployment"), false);
  assert.equal(calls.filter((args) => args[0] === "containerapp").length, 3);
  assert.equal(calls.filter((args) => args[0] === "role" && args[1] === "assignment").length, 9);
});

test("postdeploy rejects inherited and direct unexpected Blob/Queue data-plane roles", async (t) => {
  const fixture = evidenceRunnerWhatIfFixture();
  const blobRole = fixture.policy.assignments.find(({ key }) => key === "gate:signer-blob").roleDefinitionId;
  const queueRole = fixture.policy.assignments.find(({ key }) => key === "gate:signer-queue").roleDefinitionId;
  const unrelatedPrincipal = "923e4567-e89b-42d3-a456-426614174099";
  const customRoles = [
    customStorageRole(fixture, 1, ["Microsoft.Storage/storageAccounts/*/read"]),
    customStorageRole(fixture, 2, ["Microsoft.Storage/*/read"]),
    customStorageRole(fixture, 3, ["*/read"]),
    customStorageRole(fixture, 4, ["Microsoft.Storage/*/write"]),
    customStorageRole(fixture, 5, ["*/delete"]),
    customStorageRole(fixture, 6, ["*/process/action"]),
    customStorageRole(fixture, 7, ["*/action"]),
  ];
  const scopes = [
    ["container wildcard storage-account read", fixture.policy.runners.gate.containerId, customRoles[0].id],
    ["queue wildcard provider read", fixture.policy.runners.gate.queueId, customRoles[1].id],
    ["storage-account wildcard suffix read", fixture.policy.storageScope, customRoles[2].id],
    ["resource-group parent built-in Queue Data Processor", fixture.policy.resourceGroupScope, queueRole],
    ["subscription parent built-in Blob Data Contributor", fixture.policy.subscriptionScope, blobRole],
    ["storage-account parent wildcard write", fixture.policy.storageScope, customRoles[3].id],
    ["resource-group parent wildcard delete", fixture.policy.resourceGroupScope, customRoles[4].id],
    ["subscription parent wildcard process action", fixture.policy.subscriptionScope, customRoles[5].id],
    ["direct evidence scope wildcard action", fixture.policy.runners.gate.containerId, customRoles[6].id],
  ];
  const roleDefinitions = new Map(customRoles.map((definition) => [roleDefinitionName(definition.id), definition]));
  for (const [name, scope, roleDefinitionId] of scopes) {
    await t.test(name, async () => {
      const assignmentName = "99999999-9999-5999-8999-999999999999";
      const extra = {
        id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentName}`,
        scope,
        principalId: unrelatedPrincipal,
        principalType: "ServicePrincipal",
        roleDefinitionId,
      };
      await assert.rejects(validateEvidenceRunnerLiveResources({
        runAzJson: evidenceLiveReader(fixture, { inheritedAssignments: [extra], roleDefinitions }),
        projectRoot: process.cwd(),
        ...fixture.options,
      }), /unexpected direct or inherited Blob\/Queue data-plane role/);
    });
  }

  await t.test("broad custom allow fully excluded for Blob and Queue", async () => {
    const excluded = customStorageRole(fixture, 8, ["*"], [
      "Microsoft.Storage/storageAccounts/blobServices/*",
      "Microsoft.Storage/storageAccounts/queueServices/*",
    ]);
    const extra = {
      id: `${fixture.policy.subscriptionScope}/providers/Microsoft.Authorization/roleAssignments/88888888-8888-5888-8888-888888888888`,
      scope: fixture.policy.subscriptionScope,
      principalId: unrelatedPrincipal,
      principalType: "ServicePrincipal",
      roleDefinitionId: excluded.id,
    };
    assert.equal(await validateEvidenceRunnerLiveResources({
      runAzJson: evidenceLiveReader(fixture, {
        inheritedAssignments: [extra],
        roleDefinitions: new Map([[roleDefinitionName(excluded.id), excluded]]),
      }),
      projectRoot: process.cwd(),
      ...fixture.options,
    }), true);
  });

  await t.test("blob exclusions are evaluated against the assigned container rather than an impossible queue action", async () => {
    const blobExcluded = customStorageRole(fixture, 9, ["*/read"], [
      "Microsoft.Storage/storageAccounts/blobServices/*/read",
    ]);
    const extra = {
      id: `${fixture.policy.runners.gate.containerId}/providers/Microsoft.Authorization/roleAssignments/77777777-7777-5777-8777-777777777777`,
      scope: fixture.policy.runners.gate.containerId,
      principalId: unrelatedPrincipal,
      principalType: "ServicePrincipal",
      roleDefinitionId: blobExcluded.id,
    };
    assert.equal(await validateEvidenceRunnerLiveResources({
      runAzJson: evidenceLiveReader(fixture, {
        inheritedAssignments: [extra],
        roleDefinitions: new Map([[roleDefinitionName(blobExcluded.id), blobExcluded]]),
      }),
      projectRoot: process.cwd(),
      ...fixture.options,
    }), true);
  });
});

test("live runner validator rejects cross-identity and command/image override", () => {
  const identityId = "/subscriptions/s/resourceGroups/prostar-payroll/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-prostar-release-browser-prod";
  const output = {
    kind: "browser", name: "job-psm-evidence-browser", identityId,
    clientId: "123e4567-e89b-42d3-a456-426614174001",
    containerName: "release-evidence-browser", queueName: "release-evidence-browser",
  };
  const pinnedImage = evidencePinnedImage;
  const job = runnerJob({ output, pinnedImage, sourceSha256 });
  assert.equal(validateEvidenceRunnerJob(job, { output, pinnedImage, sourceSha256 }), true);
  const compromised = structuredClone(job);
  compromised.identity.userAssignedIdentities = { "/identities/gate": {} };
  assert.throws(() => validateEvidenceRunnerJob(compromised, { output, pinnedImage, sourceSha256 }), /exactly its one dedicated/);
  const overridden = structuredClone(job);
  overridden.properties.template.containers[0].args = ["scripts/sign-release-receipt.mjs", "--kind", "gate"];
  assert.throws(() => validateEvidenceRunnerJob(overridden, { output, pinnedImage, sourceSha256 }), /overrideable\/drifted/);
  const injected = structuredClone(job);
  injected.properties.template.containers[0].env.push({ name: "NODE_OPTIONS", value: "--import=/tmp/forged.mjs" });
  assert.throws(() => validateEvidenceRunnerJob(injected, { output, pinnedImage, sourceSha256 }), /environment allowlist drifted/);
});

test("browser artifact validator binds supplied sanitized reports and every referenced artifact without capture claims", async () => {
  const fixture = await createReleaseFixture();
  try {
    const outputPath = "docs/prostar-metrics/verification/browser/generated-validated-artifacts.json";
    const result = await validateBrowserArtifacts({
      root: fixture.root,
      deploymentManifestPath: fixture.paths.deploymentManifestPath,
      e2eReportPath: fixture.paths.e2eReportPath,
      a11yReportPath: fixture.paths.a11yReportPath,
      outputPath,
      executionId: runId,
    });
    const document = JSON.parse(await readFile(join(fixture.root, outputPath), "utf8"));
    assert.equal(document.outcome, "PASS");
    assert.equal(document.artifacts.length, 41);
    assert.equal(result.executionId, runId);
  } finally {
    await fixture.cleanup();
  }
});

test("reviewer runner validates pinned browser and gate receipts before it may sign SHIP", async () => {
  const fixture = await createReleaseFixture();
  try {
    const browserReceipt = JSON.parse(await readFile(join(fixture.root, fixture.browserAttestationPath), "utf8"));
    const request = {
      schemaVersion: 1,
      deploymentManifestPath: fixture.paths.deploymentManifestPath,
      e2eReportPath: fixture.paths.e2eReportPath,
      a11yReportPath: fixture.paths.a11yReportPath,
      browserAttestationPath: fixture.browserAttestationPath,
      gateReportPath: fixture.paths.gateReportPath,
      gateRunnerReceiptPath: fixture.gateRunnerReceiptPath,
      reviewerReportPath: fixture.paths.reviewerReportPath,
      outputPath: "docs/prostar-metrics/verification/reviewer/new-receipt.json",
    };
    const validated = await validateReviewerRunnerInputs({
      root: fixture.root,
      request,
      keyResolver: async () => browserReceipt.publicKey,
      nowMs: validationNow.getTime(),
    });
    assert.match(validated.browserReceiptId, /^akv:/);
    assert.match(validated.gateReceiptId, /^akv:/);
    const gateReceipt = JSON.parse(await readFile(join(fixture.root, fixture.gateRunnerReceiptPath), "utf8"));
    gateReceipt.signature = `${gateReceipt.signature.slice(0, -2)}aa`;
    await writeFile(join(fixture.root, fixture.gateRunnerReceiptPath), `${JSON.stringify(gateReceipt, null, 2)}\n`);
    await assert.rejects(validateReviewerRunnerInputs({
      root: fixture.root,
      request,
      keyResolver: async () => browserReceipt.publicKey,
      nowMs: validationNow.getTime(),
    }), /receiptId|signature is not valid/);
  } finally {
    await fixture.cleanup();
  }
});

function sequence(start) {
  let value = Date.parse(start);
  return () => {
    const date = new Date(value);
    value += 1_000;
    return date;
  };
}

async function writeAt(root, path, value) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
}

function evidenceJobEnvironment(kind, source) {
  return {
    RELEASE_EVIDENCE_KIND: kind,
    AZURE_CLIENT_ID: "123e4567-e89b-42d3-a456-426614174001",
    AZURE_SUBSCRIPTION_ID: "123e4567-e89b-42d3-a456-426614174002",
    AZURE_RESOURCE_GROUP: "prostar-payroll",
    RELEASE_EVIDENCE_STORAGE_ACCOUNT: "storageacct",
    RELEASE_EVIDENCE_CONTAINER: `release-evidence-${kind}`,
    RELEASE_EVIDENCE_QUEUE: `release-evidence-${kind}`,
    RELEASE_EVIDENCE_SOURCE_SHA256: source,
  };
}

function liveResources(fixture, suffix) {
  const type = suffix === "containers"
    ? "Microsoft.Storage/storageAccounts/blobServices/containers"
    : "Microsoft.Storage/storageAccounts/queueServices/queues";
  return fixture.document.changes.filter(({ after }) => after.type === type).map(({ after }) => structuredClone(after));
}

function roleScope(resourceId) {
  return resourceId.split(/\/providers\/Microsoft\.Authorization\/roleAssignments\//i)[0];
}

function evidenceLiveReader(fixture, { calls = [], inheritedAssignments = [], roleDefinitions = new Map() } = {}) {
  return async (args) => {
    calls.push(args);
    if (args[0] === "resource") {
      return fixture.document.changes.filter(({ after }) => after.type === "Microsoft.App/jobs")
        .map(({ after }) => ({ id: after.id, name: after.name, type: after.type }));
    }
    if (args[0] === "containerapp") {
      const name = args[args.indexOf("--name") + 1];
      return fixture.document.changes.find(({ after }) => after.type === "Microsoft.App/jobs" && after.name === name).after;
    }
    if (args[0] === "rest") {
      const url = args[args.indexOf("--url") + 1];
      if (url.includes("/blobServices/default/containers?")) return { value: liveResources(fixture, "containers") };
      if (url.includes("/queueServices/default/queues?")) return { value: liveResources(fixture, "queues") };
      return fixture.document.changes.find(({ after }) => after.type === "Microsoft.Storage/storageAccounts/managementPolicies").after;
    }
    if (args[0] === "role" && args[1] === "definition") {
      const roleId = args[args.indexOf("--name") + 1].toLowerCase();
      const custom = fixture.document.changes.find(({ after }) => (
        after.type === "Microsoft.Authorization/roleDefinitions" && after.name.toLowerCase() === roleId
      ));
      if (custom) return [custom.after];
      if (roleDefinitions.has(roleId)) return [roleDefinitions.get(roleId)];
      const blob = roleId === "ba92f5b4-2d11-453d-a403-e96b0029c9fe";
      const queue = ["8a0f0c08-91a1-4084-bc3d-661d67233fed", "c6a89b2d-59bc-44d0-9896-0f6e12d7b80a"].includes(roleId);
      return [{
        id: `${fixture.policy.subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`,
        permissions: [{
          dataActions: blob
            ? ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"]
            : queue ? ["Microsoft.Storage/storageAccounts/queueServices/queues/messages/read"] : [],
        }],
      }];
    }
    if (args[0] === "role" && args[1] === "assignment") {
      const scope = args[args.indexOf("--scope") + 1];
      const direct = fixture.document.changes.filter(({ after, resourceId }) => (
        after.type === "Microsoft.Authorization/roleAssignments"
        && roleScope(resourceId).toLowerCase() === scope.toLowerCase()
      )).map(({ after, resourceId }) => ({ id: resourceId, scope: roleScope(resourceId), ...after.properties }));
      const inherited = inheritedAssignments.filter((assignment) => (
        scope.toLowerCase() === assignment.scope.toLowerCase()
        || scope.toLowerCase().startsWith(`${assignment.scope.toLowerCase()}/`)
      ));
      return [...direct, ...inherited];
    }
    throw new Error(`unexpected Azure read: ${args.join(" ")}`);
  };
}

function customStorageRole(fixture, index, dataActions, notDataActions = []) {
  const name = `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id: `${fixture.policy.subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/${name}`,
    name,
    permissions: [{ dataActions, notDataActions }],
  };
}

function roleDefinitionName(value) {
  return value.split("/").filter(Boolean).at(-1).toLowerCase();
}
