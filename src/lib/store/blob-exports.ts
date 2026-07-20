import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

let blobServicePromise: Promise<BlobServiceClient | null> | null = null;

export function getCommissionExportBlobStatus() {
  return {
    configured: Boolean(process.env.AZURE_STORAGE_ACCOUNT_NAME && process.env.COMMISSION_EXPORT_CONTAINER),
    accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME ?? null,
    containerName: process.env.COMMISSION_EXPORT_CONTAINER ?? null,
  };
}

export async function uploadCommissionExportBlob(params: {
  storageKey: string;
  content: string | Uint8Array;
  contentType: string;
  fileHash: string;
}) {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const containerName = process.env.COMMISSION_EXPORT_CONTAINER;
  if (!accountName || !containerName) {
    return { uploaded: false, reason: "Azure Blob export storage is not configured." };
  }

  const blobService = await getBlobServiceClient(accountName);
  if (!blobService) {
    return { uploaded: false, reason: "Azure Blob client is unavailable." };
  }

  const container = blobService.getContainerClient(containerName);
  await container.createIfNotExists();
  const blob = container.getBlockBlobClient(params.storageKey);
  const content = typeof params.content === "string" ? Buffer.from(params.content) : Buffer.from(params.content);
  await blob.upload(content, content.byteLength, {
    blobHTTPHeaders: {
      blobContentType: params.contentType,
    },
    metadata: {
      sha256: params.fileHash,
      source: "prostar-metrics-dashboard",
    },
  });

  return { uploaded: true, url: blob.url };
}

async function getBlobServiceClient(accountName: string) {
  if (!blobServicePromise) {
    blobServicePromise = Promise.resolve(
      new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, new DefaultAzureCredential()),
    );
  }
  return blobServicePromise;
}
