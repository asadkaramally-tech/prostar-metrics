targetScope = 'resourceGroup'

@description('Azure region for metrics resources.')
param location string = resourceGroup().location

@description('Environment suffix used in resource names.')
param environmentName string = 'prod'

@description('Base workload name used in tags.')
param workloadName string = 'prostar-metrics'

@description('Existing Container Apps environment shared with Pro Star apps.')
param containerAppsEnvironmentName string = 'cae-prostar-dispatch-prod'

@description('Metrics web Container App name.')
param containerAppName string = 'aca-prostar-metrics-prod'

@description('Scheduled ingestion Container Apps job name.')
param ingestionJobName string = 'job-prostar-metrics-ingest'

@description('Scheduled completed jobs ingestion Container Apps job name.')
param jobsIngestionJobName string = 'job-prostar-metrics-jobs'

@description('Scheduled reconciliation Container Apps job name.')
param reconciliationJobName string = 'job-prostar-metrics-reconcile'

@description('Manual rollup rebuild Container Apps job name.')
param rollupRebuildJobName string = 'job-prostar-metrics-rollups'

@description('Concrete login server for the existing Azure Container Registry.')
@minLength(1)
param acrLoginServer string

@description('Existing user-assigned managed identity with AcrPull on the ACR.')
param managedIdentityName string = 'id-prostar-dispatch-prod'

@description('Concrete client ID for the existing user-assigned managed identity.')
@minLength(1)
param managedIdentityClientId string

@description('Concrete principal ID for the existing user-assigned managed identity.')
@minLength(1)
param managedIdentityPrincipalId string

@description('Storage account name for private commission exports. Must be globally unique.')
param exportStorageAccountName string = 'stprostarmetricsexports'

@description('Private Blob container name for commission export retention.')
param commissionExportContainerName string = 'commission-exports'

@description('Container image to run.')
param containerImage string = 'acrprostardispatchprod.azurecr.io/prostar-metrics:latest'

@description('Container listening port for the metrics web app.')
param targetPort int = 3000

@description('Owner-facing custom domains bound to the web app ingress, with their managed certificates. Empty means the default azurecontainerapps.io hostname only.')
param customDomains array = []

@description('Minimum web app replicas.')
param minReplicas int = 1

@description('Maximum web app replicas.')
param maxReplicas int = 2

@description('Container Apps revision mode. Keep Single for routine deployments; set Multiple only for an explicitly managed canary/rollback release.')
@allowed([
  'Single'
  'Multiple'
])
param activeRevisionsMode string = 'Single'

@description('CPU cores for the web app container.')
param webCpu string = '0.5'

@description('Memory for the web app container.')
param webMemory string = '1Gi'

@description('CPU cores for scheduled jobs.')
param jobCpu string = '0.5'

@description('Memory for scheduled jobs.')
param jobMemory string = '1Gi'

@description('Cron expression for bounded Simpro ingestion.')
param ingestionCronExpression string = '*/20 * * * *'

@description('Cron expression for rollup/snapshot reconciliation.')
param reconciliationCronExpression string = '30 5 * * *'

@description('Inline Azure PostgreSQL connection string fallback. Omit when Key Vault references are enabled.')
@secure()
param azurePostgresConnectionString string = ''

@description('Inline Simpro bearer token fallback. Omit when Key Vault references are enabled.')
@secure()
param simproBearerToken string = ''

@description('Use user-assigned-identity Key Vault references for all app and job secrets.')
param useKeyVaultSecretReferences bool = false

@description('Dedicated Pro Star Metrics Key Vault name.')
param keyVaultName string = 'kv-prostar-metrics-prod'

@description('Key Vault secret name for the PostgreSQL connection string.')
param azurePostgresConnectionStringSecretName string = 'azure-postgres-connection-string'

@description('Key Vault secret name for the Simpro bearer token.')
param simproBearerTokenSecretName string = 'simpro-bearer-token'

@description('Key Vault secret name for the Easy Auth Microsoft provider client secret.')
param microsoftProviderAuthenticationSecretName string = 'microsoft-provider-authentication-secret'

@description('Key Vault secret name for the optional base64 PostgreSQL CA certificate.')
param postgresSslCaCertBase64SecretName string = 'postgres-ssl-ca-cert-base64'

@description('Include the optional PostgreSQL CA secret and environment reference.')
param includePostgresSslCaCertSecret bool = false

@description('Base Simpro API URL without company path.')
param simproBaseUrl string = 'https://prostarmechanical.simprosuite.com/api/v1.0'

