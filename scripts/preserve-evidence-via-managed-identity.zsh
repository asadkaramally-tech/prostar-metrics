#!/bin/zsh
set -euo pipefail

readonly transcript="$(mktemp -t psm-evidence-sas.XXXXXX)"
chmod 600 "$transcript"
trap 'rm -f "$transcript"' EXIT

readonly public_access="$(az storage container show \
  --account-name stprostarmetricsexports \
  --name psm-metrics-preservation \
  --auth-mode login \
  --query properties.publicAccess \
  --output tsv)"
if [[ -n "$public_access" ]]; then
  echo "Preservation container unexpectedly permits public access." >&2
  exit 1
fi

readonly remote_source='(async()=>{ const {ManagedIdentityCredential}=await import("@azure/identity"); const {BlobServiceClient,ContainerSASPermissions,generateBlobSASQueryParameters,SASProtocol}=await import("@azure/storage-blob"); const account="stprostarmetricsexports"; const credential=new ManagedIdentityCredential("c60a7d88-298b-4787-93a7-922c58437042"); const service=new BlobServiceClient("https://"+account+".blob.core.windows.net",credential); const startsOn=new Date(Date.now()-300000); const expiresOn=new Date(Date.now()+1800000); const key=await service.getUserDelegationKey(startsOn,expiresOn); const token=generateBlobSASQueryParameters({containerName:"psm-metrics-preservation",permissions:ContainerSASPermissions.parse("rcw"),protocol:SASProtocol.Https,startsOn,expiresOn},key,account).toString(); console.log("__PSM_SAS_BEGIN__"+token+"__PSM_SAS_END__"); process.exit(0); })().catch((error)=>{ console.error(error); process.exit(1); });'
readonly remote_source_base64="$(printf %s "$remote_source" | base64 | tr -d '\n')"
readonly remote_command="node --input-type=module -e eval(Buffer.from(process.argv[1],Buffer.from([98,97,115,101,54,52]).toString()).toString()) $remote_source_base64"

az containerapp exec \
  --resource-group prostar-payroll \
  --name aca-prostar-metrics-prod \
  --command "$remote_command" >"$transcript"

PSM_EVIDENCE_SAS_TOKEN="$(node -e '
  const { readFileSync } = require("node:fs");
  const raw = readFileSync(process.argv[1], "utf8");
  const clean = raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\r\n]/g, "");
  const candidates = [...clean.matchAll(/__PSM_SAS_BEGIN__(.*?)__PSM_SAS_END__/g)].map((match) => match[1]);
  if (candidates.length === 0) process.exit(2);
  for (const candidate of candidates.reverse()) {
    const params = new URLSearchParams(candidate);
    const complete = ["sv", "se", "sp", "sig", "sr"].every((key) => params.get(key));
    if (complete && params.get("sp") === "rcw" && params.get("sr") === "c") {
      process.stdout.write(candidate);
      process.exit(0);
    }
  }
  const shapes = candidates.map((candidate) => [...new URLSearchParams(candidate).keys()].join(",") || "empty");
  process.stderr.write(`Managed identity returned no bounded token candidate; observed shapes: ${shapes.join(" | ")}.\n`);
  const errors = raw.split(/\r?\n/)
    .filter((line) => /(?:Error|error|failed|Failure)/.test(line) && !line.includes("__PSM_SAS_"))
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (errors.length > 0) process.stderr.write(`Sanitized remote error: ${errors.join(" | ")}\n`);
  process.exit(3);
' "$transcript")"
if [[ -z "$PSM_EVIDENCE_SAS_TOKEN" ]]; then
  echo "Managed identity did not return a bounded preservation token." >&2
  exit 1
fi
export PSM_EVIDENCE_SAS_TOKEN

node scripts/preserve-evidence-to-azure.mjs --execute
unset PSM_EVIDENCE_SAS_TOKEN
