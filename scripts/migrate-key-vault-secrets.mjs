import { createHash, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCTION_CONTAINER_APP,
  PRODUCTION_RESOURCE_GROUP,
} from "./lib/deployment-provenance.mjs";
import {
  PRODUCTION_JOB_NAMES,
  PRODUCTION_TARGETS,
  assertExactProductionTargets,
} from "./lib/production-targets.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIRMATION = "MIGRATE-PROSTAR-METRICS-KEY-VAULT";
const WRITER_FREEZE_CONFIRMATION = "NO-CONCURRENT-PROSTAR-METRICS-SECRET-WRITERS";
const VAULT_NAME = "kv-prostar-metrics-prod";
const IDENTITY_NAME = "id-prostar-dispatch-prod";
const KEY_VAULT_SECRETS_USER_ROLE_ID = "4633458b-17de-408a-b874-0445c86b69e6";
const ARM_API_VERSION = "2024-03-01";
const KEY_VAULT_API_VERSION = "7.4";
const PRODUCTION_AAD_TENANT_ID = "515fbfd7-12b1-4238-bb6c-f827588dd488";
const PRODUCTION_AAD_CLIENT_ID = "369bef95-48a6-45db-bad6-1e16278fa229";
const PRODUCTION_AAD_ISSUER = `https://login.microsoftonline.com/${PRODUCTION_AAD_TENANT_ID}/v2.0`;
const PRODUCTION_AAD_AUDIENCES = Object.freeze([
  PRODUCTION_AAD_CLIENT_ID,
  `api://${PRODUCTION_AAD_CLIENT_ID}`,
].sort());
const AUTHORIZE_QUERY_NAMES = Object.freeze([
  "client_id", "nonce", "redirect_uri", "response_mode", "response_type", "scope", "state",
]);
const AUTHORIZE_STATE_NAMES = Object.freeze(["redir"]);
const AUTHORIZE_NONCE_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const AUTHORIZE_RESPONSE_MODE = "form_post";
const AUTHORIZE_RESPONSE_TYPE = "code id_token";
const AUTHORIZE_SCOPE = "openid profile email";
const BROWSER_PROBE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const API_PROBE_USER_AGENT = "prostar-rollout-probe/1.0";
const MIGRATION_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIGRATION_RUN_TAG = "prostar-metrics-migration-run-id";
const MIGRATION_PHASE_TAG = "prostar-metrics-migration-phase";
const MIGRATION_WRITE_PHASE = "source-write";
const ROLLBACK_RESTORE_PHASE = "rollback-restore";

function canonicalMigrationRunId(value, errorMessage = "Migration run ID must be a UUIDv4") {
  if (typeof value !== "string" || !MIGRATION_RUN_ID_PATTERN.test(value)) {
    throw new Error(errorMessage);
  }
  return value.toLowerCase();
}

export const TARGET_SECRET_NAMES = Object.freeze({
  postgres: "azure-postgres-connection-string",
  simpro: "simpro-bearer-token",
  easyAuth: "microsoft-provider-authentication-secret",
  postgresCa: "postgres-ssl-ca-cert-base64",
});

const CONTENT_TYPES = Object.freeze({
  [TARGET_SECRET_NAMES.postgres]: "application/x-postgresql-connection-string",
  [TARGET_SECRET_NAMES.simpro]: "application/x-simpro-bearer-token",
  [TARGET_SECRET_NAMES.easyAuth]: "application/x-easy-auth-client-secret",
  [TARGET_SECRET_NAMES.postgresCa]: "application/x-pem-file-base64",
});

function parseOptions(args) {
  const allowedFlags = new Set(["--execute"]);
  const allowedValues = new Set([
    "--confirm",
    "--confirm-writer-freeze",
    "--evidence-dir",
    "--writer-freeze-id",
  ]);
  const values = new Map();
  const flags = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (allowedFlags.has(arg)) {
      if (flags.has(arg)) throw new Error(`Duplicate migration argument: ${arg}`);
      flags.add(arg);
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    if (!allowedValues.has(name)) throw new Error(`Unknown migration argument: ${arg}`);
    if (values.has(name)) throw new Error(`Duplicate migration argument: ${name}`);
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.set(name, value);
  }
  return { flags, values };
}

export function parseMigrationArgs(args) {
  const { flags, values } = parseOptions(args);
  const execute = flags.has("--execute");
  if (execute && values.get("--confirm") !== CONFIRMATION) {
    throw new Error(`Execution requires --confirm=${CONFIRMATION}`);
  }
  if (!execute && values.has("--confirm")) throw new Error("--confirm is valid only with --execute");
  const suppliedWriterFreezeId = values.get("--writer-freeze-id") ?? null;
  const writerFreezeConfirmation = values.get("--confirm-writer-freeze") ?? null;
  if (!execute && (suppliedWriterFreezeId || writerFreezeConfirmation)) {
    throw new Error("Writer-freeze arguments are valid only with --execute");
  }
  if ((suppliedWriterFreezeId === null) !== (writerFreezeConfirmation === null)) {
    throw new Error("--writer-freeze-id and --confirm-writer-freeze must be supplied together");
  }
  const writerFreezeId = suppliedWriterFreezeId === null
    ? null
    : canonicalMigrationRunId(suppliedWriterFreezeId, "--writer-freeze-id must be a fresh UUIDv4");
  if (writerFreezeConfirmation && writerFreezeConfirmation !== WRITER_FREEZE_CONFIRMATION) {
    throw new Error(`Writer freeze requires --confirm-writer-freeze=${WRITER_FREEZE_CONFIRMATION}`);
  }
  return {
    execute,
    writerFreezeId,
    writerFreezeConfirmed: writerFreezeConfirmation === WRITER_FREEZE_CONFIRMATION,
    evidenceDirectory: resolve(values.get("--evidence-dir") ?? resolve(ROOT, ".work", "infra-evidence")),
  };
}

function runAz(args, { sensitive = false, output = "json" } = {}) {
  const commandArgs = [...args];
  if (output && !commandArgs.includes("--output") && !commandArgs.includes("-o")) {
    commandArgs.push("--output", output);
  }
  commandArgs.push("--only-show-errors");
  const result = spawnSync("az", commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AZURE_CORE_OUTPUT: "none" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = sensitive
      ? "Sensitive Azure command failed"
      : (result.stderr || result.stdout || "Azure command failed").trim();
    throw new Error(detail);
  }
  if (output === "none") return null;
  const text = result.stdout.trim();
  if (output === "tsv") return text;
  return text ? JSON.parse(text) : null;
}

async function authenticatedJson(url, {
  token,
  method = "GET",
  body,
  allowNotFound = false,
  label = "Azure REST request",
  headers = {},
} = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`${label} failed before an HTTP response was received`);
  }
  if (response.status === 404 && allowNotFound) return null;
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return parseAzureJsonResponse(response, label);
}

export async function parseAzureJsonResponse(response, label = "Azure REST request") {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

export function constantTimeSecretEqual(left, right, compare = timingSafeEqual) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const leftDigest = createHash("sha256").update(leftBytes).digest();
  const rightDigest = createHash("sha256").update(rightBytes).digest();
  return compare(leftDigest, rightDigest);
}

