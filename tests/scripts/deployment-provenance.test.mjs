import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  acquireProductionAccessToken,
  canonicalTargetContract,
  canonicalAuthContract,
  collectLiveHttpVerification,
  computeDockerBuildContext,
  defaultAuthenticatedIdentityVerifier,
  validateLiveAcrRepositoryBinding,
  validateLiveVerificationMatch,
  verifyAzureDeploymentLive,
  verifyUnauthenticatedProtection,
  withImmutableDockerBuildContext,
  writeDeploymentManifestAtomic,
} from "../../scripts/lib/deployment-provenance.mjs";
import { createReleaseFixture } from "./release-evidence-fixture.mjs";

const productionUrl = "https://metrics.example.test";
const aadClientId = "369bef95-48a6-45db-bad6-1e16278fa229";
const aadTenantId = "515fbfd7-12b1-4238-bb6c-f827588dd488";

function productionAuthContract() {
  return {
    platform: { enabled: true },
    globalValidation: {
      excludedPaths: ["/api/health"],
      redirectToProvider: "AzureActiveDirectory",
      unauthenticatedClientAction: "RedirectToLoginPage",
    },
    httpSettings: { requireHttps: true },
    identityProviders: {
      azureActiveDirectory: {
        registration: {
          clientId: aadClientId,
          clientSecretSettingName: "microsoft-provider-authentication-secret",
          openIdIssuer: `https://login.microsoftonline.com/${aadTenantId}/v2.0`,
        },
        validation: { allowedAudiences: [aadClientId, `api://${aadClientId}`] },
      },
    },
  };
}

