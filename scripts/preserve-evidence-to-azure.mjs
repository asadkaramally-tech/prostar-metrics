import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AzureCliCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

const ACCOUNT = "stprostarmetricsexports";
const CONTAINER = "psm-metrics-preservation";
const PREFIX = "2026-08-28";
const projectRoot = path.resolve(import.meta.dirname, "..");
const historicalRoot = "/Users/asadkaramally/Documents/Codex/2026-07-20/i/work/prostar-metrics";

const sourceSets = Object.freeze([
  {
    localPath: path.join(projectRoot, "preservation/2026-08-28"),
    blobPath: `${PREFIX}/candidate-evidence`,
  },
  {
    localPath: path.join(historicalRoot, "docs/prostar-metrics/verification/deployment-manifest.json"),
    blobPath: `${PREFIX}/deployment-evidence/deployment-manifest.json`,
  },
  {
    localPath: path.join(historicalRoot, ".work/deploy-prod-resume"),
    blobPath: `${PREFIX}/deployment-evidence/deploy-prod-resume`,
  },
]);

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filename);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function enumerate(source, output = []) {
  const details = await stat(source.localPath);
  if (details.isSymbolicLink()) throw new Error(`Refusing symbolic link ${source.localPath}`);
  if (details.isFile()) {
    output.push({
      localPath: source.localPath,
      blobPath: source.blobPath.replaceAll(path.sep, "/"),
      bytes: details.size,
      sha256: await sha256File(source.localPath),
    });
    return output;
  }
  if (!details.isDirectory()) throw new Error(`Unsupported evidence entry ${source.localPath}`);
  const children = await readdir(source.localPath, { withFileTypes: true });
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    if (child.isSymbolicLink()) throw new Error(`Refusing symbolic link ${path.join(source.localPath, child.name)}`);
    await enumerate({
      localPath: path.join(source.localPath, child.name),
      blobPath: `${source.blobPath}/${child.name}`,
    }, output);
  }
  return output;
}

async function remoteSha256(blobClient) {
  const response = await blobClient.download();
  if (!response.readableStreamBody) throw new Error(`Azure returned no body for ${blobClient.name}`);
  const hash = createHash("sha256");
  for await (const chunk of response.readableStreamBody) hash.update(chunk);
  return hash.digest("hex");
}

async function run({ execute = false } = {}) {
  const files = [];
  for (const source of sourceSets) await enumerate(source, files);
  files.sort((left, right) => left.blobPath.localeCompare(right.blobPath));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const manifestText = files.map((file) => `${file.sha256}  ${file.blobPath}`).join("\n") + "\n";
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");

  if (!execute) {
    return { mode: "preview", account: ACCOUNT, container: CONTAINER, prefix: PREFIX, files: files.length, totalBytes, manifestSha256 };
  }

  const credential = new AzureCliCredential();
  const service = new BlobServiceClient(`https://${ACCOUNT}.blob.core.windows.net`, credential);
  const container = service.getContainerClient(CONTAINER);
  await container.createIfNotExists();
  const properties = await container.getProperties();
  if (properties.blobPublicAccess) throw new Error(`Container ${CONTAINER} unexpectedly permits ${properties.blobPublicAccess} access`);

  let uploaded = 0;
  let reused = 0;
  for (const file of files) {
    const blob = container.getBlockBlobClient(file.blobPath);
    if (await blob.exists()) {
      const existing = await blob.getProperties();
      if (existing.metadata?.sha256 !== file.sha256 || existing.contentLength !== file.bytes) {
        throw new Error(`Existing blob differs; refusing overwrite: ${file.blobPath}`);
      }
      reused += 1;
    } else {
      await blob.uploadFile(file.localPath, {
        conditions: { ifNoneMatch: "*" },
        metadata: { sha256: file.sha256 },
        concurrency: 2,
      });
      uploaded += 1;
    }
    const readBackSha256 = await remoteSha256(blob);
    if (readBackSha256 !== file.sha256) throw new Error(`Read-back hash mismatch: ${file.blobPath}`);
  }

  const manifestBlob = container.getBlockBlobClient(`${PREFIX}/SHA256SUMS`);
  if (await manifestBlob.exists()) {
    const existingManifest = await remoteSha256(manifestBlob);
    if (existingManifest !== manifestSha256) throw new Error("Existing remote SHA256SUMS differs; refusing overwrite");
  } else {
    await manifestBlob.upload(manifestText, Buffer.byteLength(manifestText), {
      conditions: { ifNoneMatch: "*" },
      metadata: { sha256: manifestSha256 },
    });
  }
  if (await remoteSha256(manifestBlob) !== manifestSha256) throw new Error("Remote SHA256SUMS read-back mismatch");

  return {
    mode: "executed",
    account: ACCOUNT,
    container: CONTAINER,
    prefix: PREFIX,
    publicAccess: "disabled",
    files: files.length,
    totalBytes,
    uploaded,
    reused,
    manifestSha256,
    verifiedAt: new Date().toISOString(),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--execute")) throw new Error("Usage: node scripts/preserve-evidence-to-azure.mjs [--execute]");
  run({ execute: args.includes("--execute") })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(`[preserve-evidence] ${error.message}`);
      process.exitCode = 1;
    });
}

export { enumerate, run };
