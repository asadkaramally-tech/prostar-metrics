import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [metricsBicep, parametersText, releases, readme] = await Promise.all([
  readFile(new URL("../../infra/azure/metrics.bicep", import.meta.url), "utf8"),
  readFile(
    new URL("../../infra/azure/main.parameters.prod.example.json", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../../infra/azure/RELEASES.md", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/README.md", import.meta.url), "utf8"),
]);
const parameters = JSON.parse(parametersText);

test("routine deployments preserve Single revision mode with explicit canary opt-in", () => {
  assert.match(
    metricsBicep,
    /@allowed\(\[\s*'Single'\s*'Multiple'\s*]\)\s*param activeRevisionsMode string = 'Single'/,
  );
  assert.match(metricsBicep, /activeRevisionsMode: activeRevisionsMode/);
  assert.doesNotMatch(metricsBicep, /activeRevisionsMode: 'Single'/);
  assert.equal(parameters.parameters.activeRevisionsMode.value, "Single");
});

test("deployment documentation exposes only the guarded production orchestrator", () => {
  const deploymentDocs = `${readme}\n${releases}`;
  assert.match(readme, /npm run deploy:prod/);
  assert.match(releases, /npm run deploy:prod/);
  assert.match(releases, /No manual canary deployment is authorized/);
  assert.doesNotMatch(deploymentDocs, /prostar-metrics:latest/i);
  assert.doesNotMatch(deploymentDocs, /az\s+acr\s+build/i);
  assert.doesNotMatch(deploymentDocs, /az\s+deployment\s+group\s+(?:create|what-if)/i);
  assert.doesNotMatch(deploymentDocs, /az\s+containerapp\s+(?:update|revision\s+set-mode|ingress\s+traffic\s+set|revision\s+label\s+add)/i);
  assert.doesNotMatch(deploymentDocs, /--template-file\s+infra\/azure\/metrics\.bicep/i);
});

test("web container defines conservative HTTP health probes", () => {
  const webStart = metricsBicep.indexOf("resource webApp ");
  const jobsStart = metricsBicep.indexOf("resource ingestionJob ");
  const webApp = metricsBicep.slice(webStart, jobsStart);
  assert.notEqual(webStart, -1);
  assert.ok(jobsStart > webStart);
  assert.equal((webApp.match(/path: '\/api\/health'/g) ?? []).length, 3);
  assert.equal((webApp.match(/port: targetPort/g) ?? []).length, 3);
  assert.equal((webApp.match(/scheme: 'HTTP'/g) ?? []).length, 3);

  const expectations = [
    {
      type: "Startup",
      initialDelay: 5,
      period: 10,
      timeout: 5,
      failures: 30,
    },
    {
      type: "Readiness",
      initialDelay: 10,
      period: 10,
      timeout: 5,
      failures: 12,
    },
    {
      type: "Liveness",
      initialDelay: 60,
      period: 30,
      timeout: 5,
      failures: 10,
    },
  ];

  for (const expectation of expectations) {
    const start = webApp.indexOf(`type: '${expectation.type}'`);
    assert.notEqual(start, -1, `${expectation.type} probe is missing`);
    const next = webApp.indexOf("\n            {", start + 1);
    const probe = webApp.slice(start, next === -1 ? undefined : next);
    assert.match(probe, /path: '\/api\/health'/);
    assert.match(probe, /port: targetPort/);
    assert.match(probe, new RegExp(`initialDelaySeconds: ${expectation.initialDelay}`));
    assert.match(probe, new RegExp(`periodSeconds: ${expectation.period}`));
    assert.match(probe, new RegExp(`timeoutSeconds: ${expectation.timeout}`));
    assert.match(probe, new RegExp(`failureThreshold: ${expectation.failures}`));
    assert.match(probe, /successThreshold: 1/);
  }
});
