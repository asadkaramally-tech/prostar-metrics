import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AzureCliError,
  assertArmResourceAbsent,
  executeRestoreWorkflow,
  isExplicitCliResourceNotFound,
  isPublicIpv4,
  parseRestoreArgs,
} from "../../scripts/restore-postgres-drill.mjs";
import {
  assertExactDatabaseSchemaManifest,
  generateRepositoryDatabaseSchemaManifest,
  loadRepositoryMigrations,
} from "../../scripts/lib/database-schema-manifest.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const [source, schemaSource, repositoryManifest, repositoryMigrations] = await Promise.all([
  readFile(new URL("../../scripts/restore-postgres-drill.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../scripts/lib/database-schema-manifest.mjs", import.meta.url), "utf8"),
  generateRepositoryDatabaseSchemaManifest(ROOT),
  loadRepositoryMigrations(ROOT),
]);

test("restore drill requires public caller IP and fixed confirmation while rejecting target overrides", () => {
  const now = new Date("2026-07-13T12:00:00Z");
  const dryRun = parseRestoreArgs(["--caller-ip=8.8.8.8"], now);
  assert.equal(dryRun.execute, false);
  assert.match(dryRun.temporaryServerName, /^pg-psm-drill-\d{14}-[a-f0-9]{6}$/);
  assert.throws(() => parseRestoreArgs([], now), /globally routable public IPv4/);
  assert.throws(() => parseRestoreArgs(["--execute", "--caller-ip=8.8.8.8"], now), /RESTORE-PG-PROSTAR-METRICS-PROD/);
  assert.equal(parseRestoreArgs([
    "--execute",
    "--confirm=RESTORE-PG-PROSTAR-METRICS-PROD",
    "--caller-ip=8.8.8.8",
  ], now).execute, true);
  for (const override of [
    "--resource-group=other",
    "--source-server=other",
    "--temporary-server-name=other",
    "--database-name=other",
    "--key-vault-name=other",
  ]) assert.throws(() => parseRestoreArgs([override], now), /Unknown restore argument/);
});

test("caller firewall validator rejects every nonpublic, reserved, multicast, and ambiguous IPv4 class", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "44.32.1.9", "223.255.255.254"]) {
    assert.equal(isPublicIpv4(address), true, address);
  }
  for (const address of [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254",
    "127.0.0.1", "127.255.255.255", "169.254.1.1", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1",
    "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255",
    "240.0.0.1", "255.255.255.255", "01.2.3.4", "1.2.3", "1.2.3.999", "localhost",
  ]) assert.equal(isPublicIpv4(address), false, address);
});

test("only an explicit Azure CLI ResourceNotFound code proves absence", () => {
  const cliError = (stderr) => new AzureCliError("failed", { status: 1, stdout: "", stderr });
  assert.equal(isExplicitCliResourceNotFound(cliError("(ResourceNotFound) Resource was not found")), true);
  assert.equal(isExplicitCliResourceNotFound(cliError('{"code":"ResourceNotFound"}')), true);
  assert.equal(isExplicitCliResourceNotFound(cliError("Code: ResourceNotFound")), true);
  for (const detail of [
    "(AuthorizationFailed) forbidden",
    "Gateway timeout while checking resource",
    "Connection refused",
    "resource was not found",
    '{"code":"ResourceGroupNotFound"}',
  ]) assert.equal(isExplicitCliResourceNotFound(cliError(detail)), false, detail);
  assert.equal(isExplicitCliResourceNotFound(new Error("(ResourceNotFound)")), false);
});