function aadAuthorizeLocation(overrides = {}) {
  const url = new URL(`https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", aadClientId);
  url.searchParams.set("redirect_uri", `${productionUrl}/.auth/login/aad/callback`);
  url.searchParams.set("state", "redir=%2Fquotes");
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "origin") {
      const replacement = new URL(value);
      url.protocol = replacement.protocol;
      url.hostname = replacement.hostname;
    } else if (key === "pathname") url.pathname = value;
    else url.searchParams.set(key, value);
  }
  return url.href;
}

function response(status, location = null, payload = null) {
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === "location" ? location : null },
    json: async () => payload,
  };
}

function unauthenticatedFetch({ browserStatus = 302, browserLocation = aadAuthorizeLocation(), apiStatus = 401, apiLocation = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return options.headers.accept === "text/html"
      ? response(browserStatus, browserLocation)
      : response(apiStatus, apiLocation);
  };
  return { calls, fetchImpl };
}

test("canonical Docker context hashes deterministic paths and bytes while respecting dockerignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-context-sha-"));
  await writeAt(root, ".dockerignore", "node_modules\n*.log\ndocs/prostar-metrics/verification\n");
  await writeAt(root, "Dockerfile", "FROM scratch\nCOPY . /app\n");
  await writeAt(root, "src/z.txt", "z\n");
  await writeAt(root, "src/a.txt", "a\n");
  await writeAt(root, "node_modules/dependency/index.js", "ignored-one\n");
  await writeAt(root, "debug.log", "ignored-log-one\n");
  await writeAt(root, "docs/prostar-metrics/verification/evidence.json", "ignored-evidence-one\n");

  const first = await computeDockerBuildContext(root);
  assert.deepEqual(
    first.entries.map((entry) => entry.path),
    [...first.entries.map((entry) => entry.path)].sort(),
  );
  assert.ok(first.entries.some((entry) => entry.path === ".dockerignore"));
  assert.ok(first.entries.some((entry) => entry.path === "Dockerfile"));
  assert.ok(first.entries.some((entry) => entry.path === "src/a.txt"));
  assert.ok(!first.entries.some((entry) => entry.path.startsWith("node_modules")));
  assert.ok(!first.entries.some((entry) => entry.path.includes("verification")));

  await writeAt(root, "node_modules/dependency/index.js", "ignored-two\n");
  await writeAt(root, "debug.log", "ignored-log-two\n");
  await writeAt(root, "docs/prostar-metrics/verification/evidence.json", "ignored-evidence-two\n");
  assert.equal((await computeDockerBuildContext(root)).sha256, first.sha256);

  await writeAt(root, "src/a.txt", "changed source\n");
  assert.notEqual((await computeDockerBuildContext(root)).sha256, first.sha256);
});

test("canonical Docker context binds normalized modes and symlink targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-context-metadata-"));
  await writeAt(root, ".dockerignore", "node_modules\n");
  await writeAt(root, "Dockerfile", "FROM scratch\nCOPY . /app\n");
  await writeAt(root, "target-a.txt", "same bytes\n");
  await writeAt(root, "target-b.txt", "same bytes\n");
  await symlink("target-a.txt", join(root, "current.txt"));
  const original = await computeDockerBuildContext(root);

  await chmod(join(root, "target-a.txt"), 0o755);
  assert.notEqual((await computeDockerBuildContext(root)).sha256, original.sha256);
  await chmod(join(root, "target-a.txt"), 0o644);
  await unlink(join(root, "current.txt"));
  await symlink("target-b.txt", join(root, "current.txt"));
  assert.notEqual((await computeDockerBuildContext(root)).sha256, original.sha256);
});

test("immutable Docker snapshot accepts an unchanged read-only build and rejects source byte or mode changes", async (t) => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "docker-context-immutable-"));
    await writeAt(root, ".dockerignore", "node_modules\n");
    await writeAt(root, "Dockerfile", "FROM scratch\nCOPY . /app\n");
    await writeAt(root, "src/index.js", "export const value = 1;\n");
    return root;
  }

  await t.test("unchanged", async () => {
    const root = await fixture();
    const result = await withImmutableDockerBuildContext({
      root,
      build: async ({ path, sha256 }) => {
        assert.equal(await readFile(join(path, "src/index.js"), "utf8"), "export const value = 1;\n");
        assert.equal((await lstat(join(path, "src/index.js"))).mode & 0o222, 0);
        return sha256;
      },
    });
    assert.equal(result.result, result.sha256);
  });

  await t.test("source bytes", async () => {
    const root = await fixture();
    await assert.rejects(withImmutableDockerBuildContext({
      root,
      build: async () => writeFile(join(root, "src/index.js"), "export const value = 2;\n"),
    }), /source tree during build/);
  });

  await t.test("source mode", async () => {
    const root = await fixture();
    await assert.rejects(withImmutableDockerBuildContext({
      root,
      build: async () => chmod(join(root, "src/index.js"), 0o755),
    }), /source tree during build/);
  });
});

test("deployment manifest writer replaces one complete JSON file atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "deployment-manifest-"));
  const manifest = { schemaVersion: 2, deployedRevision: "aca-prostar-metrics-prod--99" };
  const result = await writeDeploymentManifestAtomic({ root, manifest });
  const bytes = await readFile(join(root, result.path), "utf8");
  assert.deepEqual(JSON.parse(bytes), manifest);
  const siblings = await readdir(dirname(join(root, result.path)));
  assert.equal(siblings.some((name) => name.includes(".partial-")), false);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("live auth verification requires exact browser redirect and separate API denial", async () => {
  const { calls, fetchImpl } = unauthenticatedFetch();
  const evidence = await verifyUnauthenticatedProtection(fetchImpl, `${productionUrl}/quotes`);
  assert.equal(evidence.browser.status, 302);
  assert.equal(evidence.browser.authorizeEndpoint, `https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/authorize`);
  assert.equal(evidence.browser.clientId, aadClientId);
  assert.equal(evidence.browser.redirectUri, `${productionUrl}/.auth/login/aad/callback`);
  assert.equal(evidence.browser.stateRedirect, "/quotes");
  assert.deepEqual(evidence.api, { url: `${productionUrl}/quotes`, status: 401, location: null });
  assert.match(calls[0].options.headers["user-agent"], /Chrome/);
  assert.match(calls[1].options.headers["user-agent"], /Node\.js API client/);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[1].options.redirect, "manual");
});

test("live auth verification rejects every browser and API contract drift", async (t) => {
  const cases = [
    ["browser status", { browserStatus: 401 }],
    ["AAD host", { browserLocation: aadAuthorizeLocation({ origin: "https://evil.example" }) }],
    ["tenant authorize path", { browserLocation: aadAuthorizeLocation({ pathname: "/wrong/oauth2/v2.0/authorize" }) }],
    ["client ID", { browserLocation: aadAuthorizeLocation({ client_id: "wrong" }) }],
    ["callback", { browserLocation: aadAuthorizeLocation({ redirect_uri: `${productionUrl}/.auth/login/aad/not-callback` }) }],
    ["state redirect", { browserLocation: aadAuthorizeLocation({ state: "redir=%2Fadmin" }) }],
    ["API status", { apiStatus: 302 }],
    ["API Location", { apiLocation: "https://login.microsoftonline.com/" }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyUnauthenticatedProtection(unauthenticatedFetch(options).fetchImpl, `${productionUrl}/quotes`),
        /exact Easy Auth redirect|authorization contract|exact 401/,
      );
    });
  }
});

test("live Easy Auth metadata is canonical and exact", () => {
  const expected = canonicalAuthContract(productionAuthContract());
  assert.deepEqual(expected, {
    platformEnabled: true,
    unauthenticatedClientAction: "RedirectToLoginPage",
    excludedPaths: ["/api/health"],
    redirectToProvider: "AzureActiveDirectory",
    requireHttps: true,
    clientId: aadClientId,
    openIdIssuer: `https://login.microsoftonline.com/${aadTenantId}/v2.0`,
    clientSecretSettingName: "microsoft-provider-authentication-secret",
    allowedAudiences: [aadClientId, `api://${aadClientId}`].sort(),
  });
  const mutations = [
    (auth) => { auth.platform.enabled = false; },
    (auth) => { auth.globalValidation.redirectToProvider = "Google"; },
    (auth) => { auth.httpSettings.requireHttps = false; },
    (auth) => { auth.identityProviders.azureActiveDirectory.registration.clientId = "wrong"; },
    (auth) => { auth.identityProviders.azureActiveDirectory.registration.openIdIssuer = "https://login.microsoftonline.com/common/v2.0"; },
    (auth) => { auth.identityProviders.azureActiveDirectory.registration.clientSecretSettingName = "wrong"; },
    (auth) => { auth.identityProviders.azureActiveDirectory.validation.allowedAudiences = [aadClientId]; },
  ];
  for (const mutate of mutations) {
    const auth = productionAuthContract();
    mutate(auth);
    assert.throws(() => canonicalAuthContract(auth), /incomplete or drifted/);
  }
});

