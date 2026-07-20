targetScope = 'resourceGroup'

@description('Azure region for the isolated release-evidence jobs.')
param location string = resourceGroup().location

@description('Environment suffix used in tags.')
param environmentName string = 'prod'

@description('Existing Container Apps environment shared by Pro Star workloads.')
param containerAppsEnvironmentName string = 'cae-prostar-dispatch-prod'

@description('Existing Azure Container Registry containing the pinned evidence-runner image.')
param acrName string = 'acrprostardispatchprod'

@description('Existing storage account used for bounded evidence handoff.')
param storageAccountName string = 'stprostarmetricsexports'

@description('Existing private commission export container whose retention shares the storage lifecycle singleton.')
param commissionExportContainerName string = 'commission-exports'

@description('Existing Key Vault containing the gate reconciliation database secret.')
param keyVaultName string = 'kv-prostar-metrics-prod'

@description('Existing PostgreSQL connection-string secret used only by the gate job.')
param postgresConnectionStringSecretName string = 'azure-postgres-connection-string'

@description('Immutable evidence-runner image pinned by sha256 digest.')
@minLength(80)
param evidenceRunnerImage string

@description('Candidate Docker build-context SHA-256 embedded in every fixed job.')
@minLength(64)
@maxLength(64)
param candidateSourceSha256 string

@description('Operator object ID granted only per-container upload and per-queue send permissions.')
@minLength(36)
@maxLength(36)
param operatorPrincipalId string

@description('Dedicated gate signer identity provisioned by security.bicep.')
param gateSignerIdentityName string = 'id-prostar-release-gate-prod'

@description('Dedicated supplied-browser-artifact validation signer identity provisioned by security.bicep.')
param browserSignerIdentityName string = 'id-prostar-release-browser-prod'

@description('Dedicated external review report content-validation signer identity provisioned by security.bicep.')
param reviewerSignerIdentityName string = 'id-prostar-release-reviewer-prod'

var subscriptionId = subscription().subscriptionId
var tags = {
  workload: 'prostar-metrics'
  environment: environmentName
  managedBy: 'bicep'
  component: 'release-evidence-runner'
}
var runners = [
  {
    kind: 'gate'
    jobName: 'job-psm-evidence-gate'
    identityName: gateSignerIdentityName
    containerName: 'release-evidence-gate'
    queueName: 'release-evidence-gate'
  }
  {
    kind: 'browser'
    jobName: 'job-psm-evidence-browser'
    identityName: browserSignerIdentityName
    containerName: 'release-evidence-browser'
    queueName: 'release-evidence-browser'
  }
  {
    kind: 'reviewer'
    jobName: 'job-psm-evidence-reviewer'
    identityName: reviewerSignerIdentityName
    containerName: 'release-evidence-reviewer'
    queueName: 'release-evidence-reviewer'
  }
]
var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var blobDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)
var queueMessageProcessorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '8a0f0c08-91a1-4084-bc3d-661d67233fed'
)
var queueMessageSenderRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'
)
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var evidencePublicKeyReaderRoleId = 'f8e7848d-52cd-4c6e-a6e6-efbcb59fc819'
var postgresConnectionSecretUrl = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/${postgresConnectionStringSecretName}'

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource postgresConnectionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: keyVault
  name: postgresConnectionStringSecretName
}

resource evidencePublicKeyReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: evidencePublicKeyReaderRoleId
  properties: {
    roleName: 'ProStar Evidence Public Key Reader'
    description: 'Reads evidence public keys for receipt verification without any signing action.'
    type: 'CustomRole'
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.KeyVault/vaults/keys/read'
        ]
        notDataActions: []
      }
    ]
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

resource signerIdentities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = [for runner in runners: {
  name: runner.identityName
}]

resource handoffContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for runner in runners: {
  parent: blobService
  name: runner.containerName
  properties: {
    publicAccess: 'None'
    immutableStorageWithVersioning: {
      enabled: false
    }
  }
}]

resource handoffQueues 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = [for runner in runners: {
  parent: queueService
  name: runner.queueName
}]

resource evidenceHandoffLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
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

