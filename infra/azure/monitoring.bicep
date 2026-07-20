targetScope = 'resourceGroup'

@description('Azure region for regional monitoring resources and monitored targets.')
param location string = resourceGroup().location

@description('Environment suffix used in monitoring resource names and tags.')
param environmentName string = 'prod'

@description('Base workload name used in tags.')
param workloadName string = 'prostar-metrics'

@description('Subscription containing the existing Log Analytics workspace.')
param logAnalyticsSubscriptionId string = subscription().subscriptionId

@description('Resource group containing the existing Log Analytics workspace.')
param logAnalyticsResourceGroupName string = resourceGroup().name

@description('Existing Log Analytics workspace shared by Pro Star Container Apps.')
param logAnalyticsWorkspaceName string = 'log-prostar-dispatch-prod'

@description('Workspace-based Application Insights component for Pro Star Metrics custom telemetry.')
param applicationInsightsName string = 'appi-prostar-metrics-prod'

@description('Owner action group name.')
param ownerActionGroupName string = 'ag-prostar-metrics-owners'

@description('Email address for Asad in the owner action group.')
@minLength(3)
param asadOwnerEmail string

@description('Email address for Laila in the owner action group.')
@minLength(3)
param lailaOwnerEmail string

@description('Existing Container Apps environment shared with Pro Star apps.')
param containerAppsEnvironmentName string = 'cae-prostar-dispatch-prod'

@description('Metrics web Container App name.')
param containerAppName string = 'aca-prostar-metrics-prod'

@description('All Pro Star Metrics Container Apps job names. Keep synchronized with metrics.bicep.')
@minLength(1)
param containerAppsJobNames array

@description('Existing PostgreSQL Flexible Server name.')
param postgresServerName string = 'pg-prostar-metrics-prod'

@description('Configured PostgreSQL max_connections value. The connection alert is calculated at 70 percent of this value.')
@minValue(1)
param postgresMaxConnections int = 50

@description('Export storage account name.')
param exportStorageAccountName string = 'stprostarmetricsexports'

@description('Maximum allowed web HTTP 5xx percentage over five minutes.')
@minValue(0)
@maxValue(100)
param webHttp5xxRatePercentThreshold int = 1

@description('Maximum allowed web p95 request duration in milliseconds over ten minutes.')
@minValue(1)
param webP95LatencyMsThreshold int = 3000

@description('PostgreSQL CPU percentage alert threshold over 15 minutes.')
@minValue(1)
@maxValue(100)
param postgresCpuPercentThreshold int = 80

@description('PostgreSQL memory percentage alert threshold over 15 minutes.')
@minValue(1)
@maxValue(100)
param postgresMemoryPercentThreshold int = 80

@description('PostgreSQL storage warning threshold over 15 minutes.')
@minValue(1)
@maxValue(100)
param postgresStorageWarningPercentThreshold int = 75

@description('PostgreSQL storage critical threshold over 15 minutes.')
@minValue(1)
@maxValue(100)
param postgresStorageCriticalPercentThreshold int = 85

@description('Maximum supported PostgreSQL longest query duration in seconds over 15 minutes.')
@minValue(1)
param postgresLongestQuerySecondsThreshold int = 60

@description('PostgreSQL backup storage capacity threshold in GiB over 15 minutes.')
@minValue(1)
param postgresBackupStorageUsedGiBThreshold int = 32

var tags = {
  workload: workloadName
  environment: environmentName
  managedBy: 'bicep'
  component: 'observability'
}

var postgresActiveConnectionsThreshold = (postgresMaxConnections * 70) / 100
var postgresBackupStorageUsedBytesThreshold = postgresBackupStorageUsedGiBThreshold * 1073741824
var postgresFastMetricNames = [
  'connections_failed'
  'deadlocks'
  'is_db_alive'
]