@description('Simpro company ID. Pro Star defaults to 0.')
param simproCompanyId string = '0'

@description('Whether Postgres should reject untrusted TLS certificates.')
@allowed([
  'true'
  'false'
])
param postgresSslRejectUnauthorized string = 'true'

@description('Optional PostgreSQL CA certificate as base64.')
@secure()
param postgresSslCaCertBase64 string = ''

@description('Inline Easy Auth Microsoft provider client secret fallback. Omit when Key Vault references are enabled.')
@secure()
param microsoftProviderAuthenticationSecret string = ''

@description('Existing Easy Auth Microsoft provider application client ID.')
@minLength(1)
param microsoftProviderClientId string

@description('Existing Easy Auth Microsoft provider OpenID issuer URL.')
@minLength(1)
param microsoftProviderOpenIdIssuer string

@description('Existing Easy Auth Microsoft provider allowed audiences.')
@minLength(1)
param microsoftProviderAllowedAudiences array

@description('Comma-separated admin emails for app role enforcement.')
param metricsAdminEmails string = ''

@description('Comma-separated finance emails for commission access.')
param metricsFinanceEmails string = ''

@description('Comma-separated operator emails.')
param metricsOperatorEmails string = ''

@description('Comma-separated viewer emails.')
param metricsViewerEmails string = ''

@description('Authentication mode. Set to easy-auth only after Container Apps auth is configured to inject trusted x-ms-client-principal headers.')
@allowed([
  'disabled'
  'easy-auth'
])
param metricsAuthMode string = 'disabled'

var tags = {
  workload: workloadName
  environment: environmentName
  managedBy: 'bicep'
}

var secretNames = {
  azurePostgresConnectionString: 'azure-postgres-connection-string'
  simproBearerToken: 'simpro-bearer-token'
  postgresSslCaCertBase64: 'postgres-ssl-ca-cert-base64'
  microsoftProviderAuthenticationSecret: 'microsoft-provider-authentication-secret'
}

var keyVaultSecretBaseUrl = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets'

var commonRequiredSecrets = useKeyVaultSecretReferences ? [
  {
    name: secretNames.azurePostgresConnectionString
    keyVaultUrl: '${keyVaultSecretBaseUrl}/${azurePostgresConnectionStringSecretName}'
    identity: identity.id
  }
  {
    name: secretNames.simproBearerToken
    keyVaultUrl: '${keyVaultSecretBaseUrl}/${simproBearerTokenSecretName}'
    identity: identity.id
  }
] : [
  {
    name: secretNames.azurePostgresConnectionString
    value: azurePostgresConnectionString
  }
  {
    name: secretNames.simproBearerToken
    value: simproBearerToken
  }
]

var commonOptionalSecrets = !includePostgresSslCaCertSecret ? [] : useKeyVaultSecretReferences ? [
  {
    name: secretNames.postgresSslCaCertBase64
    keyVaultUrl: '${keyVaultSecretBaseUrl}/${postgresSslCaCertBase64SecretName}'
    identity: identity.id
  }
] : [
  {
    name: secretNames.postgresSslCaCertBase64
    value: postgresSslCaCertBase64
  }
]

var commonSecrets = concat(commonRequiredSecrets, commonOptionalSecrets)

var webAuthSecrets = metricsAuthMode != 'easy-auth' ? [] : useKeyVaultSecretReferences ? [
  {
    name: secretNames.microsoftProviderAuthenticationSecret
    keyVaultUrl: '${keyVaultSecretBaseUrl}/${microsoftProviderAuthenticationSecretName}'
    identity: identity.id
  }
] : [
  {
    name: secretNames.microsoftProviderAuthenticationSecret
    value: microsoftProviderAuthenticationSecret
  }
]

var webSecrets = concat(commonSecrets, webAuthSecrets)

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: containerAppsEnvironmentName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: managedIdentityName
}

resource exportStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: exportStorageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource exportBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: exportStorage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 30
      allowPermanentDelete: false
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
  }
}

resource commissionExportContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: exportBlobService
  name: commissionExportContainerName
  properties: {
    publicAccess: 'None'
    defaultEncryptionScope: '$account-encryption-key'
    denyEncryptionScopeOverride: false
  }
}