test("combined live verification keeps authenticated identity proof separate", async () => {
  const unauth = unauthenticatedFetch();
  const fetchImpl = async (url, options) => url.endsWith("/api/health")
    ? response(200, null, { ok: true, database: { connected: true } })
    : unauth.fetchImpl(url, options);
  let identityCalls = 0;
  const evidence = await collectLiveHttpVerification({
    productionUrl,
    auth: productionAuthContract(),
    fetchImpl,
    authenticatedIdentityVerifier: async () => {
      identityCalls += 1;
      return {
        authenticated: true,
        principalEmail: "asad@prostarmechanical.com",
        principalId: "owner-object-id",
        provider: "aad",
        verifiedAt: "2026-07-13T20:00:00.000Z",
        sessionReceiptSha256: "a".repeat(64),
      };
    },
  });
  assert.equal(identityCalls, 1);
  assert.equal(evidence.health.databaseConnected, true);
  assert.equal(evidence.unauthenticated.browser.status, 302);
  assert.equal(evidence.unauthenticated.api.status, 401);
  assert.equal(evidence.authenticatedIdentity.principalEmail, "asad@prostarmechanical.com");
});

test("live verifier matching ignores redirect nonce and verification time but rejects stable drift", async () => {
  async function capture(nonce, verifiedAt) {
    const location = aadAuthorizeLocation({ nonce, state: `redir=%2Fquotes&nonce=${nonce}` });
    const unauth = unauthenticatedFetch({ browserLocation: location });
    return collectLiveHttpVerification({
      productionUrl,
      auth: productionAuthContract(),
      fetchImpl: async (url, options) => url.endsWith("/api/health")
        ? response(200, null, { ok: true, database: { connected: true } })
        : unauth.fetchImpl(url, options),
      authenticatedIdentityVerifier: async () => ({
        authenticated: true,
        principalEmail: "asad@prostarmechanical.com",
        principalId: "owner-object-id",
        provider: "aad",
        verifiedAt,
        sessionReceiptSha256: "a".repeat(64),
      }),
    });
  }
  const recorded = await capture("recorded-nonce", "2026-07-13T20:00:00.000Z");
  const current = await capture("current-nonce", "2026-07-13T20:05:00.000Z");
  assert.notEqual(recorded.unauthenticated.browser.location, current.unauthenticated.browser.location);
  assert.notEqual(recorded.authenticatedIdentity.verifiedAt, current.authenticatedIdentity.verifiedAt);
  assert.equal(validateLiveVerificationMatch(current, recorded, {
    productionUrl,
    notBefore: "2026-07-13T19:59:00.000Z",
    now: new Date("2026-07-13T20:06:00.000Z"),
  }), true);

  const principalDrift = structuredClone(current);
  principalDrift.authenticatedIdentity.principalId = "different-owner-object-id";
  assert.throws(() => validateLiveVerificationMatch(principalDrift, recorded, {
    productionUrl,
    notBefore: "2026-07-13T19:59:00.000Z",
    now: new Date("2026-07-13T20:06:00.000Z"),
  }), /stable fields/);

  const redirectDrift = structuredClone(current);
  redirectDrift.unauthenticated.browser.clientId = "wrong";
  assert.throws(() => validateLiveVerificationMatch(redirectDrift, recorded, {
    productionUrl,
    notBefore: "2026-07-13T19:59:00.000Z",
    now: new Date("2026-07-13T20:06:00.000Z"),
  }), /protection evidence is invalid/);

  const future = structuredClone(current);
  future.authenticatedIdentity.verifiedAt = "2026-07-13T20:07:00.000Z";
  assert.throws(() => validateLiveVerificationMatch(future, recorded, {
    productionUrl,
    notBefore: "2026-07-13T19:59:00.000Z",
    now: new Date("2026-07-13T20:06:00.000Z"),
  }), /outside its deployment verification bounds/);
});