resource signerBlobRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (runner, index) in runners: {
  name: guid(handoffContainers[index].id, signerIdentities[index].id, blobDataContributorRoleDefinitionId)
  scope: handoffContainers[index]
  properties: {
    roleDefinitionId: blobDataContributorRoleDefinitionId
    principalId: signerIdentities[index].properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

resource signerQueueRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (runner, index) in runners: {
  name: guid(handoffQueues[index].id, signerIdentities[index].id, queueMessageProcessorRoleDefinitionId)
  scope: handoffQueues[index]
  properties: {
    roleDefinitionId: queueMessageProcessorRoleDefinitionId
    principalId: signerIdentities[index].properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

resource operatorBlobRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (runner, index) in runners: {
  name: guid(handoffContainers[index].id, operatorPrincipalId, blobDataContributorRoleDefinitionId)
  scope: handoffContainers[index]
  properties: {
    roleDefinitionId: blobDataContributorRoleDefinitionId
    principalId: operatorPrincipalId
    principalType: 'User'
  }
}]

resource operatorQueueRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (runner, index) in runners: {
  name: guid(handoffQueues[index].id, operatorPrincipalId, queueMessageSenderRoleDefinitionId)
  scope: handoffQueues[index]
  properties: {
    roleDefinitionId: queueMessageSenderRoleDefinitionId
    principalId: operatorPrincipalId
    principalType: 'User'
  }
}]

resource signerAcrPullRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (runner, index) in runners: {
  name: guid(acr.id, signerIdentities[index].id, acrPullRoleDefinitionId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: signerIdentities[index].properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

resource gatePostgresSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(postgresConnectionSecret.id, signerIdentities[0].id, keyVaultSecretsUserRoleDefinitionId)
  scope: postgresConnectionSecret
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: signerIdentities[0].properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource signerPublicKeyReaderRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (runner, index) in runners: {
  name: guid(keyVault.id, signerIdentities[index].id, evidencePublicKeyReaderRole.id)
  scope: keyVault
  properties: {
    roleDefinitionId: evidencePublicKeyReaderRole.id
    principalId: signerIdentities[index].properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

resource evidenceJobs 'Microsoft.App/jobs@2025-07-01' = [for (runner, index) in runners: {
  name: runner.jobName
  location: location
  tags: union(tags, { evidenceKind: runner.kind })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${signerIdentities[index].id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 7200
      replicaRetryLimit: 1
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 1
          pollingInterval: 30
          rules: [
            {
              name: '${runner.kind}-queue'
              type: 'azure-queue'
              metadata: {
                accountName: storage.name
                queueName: handoffQueues[index].name
                queueLength: '1'
              }
              identity: signerIdentities[index].id
            }
          ]
        }
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: signerIdentities[index].id
        }
      ]
      secrets: runner.kind == 'gate' ? [
        {
          name: 'postgres-connection'
          keyVaultUrl: postgresConnectionSecretUrl
          identity: signerIdentities[index].id
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'evidence-${runner.kind}'
          image: evidenceRunnerImage
          command: [
            'node'
          ]
          args: [
            'scripts/run-release-evidence-job.mjs'
            '--kind'
            runner.kind
          ]
          env: concat([
            {
              name: 'NODE_ENV'
              value: 'test'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: signerIdentities[index].properties.clientId
            }
            {
              name: 'AZURE_SUBSCRIPTION_ID'
              value: subscriptionId
            }
            {
              name: 'AZURE_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'RELEASE_EVIDENCE_KIND'
              value: runner.kind
            }
            {
              name: 'RELEASE_EVIDENCE_STORAGE_ACCOUNT'
              value: storage.name
            }
            {
              name: 'RELEASE_EVIDENCE_CONTAINER'
              value: handoffContainers[index].name
            }
            {
              name: 'RELEASE_EVIDENCE_QUEUE'
              value: handoffQueues[index].name
            }
            {
              name: 'RELEASE_EVIDENCE_SOURCE_SHA256'
              value: candidateSourceSha256
            }
          ], runner.kind == 'gate' ? [
            {
              name: 'AZURE_POSTGRES_CONNECTION_STRING'
              secretRef: 'postgres-connection'
            }
          ] : [])
          resources: {
            cpu: 1
            memory: '2Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    signerBlobRoles[index]
    signerQueueRoles[index]
    signerAcrPullRoles[index]
    signerPublicKeyReaderRoles[index]
  ]
}]

output runnerJobs array = [for (runner, index) in runners: {
  kind: runner.kind
  name: evidenceJobs[index].name
  identityId: signerIdentities[index].id
  clientId: signerIdentities[index].properties.clientId
  containerName: handoffContainers[index].name
  queueName: handoffQueues[index].name
}]
output evidenceRunnerImage string = evidenceRunnerImage
output candidateSourceSha256 string = candidateSourceSha256
