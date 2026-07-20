targetScope = 'resourceGroup'

@description('Azure region for the metrics database.')
param location string = resourceGroup().location

@description('Environment suffix used in resource names.')
param environmentName string = 'prod'

@description('PostgreSQL Flexible Server name. Must be globally unique.')
param postgresServerName string = 'pg-prostar-metrics-prod'

@description('Application database name.')
param postgresDatabaseName string = 'prostar_metrics'

@description('PostgreSQL administrator user.')
param postgresAdminUser string = 'metricsadmin'

@description('PostgreSQL administrator password.')
@secure()
param postgresAdminPassword string

@description('Compute SKU for the metrics store.')
param postgresSkuName string = 'Standard_B1ms'

@description('Compute tier for the metrics store.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresTier string = 'Burstable'

@description('PostgreSQL major version.')
param postgresVersion string = '17'

@description('Storage size in GiB.')
param postgresStorageSizeGb int = 32

var tags = {
  workload: 'prostar-metrics'
  environment: environmentName
  managedBy: 'bicep'
}

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: postgresServerName
  location: location
  tags: tags
  sku: {
    name: postgresSkuName
    tier: postgresTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: postgresAdminUser
    administratorLoginPassword: postgresAdminPassword
    availabilityZone: '1'
    backup: {
      backupRetentionDays: 35
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    storage: {
      storageSizeGB: postgresStorageSizeGb
      autoGrow: 'Enabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: server
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output postgresServerName string = server.name
output postgresHost string = server.properties.fullyQualifiedDomainName
output postgresDatabaseName string = database.name