var postgresMetricAlertDefinitions = [
  {
    suffix: 'cpu-high'
    description: 'PostgreSQL average CPU is above the locked 80 percent threshold for 15 minutes.'
    metricName: 'cpu_percent'
    timeAggregation: 'Average'
    operator: 'GreaterThan'
    threshold: postgresCpuPercentThreshold
    severity: 2
  }
  {
    suffix: 'memory-high'
    description: 'PostgreSQL average memory is above the configured threshold for 15 minutes.'
    metricName: 'memory_percent'
    timeAggregation: 'Average'
    operator: 'GreaterThan'
    threshold: postgresMemoryPercentThreshold
    severity: 2
  }
  {
    suffix: 'storage-warning'
    description: 'PostgreSQL storage is above the locked 75 percent warning threshold for 15 minutes.'
    metricName: 'storage_percent'
    timeAggregation: 'Average'
    operator: 'GreaterThan'
    threshold: postgresStorageWarningPercentThreshold
    severity: 2
  }
  {
    suffix: 'storage-critical'
    description: 'PostgreSQL storage is above the locked 85 percent critical threshold for 15 minutes.'
    metricName: 'storage_percent'
    timeAggregation: 'Average'
    operator: 'GreaterThan'
    threshold: postgresStorageCriticalPercentThreshold
    severity: 1
  }
  {
    suffix: 'connections-high'
    description: 'PostgreSQL active connections are above 70 percent of the configured maximum for 15 minutes.'
    metricName: 'active_connections'
    timeAggregation: 'Average'
    operator: 'GreaterThan'
    threshold: postgresActiveConnectionsThreshold
    severity: 2
  }
  {
    suffix: 'connections-failed'
    description: 'PostgreSQL reported one or more failed connections in five minutes.'
    metricName: 'connections_failed'
    timeAggregation: 'Total'
    operator: 'GreaterThan'
    threshold: 0
    severity: 2
  }
  {
    suffix: 'deadlocks'
    description: 'PostgreSQL reported one or more deadlocks in five minutes.'
    metricName: 'deadlocks'
    timeAggregation: 'Total'
    operator: 'GreaterThan'
    threshold: 0
    severity: 2
  }
  {
    suffix: 'longest-query'
    description: 'PostgreSQL longest_query_time_sec exceeded the configured duration over 15 minutes.'
    metricName: 'longest_query_time_sec'
    timeAggregation: 'Maximum'
    operator: 'GreaterThan'
    threshold: postgresLongestQuerySecondsThreshold
    severity: 2
  }
  {
    suffix: 'not-alive'
    description: 'PostgreSQL is_db_alive reported that the server was not alive.'
    metricName: 'is_db_alive'
    timeAggregation: 'Minimum'
    operator: 'LessThan'
    threshold: 1
    severity: 0
  }
  {
    suffix: 'backup-storage-capacity'
    description: 'PostgreSQL backup_storage_used exceeded the configured capacity threshold over 15 minutes.'
    metricName: 'backup_storage_used'
    timeAggregation: 'Maximum'
    operator: 'GreaterThan'
    threshold: postgresBackupStorageUsedBytesThreshold
    severity: 2
  }
]

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  scope: resourceGroup(logAnalyticsSubscriptionId, logAnalyticsResourceGroupName)
  name: logAnalyticsWorkspaceName
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    IngestionMode: 'LogAnalytics'
    WorkspaceResourceId: logAnalyticsWorkspace.id
  }
}

resource ownerActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: ownerActionGroupName
  location: 'Global'
  tags: tags
  properties: {
    groupShortName: 'PSM Owners'
    enabled: true
    emailReceivers: [
      {
        name: 'Asad'
        emailAddress: asadOwnerEmail
        useCommonAlertSchema: true
      }
      {
        name: 'Laila'
        emailAddress: lailaOwnerEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: containerAppsEnvironmentName
}

resource webApp 'Microsoft.App/containerApps@2023-05-01' existing = {
  name: containerAppName
}

resource containerAppsJobs 'Microsoft.App/jobs@2023-05-01' existing = [for jobName in containerAppsJobNames: {
  name: jobName
}]

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' existing = {
  name: postgresServerName
}

resource exportStorage 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: exportStorageAccountName
}

resource exportBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' existing = {
  parent: exportStorage
  name: 'default'
}