test("ARM cleanup requires HTTP 404 and propagates every auth, timeout, network, and server error", async () => {
  const request = (status) => assertArmResourceAbsent(
    "https://management.azure.com/resource?api-version=1",
    "opaque-token",
    async () => new Response(status === 200 ? "{}" : "", { status }),
  );
  await assert.doesNotReject(request(404));
  await assert.rejects(request(200), /still returns/);
  for (const status of [401, 403, 408, 429, 500, 503]) {
    await assert.rejects(request(status), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(
    assertArmResourceAbsent("https://management.azure.com/resource", "token", async () => { throw new Error("network"); }),
    /before an HTTP response/,
  );
});

test("database validation failure still removes firewall, deletes server, verifies both absence paths, and checks source", async () => {
  const events = [];
  await assert.rejects(
    executeRestoreWorkflow({
      operations: {
        async restore() { events.push("restore"); },
        async waitUntilReady() { events.push("ready"); return { name: "temporary" }; },
        async validateRestoredConfiguration() { events.push("config"); },
        async addTemporaryFirewall() { events.push("firewall-add"); },
        async validateDatabase() { events.push("database"); throw new Error("schema invalid"); },
        async removeTemporaryFirewall() { events.push("firewall-remove"); },
        async deleteTemporaryServer() { events.push("server-delete"); },
        async verifyCleanup() { events.push("cli-and-arm-cleanup-verify"); },
        async verifySourceUnchanged() { events.push("source-verify"); },
      },
    }),
    /schema invalid/,
  );
  assert.deepEqual(events, [
    "restore", "ready", "config", "firewall-add", "database", "firewall-remove",
    "server-delete", "cli-and-arm-cleanup-verify", "source-verify",
  ]);
});

test("every cleanup check runs even when earlier cleanup operations fail", async () => {
  const events = [];
  await assert.rejects(
    executeRestoreWorkflow({
      operations: {
        async restore() { events.push("restore"); throw new Error("restore failed"); },
        async waitUntilReady() { throw new Error("unexpected"); },
        async validateRestoredConfiguration() { throw new Error("unexpected"); },
        async addTemporaryFirewall() { throw new Error("unexpected"); },
        async validateDatabase() { throw new Error("unexpected"); },
        async removeTemporaryFirewall() { events.push("firewall-remove"); throw new Error("remove failed"); },
        async deleteTemporaryServer() { events.push("server-delete"); throw new Error("delete failed"); },
        async verifyCleanup() { events.push("cleanup-verify"); throw new Error("still exists"); },
        async verifySourceUnchanged() { events.push("source-verify"); },
      },
    }),
    /cleanup verification was incomplete/,
  );
  assert.deepEqual(events, ["restore", "firewall-remove", "server-delete", "cleanup-verify", "source-verify"]);
});

test("restore writes the temporary target only and source network/config remains read-only", () => {
  const restoreBlock = source.slice(source.indexOf("async restore()"), source.indexOf("async waitUntilReady()"));
  const addFirewallBlock = source.slice(source.indexOf("async addTemporaryFirewall()"), source.indexOf("async validateDatabase(restored)"));
  const removeFirewallBlock = source.slice(source.indexOf("async removeTemporaryFirewall()"), source.indexOf("async deleteTemporaryServer()"));
  assert.match(restoreBlock, /"--source-server", source\.id/);
  assert.match(restoreBlock, /"--name", args\.temporaryServerName/);
  assert.doesNotMatch(restoreBlock, /--vnet|--subnet|--private-dns-zone/);
  assert.match(addFirewallBlock, /"--server-name", args\.temporaryServerName/);
  assert.match(addFirewallBlock, /"--name", TEMP_FIREWALL_RULE/);
  assert.doesNotMatch(addFirewallBlock, /SOURCE_SERVER_NAME|source\.id/);
  assert.match(removeFirewallBlock, /"--server-name", args\.temporaryServerName/);
  assert.match(removeFirewallBlock, /"--name", TEMP_FIREWALL_RULE/);
  assert.doesNotMatch(removeFirewallBlock, /SOURCE_SERVER_NAME|source\.id/);
  assert.match(source, /await waitForCliDeletion\(args\.temporaryServerName\)/);
  assert.match(source, /await assertArmResourceAbsent\(temporaryServerUrl, cleanupArmToken\)/);
  assert.match(source, /JSON\.stringify\(sourceContract\(after\)\) !== JSON\.stringify\(sourceContract\(source\)\)/);
  assert.doesNotMatch(source, /allowFailure|"resource", "show"/);
});

test("repository manifest contains exact schema structure and migration filename/hash contract", () => {
  assert.deepEqual(repositoryManifest.schemas, [{ name: "metrics" }]);
  assert.ok(repositoryManifest.tables.length > 0);
  assert.ok(repositoryManifest.columns.length > repositoryManifest.tables.length);
  assert.ok(repositoryManifest.constraints.length > 0);
  assert.ok(repositoryManifest.indexes.length > 0);
  assert.deepEqual(
    repositoryManifest.migrations,
    repositoryMigrations.map(({ filename, sha256 }) => ({ filename, sha256 })),
  );
  assert.ok(repositoryManifest.migrations.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
  assert.match(schemaSource, /pg_catalog\.format_type/);
  assert.match(schemaSource, /pg_catalog\.pg_get_constraintdef/);
  assert.match(schemaSource, /from pg_catalog\.pg_indexes/);
});

test("schema comparison fails closed on columns, defaults, constraints, indexes, or migration drift", () => {
  assert.equal(assertExactDatabaseSchemaManifest(structuredClone(repositoryManifest), repositoryManifest).exactMatch, true);
  for (const mutate of [
    (manifest) => { manifest.columns[0].nullable = !manifest.columns[0].nullable; },
    (manifest) => { manifest.columns[0].default = "invented_default()"; },
    (manifest) => { manifest.constraints.pop(); },
    (manifest) => { manifest.indexes[0].definition += " WHERE false"; },
    (manifest) => { manifest.migrations[0].sha256 = "0".repeat(64); },
    (manifest) => { manifest.migrations[0].filename = "000_wrong.sql"; },
  ]) {
    const changed = structuredClone(repositoryManifest);
    mutate(changed);
    assert.throws(() => assertExactDatabaseSchemaManifest(changed, repositoryManifest), /schema manifest differs/);
  }
});

test("restore validates TLS and exact manifest while treating row counts as evidence only", () => {
  assert.match(source, /verifiedPostgresClientConfig/);
  assert.match(source, /from pg_stat_ssl/);
  assert.match(source, /tls\?\.ssl !== true/);
  assert.match(source, /collectDatabaseSchemaManifest/);
  assert.match(source, /assertExactDatabaseSchemaManifest/);
  assert.match(source, /migrationsCompatible: true/);
  assert.match(source, /purpose: "evidence-only"/);
  assert.match(source, /comparedToSourceBaseline: false/);
  assert.doesNotMatch(source, /pendingPriorImageCompatible|backwardCompatibilityViolations/);
});

test("evidence construction and console output exclude secret material", () => {
  const evidenceBlock = source.slice(source.indexOf("const evidence = {"), source.indexOf("if (!args.execute)"));
  assert.doesNotMatch(evidenceBlock, /sourceConnectionString|caBase64|password|secretValue|accessToken/i);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:sourceConnectionString|caBase64|password|secretValue|accessToken)/i);
  assert.match(source, /Secret-free evidence/);
  assert.doesNotMatch(source, /createHash|sha256\([^)]*(?:secret|connection|password|token)/i);
});