test("AAD token acquisition uses a strict child environment and exact production audience", () => {
  let invocation;
  const token = acquireProductionAccessToken({
    projectRoot: "/immutable/source",
    sourceEnvironment: {
      PATH: "/bin",
      HOME: "/home/release",
      AZURE_CONFIG_DIR: "/azure",
      AZURE_POSTGRES_MIGRATION_CONNECTION_STRING: "postgres-secret",
      PROSTAR_RELEASE_AUTH_SESSION_COOKIE: "browser-cookie",
      OTHER_TOKEN: "secret-token",
    },
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: JSON.stringify({ accessToken: "memory-only-token", tokenType: "Bearer" }) };
    },
  });
  assert.equal(token, "memory-only-token");
  assert.deepEqual(invocation.args, [
    "account", "get-access-token", "--resource", `api://${aadClientId}`, "--output", "json",
  ]);
  assert.equal(invocation.command, "az");
  assert.deepEqual(invocation.options.env, { AZURE_CONFIG_DIR: "/azure", HOME: "/home/release", PATH: "/bin" });
  assert.doesNotMatch(JSON.stringify(invocation), /postgres-secret|browser-cookie|secret-token/);
});

test("authenticated verifier uses bearer token once and stores only sanitized owner metadata", async () => {
  const secretToken = "ey-secret-production-token";
  let request;
  const receipt = await defaultAuthenticatedIdentityVerifier({
    productionUrl,
    accessTokenProvider: () => secretToken,
    now: () => new Date("2026-07-13T20:00:00.000Z"),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, null, {
        authenticated: true,
        principalEmail: "ASAD@PROSTARMECHANICAL.COM",
        principalId: "owner-object-id",
        provider: "aad",
      });
    },
  });
  assert.equal(request.url, `${productionUrl}/api/auth/session`);
  assert.equal(request.options.headers.authorization, `Bearer ${secretToken}`);
  assert.equal(request.options.headers.accept, "application/json");
  assert.equal(request.options.redirect, "manual");
  assert.deepEqual(receipt, {
    authenticated: true,
    principalEmail: "asad@prostarmechanical.com",
    principalId: "owner-object-id",
    provider: "aad",
    verifiedAt: "2026-07-13T20:00:00.000Z",
    sessionReceiptSha256: receipt.sessionReceiptSha256,
  });
  assert.match(receipt.sessionReceiptSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secretToken));
});