// The shared environment already routes console and system logs through appLogsConfiguration.
// This diagnostic setting adds HTTP logs and metrics without duplicating those existing streams.
resource containerAppsEnvironmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-prostar-metrics-environment'
  scope: containerAppsEnvironment
  properties: {
    workspaceId: logAnalyticsWorkspace.id
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'ContainerAppHTTPLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource webAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-prostar-metrics-web'
  scope: webApp
  properties: {
    workspaceId: logAnalyticsWorkspace.id
    logAnalyticsDestinationType: 'Dedicated'
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource jobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = [for (jobName, index) in containerAppsJobNames: {
  name: 'diag-${jobName}'
  scope: containerAppsJobs[index]
  properties: {
    workspaceId: logAnalyticsWorkspace.id
    logAnalyticsDestinationType: 'Dedicated'
    metrics: [
      {
        category: 'Basic'
        enabled: true
      }
    ]
  }
}]

resource postgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-prostar-metrics-postgres'
  scope: postgresServer
  properties: {
    workspaceId: logAnalyticsWorkspace.id
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'PostgreSQLLogs'
        enabled: true
      }
      {
        category: 'PostgreSQLFlexSessions'
        enabled: true
      }
      {
        category: 'PostgreSQLFlexQueryStoreRuntime'
        enabled: true
      }
      {
        category: 'PostgreSQLFlexQueryStoreWaitStats'
        enabled: true
      }
      {
        category: 'PostgreSQLFlexPGBouncer'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource exportStorageDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-prostar-metrics-storage'
  scope: exportStorage
  properties: {
    workspaceId: logAnalyticsWorkspace.id
    logAnalyticsDestinationType: 'Dedicated'
    metrics: [
      {
        category: 'Capacity'
        enabled: true
      }
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

resource exportBlobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-prostar-metrics-blob'
  scope: exportBlobService
  properties: {
    workspaceId: logAnalyticsWorkspace.id
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'StorageRead'
        enabled: true
      }
      {
        category: 'StorageWrite'
        enabled: true
      }
      {
        category: 'StorageDelete'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'Capacity'
        enabled: true
      }
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

resource webHttp5xxRateAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-${workloadName}-web-5xx-rate'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Pro Star Metrics web HTTP 5xx rate'
    description: 'HTTP 5xx responses exceed ${webHttp5xxRatePercentThreshold} percent over five minutes.'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    scopes: [
      logAnalyticsWorkspace.id
    ]
    criteria: {
      allOf: [
        {
          query: format('''
            ContainerAppHTTPLogs
            | where ContainerAppName =~ '{0}'
            | summarize TotalRequests = count(), FailedRequests = countif(StatusCode between (500 .. 599))
            | extend FailureRatePercent = 100.0 * todouble(FailedRequests) / todouble(TotalRequests)
            | where TotalRequests > 0 and FailureRatePercent > {1}
          ''', containerAppName, webHttp5xxRatePercentThreshold)
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        ownerActionGroup.id
      ]
    }
    skipQueryValidation: false
  }
  dependsOn: [
    containerAppsEnvironmentDiagnostics
  ]
}

resource webP95LatencyAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-${workloadName}-web-p95-latency'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Pro Star Metrics web p95 latency'
    description: 'Ingress p95 request duration exceeds ${webP95LatencyMsThreshold} ms over ten minutes.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT10M'
    scopes: [
      logAnalyticsWorkspace.id
    ]
    criteria: {
      allOf: [
        {
          query: format('''
            ContainerAppHTTPLogs
            | where ContainerAppName =~ '{0}'
            | summarize P95Milliseconds = percentile(RequestDuration, 95)
            | where P95Milliseconds > {1}
          ''', containerAppName, webP95LatencyMsThreshold)
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        ownerActionGroup.id
      ]
    }
    skipQueryValidation: false
  }
  dependsOn: [
    containerAppsEnvironmentDiagnostics
  ]
}

resource operationalCriticalAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-${workloadName}-operational-critical'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Pro Star Metrics operational critical signal'
    description: 'The app-owned data health model emitted a critical queue, dead-letter, freshness, or reconciliation signal.'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT30M'
    scopes: [
      logAnalyticsWorkspace.id
    ]
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerJobName_s =~ 'job-psm-operational-health'
            | extend Payload = parse_json(Log_s)
            | where tostring(Payload.event) == 'prostar_metrics_operational_health'
            | where tostring(Payload.severity) == 'critical'
            | where tostring(Payload.alertId) != 'dead-letter-immediate'
            | extend EventKey = tostring(Payload.eventKey)
            | where isnotempty(EventKey)
            | summarize Payload = take_any(Payload) by EventKey
            | summarize Signals = count(), AlertIds = make_set(tostring(Payload.alertId), 20)
            | where Signals > 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        ownerActionGroup.id
      ]
    }
    skipQueryValidation: false
  }
  dependsOn: [
    containerAppsEnvironmentDiagnostics
  ]
}

