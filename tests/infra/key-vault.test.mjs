import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  newestEnabledVaultVersion,
  parseAzureJsonResponse,
  safeFailureDiagnostics,
  validateVault,
  validateVaultRoleAssignment,
} from "../../scripts/migrate-key-vault-secrets.mjs";

const [securityBicep, metricsBicep, securityParametersText, metricsParametersText] = await Promise.all([
  readFile(new URL("../../infra/azure/security.bicep", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/metrics.bicep", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/security.parameters.prod.example.json", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/main.parameters.prod.example.json", import.meta.url), "utf8"),
]);
const securityParameters = JSON.parse(securityParametersText).parameters;
const metricsParameters = JSON.parse(metricsParametersText).parameters;

test("dedicated Key Vault is create-or-import, RBAC-only, recoverable, and public", () => {
  assert.equal(securityParameters.keyVaultName.value, "kv-prostar-metrics-prod");
  assert.equal(securityParameters.writeSecretValues.value, false);
  assert.match(securityBicep, /param deployNewKeyVault bool = true/);
  assert.match(securityBicep, /resource newKeyVault .* = if \(deployNewKeyVault\)/);
  assert.match(securityBicep, /resource existingKeyVault .* existing = if \(!deployNewKeyVault\)/);
  assert.match(securityBicep, /enableRbacAuthorization: true/);
  assert.match(securityBicep, /enableSoftDelete: true/);
  assert.match(securityBicep, /softDeleteRetentionInDays: 90/);
  assert.match(securityBicep, /enablePurgeProtection: true/);
  assert.match(securityBicep, /publicNetworkAccess: 'Enabled'/);
  assert.match(securityBicep, /defaultAction: 'Allow'/);
  assert.doesNotMatch(securityBicep, /privateEndpoint|privateLink/i);
});

test("vault validation accepts Azure's null default-Allow normalization but rejects Deny", () => {
  const properties = {
    enableRbacAuthorization: true,
    enablePurgeProtection: true,
    enableSoftDelete: true,
    publicNetworkAccess: "Enabled",
    networkAcls: null,
  };
  assert.doesNotThrow(() => validateVault({ name: "kv-prostar-metrics-prod", properties }));
  assert.doesNotThrow(() => validateVault({
    name: "kv-prostar-metrics-prod",
    properties: { ...properties, networkAcls: { defaultAction: "Allow" } },
  }));
  assert.throws(() => validateVault({
    name: "kv-prostar-metrics-prod",
    properties: { ...properties, networkAcls: { defaultAction: "Deny" } },
  }), /default action must remain Allow/);
});

test("migration failure diagnostics preserve operation labels without exposing nested secrets", () => {
  const secret = "postgresql://migration-user:swordfish@db.example.test:5432/metrics";
  const unlabelledMarker = "opaque-unlabelled-marker-839201";
  const credentialUrl = "https://service-user:credential-value@example.test/private";
  const error = new AggregateError([
    new Error(`Update app failed with ${secret}`),
    new Error("Authorization: Bearer eyJprivate"),
    new Error(`Unclassified failure ${unlabelledMarker}`),
    new Error(`Remote endpoint ${credentialUrl}`),
  ], "rollback incomplete");
  const diagnostic = JSON.stringify(safeFailureDiagnostics(error, [secret, unlabelledMarker]));
  assert.match(diagnostic, /rollback incomplete|Update app failed/);
  assert.doesNotMatch(diagnostic, /swordfish|eyJprivate|postgresql:\/\/|opaque-unlabelled-marker|credential-value/);
  assert.match(diagnostic, /REDACTED/);
});

test("application UAMI role preflight rejects every additional effective Key Vault data-plane role", () => {
  const vaultId = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-prostar-metrics-prod";
  const principalId = "application-principal";
  const secretsUserId = "4633458b-17de-408a-b874-0445c86b69e6";
  const readerId = "21090545-7ca7-4776-b22c-e363652d74d2";
  const secretsOfficerId = "b86a8fe4-44ce-4948-aee5-eccb2c155cd7";
  const cryptoUserId = "12338af0-0e69-4776-bea7-57ae8d297424";
  const armReaderId = "00000000-0000-0000-0000-000000000001";
  const expected = {
    id: "expected",
    principalId,
    scope: vaultId,
    roleDefinitionId: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${secretsUserId}`,
  };
  const definitions = new Map([
    [secretsUserId, { permissions: [{ dataActions: ["Microsoft.KeyVault/vaults/secrets/getSecret/action"] }] }],
    [readerId, { permissions: [{ dataActions: ["Microsoft.KeyVault/vaults/*/read"] }] }],
    [secretsOfficerId, { permissions: [{ dataActions: ["Microsoft.KeyVault/vaults/secrets/*"] }] }],
    [cryptoUserId, { permissions: [{ dataActions: ["Microsoft.KeyVault/vaults/keys/sign/action"] }] }],
    [armReaderId, { permissions: [{ dataActions: [] }] }],
  ]);
  const armReader = {
    id: "arm-reader",
    principalId,
    scope: "/subscriptions/sub/resourceGroups/rg",
    roleDefinitionId: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${armReaderId}`,
  };
  assert.doesNotThrow(() => validateVaultRoleAssignment(
    [expected, armReader],
    definitions,
    vaultId,
    principalId,
  ));

  for (const additional of [
    {
      id: "inherited-secrets-user",
      principalId: "effective-group",
      scope: "/subscriptions/sub/resourceGroups/rg",
      roleDefinitionId: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${secretsUserId}`,
    },
    {
      id: "inherited-reader",
      principalId: "effective-group",
      scope: "/subscriptions/sub/resourceGroups/rg",
      roleDefinitionId: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${readerId}`,
    },
    {
      id: "direct-officer",
      principalId,
      scope: vaultId,
      roleDefinitionId: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${secretsOfficerId}`,
    },
    {
      id: "key-crypto",
      principalId,
      scope: `${vaultId}/keys/evidence-key`,
      roleDefinitionId: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${cryptoUserId}`,
    },
  ]) {
    assert.throws(() => validateVaultRoleAssignment(
      [expected, additional],
      definitions,
      vaultId,
      principalId,
    ), /no additional direct or inherited Key Vault data-plane role/);
  }
});

test("vault baseline selection treats a disabled newest version as no active secret", () => {
  const older = { id: "older", attributes: { created: 10, enabled: true } };
  const newest = { id: "newest", attributes: { created: 20, enabled: false } };
  assert.equal(newestEnabledVaultVersion([older, newest]), null);
  assert.equal(newestEnabledVaultVersion([{ ...newest, attributes: { created: 20, enabled: true } }, older]).id, "newest");
  assert.equal(newestEnabledVaultVersion([]), null);
  assert.throws(
    () => newestEnabledVaultVersion([{ id: "missing-created", attributes: { enabled: true } }]),
    /ordering metadata is incomplete or ambiguous/,
  );
  assert.throws(
    () => newestEnabledVaultVersion([older, { id: "same-time", attributes: { created: 10, enabled: true } }]),
    /ordering metadata is incomplete or ambiguous/,
  );
});

test("Azure REST parsing accepts empty successful PATCH responses but rejects malformed JSON", async () => {
  assert.equal(await parseAzureJsonResponse(new Response(null, { status: 200 }), "PATCH"), null);
  assert.equal(await parseAzureJsonResponse(new Response(null, { status: 204 }), "PATCH"), null);
  assert.deepEqual(await parseAzureJsonResponse(new Response('{"ok":true}', { status: 200 }), "GET"), { ok: true });
  await assert.rejects(parseAzureJsonResponse(new Response("{", { status: 200 }), "GET"), /malformed JSON/);
});

test("application identity receives only Key Vault Secrets User and no evidence-key role", () => {
  assert.match(securityBicep, /resource identity .*userAssignedIdentities.* existing/);
  assert.match(securityBicep, /4633458b-17de-408a-b874-0445c86b69e6/);
  assert.equal((securityBicep.match(/principalId: identity\.properties\.principalId/g) ?? []).length, 2);
  const appRoleBlocks = ["newVaultSecretsUser", "existingVaultSecretsUser"].map((name) => {
    const start = securityBicep.indexOf(`resource ${name} `);
    return securityBicep.slice(start, securityBicep.indexOf("\n}\n", start) + 2);
  });
  assert.ok(appRoleBlocks.every((block) => block.includes("identity.properties.principalId")));
  assert.ok(appRoleBlocks.every((block) => !block.includes("keyVaultCryptoUserRoleDefinitionId")));
  assert.doesNotMatch(securityBicep, /Key Vault Administrator|Owner|Contributor/);
});

test("security module provisions three dedicated identities with one key-scoped signing role each", () => {
  const identityNames = {
    gate: "id-prostar-release-gate-prod",
    browser: "id-prostar-release-browser-prod",
    reviewer: "id-prostar-release-reviewer-prod",
  };
  for (const [kind, name] of Object.entries(identityNames)) {
    const parameter = `${kind}EvidenceSignerIdentityName`;
    assert.equal(securityParameters[parameter].value, name);
    assert.match(securityBicep, new RegExp(`param ${parameter} string`));
    assert.match(securityBicep, new RegExp(`name: ${parameter}`));
  }
  assert.doesNotMatch(securityBicep, /evidenceSignerPrincipalId|principalType: 'User'/);
  assert.match(securityBicep, /12338af0-0e69-4776-bea7-57ae8d297424/);
  assert.match(securityBicep, /acdd72a7-3385-48ef-bd42-f606fba81ae7/);
  assert.equal((securityBicep.match(/Microsoft\.KeyVault\/vaults\/keys@2023-07-01/g) ?? []).length, 6);
  for (const name of [
    "prostar-release-gate-evidence",
    "prostar-release-browser-evidence",
    "prostar-release-reviewer-evidence",
  ]) assert.match(securityBicep, new RegExp(`'${name}'`));
  assert.equal((securityBicep.match(/kty: 'RSA'/g) ?? []).length, 6);
  assert.equal((securityBicep.match(/keySize: 2048/g) ?? []).length, 6);
  assert.equal((securityBicep.match(/'sign'/g) ?? []).length, 6);
  assert.equal((securityBicep.match(/'verify'/g) ?? []).length, 6);
  assert.equal((securityBicep.match(/EvidenceSignerRole 'Microsoft\.Authorization\/roleAssignments@2022-04-01'/g) ?? []).length, 6);
  assert.equal((securityBicep.match(/scope: (?:new|existing)(?:Gate|Browser|Reviewer)EvidenceKey/g) ?? []).length, 6);
  assert.equal((securityBicep.match(/principalId: (?:gate|browser|reviewer)EvidenceSignerIdentity\.properties\.principalId/g) ?? []).length, 12);
  assert.equal((securityBicep.match(/EvidenceSignerReader 'Microsoft\.Authorization\/roleAssignments@2022-04-01'/g) ?? []).length, 3);
  assert.equal((securityBicep.match(/principalType: 'ServicePrincipal'/g) ?? []).length, 11);
  assert.equal((securityBicep.match(/scope: (?:new|existing)KeyVault/g) ?? []).length, 2);
  assert.match(securityBicep, /output evidenceSigningKeyIds object/);
  assert.match(securityBicep, /output evidenceSignerIdentities object/);
  assert.match(securityBicep, /keyUriWithVersion/);
});

test("security module owns exactly the DB, Simpro, EasyAuth, and optional CA secret definitions", () => {
  for (const name of [
    "azure-postgres-connection-string",
    "simpro-bearer-token",
    "microsoft-provider-authentication-secret",
    "postgres-ssl-ca-cert-base64",
  ]) {
    assert.equal(securityParameters[Object.keys(securityParameters).find((key) => securityParameters[key].value === name)].value, name);
  }
  assert.equal((securityBicep.match(/Microsoft\.KeyVault\/vaults\/secrets@/g) ?? []).length, 8);
  assert.match(securityBicep, /@secure\(\)[\s\S]*param azurePostgresConnectionString string = ''/);
  assert.match(securityBicep, /@secure\(\)[\s\S]*param simproBearerToken string = ''/);
  assert.match(securityBicep, /@secure\(\)[\s\S]*param microsoftProviderAuthenticationSecret string = ''/);
  assert.match(securityBicep, /@secure\(\)[\s\S]*param postgresSslCaCertBase64 string = ''/);
  const outputs = securityBicep.slice(securityBicep.indexOf("output keyVaultName"));
  assert.doesNotMatch(outputs, /azurePostgresConnectionString|simproBearerToken|microsoftProviderAuthenticationSecret|postgresSslCaCertBase64/);
});

test("metrics production contract uses versionless Key Vault references with the user identity", () => {
  assert.equal(metricsParameters.useKeyVaultSecretReferences.value, true);
  assert.equal(metricsParameters.keyVaultName.value, "kv-prostar-metrics-prod");
  assert.equal(metricsParameters.includePostgresSslCaCertSecret.value, false);
  assert.match(metricsBicep, /var keyVaultSecretBaseUrl = 'https:\/\/\$\{keyVaultName\}\$\{environment\(\)\.suffixes\.keyvaultDns\}\/secrets'/);
  assert.match(metricsBicep, /keyVaultUrl: '\$\{keyVaultSecretBaseUrl\}\/\$\{azurePostgresConnectionStringSecretName\}'\s*identity: identity\.id/);
  assert.match(metricsBicep, /keyVaultUrl: '\$\{keyVaultSecretBaseUrl\}\/\$\{simproBearerTokenSecretName\}'\s*identity: identity\.id/);
  assert.match(metricsBicep, /keyVaultUrl: '\$\{keyVaultSecretBaseUrl\}\/\$\{microsoftProviderAuthenticationSecretName\}'\s*identity: identity\.id/);
  assert.match(metricsBicep, /keyVaultUrl: '\$\{keyVaultSecretBaseUrl\}\/\$\{postgresSslCaCertBase64SecretName\}'\s*identity: identity\.id/);
  assert.equal((metricsBicep.match(/secrets: webSecrets/g) ?? []).length, 1);
  assert.equal((metricsBicep.match(/secrets: commonSecrets/g) ?? []).length, 6);
});