test("authenticated verifier rejects denied and malformed session responses without leaking its token", async (t) => {
  const secretToken = "must-never-appear-in-an-error";
  const cases = [
    ["401", 401, null],
    ["403", 403, null],
    ["non-object", 200, []],
    ["extra field", 200, { authenticated: true, principalEmail: "asad@prostarmechanical.com", principalId: "id", provider: "aad", token: "bad" }],
    ["nonowner", 200, { authenticated: true, principalEmail: "intruder@example.test", principalId: "id", provider: "aad" }],
    ["wrong provider", 200, { authenticated: true, principalEmail: "laila@prostarmechanical.com", principalId: "id", provider: "google" }],
    ["missing ID", 200, { authenticated: true, principalEmail: "laila@prostarmechanical.com", provider: "aad" }],
  ];
  for (const [name, status, payload] of cases) {
    await t.test(name, async () => {
      let error;
      try {
        await defaultAuthenticatedIdentityVerifier({
          productionUrl,
          accessTokenProvider: () => secretToken,
          fetchImpl: async () => response(status, null, payload),
        });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(secretToken));
    });
  }
});

test("live ACR verification binds the production repository tag and digest independently", () => {
  const imageTag = "deploy-0123456789abcdef-0193f1a0-1234-4abc-8def-0123456789ab";
  const digest = `sha256:${"d".repeat(64)}`;
  const valid = {
    registry: "acrprostardispatchprod",
    repository: "prostar-metrics",
    imageTag,
    digest,
    tagManifest: { digest, tags: [imageTag] },
    digestManifest: { digest },
  };
  assert.doesNotThrow(() => validateLiveAcrRepositoryBinding(valid));

  for (const [mutation, expectedError] of [
    [(value) => { value.tagManifest.digest = `sha256:${"e".repeat(64)}`; }, /immutable tag moved/],
    [(value) => { value.tagManifest.tags = ["different-tag"]; }, /exact deployment manifest tag/],
    [(value) => { value.digestManifest.digest = `sha256:${"e".repeat(64)}`; }, /digest lookup does not contain/],
    [(value) => { value.registry = "another-registry"; }, /production registry and repository/],
    [(value) => { value.repository = "another-repository"; }, /production registry and repository/],
  ]) {
    const changed = structuredClone(valid);
    mutation(changed);
    assert.throws(() => validateLiveAcrRepositoryBinding(changed), expectedError);
  }
});

