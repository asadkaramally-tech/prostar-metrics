targetScope = 'resourceGroup'

@description('Existing storage account used for private commission exports and release evidence.')
param exportStorageAccountName string = 'stprostarmetricsexports'

@description('Existing private commission export container.')
param commissionExportContainerName string = 'commission-exports'

@description('Existing metrics user-assigned managed identity.')
param managedIdentityName string = 'id-prostar-dispatch-prod'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: managedIdentityName
}

resource exportStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: exportStorageAccountName
}

resource exportBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: exportStorage
  name: 'default'
}

resource commissionExportContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: exportBlobService
  name: commissionExportContainerName
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
          name: 'delete-orphaned-release-evidence-handoffs'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 1
                }
              }
            }
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
          }
        }
        {
          name: 'expire-release-evidence-replay-ledger'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 7
                }
              }
            }
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
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
