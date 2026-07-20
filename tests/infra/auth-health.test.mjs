import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [metricsBicep, parametersText, deployScript] = await Promise.all([
  readFile(new URL("../../infra/azure/metrics.bicep", import.meta.url), "utf8"),
  readFile(
    new URL("../../infra/azure/main.parameters.prod.example.json", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../../scripts/deploy-prod.mjs", import.meta.url),
    "utf8",
  ),
]);
const parameters = JSON.parse(parametersText).parameters;

test("Easy Auth excludes exactly the public health endpoint", () => {
  const authStart = metricsBicep.indexOf("resource webAuth ");
  const ingestionStart = metricsBicep.indexOf("resource ingestionJob ");
  assert.notEqual(authStart, -1);
  assert.ok(ingestionStart > authStart);
  const auth = metricsBicep.slice(authStart, ingestionStart);

  assert.match(auth, /excludedPaths: \[\s*'\/api\/health'\s*]/);
  assert.doesNotMatch(auth, /excludedPaths: \[\s*''\s*]/);
  assert.equal((auth.match(/'\/api\/health'/g) ?? []).length, 1);
  assert.match(auth, /unauthenticatedClientAction: 'RedirectToLoginPage'/);
  assert.match(auth, /redirectToProvider: 'AzureActiveDirectory'/);
});

test("Easy Auth preserves the discovered AAD provider contract through parameters", () => {
  assert.match(metricsBicep, /clientId: microsoftProviderClientId/);
  assert.match(metricsBicep, /openIdIssuer: microsoftProviderOpenIdIssuer/);
  assert.match(metricsBicep, /allowedAudiences: microsoftProviderAllowedAudiences/);
  assert.match(
    metricsBicep,
    /clientSecretSettingName: secretNames\.microsoftProviderAuthenticationSecret/,
  );
  assert.match(metricsBicep, /convention: 'Standard'/);
  assert.match(metricsBicep, /requireHttps: true/);
  assert.match(metricsBicep, /preserveUrlFragmentsForLogins: false/);

  assert.equal(
    parameters.microsoftProviderClientId.value,
    "369bef95-48a6-45db-bad6-1e16278fa229",
  );
  assert.equal(
    parameters.microsoftProviderOpenIdIssuer.value,
    "https://login.microsoftonline.com/515fbfd7-12b1-4238-bb6c-f827588dd488/v2.0",
  );
  assert.deepEqual(parameters.microsoftProviderAllowedAudiences.value, [
    "369bef95-48a6-45db-bad6-1e16278fa229",
    "api://369bef95-48a6-45db-bad6-1e16278fa229",
  ]);
});

test("Easy Auth production deployments fail closed through a Key Vault reference", () => {
  assert.equal(parameters.useKeyVaultSecretReferences.value, true);
  assert.equal(parameters.microsoftProviderAuthenticationSecretName.value, "microsoft-provider-authentication-secret");
  assert.equal("microsoftProviderAuthenticationSecret" in parameters, false);
  assert.match(metricsBicep, /webAuthSecrets = metricsAuthMode != 'easy-auth' \? \[\] : useKeyVaultSecretReferences \?/);
  assert.match(metricsBicep, /keyVaultUrl: '\$\{keyVaultSecretBaseUrl\}\/\$\{microsoftProviderAuthenticationSecretName\}'/);
  assert.match(metricsBicep, /identity: identity\.id/);

  assert.doesNotMatch(deployScript, /MICROSOFT_PROVIDER_AUTHENTICATION_SECRET|microsoftProviderAuthenticationSecret=/);
  assert.match(deployScript, /validateKeyVaultReferenceSet/);
  assert.match(deployScript, /collectLiveHttpVerification/);
});
