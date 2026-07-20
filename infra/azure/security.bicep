targetScope = 'resourceGroup'

@description('Azure region for a newly created Key Vault.')
param location string = resourceGroup().location

@description('Environment suffix used in tags.')
param environmentName string = 'prod'

@description('Dedicated Pro Star Metrics Key Vault name.')
param keyVaultName string = 'kv-prostar-metrics-prod'

@description('Create the dedicated vault when true; import it as existing when false.')
param deployNewKeyVault bool = true

@description('Existing user-assigned identity used by the Metrics app and jobs.')
param managedIdentityName string = 'id-prostar-dispatch-prod'

@description('Dedicated managed identity name for immutable gate evidence signing.')
param gateEvidenceSignerIdentityName string = 'id-prostar-release-gate-prod'

@description('Dedicated managed identity name for browser evidence signing.')
param browserEvidenceSignerIdentityName string = 'id-prostar-release-browser-prod'

@description('Dedicated managed identity name for independent reviewer evidence signing.')
param reviewerEvidenceSignerIdentityName string = 'id-prostar-release-reviewer-prod'

@description('Create or update the supplied secret values through ARM. Routine deployments leave this false.')
param writeSecretValues bool = false

@description('Key Vault secret name for the PostgreSQL connection string.')
param azurePostgresConnectionStringSecretName string = 'azure-postgres-connection-string'

@description('Key Vault secret name for the Simpro bearer token.')
param simproBearerTokenSecretName string = 'simpro-bearer-token'

@description('Key Vault secret name for the Easy Auth Microsoft provider client secret.')
param microsoftProviderAuthenticationSecretName string = 'microsoft-provider-authentication-secret'

@description('Optional Key Vault secret name for the base64 PostgreSQL CA certificate.')
param postgresSslCaCertBase64SecretName string = 'postgres-ssl-ca-cert-base64'

@secure()
@description('PostgreSQL connection string written only when writeSecretValues is true.')
param azurePostgresConnectionString string = ''

@secure()
@description('Simpro bearer token written only when writeSecretValues is true.')
param simproBearerToken string = ''

@secure()
@description('Easy Auth Microsoft provider client secret written only when writeSecretValues is true.')
param microsoftProviderAuthenticationSecret string = ''

@secure()
@description('Optional base64 PostgreSQL CA certificate written only when supplied and writeSecretValues is true.')
param postgresSslCaCertBase64 string = ''

var tags = {
  workload: 'prostar-metrics'
  environment: environmentName
  managedBy: 'bicep'
  component: 'security'
}

var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

var keyVaultCryptoUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '12338af0-0e69-4776-bea7-57ae8d297424'
)

var readerRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'acdd72a7-3385-48ef-bd42-f606fba81ae7'
)

var gateEvidenceKeyName = 'prostar-release-gate-evidence'
var browserEvidenceKeyName = 'prostar-release-browser-evidence'
var reviewerEvidenceKeyName = 'prostar-release-reviewer-evidence'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: managedIdentityName
}

resource gateEvidenceSignerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: gateEvidenceSignerIdentityName
  location: location
  tags: union(tags, { evidenceKind: 'gate' })
}

resource browserEvidenceSignerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: browserEvidenceSignerIdentityName
  location: location
  tags: union(tags, { evidenceKind: 'browser' })
}

resource reviewerEvidenceSignerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: reviewerEvidenceSignerIdentityName
  location: location
  tags: union(tags, { evidenceKind: 'reviewer' })
}

