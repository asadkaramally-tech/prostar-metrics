#!/usr/bin/env bash
set -euo pipefail

# Compatibility entry point only. scripts/deploy-prod.mjs is the sole production
# deployment authority and owns every preflight, what-if, rollback, and receipt.
if (($# != 0)); then
  echo "Legacy deployment arguments are not supported. Run: npm run deploy:prod" >&2
  exit 64
fi

legacy_environment=(
  ACR_NAME
  AZURE_POSTGRES_CONNECTION_STRING
  IMAGE_TAG
  MICROSOFT_PROVIDER_AUTHENTICATION_SECRET
  POSTGRES_SSL_CA_CERT_BASE64
  RESOURCE_GROUP
  SIMPRO_BEARER_TOKEN
)

for name in "${legacy_environment[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    echo "Legacy deployment environment variable ${name} is not supported. Run the guarded npm run deploy:prod flow." >&2
    exit 64
  fi
done

exec npm run deploy:prod