// The application owns sequence semantics. This rule consumes only the explicit
// three-consecutive-failures event and never infers a sequence from platform executions.
resource operationalIngestionConsecutiveFailuresAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-${workloadName}-ingestion-three-consecutive-failures'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Pro Star Metrics three consecutive ingestion failures'
    description: 'App-owned operational telemetry confirmed three consecutive ingestion failures.'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT30M'
    scopes: [
      logAnalyticsWorkspace.id
    ]
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerJobName_s =~ 'job-psm-operational-health'
            | extend Payload = parse_json(Log_s)
            | where tostring(Payload.event) == 'prostar_metrics_operational_health'
            | where tostring(Payload.severity) == 'critical'
            | where tostring(Payload.alertId) == 'ingestion-three-consecutive-failures'
            | where tostring(Payload.evidenceKind) == 'ingestion_run'
            | where toint(Payload.consecutiveFailures) >= 3
            | where tolong(Payload.deadLetterCount) == 0
            | extend EventKey = tostring(Payload.eventKey)
            | where isnotempty(EventKey)
            | where isnotempty(tostring(Payload.sourceFamily))
            | where isnotempty(tostring(Payload.evidenceId))
            | where isnotempty(tostring(Payload.occurredAt))
            | summarize Payload = take_any(Payload) by EventKey
            | summarize Signals = count(), Sources = make_set(tostring(Payload.sourceFamily), 20)
            | where Signals > 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        ownerActionGroup.id
      ]
    }
    skipQueryValidation: false
  }
  dependsOn: [
    containerAppsEnvironmentDiagnostics
  ]
}

resource operationalDeadLetterImmediateAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-${workloadName}-dead-letter-immediate'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Pro Star Metrics dead letter detected'
    description: 'App-owned operational telemetry reported one or more dead-lettered work items.'
    severity: 0
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    scopes: [
      logAnalyticsWorkspace.id
    ]
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerJobName_s =~ 'job-psm-operational-health'
            | extend Payload = parse_json(Log_s)
            | where tostring(Payload.event) == 'prostar_metrics_operational_health'
            | where tostring(Payload.severity) == 'critical'
            | where tostring(Payload.alertId) == 'dead-letter-immediate'
            | where tostring(Payload.evidenceKind) in ('ingestion_job', 'backfill_work_unit')
            | where toint(Payload.consecutiveFailures) == 0
            | where tolong(Payload.deadLetterCount) > 0
            | extend EventKey = tostring(Payload.eventKey)
            | where isnotempty(EventKey)
            | where isnotempty(tostring(Payload.sourceFamily))
            | where isnotempty(tostring(Payload.evidenceId))
            | where isnotempty(tostring(Payload.occurredAt))
            | summarize Payload = take_any(Payload) by EventKey
            | summarize Signals = count(), DeadLetters = max(tolong(Payload.deadLetterCount))
            | where Signals > 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        ownerActionGroup.id
      ]
    }
    skipQueryValidation: false
  }
  dependsOn: [
    containerAppsEnvironmentDiagnostics
  ]
}

