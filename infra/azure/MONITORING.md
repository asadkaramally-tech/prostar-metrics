# Pro Star Metrics Azure Monitoring

`monitoring.bicep` is the source of truth for the WP-10 observability slice. It is a separate deployment because the web/jobs, PostgreSQL server, storage account, shared Container Apps environment, and shared Log Analytics workspace must already exist.

## Existing Workspace

The template imports `log-prostar-dispatch-prod`; it does not create or replace a Log Analytics workspace. Production discovery on 2026-07-09 confirmed:

- workspace customer ID `154bf9e9-1d9d-488e-b38a-7dabfb2b7497`;
- `cae-prostar-dispatch-prod` already uses `appLogsConfiguration.destination = log-analytics` for console and system logs;
- the environment has no VNet configuration.

The environment diagnostic setting adds `ContainerAppHTTPLogs` and `AllMetrics`. It deliberately does not duplicate console/system categories already sent by `appLogsConfiguration`. Web diagnostics add `AllMetrics`; each job adds the discovered `Basic` metric category. PostgreSQL sends operational/session/query-runtime/wait/PgBouncer logs and metrics. Storage sends account metrics plus Blob read/write/delete logs and metrics.

`longest_query_time_sec` is a supported enhanced metric, but PostgreSQL can leave its collector disabled. The production release script performs a real monitoring what-if and verifies the exact `prostar-payroll/pg-prostar-metrics-prod` target before reading `metrics.collector_database_activity`. It captures the prior value, sets only that dynamic parameter to `on`, reads it back before deploying monitoring, and restores the captured value if any later monitoring, build, migration, candidate-verification, or rollback operation fails. This collector control adds no other PostgreSQL parameter or network change; the existing privileged migration-only temporary firewall rule remains a separate bounded operation.

Enhanced metric activation can lag the dynamic parameter and alert deployment. After deploying the corrected monitoring template, the release script queries only `longest_query_time_sec` with `Maximum` aggregation and one-minute granularity over the trailing 30 minutes. It requires Azure API `Success`, exactly one matching metric, valid timeseries metadata/data arrays, and at least one bounded nonnegative sample. Structurally valid empty responses are polled every 30 seconds for at most 10 minutes; malformed responses, another metric, command/API errors, or timeout fail the release and trigger collector-value compensation. Successful availability evidence is written atomically under `docs/prostar-metrics/verification/monitoring/longest-query-metric-*.json` without SQL text, credentials, tokens, or other secret material.

The workspace-based Application Insights component is reserved for request, dependency, exception, and custom-event instrumentation. The current application-level operational signal uses structured JSON console events from `job-psm-operational-health`, which already land in `ContainerAppConsoleLogs_CL` through the environment's Log Analytics configuration.

## Alert Rules

| Signal | Rule |
| --- | --- |
| Web failures | `ContainerAppHTTPLogs` 5xx rate greater than 1 percent over 5 minutes |
| Web latency | Ingress request-duration p95 greater than 3,000 ms over 10 minutes |
| Job failures | Any `Executions` metric with `state = Failed` per Container Apps job over 15 minutes |
| PostgreSQL CPU | Average `cpu_percent` greater than 80 over 15 minutes |
| PostgreSQL memory | Average `memory_percent` greater than 80 over 15 minutes |
| PostgreSQL storage | Warning above 75 percent; critical above 85 percent over 15 minutes |
| PostgreSQL connections | Average `active_connections` above 70 percent of parameterized `max_connections` |
| PostgreSQL failures | Any `connections_failed` or `deadlocks` in 5 minutes |
| PostgreSQL availability | Critical when minimum `is_db_alive` is less than 1 in 5 minutes |
| PostgreSQL long query | Maximum supported `longest_query_time_sec` above the parameterized 60-second default in 15 minutes |
| PostgreSQL backup capacity | Maximum `backup_storage_used` above the parameterized 32 GiB default in 15 minutes |
| Export storage | Any selected failed `Transactions` response type in 5 minutes |
| App-owned operational health | Critical and warning structured events from the 15-minute data-health worker over 30 minutes |
| App-owned ingestion sequence | `ingestion-three-consecutive-failures` only when app telemetry reports `consecutiveFailures >= 3` |
| Dead letters | Critical on any app-emitted `deadLetterCount > 0`, evaluated every minute over 5 minutes |

The production parameter example sets `postgresMaxConnections` to the discovered server value of 50, so the active-connection threshold compiles to 35. It also sets the long-query threshold to 60 seconds and backup-capacity threshold to 32 GiB. Update the connection and backup-capacity parameters whenever the server setting or allocated storage changes.