resource commissionExportLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: exportStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'retain-commission-exports-seven-years'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 2555
                }
              }
              snapshot: {
                delete: {
                  daysAfterCreationGreaterThan: 2555
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 2555
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${commissionExportContainerName}/'
              ]
            }
          }
        }
        {
          enabled: true
          name: 'delete-orphaned-release-evidence-handoffs'
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'release-evidence-gate/runs/'
                'release-evidence-browser/runs/'
                'release-evidence-reviewer/runs/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 1
                }
              }
            }
          }
        }
        {
          enabled: true
          name: 'expire-release-evidence-replay-ledger'
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'release-evidence-gate/replay-ledger/'
                'release-evidence-browser/replay-ledger/'
                'release-evidence-reviewer/replay-ledger/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 7
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource exportStorageBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(commissionExportContainer.id, identity.id, 'storage-blob-data-contributor')
  scope: commissionExportContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

var commonRequiredEnv = [
  {
    name: 'AZURE_POSTGRES_CONNECTION_STRING'
    secretRef: secretNames.azurePostgresConnectionString
  }
  {
    name: 'POSTGRES_SSL_REJECT_UNAUTHORIZED'
    value: postgresSslRejectUnauthorized
  }
  {
    name: 'POSTGRES_POOL_IDLE_TIMEOUT_MS'
    value: '30000'
  }
  {
    name: 'POSTGRES_CONNECTION_TIMEOUT_MS'
    value: '60000'
  }
  {
    name: 'SIMPRO_BASE_URL'
    value: simproBaseUrl
  }
  {
    name: 'SIMPRO_COMPANY_ID'
    value: simproCompanyId
  }
  {
    name: 'SIMPRO_BEARER_TOKEN'
    secretRef: secretNames.simproBearerToken
  }
  {
    name: 'SIMPRO_REQUESTS_PER_SECOND'
    value: '5'
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: managedIdentityClientId
  }
  {
    name: 'AZURE_STORAGE_ACCOUNT_NAME'
    value: exportStorage.name
  }
  {
    name: 'COMMISSION_EXPORT_CONTAINER'
    value: commissionExportContainer.name
  }
  {
    name: 'METRICS_ADMIN_EMAILS'
    value: metricsAdminEmails
  }
  {
    name: 'METRICS_FINANCE_EMAILS'
    value: metricsFinanceEmails
  }
  {
    name: 'METRICS_OPERATOR_EMAILS'
    value: metricsOperatorEmails
  }
  {
    name: 'METRICS_VIEWER_EMAILS'
    value: metricsViewerEmails
  }
  {
    name: 'METRICS_AUTH_MODE'
    value: metricsAuthMode
  }
]

var commonOptionalEnv = !includePostgresSslCaCertSecret ? [] : [
  {
    name: 'POSTGRES_SSL_CA_CERT_BASE64'
    secretRef: secretNames.postgresSslCaCertBase64
  }
]

var sharedEnv = concat(commonRequiredEnv, commonOptionalEnv)

var commonEnv = concat(sharedEnv, [
  {
    name: 'POSTGRES_POOL_MAX'
    value: '1'
  }
])

// Rollup workers need a second connection so their lease heartbeats are not
// starved while a long monthly rebuild occupies the primary connection.
var rollupEnv = concat(sharedEnv, [
  {
    name: 'POSTGRES_POOL_MAX'
    value: '2'
  }
])

var webEnv = concat(sharedEnv, [
  {
    name: 'POSTGRES_POOL_MAX'
    value: '4'
  }
  {
    name: 'HOSTNAME'
    value: '0.0.0.0'
  }
])

var manualIngestionJobs = [
  {
    name: 'job-prostar-metrics-employees'
    entity: 'employees'
    budget: '250'
  }
  {
    name: 'job-prostar-metrics-timesheets'
    entity: 'timesheets'
    budget: '250'
  }
  {
    name: 'job-prostar-timesheet-jobs'
    entity: 'jobs_from_timesheets'
    budget: '250'
  }
  {
    name: 'job-prostar-metrics-schedules'
    entity: 'schedules'
    budget: '250'
  }
  {
    name: 'job-prostar-metrics-mobile'
    entity: 'mobile_status'
    budget: '250'
  }
]

var scheduledSourceJobs = [
  {
    name: 'job-psm-quote-logs'
    cron: '*/15 * * * *'
    args: ['run', 'ingest:worker', '--', '--entity', 'quote_logs', '--request-budget', '250', '--drain-limit', '4']
  }
  {
    name: 'job-psm-job-logs'
    cron: '*/15 * * * *'
    args: ['run', 'ingest:worker', '--', '--entity', 'job_logs', '--request-budget', '250', '--drain-limit', '4']
  }
  {
    name: 'job-psm-schedule-logs'
    cron: '*/15 * * * *'
    args: ['run', 'ingest:worker', '--', '--entity', 'schedule_logs', '--request-budget', '250', '--drain-limit', '4']
  }
  {
    name: 'job-psm-mobile-logs'
    cron: '*/15 * * * *'
    args: ['run', 'ingest:worker', '--', '--entity', 'mobile_status', '--request-budget', '250', '--drain-limit', '4']
  }
  {
    name: 'job-psm-candidate-drain'
    cron: '2,32 * * * *'
    args: ['run', 'ingest:worker', '--', '--request-budget', '250', '--drain-limit', '50']
  }
  {
    name: 'job-psm-timesheets-hourly'
    cron: '0 * * * *'
    args: ['run', 'ingest:worker', '--', '--entity', 'timesheets', '--lookback-days', '90', '--request-budget', '250', '--drain-limit', '20']
  }
  {
    name: 'job-psm-ts-jobs-hourly'
    cron: '5 * * * *'
    args: ['run', 'ingest:worker', '--', '--entity', 'jobs_from_timesheets', '--lookback-days', '120', '--request-budget', '250', '--drain-limit', '20']
  }
  {
    name: 'job-psm-employees-daily'
    cron: '0 9,10 * * *'
    args: ['run', 'ingest:worker', '--', '--entity', 'employees', '--local-hour', '2', '--request-budget', '250', '--drain-limit', '20']
  }
  {
    name: 'job-psm-rollup-drain'
    cron: '12,42 * * * *'
    args: ['run', 'rollups:worker', '--', '--limit', '30']
  }
  {
    name: 'job-psm-backfill-hourly'
    cron: '20,50 * * * *'
    args: ['run', 'backfill:worker', '--', '--execute', '--drain-limit', '5', '--runtime-minutes', '19', '--run-request-limit', '1000']
  }
  {
    name: 'job-psm-operational-health'
    cron: '10,25,40,55 * * * *'
    args: ['run', 'telemetry:operational']
  }
  {
    name: 'job-psm-reconcile-trailing-24m'
    cron: '0 8 * * *'
    args: ['run', 'reconcile:worker', '--', '--mode', 'trailing-24-months', '--scope', 'all', '--batch-months', '3', '--runtime-minutes', '20', '--request-budget', '1000']
  }
  {
    name: 'job-psm-reconcile-stable-history'
    cron: '0 9 1 * *'
    args: ['run', 'reconcile:worker', '--', '--mode', 'older-stable-history', '--scope', 'all', '--batch-months', '3', '--runtime-minutes', '20', '--request-budget', '1000']
  }
  {
    name: 'job-psm-commissions-nightly'
    cron: '0 10,11 * * *'
    args: ['run', 'rollups:worker', '--', '--nightly-commissions', '--local-hour', '3', '--limit', '1']
  }
  {
    name: 'job-psm-materials'
    cron: '40 1,7,13,19 * * *'
    args: ['run', 'materials:worker', '--', '--mode', 'incremental', '--hot-window-days', '7', '--request-limit', '8000']
  }
]

resource webApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: activeRevisionsMode
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
        exposedPort: 0
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        // Owner-facing custom domains. These must live in the template: a
        // deployment reconciles ingress wholesale, so a domain bound only
        // out-of-band would be stripped by the next release.
        customDomains: [for domain in customDomains: {
          name: domain.name
          certificateId: domain.certificateId
          bindingType: 'SniEnabled'
        }]
      }
      registries: [
        {
          server: acrLoginServer
          identity: identity.id
        }
      ]
      secrets: webSecrets
    }
    template: {
      containers: [
        {
          name: 'web'
          image: containerImage
          env: webEnv
          resources: {
            cpu: json(webCpu)
            memory: webMemory
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: targetPort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 60
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 10
              successThreshold: 1
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: targetPort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 12
              successThreshold: 1
            }
            {
              type: 'Startup'
              httpGet: {
                path: '/api/health'
                port: targetPort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 30
              successThreshold: 1
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

resource webAuth 'Microsoft.App/containerApps/authConfigs@2023-05-01' = if (metricsAuthMode == 'easy-auth') {
  parent: webApp
  name: 'current'
  properties: {
    globalValidation: {
      excludedPaths: [
        '/api/health'
      ]
      redirectToProvider: 'AzureActiveDirectory'
      unauthenticatedClientAction: 'RedirectToLoginPage'
    }
    httpSettings: {
      forwardProxy: {
        convention: 'Standard'
      }
      requireHttps: true
    }
    identityProviders: {
      azureActiveDirectory: {
        isAutoProvisioned: false
        registration: {
          clientId: microsoftProviderClientId
          clientSecretSettingName: secretNames.microsoftProviderAuthenticationSecret
          openIdIssuer: microsoftProviderOpenIdIssuer
        }
        validation: {
          allowedAudiences: microsoftProviderAllowedAudiences
        }
      }
    }
    login: {
      preserveUrlFragmentsForLogins: false
    }
    platform: {
      enabled: true
    }
  }
}

resource ingestionJob 'Microsoft.App/jobs@2023-05-01' = {
  name: ingestionJobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1200
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: ingestionCronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: identity.id
        }
      ]
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'ingest'
          image: containerImage
          command: [
            'npm'
          ]
          args: [
            'run'
            'ingest:worker'
            '--'
            '--entity'
            'quotes'
            '--request-budget'
            '250'
            '--lookback-days'
            '7'
            '--drain-limit'
            '100'
          ]
          env: commonEnv
          resources: {
            cpu: json(jobCpu)
            memory: jobMemory
          }
        }
      ]
    }
  }
}