resource operationalWarningAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-${workloadName}-operational-warning'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'Pro Star Metrics operational warning signal'
    description: 'The app-owned data health model emitted a warning queue-age, partial-coverage, or reconciliation signal.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT30M'
    scopes: [
      logAnalyticsWorkspace.id
    ]
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerJobName_s =~ 'job-psm-operational-health'
            | extend Payload = parse_json(Log_s)
            | where tostring(Payload.event) == 'prostar_metrics_operational_health'
            | where tostring(Payload.severity) == 'warning'
            | extend EventKey = tostring(Payload.eventKey)
            | where isnotempty(EventKey)
            | summarize Payload = take_any(Payload) by EventKey
            | summarize Signals = count(), AlertIds = make_set(tostring(Payload.alertId), 20)
            | where Signals > 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        ownerActionGroup.id
      ]
    }
    skipQueryValidation: false
  }
  dependsOn: [
    containerAppsEnvironmentDiagnostics
  ]
}

resource jobFailureAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [for (jobName, index) in containerAppsJobNames: {
  name: 'alert-${jobName}-failed'
  location: 'global'
  tags: tags
  properties: {
    description: 'Container Apps job ${jobName} reported a failed execution in 15 minutes.'
    severity: 1
    enabled: true
    scopes: [
      containerAppsJobs[index].id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    targetResourceType: 'Microsoft.App/jobs'
    targetResourceRegion: location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'FailedExecutions'
          metricName: 'Executions'
          metricNamespace: 'Microsoft.App/jobs'
          operator: 'GreaterThan'
          timeAggregation: 'Maximum'
          threshold: 0
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'state'
              operator: 'Include'
              values: [
                'Failed'
              ]
            }
          ]
          skipMetricValidation: false
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: ownerActionGroup.id
      }
    ]
  }
}]

resource postgresMetricAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [for alert in postgresMetricAlertDefinitions: {
  name: 'alert-${workloadName}-postgres-${alert.suffix}'
  location: 'global'
  tags: tags
  properties: {
    description: alert.description
    severity: alert.severity
    enabled: true
    scopes: [
      postgresServer.id
    ]
    evaluationFrequency: contains(postgresFastMetricNames, alert.metricName) ? 'PT1M' : 'PT5M'
    windowSize: contains(postgresFastMetricNames, alert.metricName) ? 'PT5M' : 'PT15M'
    targetResourceType: 'Microsoft.DBforPostgreSQL/flexibleServers'
    targetResourceRegion: location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'PostgresMetricThreshold'
          metricName: alert.metricName
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          operator: alert.operator
          timeAggregation: alert.timeAggregation
          threshold: alert.threshold
          criterionType: 'StaticThresholdCriterion'
          skipMetricValidation: false
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: ownerActionGroup.id
      }
    ]
  }
}]

resource exportStorageFailureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${workloadName}-export-storage-failures'
  location: 'global'
  tags: tags
  properties: {
    description: 'The dedicated export storage account reported one or more failed transactions in five minutes.'
    severity: 1
    enabled: true
    scopes: [
      exportStorage.id
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    targetResourceType: 'Microsoft.Storage/storageAccounts'
    targetResourceRegion: location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'FailedStorageTransactions'
          metricName: 'Transactions'
          metricNamespace: 'Microsoft.Storage/storageAccounts'
          operator: 'GreaterThan'
          timeAggregation: 'Total'
          threshold: 0
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'ResponseType'
              operator: 'Include'
              values: [
                'AuthenticationError'
                'AuthorizationError'
                'ClientOtherError'
                'ClientTimeoutError'
                'NetworkError'
                'ServerOtherError'
                'ServerTimeoutError'
              ]
            }
          ]
          skipMetricValidation: false
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: ownerActionGroup.id
      }
    ]
  }
}

output logAnalyticsWorkspaceResourceId string = logAnalyticsWorkspace.id
output applicationInsightsResourceId string = applicationInsights.id
output ownerActionGroupResourceId string = ownerActionGroup.id
output postgresActiveConnectionsAlertThreshold int = postgresActiveConnectionsThreshold
output postgresBackupStorageUsedBytesAlertThreshold int = postgresBackupStorageUsedBytesThreshold