The owner action group contains Asad and Laila. Their addresses are Bicep parameters, and email receivers use the Azure Monitor common alert schema. No webhook, API key, connection string, or other secret is stored in the template.

## App-Owned Operational Signal

`npm run telemetry:operational` obtains its health model through the same single bounded aggregate query as the owner Data Health drawer, then atomically claims any new durable sequence/dead-letter signals. It emits a summary event and one event per active alert with `event = prostar_metrics_operational_health`, severity, stable alert ID, queue/dead-letter totals, reconciliation/freshness detail, and backfill progress. Separate warning and critical scheduled-query rules notify the owner action group. This covers complete-source freshness state, queue age, dead letters, failed work, reconciliation drift, suspect/stale pages, and historical-backfill incompleteness without performing any Simpro request.

The native Container Apps metric rule remains deliberately conservative: one failed execution for any of the 24 jobs alerts. It does not claim that three logical ingestion attempts failed consecutively. That sequence belongs to application state and must be emitted by `job-psm-operational-health` only after durable ingestion history proves three adjacent failed attempts for the same source family, with no intervening success:

```json
{
  "event": "prostar_metrics_operational_health",
  "severity": "critical",
  "alertId": "ingestion-three-consecutive-failures",
  "eventKey": "<durable-threshold-crossing-key>",
  "sourceFamily": "<stable-source-family>",
  "consecutiveFailures": 3,
  "deadLetterCount": 0,
  "evidenceKind": "ingestion_run",
  "evidenceId": "<durable-run-id>",
  "occurredAt": "<UTC-ISO8601>"
}
```

The scheduled-query rule tests the exact typed producer contract: critical severity, exact alert ID, `evidenceKind = ingestion_run`, `consecutiveFailures >= 3`, zero dead letters, and nonempty durable identity/timestamp fields. It does not reconstruct a sequence from Azure execution metrics. A durable emission ledger deduplicates each failure-threshold crossing and each dead-letter episode across workers. The one-minute dead-letter rule accepts only critical `alertId = dead-letter-immediate`, job/backfill evidence kinds, `consecutiveFailures = 0`, `deadLetterCount > 0`, and nonempty durable fields.

The generic critical rule excludes only `alertId = dead-letter-immediate`, because that signal has an immediate dedicated rule. It does not filter globally on `deadLetterCount` and does not exclude the ingestion-sequence ID. `tests/infra/monitoring.test.mjs` executes the shared TypeScript producer and verifies its serialized JSON fields against both scheduled-query contracts.

## Remaining Telemetry Gaps

The following outcomes still need dedicated release/export instrumentation before corresponding rules can be added without false confidence:

- authenticated-route release-smoke failures;
- export/run total mismatch, export generation failure before Blob I/O, and calculation-run mismatch;
- application exception, dependency, and route-level latency attribution inside the container.

The supported PostgreSQL platform metrics now cover server liveness, longest query duration, and backup-storage capacity. The restore drill itself is evidenced separately by `scripts/restore-postgres-drill.mjs`; no alert rule manufactures or performs a restore. Diagnostics still avoid SQL-text logging because it can capture sensitive statement content.

## Validate And Review

Compilation and static checks:

```bash
az bicep build --file infra/azure/monitoring.bicep --stdout >/dev/null
az bicep build --file infra/azure/metrics.bicep --stdout >/dev/null
az bicep build --file infra/azure/postgres.bicep --stdout >/dev/null
az bicep build --file infra/azure/security.bicep --stdout >/dev/null
npm run test:infra
```

Read-only production review:

```bash
AZURE_CONFIG_DIR="/Users/asadkaramally/Documents/New project/.work/azure" \
az deployment group what-if \
  --resource-group prostar-payroll \
  --name prostar-metrics-monitoring-review \
  --template-file infra/azure/monitoring.bicep \
  --parameters infra/azure/monitoring.parameters.prod.example.json \
  --no-pretty-print
```

Do not change `what-if` to `create` until the owner recipients, expected resource changes, log ingestion/privacy implications, and alert cost have been reviewed. `ContainerAppHTTPLogs` can include paths/query strings and forwarded client IP addresses; keep access to the shared workspace restricted.

## Live Configuration Validation

These commands confirm the deployed rule shape, collector state, supported PostgreSQL metric definitions, and recent operational event fields without producing failures:

```bash
RESOURCE_GROUP="prostar-payroll"
POSTGRES_ID="$(az postgres flexible-server show -g "$RESOURCE_GROUP" -n pg-prostar-metrics-prod --query id -o tsv)"
WORKSPACE_ID="$(az monitor log-analytics workspace show -g "$RESOURCE_GROUP" -n log-prostar-dispatch-prod --query customerId -o tsv)"

az postgres flexible-server parameter show \
  --resource-group "$RESOURCE_GROUP" \
  --server-name pg-prostar-metrics-prod \
  --name metrics.collector_database_activity \
  --query "{name:name,value:value,source:source}" -o table

# Only after explicit database-configuration approval, and only when the read above is not "on":
az postgres flexible-server parameter set \
  --resource-group "$RESOURCE_GROUP" \
  --server-name pg-prostar-metrics-prod \
  --name metrics.collector_database_activity \
  --value on \
  --output none

# Fail closed unless the live value is now exactly "on".
az postgres flexible-server parameter show \
  --resource-group "$RESOURCE_GROUP" \
  --server-name pg-prostar-metrics-prod \
  --name metrics.collector_database_activity \
  --query value -o tsv

az monitor metrics list-definitions --resource "$POSTGRES_ID" \
  --query "[?contains(['longest_query_time_sec','is_db_alive','backup_storage_used'], name.value)].{metric:name.value,unit:unit}" \
  -o table

az monitor metrics list --resource "$POSTGRES_ID" \
  --metrics longest_query_time_sec \
  --aggregation Maximum \
  --interval 1m \
  --start-time "<UTC timestamp 30 minutes ago>" \
  --end-time "<current UTC timestamp>" \
  --output json

# Confirm the enabled collector is producing live longest-query metric samples.
az monitor metrics list --resource "$POSTGRES_ID" \
  --metric longest_query_time_sec \
  --interval PT5M \
  --aggregation Maximum \
  --query "value[0].timeseries[].data[?maximum != null]" -o json

az monitor metrics alert list -g "$RESOURCE_GROUP" \
  --query "[?contains(name, 'prostar-metrics')].{name:name,enabled:enabled,severity:severity}" -o table

az monitor scheduled-query list -g "$RESOURCE_GROUP" \
  --query "[?contains(name, 'prostar-metrics')].{name:name,enabled:properties.enabled,severity:properties.severity}" -o table

az monitor log-analytics query --workspace "$WORKSPACE_ID" --analytics-query "
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(24h) and ContainerJobName_s =~ 'job-psm-operational-health'
| extend Payload=parse_json(Log_s)
| where tostring(Payload.event) == 'prostar_metrics_operational_health'
| project TimeGenerated, AlertId=tostring(Payload.alertId), ConsecutiveFailures=toint(Payload.consecutiveFailures), DeadLetters=tolong(Payload.deadLetterCount)
| take 50"
```

## Test Notification

After deployment approval, exercise the owner action-group delivery path with Azure Monitor's synthetic test notification. This does not change an alert threshold, stop PostgreSQL, run a job, create a dead letter, or manufacture any production failure:

```bash
az monitor action-group test-notifications create \
  --resource-group prostar-payroll \
  --action-group ag-prostar-metrics-owners \
  --alert-type logalertv2 \
  --output none
```

The release worker must read the Azure CLI action-group object at its root shape and require exactly `Asad` and `Laila`. For each root-level receiver whose status is `Disabled`, it must use this exact command shape:

```bash
az monitor action-group enable-receiver \
  --resource-group prostar-payroll \
  --action-group-name ag-prostar-metrics-owners \
  --receiver-name "<Asad-or-Laila>" \
  --output none
```

It must read the root shape again, fail unless exactly Asad and Laila are `Enabled`, send the synthetic test above, and atomically record request acceptance. `scripts/deploy-prod.mjs` currently contains that integration; it must be retained by the release owner. Its evidence under `docs/prostar-metrics/verification/monitoring/` explicitly records `inboxDeliveryVerified: false`; Azure request acceptance is not proof of recipient delivery.

`scripts/deploy-prod.mjs` enforces the exact-server what-if gate, the approved `metrics.collector_database_activity=on` set/read-back, prior-value compensation if a later release step fails, and the fail-closed live `longest_query_time_sec` query shown above. After enablement it polls over a bounded recent interval until Azure returns the exact metric/timeseries schema with a finite sample, or fails the deployment and compensates the prior parameter value on timeout. Do not test either path by lowering a production rule, terminating a database connection, failing a Container Job, or inserting dead-letter state.