resource jobsIngestionJob 'Microsoft.App/jobs@2023-05-01' = {
  name: jobsIngestionJobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1200
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: ingestionCronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: identity.id
        }
      ]
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'ingest'
          image: containerImage
          command: [
            'npm'
          ]
          args: [
            'run'
            'ingest:worker'
            '--'
            '--entity'
            'jobs'
            '--request-budget'
            '250'
            '--lookback-days'
            '7'
            '--drain-limit'
            '100'
          ]
          env: commonEnv
          resources: {
            cpu: json(jobCpu)
            memory: jobMemory
          }
        }
      ]
    }
  }
}

resource scheduledSourceIngestionJobs 'Microsoft.App/jobs@2023-05-01' = [for job in scheduledSourceJobs: {
  name: job.name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1200
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: job.cron
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: identity.id
        }
      ]
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'ingest'
          image: containerImage
          command: [
            'npm'
          ]
          args: job.args
          env: (job.name == 'job-psm-rollup-drain' || job.name == 'job-psm-commissions-nightly') ? rollupEnv : commonEnv
          resources: {
            cpu: json(jobCpu)
            memory: jobMemory
          }
        }
      ]
    }
  }
}]

resource reconciliationJob 'Microsoft.App/jobs@2023-05-01' = {
  name: reconciliationJobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1200
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: reconciliationCronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: identity.id
        }
      ]
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'reconcile'
          image: containerImage
          command: [
            'npm'
          ]
          args: [
            'run'
            'reconcile:worker'
          ]
          env: commonEnv
          resources: {
            cpu: json(jobCpu)
            memory: jobMemory
          }
        }
      ]
    }
  }
}

