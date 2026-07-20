import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [dockerfile, metricsBicep] = await Promise.all([
  readFile(new URL("../../Dockerfile", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/metrics.bicep", import.meta.url), "utf8"),
]);

test("production image binds Next.js to every container interface", () => {
  assert.match(
    dockerfile,
    /^ENV HOSTNAME=0\.0\.0\.0$/m,
    "Dockerfile must set HOSTNAME=0.0.0.0 in the production image",
  );
});

test("Container Apps web container explicitly binds to every interface", () => {
  assert.match(
    metricsBicep,
    /var webEnv = concat\(sharedEnv, \[\s*{\s*name: 'POSTGRES_POOL_MAX'\s*value: '10'\s*}\s*{\s*name: 'HOSTNAME'\s*value: '0\.0\.0\.0'\s*}\s*]\)/,
    "metrics.bicep must append HOSTNAME=0.0.0.0 to the web environment",
  );

  const webAppStart = metricsBicep.indexOf("resource webApp ");
  const ingestionJobStart = metricsBicep.indexOf("resource ingestionJob ");
  assert.notEqual(webAppStart, -1, "metrics.bicep must define the web Container App");
  assert.ok(
    ingestionJobStart > webAppStart,
    "metrics.bicep web Container App block could not be isolated",
  );

  const webApp = metricsBicep.slice(webAppStart, ingestionJobStart);
  assert.match(
    webApp,
    /\benv: webEnv\b/,
    "the web container must consume the HOSTNAME-enabled web environment",
  );
  assert.doesNotMatch(
    webApp,
    /\benv: commonEnv\b/,
    "the web container must not bypass the HOSTNAME-enabled web environment",
  );
});

test("web and worker database pools use explicit bounded limits", () => {
  assert.match(
    metricsBicep,
    /name: 'POSTGRES_POOL_IDLE_TIMEOUT_MS'\s*value: '30000'/,
    "all containers must use the locked 30-second idle timeout",
  );
  assert.match(
    metricsBicep,
    /name: 'POSTGRES_CONNECTION_TIMEOUT_MS'\s*value: '60000'/,
    "all containers must use the locked 60-second connection timeout",
  );
  assert.match(
    metricsBicep,
    /var commonEnv = concat\(sharedEnv, \[\s*{\s*name: 'POSTGRES_POOL_MAX'\s*value: '1'\s*}\s*]\)/,
    "worker containers must be capped at one PostgreSQL connection",
  );
  assert.match(
    metricsBicep,
    /var webEnv = concat\(sharedEnv, \[\s*{\s*name: 'POSTGRES_POOL_MAX'\s*value: '10'/,
    "the web container must use the locked ten-connection ceiling",
  );
});
