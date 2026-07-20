import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const azureDirectory = fileURLToPath(new URL("../../infra/azure/", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const [monitoringBicep, metricsBicep, monitoringParametersText, operationalTelemetryWorker, operationalTelemetryProducer] = await Promise.all([
  readFile(new URL("../../infra/azure/monitoring.bicep", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/metrics.bicep", import.meta.url), "utf8"),
  readFile(
    new URL("../../infra/azure/monitoring.parameters.prod.example.json", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../../workers/emit-operational-telemetry.ts", import.meta.url), "utf8"),
  readFile(new URL("../../src/lib/store/operational-telemetry.ts", import.meta.url), "utf8"),
]);
const monitoringParameters = JSON.parse(monitoringParametersText);

test("all Azure Bicep entry points compile to ARM JSON", (t) => {
  const probe = spawnSync("az", ["bicep", "version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    t.skip("Azure CLI is not installed");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);

  for (const file of ["metrics.bicep", "monitoring.bicep", "postgres.bicep", "security.bicep", "evidence-runners.bicep"]) {
    const result = spawnSync(
      "az",
      ["bicep", "build", "--file", `${azureDirectory}${file}`, "--stdout"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${file} failed to compile:\n${result.stderr}`);
    const template = JSON.parse(result.stdout);
    assert.equal(template.$schema.includes("deploymentTemplate.json"), true);
  }
});

test("monitoring imports the shared workspace and links Application Insights", () => {
  const workspaceDeclarations = monitoringBicep.match(
    /resource\s+\w+\s+'Microsoft\.OperationalInsights\/workspaces@[^']+'[^\n]*/g,
  );
  assert.deepEqual(workspaceDeclarations?.length, 1);
  assert.match(workspaceDeclarations[0], /\bexisting\s*=\s*\{$/);
  assert.match(monitoringBicep, /WorkspaceResourceId: logAnalyticsWorkspace\.id/);
  assert.equal(
    monitoringParameters.parameters.logAnalyticsWorkspaceName.value,
    "log-prostar-dispatch-prod",
  );
});

test("owner action group receives parameterized Asad and Laila addresses", () => {
  assert.doesNotMatch(monitoringBicep, /@prostarmechanical\.com/i);
  assert.match(monitoringBicep, /name: 'Asad'\s*emailAddress: asadOwnerEmail/);
  assert.match(monitoringBicep, /name: 'Laila'\s*emailAddress: lailaOwnerEmail/);
  assert.equal(
    monitoringParameters.parameters.asadOwnerEmail.value,
    "asad@prostarmechanical.com",
  );
  assert.equal(
    monitoringParameters.parameters.lailaOwnerEmail.value,
    "laila@prostarmechanical.com",
  );
});

test("diagnostic settings use discovered provider categories", () => {
  for (const category of [
    "ContainerAppHTTPLogs",
    "AllMetrics",
    "Basic",
    "PostgreSQLLogs",
    "PostgreSQLFlexSessions",
    "PostgreSQLFlexQueryStoreRuntime",
    "PostgreSQLFlexQueryStoreWaitStats",
    "PostgreSQLFlexPGBouncer",
    "Capacity",
    "Transaction",
    "StorageRead",
    "StorageWrite",
    "StorageDelete",
  ]) {
    assert.match(monitoringBicep, new RegExp(`category: '${category}'`));
  }

  assert.match(monitoringBicep, /scope: containerAppsEnvironment/);
  assert.match(monitoringBicep, /scope: webApp/);
  assert.match(monitoringBicep, /scope: containerAppsJobs\[index\]/);
  assert.match(monitoringBicep, /scope: postgresServer/);
  assert.match(monitoringBicep, /scope: exportStorage/);
  assert.match(monitoringBicep, /scope: exportBlobService/);
});

test("alerts implement locked web, job, database, and storage signals", () => {
  assert.match(monitoringBicep, /FailureRatePercent > \{1\}[\s\S]*containerAppName, webHttp5xxRatePercentThreshold\)/);
  assert.match(monitoringBicep, /percentile\(RequestDuration, 95\)/);
  assert.match(monitoringBicep, /param webP95LatencyMsThreshold int = 3000/);
  assert.match(monitoringBicep, /metricName: 'Executions'/);
  assert.match(monitoringBicep, /name: 'state'[\s\S]*?'Failed'/);

  for (const metricName of [
    "cpu_percent",
    "memory_percent",
    "storage_percent",
    "active_connections",
    "connections_failed",
    "deadlocks",
    "longest_query_time_sec",
    "is_db_alive",
    "backup_storage_used",
  ]) {
    assert.match(monitoringBicep, new RegExp(`metricName: '${metricName}'`));
  }

  assert.match(
    monitoringBicep,
    /var postgresActiveConnectionsThreshold = \(postgresMaxConnections \* 70\) \/ 100/,
  );
  assert.match(monitoringBicep, /metricName: 'Transactions'/);
  assert.match(monitoringBicep, /name: 'ResponseType'/);
  assert.match(monitoringBicep, /ContainerJobName_s =~ 'job-psm-operational-health'/);
  assert.match(monitoringBicep, /tostring\(Payload\.severity\) == 'critical'/);
  assert.match(monitoringBicep, /tostring\(Payload\.severity\) == 'warning'/);
  assert.match(monitoringBicep, /metricName: 'longest_query_time_sec'[\s\S]*threshold: postgresLongestQuerySecondsThreshold/);
  assert.match(monitoringBicep, /metricName: 'is_db_alive'[\s\S]*operator: 'LessThan'[\s\S]*threshold: 1[\s\S]*severity: 0/);
  assert.match(monitoringBicep, /metricName: 'backup_storage_used'[\s\S]*threshold: postgresBackupStorageUsedBytesThreshold/);
  assert.equal(monitoringParameters.parameters.postgresLongestQuerySecondsThreshold.value, 60);
  assert.equal(monitoringParameters.parameters.postgresBackupStorageUsedGiBThreshold.value, 32);
  assert.equal([...monitoringBicep.matchAll(/windowSize: 'PT30M'/g)].length, 3);
  assert.doesNotMatch(monitoringBicep, /windowSize: 'PT20M'/);
});

test("operational alerts keep platform failures conservative and app sequence semantics explicit", () => {
  const jobFailureStart = monitoringBicep.indexOf("resource jobFailureAlerts ");
  const postgresStart = monitoringBicep.indexOf("resource postgresMetricAlerts ");
  const jobFailureRule = monitoringBicep.slice(jobFailureStart, postgresStart);
  assert.match(jobFailureRule, /metricName: 'Executions'/);
  assert.match(jobFailureRule, /values: \[\s*'Failed'/);
  assert.match(jobFailureRule, /threshold: 0/);

  const sequenceStart = monitoringBicep.indexOf("resource operationalIngestionConsecutiveFailuresAlert ");
  const deadLetterStart = monitoringBicep.indexOf("resource operationalDeadLetterImmediateAlert ");
  const warningStart = monitoringBicep.indexOf("resource operationalWarningAlert ");
  const criticalStart = monitoringBicep.indexOf("resource operationalCriticalAlert ");
  const sequenceRule = monitoringBicep.slice(sequenceStart, deadLetterStart);
  const deadLetterRule = monitoringBicep.slice(deadLetterStart, warningStart);
  const criticalRule = monitoringBicep.slice(criticalStart, sequenceStart);
  const warningRule = monitoringBicep.slice(
    warningStart,
    monitoringBicep.indexOf("resource jobFailureAlerts "),
  );

  assert.match(criticalRule, /alertId\) != 'dead-letter-immediate'/);
  assert.doesNotMatch(criticalRule, /Payload\.deadLetterCount/);
  assert.doesNotMatch(criticalRule, /alertId\) != 'ingestion-three-consecutive-failures'/);
  assert.match(sequenceRule, /alertId\) == 'ingestion-three-consecutive-failures'/);
  assert.match(sequenceRule, /evidenceKind\) == 'ingestion_run'/);
  assert.match(sequenceRule, /toint\(Payload\.consecutiveFailures\) >= 3/);
  assert.match(sequenceRule, /tolong\(Payload\.deadLetterCount\) == 0/);
  for (const field of ["sourceFamily", "evidenceId", "occurredAt"]) {
    assert.match(sequenceRule, new RegExp(`isnotempty\\(tostring\\(Payload\\.${field}\\)\\)`));
  }
  assert.match(sequenceRule, /threshold: 0/);
  assert.match(sequenceRule, /evaluationFrequency: 'PT5M'/);
  assert.match(deadLetterRule, /tolong\(Payload\.deadLetterCount\) > 0/);
  assert.match(deadLetterRule, /alertId\) == 'dead-letter-immediate'/);
  assert.match(deadLetterRule, /evidenceKind\) in \('ingestion_job', 'backfill_work_unit'\)/);
  assert.match(deadLetterRule, /toint\(Payload\.consecutiveFailures\) == 0/);
  assert.match(deadLetterRule, /evaluationFrequency: 'PT1M'/);
  assert.match(deadLetterRule, /windowSize: 'PT5M'/);
  assert.match(deadLetterRule, /severity: 0/);

  for (const [name, rule] of [
    ["critical", criticalRule],
    ["consecutive failure", sequenceRule],
    ["dead letter", deadLetterRule],
    ["warning", warningRule],
  ]) {
    const eventKeyIndex = rule.indexOf("extend EventKey = tostring(Payload.eventKey)");
    const nonemptyIndex = rule.indexOf("where isnotempty(EventKey)");
    const deduplicateIndex = rule.indexOf("summarize Payload = take_any(Payload) by EventKey");
    const aggregateIndex = rule.indexOf("summarize Signals = count()");
    assert.ok(eventKeyIndex >= 0, `${name} rule must project eventKey`);
    assert.ok(nonemptyIndex > eventKeyIndex, `${name} rule must reject missing eventKey`);
    assert.ok(deduplicateIndex > nonemptyIndex, `${name} rule must deduplicate eventKey`);
    assert.ok(aggregateIndex > deduplicateIndex, `${name} rule must deduplicate before counting`);
  }
  assert.equal(
    [...monitoringBicep.matchAll(/summarize Payload = take_any\(Payload\) by EventKey/g)].length,
    4,
  );

  assert.match(operationalTelemetryWorker, /claimOperationalTelemetrySignals/);
  assert.match(operationalTelemetryWorker, /emitClaimedOperationalTelemetrySignal\(signal, leaseOwner\)/);
  assert.match(operationalTelemetryWorker, /await writeOperationalTelemetryLine\(signal, options\.output\)/);
  assert.match(operationalTelemetryWorker, /acknowledgeOperationalTelemetrySignal/);
  const handoffIndex = operationalTelemetryWorker.indexOf("await writeOperationalTelemetryLine(signal, options.output)");
  const acknowledgeIndex = operationalTelemetryWorker.indexOf("await acknowledge(signal.eventKey, leaseOwner)");
  assert.ok(handoffIndex >= 0 && acknowledgeIndex > handoffIndex);
  assert.match(operationalTelemetryWorker, /eventKey: stableEventKey\("operational-summary"/);
  assert.match(operationalTelemetryWorker, /eventKey: stableEventKey\("data-health-alert"/);
  assert.match(operationalTelemetryWorker, /eventKey: stableEventKey\("telemetry-worker-failed"/);
  assert.match(operationalTelemetryWorker, /createHash\("sha256"\)/);
});

test("scheduled-query field contract matches serialized typed operational telemetry", () => {
  const evalSource = `
    import { claimOperationalTelemetrySignals } from './src/lib/store/operational-telemetry.ts';
    const rows = [
      {
        event_key: 'ingestion-failure-streak:jobs:42',
        event_name: 'ingestion-three-consecutive-failures',
        source_family: 'jobs',
        evidence_kind: 'ingestion_run',
        evidence_id: '42',
        occurred_at: '2026-07-13T20:00:00.000Z',
        metric_value: 3
      },
      {
        event_key: 'dead-letter:ingestion_job:7:2026-07-13T20:01:00.000Z',
        event_name: 'dead-letter-immediate',
        source_family: 'quotes',
        evidence_kind: 'ingestion_job',
        evidence_id: '7',
        occurred_at: '2026-07-13T20:01:00.000Z',
        metric_value: 1
      }
    ];
    const signals = await claimOperationalTelemetrySignals(async () => ({ rows }));
    process.stdout.write(JSON.stringify(signals));
  `;
  const result = spawnSync(process.execPath, [
    "--import", "tsx",
    "--input-type=module",
    "--eval", evalSource,
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const signals = JSON.parse(result.stdout);
  assert.deepEqual(signals, [
    {
      event: "prostar_metrics_operational_health",
      severity: "critical",
      alertId: "ingestion-three-consecutive-failures",
      eventKey: "ingestion-failure-streak:jobs:42",
      sourceFamily: "jobs",
      consecutiveFailures: 3,
      deadLetterCount: 0,
      evidenceKind: "ingestion_run",
      evidenceId: "42",
      occurredAt: "2026-07-13T20:00:00.000Z",
    },
    {
      event: "prostar_metrics_operational_health",
      severity: "critical",
      alertId: "dead-letter-immediate",
      eventKey: "dead-letter:ingestion_job:7:2026-07-13T20:01:00.000Z",
      sourceFamily: "quotes",
      consecutiveFailures: 0,
      deadLetterCount: 1,
      evidenceKind: "ingestion_job",
      evidenceId: "7",
      occurredAt: "2026-07-13T20:01:00.000Z",
    },
  ]);
  for (const field of [
    "event", "severity", "alertId", "eventKey", "sourceFamily",
    "consecutiveFailures", "deadLetterCount", "evidenceKind", "evidenceId", "occurredAt",
  ]) {
    assert.match(operationalTelemetryProducer, new RegExp(`\\b${field}\\b`));
  }
});

test("monitoring parameters cover every job declared by metrics.bicep", () => {
  const defaultJobParameterNames = [
    "ingestionJobName",
    "jobsIngestionJobName",
    "reconciliationJobName",
    "rollupRebuildJobName",
  ].map((parameterName) => {
    const match = metricsBicep.match(
      new RegExp(`param ${parameterName} string = '([^']+)'`),
    );
    assert.ok(match, `missing default value for ${parameterName}`);
    return match[1];
  });
  const deployedResourceSection = metricsBicep.slice(
    metricsBicep.indexOf("var manualIngestionJobs"),
  );
  const literalJobNames = [
    ...deployedResourceSection.matchAll(/\bname: '(job-[^']+)'/g),
  ].map((match) => match[1]);
  const deployedJobNames = [...new Set([...defaultJobParameterNames, ...literalJobNames])].sort();
  const monitoredJobNames = [
    ...monitoringParameters.parameters.containerAppsJobNames.value,
  ].sort();

  assert.equal(deployedJobNames.length, 23);
  assert.deepEqual(monitoredJobNames, deployedJobNames);
});