test("injectable live Azure verifier cross-checks app, exact 24 jobs, build, ARM, keys, health, and auth", async (t) => {
  const fixture = await createReleaseFixture();
  t.after(() => fixture.cleanup());
  const { deployment } = fixture;
  const rawTargets = new Map(deployment.targets.map((target) => [target.name, azureResourceFromContract(target)]));
  for (const target of deployment.targets) {
    assert.deepEqual(canonicalTargetContract(rawTargets.get(target.name), target.kind), target);
  }
  const app = rawTargets.get(deployment.containerAppName);
  app.properties.latestRevisionName = deployment.deployedRevision;
  app.properties.latestReadyRevisionName = deployment.deployedRevision;
  const revision = {
    name: deployment.deployedRevision,
    properties: {
      active: true,
      healthState: "Healthy",
      provisioningState: "Provisioned",
      trafficWeight: 100,
      createdTime: deployment.revisionCreatedAt,
      template: { containers: [{ image: deployment.pinnedImage }] },
    },
  };
  const build = {
    status: "Succeeded",
    runId: deployment.acrBuild.runId,
    createTime: deployment.acrBuild.createdAt,
    outputImages: [{
      registry: `${deployment.registry}.azurecr.io`,
      repository: deployment.repository,
      tag: deployment.acrBuild.imageTag,
      digest: deployment.imageDigest,
    }],
  };
  const arm = {
    id: deployment.armDeployment.operationId,
    name: deployment.armDeployment.deploymentName,
    properties: {
      provisioningState: "Succeeded",
      correlationId: deployment.armDeployment.correlationId,
      timestamp: deployment.armDeployment.completedAt,
    },
  };
  const actualAuthorizeUrl = new URL(`https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/authorize`);
  actualAuthorizeUrl.searchParams.set("client_id", aadClientId);
  actualAuthorizeUrl.searchParams.set("redirect_uri", `${deployment.productionUrl}/.auth/login/aad/callback`);
  actualAuthorizeUrl.searchParams.set("state", "redir=%2Fquotes&nonce=new-live-nonce");
  actualAuthorizeUrl.searchParams.set("nonce", "new-live-nonce");
  const actualLocation = actualAuthorizeUrl.href;
  const unauth = unauthenticatedFetch({ browserLocation: actualLocation });
  const fetchImpl = async (url, options) => url.endsWith("/api/health")
    ? response(200, null, { ok: true, database: { connected: true } })
    : unauth.fetchImpl(url, options);
  const identityVerifier = async () => ({
    ...deployment.liveVerification.authenticatedIdentity,
    verifiedAt: "2026-07-13T18:41:00.000Z",
  });
  const verificationNow = () => new Date("2026-07-13T20:40:00.000Z");

  function azureReader({
    jobMutation,
    disabledKey,
    tagDigest = deployment.imageDigest,
    tagTags = [deployment.acrBuild.imageTag],
    digestDigest = deployment.imageDigest,
  } = {}) {
    const calls = [];
    return {
      calls,
      async runAzJson({ args }) {
        calls.push(args);
        if (args[0] === "containerapp" && args[1] === "show") return structuredClone(app);
        if (args[0] === "containerapp" && args[1] === "revision") return [structuredClone(revision)];
        if (args[0] === "containerapp" && args[1] === "auth") return productionAuthContract();
        if (args[0] === "containerapp" && args[1] === "job") {
          const name = args[args.indexOf("--name") + 1];
          const job = structuredClone(rawTargets.get(name));
          if (jobMutation && name === deployment.targets.find(({ kind }) => kind === "job").name) jobMutation(job);
          return job;
        }
        if (args[0] === "acr" && args[1] === "repository") {
          const image = args[args.indexOf("--image") + 1];
          if (image === `${deployment.repository}:${deployment.acrBuild.imageTag}`) {
            return { digest: tagDigest, tags: tagTags };
          }
          if (image === `${deployment.repository}@${deployment.imageDigest}`) {
            return { digest: digestDigest };
          }
        }
        if (args[0] === "acr" && args[1] === "task") return [structuredClone(build)];
        if (args[0] === "deployment") return structuredClone(arm);
        if (args[0] === "keyvault") {
          const keyId = args[args.indexOf("--id") + 1];
          return { key: { kid: keyId, kty: "RSA" }, attributes: { enabled: keyId !== disabledKey } };
        }
        throw new Error(`Unexpected Azure read: ${args.join(" ")}`);
      },
    };
  }

  const reader = azureReader();
  const live = await verifyAzureDeploymentLive({
    projectRoot: fixture.root,
    manifest: deployment,
    runAzJson: reader.runAzJson,
    fetchImpl,
    authenticatedIdentityVerifier: identityVerifier,
    now: verificationNow,
  });
  assert.equal(reader.calls.filter((args) => args[0] === "containerapp" && args[1] === "job").length, 24);
  assert.equal(reader.calls.filter((args) => args[0] === "keyvault").length, 3);
  assert.equal(reader.calls.filter((args) => args[0] === "acr" && args[1] === "repository").length, 2);
  assert.ok(reader.calls.some((args) => args.includes(`${deployment.repository}:${deployment.acrBuild.imageTag}`)));
  assert.ok(reader.calls.some((args) => args.includes(`${deployment.repository}@${deployment.imageDigest}`)));
  assert.equal(live.targets.length, 25);
  assert.deepEqual(live.liveVerification, deployment.liveVerification);
  assert.notEqual(actualLocation, deployment.liveVerification.unauthenticated.browser.location);

  const targetDrift = azureReader({ jobMutation: (job) => { job.tags.environment = "drifted"; } });
  await assert.rejects(verifyAzureDeploymentLive({
    projectRoot: fixture.root,
    manifest: deployment,
    runAzJson: targetDrift.runAzJson,
    fetchImpl,
    authenticatedIdentityVerifier: identityVerifier,
    now: verificationNow,
  }), /exact 24-job target contracts/);

  const keyDrift = azureReader({ disabledKey: deployment.evidenceSigningKeyIds.reviewer });
  await assert.rejects(verifyAzureDeploymentLive({
    projectRoot: fixture.root,
    manifest: deployment,
    runAzJson: keyDrift.runAzJson,
    fetchImpl,
    authenticatedIdentityVerifier: identityVerifier,
    now: verificationNow,
  }), /reviewer evidence signing key version is missing or disabled/);

  for (const [readerOptions, expectedError] of [
    [{ tagDigest: `sha256:${"e".repeat(64)}` }, /immutable tag moved/],
    [{ tagTags: ["another-tag"] }, /does not include the exact/],
    [{ digestDigest: `sha256:${"e".repeat(64)}` }, /digest lookup does not contain/],
  ]) {
    const acrDrift = azureReader(readerOptions);
    await assert.rejects(verifyAzureDeploymentLive({
      projectRoot: fixture.root,
      manifest: deployment,
      runAzJson: acrDrift.runAzJson,
      fetchImpl,
      authenticatedIdentityVerifier: identityVerifier,
      now: verificationNow,
    }), expectedError);
  }
});

