import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [metricsBicep, postgresBicep] = await Promise.all([
  readFile(new URL("../../infra/azure/metrics.bicep", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/postgres.bicep", import.meta.url), "utf8"),
]);

test("PostgreSQL keeps 35-day PITR retention and storage autogrow", () => {
  assert.match(postgresBicep, /backupRetentionDays: 35/);
  assert.match(postgresBicep, /autoGrow: 'Enabled'/);
});

test("PostgreSQL IaC preserves public networking and does not manage firewall rules", () => {
  assert.match(postgresBicep, /publicNetworkAccess: 'Enabled'/);
  assert.doesNotMatch(postgresBicep, /flexibleServers\/firewallRules/);
  assert.doesNotMatch(postgresBicep, /applicationOutboundIp/);
});

test("commission exports keep the seven-year Blob lifecycle policy", () => {
  assert.match(metricsBicep, /name: 'retain-commission-exports-seven-years'/);
  assert.equal(
    [...metricsBicep.matchAll(/daysAfter(?:Modification|Creation)GreaterThan: 2555/g)].length,
    3,
    "base blobs, snapshots, and versions must each retain for 2,555 days",
  );
  assert.match(metricsBicep, /name: 'delete-orphaned-release-evidence-handoffs'/);
  assert.match(metricsBicep, /name: 'expire-release-evidence-replay-ledger'/);
  assert.match(metricsBicep, /resource exportStorageBlobContributor[\s\S]*?scope: commissionExportContainer/);
  assert.doesNotMatch(metricsBicep, /resource exportStorageBlobContributor[\s\S]*?scope: exportStorage\s/);
});

test("scheduled Container Apps job cadence remains locked", () => {
  assert.match(
    metricsBicep,
    /param ingestionCronExpression string = '0 \*\/6 \* \* \*'/,
  );
  assert.match(
    metricsBicep,
    /param reconciliationCronExpression string = '30 5 \* \* \*'/,
  );

  const scheduledJobs = Object.fromEntries(
    [...metricsBicep.matchAll(/name: '(job-psm-[^']+)'\s*cron: '([^']+)'/g)].map(
      ([, name, cron]) => [name, cron],
    ),
  );
  assert.deepEqual(scheduledJobs, {
    "job-psm-quote-logs": "*/15 * * * *",
    "job-psm-job-logs": "*/15 * * * *",
    "job-psm-schedule-logs": "*/15 * * * *",
    "job-psm-mobile-logs": "*/15 * * * *",
    "job-psm-candidate-drain": "2,17,32,47 * * * *",
    "job-psm-timesheets-hourly": "0 * * * *",
    "job-psm-ts-jobs-hourly": "5 * * * *",
    "job-psm-employees-daily": "0 * * * *",
    "job-psm-rollup-drain": "7,22,37,52 * * * *",
    "job-psm-backfill-hourly": "20,50 * * * *",
    "job-psm-operational-health": "10,25,40,55 * * * *",
    "job-psm-reconcile-trailing-24m": "0 8 * * *",
    "job-psm-reconcile-stable-history": "0 9 1 * *",
    "job-psm-commissions-nightly": "0 * * * *",
  });
  assert.doesNotMatch(metricsBicep, /job-psm-invoice|customer_invoice_logs|'--entity', 'invoices'/);
});

test("extended reconciliation and commission cadences are active worker jobs", () => {
  assert.doesNotMatch(metricsBicep, /requiredCadenceWorkerHooks/);
  assert.match(metricsBicep, /'--mode', 'trailing-24-months'/);
  assert.match(metricsBicep, /'--mode', 'older-stable-history'/);
  assert.equal([...metricsBicep.matchAll(/'--batch-months', '3'/g)].length, 2);
  assert.equal([...metricsBicep.matchAll(/'--runtime-minutes', '20'/g)].length, 2);
  assert.equal([...metricsBicep.matchAll(/'--request-budget', '1000'/g)].length, 2);
  assert.match(metricsBicep, /'--nightly-commissions', '--local-hour', '3', '--limit', '1'/);
});

test("current Jobs, Quotes, and nested candidates drain to the bounded worker maximum", () => {
  assert.match(
    metricsBicep,
    /name: 'job-psm-candidate-drain'[\s\S]*?'--drain-limit', '100'/,
  );
  assert.match(
    metricsBicep,
    /'--entity'\s*'quotes'[\s\S]*?'--drain-limit'\s*'100'/,
  );
  assert.match(
    metricsBicep,
    /'--entity'\s*'jobs'[\s\S]*?'--drain-limit'\s*'100'/,
  );
});