export function safeFailureDiagnostics(error, secrets = []) {
  const messages = [];
  const visit = (value, depth = 0) => {
    if (depth > 5 || messages.length >= 20) return;
    if (value instanceof Error) messages.push(value.message);
    else messages.push(String(value ?? "unknown error"));
    if (value instanceof AggregateError) {
      for (const nested of value.errors) visit(nested, depth + 1);
    }
    if (value && typeof value === "object" && "cause" in value && value.cause !== undefined) {
      visit(value.cause, depth + 1);
    }
  };
  visit(error);
  return messages.map((message) => {
    let redacted = String(message);
    for (const secret of secrets) {
      if (typeof secret === "string" && secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#"'<>]+:[^@\s/?#"'<>]+@[^\s"'<>]+/gi, "[REDACTED_CREDENTIAL_URL]")
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_POSTGRES_URL]")
      .replace(/authorization\s*:\s*bearer\s+[^\s,;"']+/gi, "Authorization: Bearer [REDACTED]")
      .replace(/(authorization|bearer|password|token|secret|client_secret)[=: ]+[^\s,;"']+/gi, "$1=[REDACTED]")
      .slice(0, 500);
  });
}

function exactNames(actualNames, expectedNames, label) {
  const actual = [...actualNames].sort();
  const expected = [...expectedNames].sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the immutable exact allowlist`);
  }
  return actual;
}

function secretNames(kind, includeCa) {
  const names = [TARGET_SECRET_NAMES.postgres, TARGET_SECRET_NAMES.simpro];
  if (kind === "app") names.push(TARGET_SECRET_NAMES.easyAuth);
  if (includeCa) names.push(TARGET_SECRET_NAMES.postgresCa);
  return names;
}

function secretUrl(name) {
  return `https://${VAULT_NAME}.vault.azure.net/secrets/${name}`;
}

function targetResourceId(subscriptionId, target) {
  const resourceType = target.kind === "app" ? "containerApps" : "jobs";
  return `/subscriptions/${subscriptionId}/resourceGroups/${PRODUCTION_RESOURCE_GROUP}/providers/Microsoft.App/${resourceType}/${target.name}`;
}

function targetResourceUrl(subscriptionId, target) {
  return `https://management.azure.com${targetResourceId(subscriptionId, target)}?api-version=${ARM_API_VERSION}`;
}

function targetListSecretsUrl(subscriptionId, target) {
  return `https://management.azure.com${targetResourceId(subscriptionId, target)}/listSecrets?api-version=${ARM_API_VERSION}`;
}

function normalizeSecretDefinition(secret) {
  return {
    name: secret?.name ?? null,
    keyVaultUrl: secret?.keyVaultUrl ?? null,
    identity: secret?.identity ?? null,
    value: typeof secret?.value === "string" ? secret.value : null,
  };
}

function listSecretValues(payload) {
  const entries = payload?.value ?? payload?.properties?.value;
  if (!Array.isArray(entries)) throw new Error("Container Apps listSecrets returned an invalid contract");
  return entries.map((entry) => ({
    name: entry?.name ?? null,
    value: typeof entry?.value === "string" ? entry.value : null,
  }));
}

function rememberSecretValue(knownSecretValues, value) {
  if (knownSecretValues && typeof value === "string" && value.length > 0) knownSecretValues.add(value);
}

async function readTargetMetadataState({ target, subscriptionId, armToken, includeCa }) {
  const resource = await authenticatedJson(targetResourceUrl(subscriptionId, target), {
    token: armToken,
    label: `Read ${target.kind} ${target.name} secret metadata`,
  });
  const expectedNames = secretNames(target.kind, includeCa);
  const definitions = (resource?.properties?.configuration?.secrets ?? []).map(normalizeSecretDefinition);
  exactNames(definitions.map(({ name }) => name), expectedNames, `${target.name} secret definitions`);
  if (definitions.some(({ value }) => value !== null)) {
    throw new Error(`${target.name} metadata response unexpectedly contained a secret value`);
  }
  return {
    secrets: definitions.map((definition) => ({
      ...definition,
      value: null,
      valueInspected: false,
    })),
  };
}

async function readTargetState({
  target,
  subscriptionId,
  armToken,
  includeCa,
  knownSecretValues,
}) {
  const [resource, listedPayload] = await Promise.all([
    authenticatedJson(targetResourceUrl(subscriptionId, target), {
      token: armToken,
      label: `Read ${target.kind} ${target.name}`,
    }),
    authenticatedJson(targetListSecretsUrl(subscriptionId, target), {
      token: armToken,
      method: "POST",
      label: `Read owned secret values for ${target.kind} ${target.name}`,
    }),
  ]);
  const expectedNames = secretNames(target.kind, includeCa);
  const definitions = (resource?.properties?.configuration?.secrets ?? []).map(normalizeSecretDefinition);
  const values = listSecretValues(listedPayload);
  for (const definition of definitions) rememberSecretValue(knownSecretValues, definition.value);
  for (const entry of values) rememberSecretValue(knownSecretValues, entry.value);
  exactNames(definitions.map(({ name }) => name), expectedNames, `${target.name} secret definitions`);
  exactNames(values.map(({ name }) => name), expectedNames, `${target.name} secret values`);
  const valuesByName = new Map(values.map((entry) => [entry.name, entry.value]));
  return {
    secrets: definitions.map((definition) => ({
      ...definition,
      value: definition.keyVaultUrl ? null : (definition.value ?? valuesByName.get(definition.name) ?? null),
      valueInspected: true,
    })),
  };
}

async function captureTargetMetadataBaselines(options, readMetadata = readTargetMetadataState) {
  const baselines = new Map();
  for (const target of options.targets) {
    baselines.set(`${target.kind}:${target.name}`, await readMetadata({ ...options, target }));
  }
  return baselines;
}

async function captureTargetBaselines(options, readState = readTargetState) {
  const baselines = new Map();
  for (const target of options.targets) {
    baselines.set(`${target.kind}:${target.name}`, await readState({ ...options, target }));
  }
  return baselines;
}

function sourceValuesFromInlineBaseline(baselines, includeCa) {
  const web = baselines.get(`app:${PRODUCTION_CONTAINER_APP}`)?.secrets ?? [];
  const values = new Map();
  for (const name of secretNames("app", includeCa)) {
    const secret = web.find((entry) => entry.name === name);
    if (secret?.keyVaultUrl || typeof secret?.value !== "string" || secret.value.length === 0) {
      throw new Error(`Owned source secret ${name} must be a nonempty inline value before migration`);
    }
    values.set(name, secret.value);
  }
  for (const [targetKey, baseline] of baselines.entries()) {
    for (const secret of baseline.secrets) {
      const expected = values.get(secret.name);
      if (secret.keyVaultUrl || !constantTimeSecretEqual(secret.value, expected)) {
        throw new Error(`Owned source secret values are inconsistent for ${targetKey}:${secret.name}`);
      }
    }
  }
  return values;
}

export function resolveMigrationSource({ baselines, targets, includeCa, identityId }) {
  const secretModes = [...baselines.values()].flatMap(({ secrets }) => (
    secrets.map((secret) => (secret.keyVaultUrl ? "key-vault" : "inline"))
  ));
  const allInline = secretModes.every((mode) => mode === "inline");
  const allReferenced = secretModes.every((mode) => mode === "key-vault");
  if (!allInline && !allReferenced) {
    throw new Error("Owned targets are in a mixed inline and Key Vault reference state");
  }
  if (allInline) {
    return { alreadyReferenced: false };
  }
  for (const target of targets) {
    const baseline = baselines.get(`${target.kind}:${target.name}`);
    assertReferenceContract(baseline.secrets, referenceDefinitions(target, identityId, includeCa));
  }
  return { alreadyReferenced: true };
}

function redactedTargetBaselines(targets, baselines) {
  return targets.map((target) => ({
    kind: target.kind,
    name: target.name,
    secrets: baselines.get(`${target.kind}:${target.name}`).secrets.map((secret) => ({
      name: secret.name,
      mode: secret.keyVaultUrl ? "key-vault" : "inline",
      keyVaultUrl: secret.keyVaultUrl,
      identity: secret.identity,
      valueInspected: secret.valueInspected === true,
      ...(secret.valueInspected === true
        ? { valuePresent: typeof secret.value === "string" && secret.value.length > 0 }
        : {}),
    })),
  }));
}

function referenceDefinitions(target, identityId, includeCa) {
  return secretNames(target.kind, includeCa).map((name) => ({
    name,
    keyVaultUrl: secretUrl(name),
    identity: identityId,
  }));
}

export function assertReferenceContract(actual, expected) {
  exactNames(actual.map(({ name }) => name), expected.map(({ name }) => name), "Key Vault reference set");
  const actualByName = new Map(actual.map((secret) => [secret.name, normalizeSecretDefinition(secret)]));
  for (const reference of expected) {
    const secret = actualByName.get(reference.name);
    if (
      secret.keyVaultUrl !== reference.keyVaultUrl
      || secret.identity?.toLowerCase() !== reference.identity.toLowerCase()
      || secret.value !== null
    ) {
      throw new Error(`Invalid Key Vault reference contract for ${reference.name}`);
    }
  }
}

function rollbackDefinitions(baseline) {
  return baseline.secrets.map((secret) => {
    if (secret.keyVaultUrl && secret.identity) {
      return { name: secret.name, keyVaultUrl: secret.keyVaultUrl, identity: secret.identity };
    }
    if (typeof secret.value !== "string") throw new Error(`Cannot restore baseline secret ${secret.name}`);
    return { name: secret.name, value: secret.value };
  });
}

export async function patchTargetSecrets({
  target,
  definitions,
  subscriptionId,
  armToken,
  includeCa,
  assertCurrent,
  knownSecretValues,
  readState = readTargetState,
  request = authenticatedJson,
}) {
  // Re-read and compare the complete owned secret state immediately before the
  // property-only PATCH, then verify the exact post-state.
  const current = await readState({ target, subscriptionId, armToken, includeCa, knownSecretValues });
  assertCurrent(current);
  await request(targetResourceUrl(subscriptionId, target), {
    token: armToken,
    method: "PATCH",
    body: { properties: { configuration: { secrets: definitions } } },
    label: `Update owned secret definitions for ${target.kind} ${target.name}`,
  });
}

function assertTargetBaselineState(actual, baseline, targetName) {
  exactNames(
    actual.secrets.map(({ name }) => name),
    baseline.secrets.map(({ name }) => name),
    `${targetName} rollback secret set`,
  );
  const actualByName = new Map(actual.secrets.map((secret) => [secret.name, secret]));
  for (const expected of baseline.secrets) {
    const found = actualByName.get(expected.name);
    if (expected.keyVaultUrl) {
      if (
        found.keyVaultUrl !== expected.keyVaultUrl
        || found.identity?.toLowerCase() !== expected.identity?.toLowerCase()
      ) throw new Error(`Rollback reference mismatch for ${targetName}:${expected.name}`);
    } else if (found.keyVaultUrl || !constantTimeSecretEqual(found.value, expected.value)) {
      throw new Error(`Rollback inline value mismatch for ${targetName}:${expected.name}`);
    }
  }
}

export function validateVault(vault) {
  if (vault?.name !== VAULT_NAME) throw new Error(`Migration requires existing dedicated vault ${VAULT_NAME}`);
  const properties = vault?.properties ?? {};
  if (properties.enableRbacAuthorization !== true) throw new Error("The dedicated Key Vault must use Azure RBAC");
  if (properties.enablePurgeProtection !== true) throw new Error("The dedicated Key Vault must have purge protection enabled");
  if (properties.enableSoftDelete === false) throw new Error("The dedicated Key Vault must have soft delete enabled");
  if (properties.publicNetworkAccess !== "Enabled") throw new Error("Key Vault public networking must remain enabled");
  // ARM normalizes an explicitly submitted public/default-Allow ACL to null on
  // newly created vaults. Deny is still rejected; null is the same public
  // default-Allow contract when publicNetworkAccess is Enabled.
  if (properties.networkAcls !== null
    && properties.networkAcls !== undefined
    && properties.networkAcls.defaultAction !== "Allow") {
    throw new Error("Key Vault public network default action must remain Allow");
  }
}

function roleDefinitionKey(id) {
  return String(id ?? "").split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";
}

function hasKeyVaultDataActions(roleDefinition) {
  return (roleDefinition?.permissions ?? []).some((permission) => (
    (permission?.dataActions ?? []).some((action) => {
      const normalized = String(action).toLowerCase();
      return normalized === "*" || normalized.startsWith("microsoft.keyvault/");
    })
  ));
}

export function validateVaultRoleAssignment(assignments, roleDefinitions, vaultId, principalId) {
  const expectedScope = vaultId.toLowerCase();
  const matching = assignments.filter((assignment) => (
    assignment?.principalId?.toLowerCase() === principalId.toLowerCase()
    && assignment?.scope?.toLowerCase() === expectedScope
    && roleDefinitionKey(assignment?.roleDefinitionId) === KEY_VAULT_SECRETS_USER_ROLE_ID
  ));
  if (matching.length !== 1) {
    throw new Error("Existing identity must have exactly one direct Key Vault Secrets User assignment on the dedicated vault");
  }
  const expectedAssignment = matching[0];
  for (const assignment of assignments) {
    if (assignment === expectedAssignment) continue;
    const definition = roleDefinitions.get(roleDefinitionKey(assignment?.roleDefinitionId));
    if (!definition) throw new Error("Cannot prove the application identity's effective Key Vault role set");
    if (hasKeyVaultDataActions(definition)) {
      throw new Error("Application identity must have no additional direct or inherited Key Vault data-plane role");
    }
  }
}

function effectiveVaultRoleAssignments(vaultId, principalId) {
  const inherited = runAz([
    "role", "assignment", "list",
    "--assignee-object-id", principalId,
    "--scope", vaultId,
    "--include-inherited",
    "--include-groups",
  ]);
  const direct = runAz([
    "role", "assignment", "list",
    "--assignee-object-id", principalId,
    "--all",
    "--include-groups",
  ]);
  if (!Array.isArray(inherited) || !Array.isArray(direct)) {
    throw new Error("Application identity role-assignment preflight returned an invalid contract");
  }
  const normalizedVaultId = vaultId.toLowerCase();
  const childAssignments = direct.filter((assignment) => {
    const scope = assignment?.scope?.toLowerCase();
    return scope === normalizedVaultId || scope?.startsWith(`${normalizedVaultId}/`);
  });
  const assignments = new Map();
  for (const assignment of [...inherited, ...childAssignments]) {
    const key = assignment?.id ?? [
      assignment?.principalId,
      assignment?.roleDefinitionId,
      assignment?.scope,
    ].join(":");
    assignments.set(key.toLowerCase(), assignment);
  }
  return [...assignments.values()];
}

function loadRoleDefinitions(assignments) {
  const definitions = new Map();
  for (const definitionId of new Set(assignments.map(({ roleDefinitionId }) => roleDefinitionKey(roleDefinitionId)))) {
    if (!definitionId) throw new Error("Effective role assignment is missing its role definition ID");
    const matches = runAz(["role", "definition", "list", "--name", definitionId]);
    if (!Array.isArray(matches) || matches.length !== 1) {
      throw new Error(`Cannot resolve effective role definition ${definitionId}`);
    }
    definitions.set(definitionId, matches[0]);
  }
  return definitions;
}

async function loadProductionContract() {
  const parameters = JSON.parse(await readFile(resolve(ROOT, "infra/azure/main.parameters.prod.example.json"), "utf8")).parameters;
  const value = (name) => parameters[name]?.value;
  const expected = {
    keyVaultName: VAULT_NAME,
    managedIdentityName: IDENTITY_NAME,
    azurePostgresConnectionStringSecretName: TARGET_SECRET_NAMES.postgres,
    simproBearerTokenSecretName: TARGET_SECRET_NAMES.simpro,
    microsoftProviderAuthenticationSecretName: TARGET_SECRET_NAMES.easyAuth,
    postgresSslCaCertBase64SecretName: TARGET_SECRET_NAMES.postgresCa,
  };
  if (value("useKeyVaultSecretReferences") !== true) {
    throw new Error("Production parameters must require Key Vault secret references");
  }
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (value(name) !== expectedValue) throw new Error(`Production parameter ${name} drifted from the immutable migration contract`);
  }
  if (typeof value("includePostgresSslCaCertSecret") !== "boolean") {
    throw new Error("Production optional CA secret switch must be a concrete boolean");
  }
  return { includeCa: value("includePostgresSslCaCertSecret") };
}

function vaultSecretBaseUrl(name) {
  return `https://${VAULT_NAME}.vault.azure.net/secrets/${encodeURIComponent(name)}`;
}

function versionFromId(id) {
  return String(id).split("/").filter(Boolean).at(-1) ?? null;
}

function redactedVersion(version) {
  return {
    id: version.id,
    version: versionFromId(version.id),
    enabled: version.attributes?.enabled !== false,
    created: version.attributes?.created ?? null,
    updated: version.attributes?.updated ?? null,
  };
}

async function listVaultVersions(name, token) {
  let url = `${vaultSecretBaseUrl(name)}/versions?api-version=${KEY_VAULT_API_VERSION}`;
  const versions = [];
  while (url) {
    const page = await authenticatedJson(url, {
      token,
      allowNotFound: true,
      label: `List Key Vault version metadata for ${name}`,
    });
    if (page === null) return [];
    if (!Array.isArray(page.value)) throw new Error(`Key Vault version list for ${name} is invalid`);
    versions.push(...page.value);
    url = page.nextLink ?? null;
  }
  return versions;
}

async function readActiveVaultSecret(name, token) {
  return authenticatedJson(`${vaultSecretBaseUrl(name)}?api-version=${KEY_VAULT_API_VERSION}`, {
    token,
    allowNotFound: true,
    label: `Read prior active Key Vault version for ${name}`,
  });
}

export function versionlessVaultState(versions) {
  if (!Array.isArray(versions)) throw new Error("Key Vault version metadata must be an array");
  if (versions.length === 0) return { newest: null, active: null };
  const ids = new Set();
  const ordered = versions.map((version) => {
    const id = typeof version?.id === "string" && version.id ? version.id : null;
    const created = version?.attributes?.created;
    if (!id || ids.has(id) || !Number.isSafeInteger(created) || created < 0) {
      throw new Error("Key Vault version ordering metadata is incomplete or ambiguous; manual reconciliation required");
    }
    ids.add(id);
    return { version, created };
  }).sort((left, right) => right.created - left.created);
  if (ordered.length > 1 && ordered[0].created === ordered[1].created) {
    throw new Error("Key Vault version ordering metadata is incomplete or ambiguous; manual reconciliation required");
  }
  const newest = ordered[0].version;
  return {
    newest,
    active: newest.attributes?.enabled === false ? null : newest,
  };
}

export function newestEnabledVaultVersion(versions) {
  return versionlessVaultState(versions).active;
}

async function readVaultSecretVersion(versionId, token) {
  return authenticatedJson(`${versionId}?api-version=${KEY_VAULT_API_VERSION}`, {
    token,
    label: "Read exact active Key Vault secret version",
  });
}

async function captureVaultMetadataBaselines(
  names,
  token,
  { requireActive = false } = {},
  readVersions = listVaultVersions,
) {
  const baselines = new Map();
  for (const name of names) {
    const versions = await readVersions(name, token);
    const newestEnabled = newestEnabledVaultVersion(versions);
    if (requireActive && newestEnabled === null) {
      throw new Error(`Referenced Key Vault secret ${name} has no active enabled version metadata`);
    }
    baselines.set(name, {
      versionIds: new Set(versions.map(({ id }) => id)),
      versions: versions.map(redactedVersion),
      rawVersions: versions,
      activeMetadata: newestEnabled === null ? null : redactedVersion(newestEnabled),
    });
  }
  return baselines;
}

function assertMigrationRunIdUnusedInBaselines(names, baselines, migrationRunId) {
  const canonicalRunId = canonicalMigrationRunId(
    migrationRunId,
    "Migration run reuse check requires a UUIDv4 run ID",
  );
  for (const name of names) {
    const baseline = baselines.get(name);
    if (baseline?.rawVersions?.some((version) => migrationRunTag(version) === canonicalRunId)) {
      throw new Error(`Migration run ID ${canonicalRunId} is not fresh for the owned Key Vault secret set`);
    }
  }
}

async function captureVaultBaselines(
  names,
  token,
  metadataBaselines,
  knownSecretValues,
  readVersion = readVaultSecretVersion,
) {
  const baselines = new Map();
  for (const name of names) {
    const metadata = metadataBaselines.get(name);
    if (!metadata) throw new Error(`Missing Key Vault metadata baseline for ${name}`);
    const active = metadata.activeMetadata
      ? await readVersion(metadata.activeMetadata.id, token)
      : null;
    rememberSecretValue(knownSecretValues, active?.value);
    baselines.set(name, {
      ...metadata,
      active: active === null ? null : {
        id: active.id,
        value: active.value,
        contentType: active.contentType ?? null,
        tags: active.tags ?? null,
        attributes: {
          enabled: active.attributes?.enabled !== false,
          ...(active.attributes?.nbf === undefined ? {} : { nbf: active.attributes.nbf }),
          ...(active.attributes?.exp === undefined ? {} : { exp: active.attributes.exp }),
        },
      },
    });
  }
  return baselines;
}

function migrationTags(tags, migrationRunId, phase) {
  const canonicalRunId = canonicalMigrationRunId(
    migrationRunId,
    "Migration secret write requires a UUIDv4 run ID",
  );
  if (![MIGRATION_WRITE_PHASE, ROLLBACK_RESTORE_PHASE].includes(phase)) {
    throw new Error("Migration secret write requires an exact owned phase");
  }
  return {
    ...(tags ?? {}),
    [MIGRATION_RUN_TAG]: canonicalRunId,
    [MIGRATION_PHASE_TAG]: phase,
  };
}

function migrationRunTag(version) {
  const value = version?.tags?.[MIGRATION_RUN_TAG];
  if (value === undefined) return null;
  return canonicalMigrationRunId(
    value,
    `Key Vault version ${version?.id ?? "with unknown ID"} has a malformed migration run ownership tag; manual reconciliation required`,
  );
}

function isOwnedMigrationWrite(version, migrationRunId) {
  return migrationRunTag(version) === migrationRunId
    && version?.tags?.[MIGRATION_PHASE_TAG] === MIGRATION_WRITE_PHASE;
}

function isOwnedMigrationVersion(version, migrationRunId) {
  return migrationRunTag(version) === migrationRunId
    && [MIGRATION_WRITE_PHASE, ROLLBACK_RESTORE_PHASE].includes(version?.tags?.[MIGRATION_PHASE_TAG]);
}

export function planVaultVersionCompensation({ versions, baseline, migrationRunId }) {
  const canonicalRunId = canonicalMigrationRunId(
    migrationRunId,
    "Vault rollback planning requires a UUIDv4 migration run ID",
  );
  if (!(baseline?.versionIds instanceof Set)) throw new Error("Vault rollback baseline version set is invalid");
  const { active } = versionlessVaultState(versions);
  const postBaseline = versions.filter(({ id }) => !baseline.versionIds.has(id));
  const unrelated = postBaseline.filter((version) => !isOwnedMigrationVersion(version, canonicalRunId));
  const enabledUnrelated = unrelated.filter((version) => version?.attributes?.enabled !== false);
  if (enabledUnrelated.length > 0) {
    if (active && enabledUnrelated.some(({ id }) => id === active.id)) {
      return {
        action: "concurrent-rotation-preserved",
        activeVersionId: active.id,
        baselineRestored: false,
        concurrentRotationPreserved: true,
        unrelatedPostBaselineVersionIds: unrelated.map(({ id }) => id),
      };
    }
    throw new Error("Enabled post-baseline Key Vault rotation cannot be proven versionless-active; manual reconciliation required");
  }
  if (!baseline.active) {
    if (active !== null) {
      throw new Error("No-baseline Key Vault rollback has an unexpected active version; manual reconciliation required");
    }
    return {
      action: "no-baseline-preserved",
      activeVersionId: null,
      baselineRestored: false,
      concurrentRotationPreserved: false,
      unrelatedPostBaselineVersionIds: unrelated.map(({ id }) => id),
    };
  }
  if (active?.id === baseline.active.id) {
    return {
      action: "baseline-already-active",
      activeVersionId: active.id,
      baselineRestored: true,
      concurrentRotationPreserved: false,
      unrelatedPostBaselineVersionIds: unrelated.map(({ id }) => id),
    };
  }
  const activeOwnedRestore = active
    && migrationRunTag(active) === canonicalRunId
    && active?.tags?.[MIGRATION_PHASE_TAG] === ROLLBACK_RESTORE_PHASE;
  return {
    action: activeOwnedRestore ? "verify-existing-baseline-restore" : "publish-baseline-restore",
    activeVersionId: active?.id ?? null,
    baselineRestored: false,
    concurrentRotationPreserved: false,
    unrelatedPostBaselineVersionIds: unrelated.map(({ id }) => id),
  };
}

async function assertMigrationRunIdUnused(names, token, migrationRunId) {
  const canonicalRunId = canonicalMigrationRunId(
    migrationRunId,
    "Migration run reuse check requires a UUIDv4 run ID",
  );
  for (const name of names) {
    const versions = await listVaultVersions(name, token);
    if (versions.some((version) => migrationRunTag(version) === canonicalRunId)) {
      throw new Error(`Migration run ID ${canonicalRunId} is not fresh for the owned Key Vault secret set`);
    }
  }
}

async function assertOwnedMigrationWritesAreActive(names, token, migrationRunId) {
  const canonicalRunId = canonicalMigrationRunId(
    migrationRunId,
    "Migration ownership verification requires a UUIDv4 run ID",
  );
  for (const name of names) {
    const versions = await listVaultVersions(name, token);
    const owned = versions.filter((version) => isOwnedMigrationWrite(version, canonicalRunId));
    const active = newestEnabledVaultVersion(versions);
    if (owned.length !== 1 || owned[0]?.attributes?.enabled === false || active?.id !== owned[0].id) {
      throw new Error(`Key Vault active version for ${name} is not owned by migration run ${canonicalRunId}`);
    }
  }
}

export async function putVaultSecret(name, value, token, {
  contentType,
  tags,
  attributes,
  migrationRunId,
  phase,
} = {}) {
  const canonicalRunId = canonicalMigrationRunId(
    migrationRunId,
    "Migration secret write requires a UUIDv4 run ID",
  );
  const ownedTags = migrationTags(tags, canonicalRunId, phase);
  const payload = await authenticatedJson(`${vaultSecretBaseUrl(name)}?api-version=${KEY_VAULT_API_VERSION}`, {
    token,
    method: "PUT",
    body: {
      value,
      contentType: contentType ?? CONTENT_TYPES[name],
      tags: ownedTags,
      attributes: { enabled: true, ...(attributes ?? {}) },
    },
    label: `Write allowlisted Key Vault secret ${name}`,
  });
  if (
    !payload?.id
    || payload?.attributes?.enabled !== true
    || migrationRunTag(payload) !== canonicalRunId
    || payload?.tags?.[MIGRATION_PHASE_TAG] !== phase
  ) {
    throw new Error(`Key Vault did not return enabled version metadata for ${name}`);
  }
  return redactedVersion(payload);
}

async function disableVaultVersion(versionId, token) {
  const payload = await authenticatedJson(`${versionId}?api-version=${KEY_VAULT_API_VERSION}`, {
    token,
    method: "PATCH",
    body: { attributes: { enabled: false } },
    label: "Disable a migration-created Key Vault version",
  });
  if (payload?.id !== versionId || payload?.attributes?.enabled !== false) {
    throw new Error("Key Vault did not verify a disabled migration-created version");
  }
}

function compensationJournalSnapshot(journal) {
  return {
    ...journal,
    ownedMigrationVersions: [...journal.ownedMigrationVersions],
    disabledMigrationVersions: [...journal.disabledMigrationVersions],
    unrelatedPostBaselineVersionIds: [...journal.unrelatedPostBaselineVersionIds],
  };
}

function createCompensationJournal(name) {
  return {
    name,
    status: "in-progress",
    lastCompletedPhase: "journal-created",
    failurePhase: null,
    failure: null,
    ownedMigrationVersions: [],
    disabledMigrationVersions: [],
    compensationAction: "pending",
    baselineRestored: false,
    concurrentRotationPreserved: false,
    activeVersionId: null,
    preservedConcurrentVersionId: null,
    unrelatedPostBaselineVersionIds: [],
    restoredFromVersionId: null,
    restoredVersionId: null,
  };
}

function applyCompensationPlan(journal, plan) {
  journal.compensationAction = plan.action;
  journal.baselineRestored = plan.baselineRestored;
  journal.concurrentRotationPreserved = plan.concurrentRotationPreserved;
  journal.activeVersionId = plan.activeVersionId;
  journal.preservedConcurrentVersionId = plan.concurrentRotationPreserved ? plan.activeVersionId : null;
  journal.unrelatedPostBaselineVersionIds = [...plan.unrelatedPostBaselineVersionIds];
}

export async function restoreVaultVersions({ names, baselines, token, migrationRunId, onResult = () => {} }) {
  const canonicalRunId = canonicalMigrationRunId(
    migrationRunId,
    "Vault rollback requires the exact UUIDv4 migration run ID",
  );
  const result = [];
  for (const name of names) {
    const journal = createCompensationJournal(name);
    const emitJournal = async () => onResult(compensationJournalSnapshot(journal));
    let attemptedPhase = "load-version-metadata";
    await emitJournal();
    try {
      const baseline = baselines.get(name);
      const current = await listVaultVersions(name, token);
      attemptedPhase = "resolve-run-ownership";
      const owned = current.filter((version) => isOwnedMigrationWrite(version, canonicalRunId));
      journal.ownedMigrationVersions = owned.map(({ id }) => id);
      journal.lastCompletedPhase = "run-ownership-resolved";
      await emitJournal();

      for (const version of owned) {
        attemptedPhase = "disable-owned-version";
        await disableVaultVersion(version.id, token);
        journal.disabledMigrationVersions.push(version.id);
        journal.lastCompletedPhase = "owned-version-disabled";
        await emitJournal();
      }

      attemptedPhase = "verify-owned-versions-disabled";
      const versionsAfterDisable = await listVaultVersions(name, token);
      const versionsAfterDisableById = new Map(versionsAfterDisable.map((version) => [version.id, version]));
      if (owned.some(({ id }) => versionsAfterDisableById.get(id)?.attributes?.enabled !== false)) {
        throw new Error(`Key Vault did not verify all disabled migration-created versions for ${name}`);
      }
      journal.lastCompletedPhase = "owned-versions-disabled-verified";
      await emitJournal();

      attemptedPhase = "plan-compensation";
      const plan = planVaultVersionCompensation({
        versions: versionsAfterDisable,
        baseline,
        migrationRunId: canonicalRunId,
      });
      applyCompensationPlan(journal, plan);

      if (plan.action === "publish-baseline-restore") {
        journal.lastCompletedPhase = "baseline-restore-approved";
        await emitJournal();
        attemptedPhase = "publish-baseline-restore";
        const restored = await putVaultSecret(name, baseline.active.value, token, {
          contentType: baseline.active.contentType,
          tags: baseline.active.tags,
          attributes: baseline.active.attributes,
          migrationRunId: canonicalRunId,
          phase: ROLLBACK_RESTORE_PHASE,
        });
        journal.restoredFromVersionId = baseline.active?.id ?? null;
        journal.restoredVersionId = restored.id;
        journal.lastCompletedPhase = "baseline-restore-published";
        await emitJournal();
        attemptedPhase = "verify-baseline-restore";
        const activeAfterRollback = await readActiveVaultSecret(name, token);
        if (
          activeAfterRollback?.id !== restored.id
          || activeAfterRollback?.attributes?.enabled !== true
          || !constantTimeSecretEqual(activeAfterRollback?.value, baseline.active.value)
        ) {
          throw new Error(`Key Vault did not verify restored active material for ${name}`);
        }
        journal.compensationAction = "baseline-restored";
        journal.activeVersionId = restored.id;
        journal.baselineRestored = true;
        journal.lastCompletedPhase = "baseline-restore-verified";
      } else if (plan.action === "verify-existing-baseline-restore") {
        journal.lastCompletedPhase = "existing-baseline-restore-detected";
        await emitJournal();
        attemptedPhase = "verify-existing-baseline-restore";
        const activeExistingRestore = await readActiveVaultSecret(name, token);
        if (
          activeExistingRestore?.id !== plan.activeVersionId
          || activeExistingRestore?.attributes?.enabled !== true
          || !constantTimeSecretEqual(activeExistingRestore?.value, baseline.active.value)
        ) {
          throw new Error(`Key Vault did not verify existing restored active material for ${name}`);
        }
        journal.compensationAction = "baseline-restored";
        journal.baselineRestored = true;
        journal.lastCompletedPhase = "existing-baseline-restore-verified";
      } else {
        journal.lastCompletedPhase = plan.action;
      }

      journal.status = "succeeded";
      journal.failurePhase = null;
      journal.failure = null;
      await emitJournal();
      result.push(compensationJournalSnapshot(journal));
    } catch (error) {
      journal.status = "incomplete";
      journal.failurePhase = attemptedPhase;
      journal.failure = "manual-reconciliation-required";
      await emitJournal();
      throw error;
    }
  }
  return result;
}

export async function applyReferenceMigration({ targets, operations }) {
  const changed = [];
  try {
    await operations.writeVaultSecrets();
    for (const target of targets) {
      changed.push(target);
      await operations.setReferences(target);
    }
    for (const target of targets) await operations.verifyReferences(target);
    await operations.activateReferences();
    await operations.verifyHealthAndAuth();
    return { changed: changed.length, verified: targets.length };
  } catch (migrationError) {
    const rollbackErrors = [];
    try {
      await operations.restoreVaultVersions();
    } catch (error) {
      rollbackErrors.push(error);
    }
    for (const target of [...changed].reverse()) {
      try {
        await operations.restoreBaseline(target);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    try {
      await operations.activateRollback();
      await operations.verifyRollback();
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [migrationError, ...rollbackErrors],
        "Key Vault migration failed and rollback verification was incomplete",
      );
    }
    throw migrationError;
  }
}

function summarizeWhatIf(result) {
  const changes = result?.properties?.changes ?? result?.changes ?? [];
  return changes.map((change) => ({ changeType: change.changeType, resourceId: change.resourceId }));
}

function restartLatestRevision() {
  const app = runAz([
    "containerapp", "show",
    "--resource-group", PRODUCTION_RESOURCE_GROUP,
    "--name", PRODUCTION_CONTAINER_APP,
  ]);
  const revision = app?.properties?.latestRevisionName;
  if (!revision) throw new Error("Cannot identify the latest web revision for restart");
  runAz([
    "containerapp", "revision", "restart",
    "--resource-group", PRODUCTION_RESOURCE_GROUP,
    "--name", PRODUCTION_CONTAINER_APP,
    "--revision", revision,
  ], { output: "none" });
}

export function assertEasyAuthContract(auth) {
  const azureActiveDirectory = auth?.identityProviders?.azureActiveDirectory;
  const registration = auth?.identityProviders?.azureActiveDirectory?.registration;
  const validation = auth?.identityProviders?.azureActiveDirectory?.validation;
  const contract = {
    platformEnabled: auth?.platform?.enabled === true,
    unauthenticatedClientAction: auth?.globalValidation?.unauthenticatedClientAction ?? null,
    excludedPaths: [...(auth?.globalValidation?.excludedPaths ?? [])].sort(),
    redirectToProvider: auth?.globalValidation?.redirectToProvider ?? null,
    requireHttps: auth?.httpSettings?.requireHttps === true,
    forwardProxyConvention: auth?.httpSettings?.forwardProxy?.convention ?? null,
    azureActiveDirectoryIsAutoProvisioned: azureActiveDirectory?.isAutoProvisioned ?? null,
    clientId: registration?.clientId ?? null,
    openIdIssuer: registration?.openIdIssuer ?? null,
    clientSecretSettingName: registration?.clientSecretSettingName ?? null,
    allowedAudiences: [...(validation?.allowedAudiences ?? [])].sort(),
    preserveUrlFragmentsForLogins: auth?.login?.preserveUrlFragmentsForLogins ?? null,
  };
  if (
    !contract.platformEnabled
    || contract.unauthenticatedClientAction !== "RedirectToLoginPage"
    || JSON.stringify(contract.excludedPaths) !== JSON.stringify(["/api/health"])
    || contract.redirectToProvider !== "AzureActiveDirectory"
    || !contract.requireHttps
    || contract.forwardProxyConvention !== "Standard"
    || contract.azureActiveDirectoryIsAutoProvisioned !== false
    || contract.clientId !== PRODUCTION_AAD_CLIENT_ID
    || contract.openIdIssuer !== PRODUCTION_AAD_ISSUER
    || contract.clientSecretSettingName !== TARGET_SECRET_NAMES.easyAuth
    || JSON.stringify(contract.allowedAudiences) !== JSON.stringify(PRODUCTION_AAD_AUDIENCES)
    || contract.preserveUrlFragmentsForLogins !== false
  ) {
    throw new Error("Easy Auth ARM contract changed unexpectedly");
  }
  return contract;
}

export async function verifyUnauthenticatedEasyAuth(fetchImpl, fqdn) {
  const routeUrl = new URL(`https://${fqdn}/quotes`);
  const browserResponse = await fetchImpl(routeUrl.href, {
    headers: {
      accept: "text/html",
      "user-agent": BROWSER_PROBE_USER_AGENT,
    },
    redirect: "manual",
  });
  const browserLocation = browserResponse.headers?.get?.("location") ?? null;
  if (browserResponse.status !== 302 || typeof browserLocation !== "string" || !browserLocation) {
    throw new Error(`Browser Easy Auth probe must return HTTP 302 with Location; received ${browserResponse.status}`);
  }

  let authorizeUrl;
  try {
    authorizeUrl = new URL(browserLocation);
  } catch {
    throw new Error("Browser Easy Auth probe returned an invalid Location URL");
  }
  assertExactParameterNames(authorizeUrl.searchParams, AUTHORIZE_QUERY_NAMES, "authorization query");
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
  const state = authorizeUrl.searchParams.get("state");
  const stateParameters = new URLSearchParams(state ?? "");
  assertExactParameterNames(stateParameters, AUTHORIZE_STATE_NAMES, "authorization state");
  const nonce = authorizeUrl.searchParams.get("nonce");
  const stateRedirect = stateParameters.get("redir");
  if (
    authorizeUrl.protocol !== "https:"
    || authorizeUrl.hostname !== "login.microsoftonline.com"
    || authorizeUrl.port !== ""
    || authorizeUrl.username !== ""
    || authorizeUrl.password !== ""
    || authorizeUrl.hash !== ""
    || authorizeUrl.pathname !== `/${PRODUCTION_AAD_TENANT_ID}/oauth2/v2.0/authorize`
    || authorizeUrl.searchParams.get("client_id") !== PRODUCTION_AAD_CLIENT_ID
    || redirectUri !== `${routeUrl.origin}/.auth/login/aad/callback`
    || authorizeUrl.searchParams.get("response_mode") !== AUTHORIZE_RESPONSE_MODE
    || authorizeUrl.searchParams.get("response_type") !== AUTHORIZE_RESPONSE_TYPE
    || authorizeUrl.searchParams.get("scope") !== AUTHORIZE_SCOPE
    || stateRedirect !== "/quotes"
    || typeof nonce !== "string"
    || !AUTHORIZE_NONCE_PATTERN.test(nonce)
  ) {
    throw new Error("Browser Easy Auth probe did not match the exact production authorization contract");
  }

  const apiResponse = await fetchImpl(routeUrl.href, {
    headers: {
      accept: "application/json",
      "user-agent": API_PROBE_USER_AGENT,
    },
    redirect: "manual",
  });
  const apiLocation = apiResponse.headers?.get?.("location") ?? null;
  if (apiResponse.status !== 401 || apiLocation !== null) {
    throw new Error(`API Easy Auth probe must return HTTP 401 without Location; received ${apiResponse.status}`);
  }
}

function assertExactParameterNames(parameters, expectedNames, label) {
  const actualNames = [...parameters.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Browser Easy Auth probe returned an invalid ${label} structure`);
  }
}

async function verifyHealthAndAuth(attempts = 30) {
  const app = runAz([
    "containerapp", "show",
    "--resource-group", PRODUCTION_RESOURCE_GROUP,
    "--name", PRODUCTION_CONTAINER_APP,
  ]);
  const fqdn = app?.properties?.configuration?.ingress?.fqdn;
  if (!fqdn) throw new Error("Metrics web FQDN is unavailable");
  let healthy = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`https://${fqdn}/api/health`, { redirect: "manual" }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (response?.status === 200 && payload?.ok === true && payload?.database?.connected === true) {
      healthy = true;
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
  }
  if (!healthy) throw new Error("Metrics database-aware health verification failed after secret migration");

  const auth = runAz([
    "containerapp", "auth", "show",
    "--resource-group", PRODUCTION_RESOURCE_GROUP,
    "--name", PRODUCTION_CONTAINER_APP,
  ]);
  assertEasyAuthContract(auth);
  await verifyUnauthenticatedEasyAuth(fetch, fqdn);
}

async function writeEvidence(directory, evidence) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const path = resolve(directory, `key-vault-migration-${timestamp}.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function runKeyVaultMigrationWorkflow({
  args,
  includeCa,
  targets,
  operations,
  knownSecretValues = new Set(),
  now = () => new Date().toISOString(),
}) {
  const migrationRunId = args.writerFreezeId == null
    ? null
    : canonicalMigrationRunId(args.writerFreezeId, "Workflow writer-freeze ID must be a UUIDv4");
  if (targets.length !== 24) throw new Error("Key Vault migration requires the exact 24 production targets");
  const identity = await operations.readIdentity();
  if (!identity?.id || !identity?.principalId) throw new Error("The existing production user-assigned identity was not found");
  const vault = await operations.readVault();
  validateVault(vault);
  const assignments = await operations.readEffectiveRoleAssignments(vault.id, identity.principalId);
  const roleDefinitions = await operations.readRoleDefinitions(assignments);
  validateVaultRoleAssignment(assignments, roleDefinitions, vault.id, identity.principalId);
  const { subscriptionId, armToken, vaultToken } = await operations.readAccessContext();

  const targetOptions = { targets, subscriptionId, armToken, includeCa };
  const metadataBaselines = await captureTargetMetadataBaselines(targetOptions, operations.readTargetMetadata);
  const { alreadyReferenced } = resolveMigrationSource({
    baselines: metadataBaselines,
    targets,
    includeCa,
    identityId: identity.id,
  });
  const ownedVaultNames = secretNames("app", includeCa);
  const vaultMetadataBaselines = await captureVaultMetadataBaselines(
    ownedVaultNames,
    vaultToken,
    { requireActive: alreadyReferenced },
    operations.listVaultVersions,
  );
  if (args.execute && !alreadyReferenced) {
    if (!args.writerFreezeConfirmed || !migrationRunId) {
      throw new Error(
        `Value migration requires a fresh --writer-freeze-id UUIDv4 and --confirm-writer-freeze=${WRITER_FREEZE_CONFIRMATION}`,
      );
    }
    assertMigrationRunIdUnusedInBaselines(ownedVaultNames, vaultMetadataBaselines, migrationRunId);
  }

  let baselines = metadataBaselines;
  let vaultBaselines = vaultMetadataBaselines;
  let sourceValues = new Map();
  if (!alreadyReferenced) {
    baselines = await captureTargetBaselines(
      { ...targetOptions, knownSecretValues },
      operations.readTargetState,
    );
    if (resolveMigrationSource({ baselines, targets, includeCa, identityId: identity.id }).alreadyReferenced) {
      throw new Error("Owned targets changed mode during migration baseline capture");
    }
    sourceValues = sourceValuesFromInlineBaseline(baselines, includeCa);
    vaultBaselines = await captureVaultBaselines(
      ownedVaultNames,
      vaultToken,
      vaultMetadataBaselines,
      knownSecretValues,
      operations.readVaultSecretVersion,
    );
  }
  const whatIf = await operations.runWhatIf();
  const evidence = {
    schemaVersion: 3,
    operation: "prostar-metrics-key-vault-migration",
    mode: args.execute ? "execute" : "dry-run",
    startedAt: now(),
    resourceGroup: PRODUCTION_RESOURCE_GROUP,
    keyVaultName: VAULT_NAME,
    vaultProvisioningPrerequisiteVerified: true,
    vaultRbacPrerequisiteVerified: true,
    managedIdentityResourceId: identity.id,
    webAppName: PRODUCTION_CONTAINER_APP,
    jobNames: [...PRODUCTION_JOB_NAMES],
    targetCount: targets.length,
    includedSecretNames: ownedVaultNames,
    initialSecretMode: alreadyReferenced ? "key-vault" : "inline",
    verificationMode: alreadyReferenced ? "metadata-only" : "value-dependent-migration",
    secretValuesAccessed: !alreadyReferenced,
    secretValuesWritten: args.execute && !alreadyReferenced,
    operatorSecretsOfficerRequired: args.execute && !alreadyReferenced,
    migrationRunId: args.execute && !alreadyReferenced ? migrationRunId : null,
    writerFreeze: {
      required: args.execute && !alreadyReferenced,
      operatorAttested: args.execute && !alreadyReferenced && args.writerFreezeConfirmed,
      enforcement: alreadyReferenced
        ? "no-write-metadata-verification"
        : "operational-single-writer-freeze-with-fresh-exact-state-guards",
    },
    targetBaseline: redactedTargetBaselines(targets, baselines),
    vaultVersionBaseline: ownedVaultNames.map((name) => ({
      name,
      versions: vaultBaselines.get(name).versions,
      activeVersionId: vaultBaselines.get(name).activeMetadata?.id ?? null,
    })),
    whatIf: summarizeWhatIf(whatIf),
    status: "planned",
  };

  if (!args.execute && !alreadyReferenced) {
    evidence.completedAt = now();
    const evidencePath = await operations.writeEvidence(args.evidenceDirectory, evidence);
    return { evidence, evidencePath, result: null };
  }

  const vaultRollback = [];
  const recordVaultRollback = (outcome) => {
    const index = vaultRollback.findIndex(({ name }) => name === outcome.name);
    if (index === -1) vaultRollback.push(outcome);
    else vaultRollback[index] = outcome;
  };
  let result;
  let failure;
  let evidencePath;
  try {
    if (alreadyReferenced) {
      for (const target of targets) {
        const state = await operations.readTargetMetadata({ target, subscriptionId, armToken, includeCa });
        assertReferenceContract(state.secrets, referenceDefinitions(target, identity.id, includeCa));
      }
      await captureVaultMetadataBaselines(
        ownedVaultNames,
        vaultToken,
        { requireActive: true },
        operations.listVaultVersions,
      );
      await operations.verifyHealthAndAuth();
      result = {
        changed: 0,
        verified: targets.length,
        verificationMode: "metadata-only",
        secretValuesAccessed: false,
      };
    } else {
      result = await applyReferenceMigration({
        targets,
        operations: {
          async writeVaultSecrets() {
            await operations.assertMigrationRunIdUnused(ownedVaultNames, vaultToken, migrationRunId);
            for (const [name, value] of sourceValues.entries()) {
              await operations.putVaultSecret(name, value, vaultToken, {
                migrationRunId,
                phase: MIGRATION_WRITE_PHASE,
              });
            }
            await operations.assertOwnedMigrationWrites(ownedVaultNames, vaultToken, migrationRunId);
          },
          async restoreVaultVersions() {
            await operations.restoreVaultVersions({
              names: ownedVaultNames,
              baselines: vaultBaselines,
              token: vaultToken,
              migrationRunId,
              onResult: recordVaultRollback,
            });
          },
          async setReferences(target) {
            await operations.assertOwnedMigrationWrites(ownedVaultNames, vaultToken, migrationRunId);
            const baseline = baselines.get(`${target.kind}:${target.name}`);
            await operations.patchTargetSecrets({
              target,
              definitions: referenceDefinitions(target, identity.id, includeCa),
              subscriptionId,
              armToken,
              includeCa,
              knownSecretValues,
              assertCurrent: (current) => assertTargetBaselineState(current, baseline, target.name),
            });
          },
          async verifyReferences(target) {
            const state = await operations.readTargetState({
              target, subscriptionId, armToken, includeCa, knownSecretValues,
            });
            assertReferenceContract(state.secrets, referenceDefinitions(target, identity.id, includeCa));
          },
          async activateReferences() {
            await operations.assertOwnedMigrationWrites(ownedVaultNames, vaultToken, migrationRunId);
            await operations.restartLatestRevision();
          },
          async verifyHealthAndAuth() {
            await operations.verifyHealthAndAuth();
          },
          async restoreBaseline(target) {
            const baseline = baselines.get(`${target.kind}:${target.name}`);
            const references = referenceDefinitions(target, identity.id, includeCa);
            const current = await operations.readTargetState({
              target, subscriptionId, armToken, includeCa, knownSecretValues,
            });
            try {
              assertTargetBaselineState(current, baseline, target.name);
              return;
            } catch {
              assertReferenceContract(current.secrets, references);
            }
            await operations.patchTargetSecrets({
              target,
              definitions: rollbackDefinitions(baseline),
              subscriptionId,
              armToken,
              includeCa,
              knownSecretValues,
              assertCurrent: (state) => assertReferenceContract(state.secrets, references),
            });
          },
          async activateRollback() {
            await operations.restartLatestRevision();
          },
          async verifyRollback() {
            for (const target of targets) {
              const state = await operations.readTargetState({
                target, subscriptionId, armToken, includeCa, knownSecretValues,
              });
              assertTargetBaselineState(state, baselines.get(`${target.kind}:${target.name}`), target.name);
            }
            await operations.verifyHealthAndAuth();
          },
        },
      });
    }
    evidence.status = "succeeded";
    evidence.referencesChanged = result.changed;
    evidence.referencesVerified = result.verified;
    if (alreadyReferenced) evidence.noOpVerified = true;
  } catch (error) {
    failure = error;
    evidence.status = "failed";
    evidence.vaultRollback = vaultRollback;
    evidence.failureDiagnostics = safeFailureDiagnostics(error, [...knownSecretValues]);
    evidence.failure = alreadyReferenced
      ? "Metadata-only Key Vault reference verification failed"
      : error instanceof AggregateError
        ? "Migration failed and rollback verification was incomplete"
        : "Migration failed after verified vault and app/job rollback";
  } finally {
    evidence.completedAt = now();
    evidencePath = await operations.writeEvidence(args.evidenceDirectory, evidence);
  }
  if (failure) throw failure;
  return { evidence, evidencePath, result };
}

function productionMigrationOperations() {
  return {
    readIdentity: () => runAz([
      "identity", "show",
      "--resource-group", PRODUCTION_RESOURCE_GROUP,
      "--name", IDENTITY_NAME,
    ]),
    readVault: () => runAz([
      "keyvault", "show",
      "--resource-group", PRODUCTION_RESOURCE_GROUP,
      "--name", VAULT_NAME,
    ]),
    readEffectiveRoleAssignments: effectiveVaultRoleAssignments,
    readRoleDefinitions: loadRoleDefinitions,
    async readAccessContext() {
      const subscriptionId = runAz(["account", "show", "--query", "id"], { output: "tsv" });
      const [armToken, vaultToken] = await Promise.all([
        runAz([
          "account", "get-access-token", "--resource", "https://management.azure.com", "--query", "accessToken",
        ], { sensitive: true, output: "tsv" }),
        runAz([
          "account", "get-access-token", "--resource", "https://vault.azure.net", "--query", "accessToken",
        ], { sensitive: true, output: "tsv" }),
      ]);
      return { subscriptionId, armToken, vaultToken };
    },
    readTargetMetadata: readTargetMetadataState,
    listVaultVersions,
    assertMigrationRunIdUnused,
    readTargetState,
    readVaultSecretVersion,
    runWhatIf: () => runAz([
      "deployment", "group", "what-if",
      "--resource-group", PRODUCTION_RESOURCE_GROUP,
      "--name", "prostar-metrics-security-review",
      "--template-file", resolve(ROOT, "infra/azure/security.bicep"),
      "--parameters", resolve(ROOT, "infra/azure/security.parameters.prod.example.json"),
      "--parameters", "deployNewKeyVault=false", "writeSecretValues=false",
      "--result-format", "ResourceIdOnly",
      "--no-pretty-print",
    ]),
    writeEvidence,
    verifyHealthAndAuth,
    putVaultSecret,
    assertOwnedMigrationWrites: assertOwnedMigrationWritesAreActive,
    restoreVaultVersions,
    patchTargetSecrets,
    restartLatestRevision,
  };
}

async function main(knownSecretValues = new Set()) {
  const args = parseMigrationArgs(process.argv.slice(2));
  const { includeCa } = await loadProductionContract();
  const targets = assertExactProductionTargets(PRODUCTION_TARGETS);
  const outcome = await runKeyVaultMigrationWorkflow({
    args,
    includeCa,
    targets,
    operations: productionMigrationOperations(),
    knownSecretValues,
  });
  const label = !args.execute && outcome.evidence.initialSecretMode === "inline"
    ? "Dry run complete. Redacted evidence"
    : "Redacted evidence";
  console.log(`${label}: ${outcome.evidencePath}`);
}

export async function runWithKnownSecretRedaction({ run, knownSecretValues = new Set(), reportFailure }) {
  try {
    return await run(knownSecretValues);
  } catch (error) {
    reportFailure(safeFailureDiagnostics(error, [...knownSecretValues]));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const knownSecretValues = new Set();
  runWithKnownSecretRedaction({
    knownSecretValues,
    run: main,
    reportFailure: (diagnostics) => {
      console.error(`Key Vault migration diagnostic: ${JSON.stringify(diagnostics)}`);
    },
  }).catch(() => {
    console.error("Key Vault migration failed; inspect the redacted evidence report");
    process.exitCode = 1;
  });
}