resource gateEvidenceSignerReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, gateEvidenceSignerIdentity.id, readerRoleDefinitionId)
  properties: {
    roleDefinitionId: readerRoleDefinitionId
    principalId: gateEvidenceSignerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource browserEvidenceSignerReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, browserEvidenceSignerIdentity.id, readerRoleDefinitionId)
  properties: {
    roleDefinitionId: readerRoleDefinitionId
    principalId: browserEvidenceSignerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource reviewerEvidenceSignerReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, reviewerEvidenceSignerIdentity.id, readerRoleDefinitionId)
  properties: {
    roleDefinitionId: readerRoleDefinitionId
    principalId: reviewerEvidenceSignerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource newKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' = if (deployNewKeyVault) {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    accessPolicies: []
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource existingKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = if (!deployNewKeyVault) {
  name: keyVaultName
}

resource newVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployNewKeyVault) {
  name: guid(newKeyVault.id, identity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: newKeyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource existingVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!deployNewKeyVault) {
  name: guid(existingKeyVault.id, identity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: existingKeyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource newGateEvidenceKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = if (deployNewKeyVault) {
  parent: newKeyVault
  name: gateEvidenceKeyName
  properties: {
    kty: 'RSA'
    keySize: 2048
    keyOps: [
      'sign'
      'verify'
    ]
    attributes: {
      enabled: true
    }
  }
}

resource existingGateEvidenceKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = if (!deployNewKeyVault) {
  parent: existingKeyVault
  name: gateEvidenceKeyName
  properties: {
    kty: 'RSA'
    keySize: 2048
    keyOps: [
      'sign'
      'verify'
    ]
    attributes: {
      enabled: true
    }
  }
}

resource newBrowserEvidenceKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = if (deployNewKeyVault) {
  parent: newKeyVault
  name: browserEvidenceKeyName
  properties: {
    kty: 'RSA'
    keySize: 2048
    keyOps: [
      'sign'
      'verify'
    ]
    attributes: {
      enabled: true
    }
  }
}

resource existingBrowserEvidenceKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = if (!deployNewKeyVault) {
  parent: existingKeyVault
  name: browserEvidenceKeyName
  properties: {
    kty: 'RSA'
    keySize: 2048
    keyOps: [
      'sign'
      'verify'
    ]
    attributes: {
      enabled: true
    }
  }
}

resource newReviewerEvidenceKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = if (deployNewKeyVault) {
  parent: newKeyVault
  name: reviewerEvidenceKeyName
  properties: {
    kty: 'RSA'
    keySize: 2048
    keyOps: [
      'sign'
      'verify'
    ]
    attributes: {
      enabled: true
    }
  }
}

resource existingReviewerEvidenceKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = if (!deployNewKeyVault) {
  parent: existingKeyVault
  name: reviewerEvidenceKeyName
  properties: {
    kty: 'RSA'
    keySize: 2048
    keyOps: [
      'sign'
      'verify'
    ]
    attributes: {
      enabled: true
    }
  }
}

resource newGateEvidenceSignerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployNewKeyVault) {
  name: guid(newGateEvidenceKey.id, gateEvidenceSignerIdentity.id, keyVaultCryptoUserRoleDefinitionId)
  scope: newGateEvidenceKey
  properties: {
    roleDefinitionId: keyVaultCryptoUserRoleDefinitionId
    principalId: gateEvidenceSignerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource existingGateEvidenceSignerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!deployNewKeyVault) {
  name: guid(existingGateEvidenceKey.id, gateEvidenceSignerIdentity.id, keyVaultCryptoUserRoleDefinitionId)
  scope: existingGateEvidenceKey
  properties: {
    roleDefinitionId: keyVaultCryptoUserRoleDefinitionId
    principalId: gateEvidenceSignerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource newBrowserEvidenceSignerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployNewKeyVault) {
  name: guid(newBrowserEvidenceKey.id, browserEvidenceSignerIdentity.id, keyVaultCryptoUserRoleDefinitionId)
  scope: newBrowserEvidenceKey
  properties: {
    roleDefinitionId: keyVaultCryptoUserRoleDefinitionId
    principalId: browserEvidenceSignerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource existingBrowserEvidenceSignerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!deployNewKeyVault) {
  name: guid(existingBrowserEvidenceKey.id, browserEvidenceSignerIdentity.id, keyVaultCryptoUserRoleDefinitionId)
  scope: existingBrowserEvidenceKey
  properties: {
    roleDefinitionId: keyVaultCryptoUserRoleDefinitionId
    principalId: browserEvidenceSignerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource newReviewerEvidenceSignerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployNewKeyVault) {
  name: guid(newReviewerEvidenceKey.id, reviewerEvidenceSignerIdentity.id, keyVaultCryptoUserRoleDefinitionId)
  scope: newReviewerEvidenceKey
  properties: {
    roleDefinitionId: keyVaultCryptoUserRoleDefinitionId
    principalId: reviewerEvidenceSignerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource existingReviewerEvidenceSignerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!deployNewKeyVault) {
  name: guid(existingReviewerEvidenceKey.id, reviewerEvidenceSignerIdentity.id, keyVaultCryptoUserRoleDefinitionId)
  scope: existingReviewerEvidenceKey
  properties: {
    roleDefinitionId: keyVaultCryptoUserRoleDefinitionId
    principalId: reviewerEvidenceSignerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource newPostgresSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (deployNewKeyVault && writeSecretValues && !empty(azurePostgresConnectionString)) {
  parent: newKeyVault
  name: azurePostgresConnectionStringSecretName
  properties: {
    value: azurePostgresConnectionString
    contentType: 'application/x-postgresql-connection-string'
    attributes: {
      enabled: true
    }
  }
}

resource existingPostgresSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!deployNewKeyVault && writeSecretValues && !empty(azurePostgresConnectionString)) {
  parent: existingKeyVault
  name: azurePostgresConnectionStringSecretName
  properties: {
    value: azurePostgresConnectionString
    contentType: 'application/x-postgresql-connection-string'
    attributes: {
      enabled: true
    }
  }
}

resource newSimproSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (deployNewKeyVault && writeSecretValues && !empty(simproBearerToken)) {
  parent: newKeyVault
  name: simproBearerTokenSecretName
  properties: {
    value: simproBearerToken
    contentType: 'application/x-simpro-bearer-token'
    attributes: {
      enabled: true
    }
  }
}

resource existingSimproSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!deployNewKeyVault && writeSecretValues && !empty(simproBearerToken)) {
  parent: existingKeyVault
  name: simproBearerTokenSecretName
  properties: {
    value: simproBearerToken
    contentType: 'application/x-simpro-bearer-token'
    attributes: {
      enabled: true
    }
  }
}

resource newEasyAuthSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (deployNewKeyVault && writeSecretValues && !empty(microsoftProviderAuthenticationSecret)) {
  parent: newKeyVault
  name: microsoftProviderAuthenticationSecretName
  properties: {
    value: microsoftProviderAuthenticationSecret
    contentType: 'application/x-easy-auth-client-secret'
    attributes: {
      enabled: true
    }
  }
}

resource existingEasyAuthSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!deployNewKeyVault && writeSecretValues && !empty(microsoftProviderAuthenticationSecret)) {
  parent: existingKeyVault
  name: microsoftProviderAuthenticationSecretName
  properties: {
    value: microsoftProviderAuthenticationSecret
    contentType: 'application/x-easy-auth-client-secret'
    attributes: {
      enabled: true
    }
  }
}

resource newPostgresCaSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (deployNewKeyVault && writeSecretValues && !empty(postgresSslCaCertBase64)) {
  parent: newKeyVault
  name: postgresSslCaCertBase64SecretName
  properties: {
    value: postgresSslCaCertBase64
    contentType: 'application/x-pem-file-base64'
    attributes: {
      enabled: true
    }
  }
}

resource existingPostgresCaSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!deployNewKeyVault && writeSecretValues && !empty(postgresSslCaCertBase64)) {
  parent: existingKeyVault
  name: postgresSslCaCertBase64SecretName
  properties: {
    value: postgresSslCaCertBase64
    contentType: 'application/x-pem-file-base64'
    attributes: {
      enabled: true
    }
  }
}

output keyVaultName string = keyVaultName
output keyVaultResourceId string = deployNewKeyVault ? newKeyVault.id : existingKeyVault.id
output keyVaultUri string = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/'
output managedIdentityResourceId string = identity.id
output evidenceSignerIdentities object = {
  gate: {
    resourceId: gateEvidenceSignerIdentity.id
    principalId: gateEvidenceSignerIdentity.properties.principalId
    clientId: gateEvidenceSignerIdentity.properties.clientId
  }
  browser: {
    resourceId: browserEvidenceSignerIdentity.id
    principalId: browserEvidenceSignerIdentity.properties.principalId
    clientId: browserEvidenceSignerIdentity.properties.clientId
  }
  reviewer: {
    resourceId: reviewerEvidenceSignerIdentity.id
    principalId: reviewerEvidenceSignerIdentity.properties.principalId
    clientId: reviewerEvidenceSignerIdentity.properties.clientId
  }
}
output evidenceSigningKeyIds object = {
  gate: deployNewKeyVault ? newGateEvidenceKey!.properties.keyUriWithVersion : existingGateEvidenceKey!.properties.keyUriWithVersion
  browser: deployNewKeyVault ? newBrowserEvidenceKey!.properties.keyUriWithVersion : existingBrowserEvidenceKey!.properties.keyUriWithVersion
  reviewer: deployNewKeyVault ? newReviewerEvidenceKey!.properties.keyUriWithVersion : existingReviewerEvidenceKey!.properties.keyUriWithVersion
}