test("production deploy hashes before ACR build and writes provenance only after final verification", async () => {
  const source = await readFile(new URL("../../scripts/deploy-prod.mjs", import.meta.url), "utf8");
  const snapshotIndex = source.indexOf("await withImmutableDockerBuildContext({");
  const releaseStart = source.indexOf("async function executeProductionRelease");
  const buildIndex = source.indexOf('"acr",\n      "build"', releaseStart);
  const snapshotArgumentIndex = source.indexOf("buildSnapshot.path", buildIndex);
  const buildBindingIndex = source.indexOf("readAndVerifyAcrBuild(buildResult, imageTag)", buildIndex);
  const finalStateIndex = source.indexOf("const finalRevision = await operations.currentRevision()");
  const finalDigestIndex = source.indexOf("const verifiedAcrBuild = await operations.verifyAcrBuild(acrBuild)");
  const liveVerificationIndex = source.indexOf("const liveVerification = await operations.verifyLive(fqdn)");
  const writeIndex = source.indexOf("await operations.writeManifest");
  assert.ok(snapshotIndex >= 0 && releaseStart >= 0 && buildIndex > releaseStart);
  assert.ok(snapshotArgumentIndex > buildIndex && buildBindingIndex > snapshotArgumentIndex);
  assert.ok(finalStateIndex >= 0);
  assert.ok(finalDigestIndex > finalStateIndex);
  assert.ok(liveVerificationIndex > finalDigestIndex && writeIndex > liveVerificationIndex);
  assert.doesNotMatch(source.slice(source.indexOf("const deploymentManifest ="), writeIndex), /connectionString|BearerToken|AuthenticationSecret/);
});

function azureResourceFromContract(contract) {
  const userAssignedIdentities = Object.fromEntries(
    contract.identity.userAssignedIdentityIds.map((id) => [id, {}]),
  );
  return {
    id: contract.resourceId,
    name: contract.name,
    type: contract.resourceType,
    location: contract.location,
    tags: structuredClone(contract.tags),
    identity: { type: contract.identity.type, userAssignedIdentities },
    properties: {
      ...(contract.kind === "app"
        ? { managedEnvironmentId: contract.environmentId }
        : { environmentId: contract.environmentId }),
      configuration: {
        activeRevisionsMode: contract.configuration.activeRevisionsMode,
        ingress: structuredClone(contract.configuration.ingress),
        triggerType: contract.configuration.triggerType,
        replicaTimeout: contract.configuration.replicaTimeout,
        replicaRetryLimit: contract.configuration.replicaRetryLimit,
        scheduleTriggerConfig: structuredClone(contract.configuration.scheduleTriggerConfig),
        manualTriggerConfig: structuredClone(contract.configuration.manualTriggerConfig),
        eventTriggerConfig: structuredClone(contract.configuration.eventTriggerConfig),
        registries: structuredClone(contract.configuration.registries),
        secrets: contract.configuration.secretReferences.map((secret) => ({ ...secret })),
      },
      template: structuredClone(contract.template),
    },
  };
}

async function writeAt(root, relativePath, value) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}