resource manualAttributionIngestionJobs 'Microsoft.App/jobs@2023-05-01' = [for job in manualIngestionJobs: {
  name: job.name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1200
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: identity.id
        }
      ]
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'ingest'
          image: containerImage
          command: [
            'npm'
          ]
          args: [
            'run'
            'ingest:worker'
            '--'
            '--entity'
            job.entity
            '--request-budget'
            job.budget
          ]
          env: commonEnv
          resources: {
            cpu: json(jobCpu)
            memory: jobMemory
          }
        }
      ]
    }
  }
}]

resource rollupRebuildJob 'Microsoft.App/jobs@2023-05-01' = {
  name: rollupRebuildJobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1200
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: identity.id
        }
      ]
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'rollups'
          image: containerImage
          command: [
            'npm'
          ]
          args: [
            'run'
            'rollups:worker'
          ]
          env: rollupEnv
          resources: {
            cpu: json(jobCpu)
            memory: jobMemory
          }
        }
      ]
    }
  }
}

output containerAppName string = webApp.name
output containerAppFqdn string = webApp.properties.configuration.ingress.fqdn
output ingestionJobName string = ingestionJob.name
output jobsIngestionJobName string = jobsIngestionJob.name
output reconciliationJobName string = reconciliationJob.name
output rollupRebuildJobName string = rollupRebuildJob.name
output manualAttributionIngestionJobNames array = [for job in manualIngestionJobs: job.name]
output scheduledSourceIngestionJobNames array = [for job in scheduledSourceJobs: job.name]
output acrLoginServer string = acrLoginServer
output exportStorageAccountName string = exportStorage.name
output commissionExportContainerName string = commissionExportContainer.name
