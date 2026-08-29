import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function withIsolatedBicepEnvironment(callback) {
  const isolatedConfig = mkdtempSync(join(tmpdir(), "psm-bicep-test-"));
  const binaryName = process.platform === "win32" ? "bicep.exe" : "bicep";
  const installedBicep = [process.env.AZURE_CONFIG_DIR, join(homedir(), ".azure")]
    .filter(Boolean)
    .map((configDirectory) => join(configDirectory, "bin", binaryName))
    .find((candidate) => existsSync(candidate));
  const isolatedBin = join(isolatedConfig, "bin");
  const dotnetCache = join(isolatedConfig, "dotnet-cache");
  mkdirSync(isolatedBin, { recursive: true });
  mkdirSync(dotnetCache, { recursive: true });
  if (installedBicep) symlinkSync(installedBicep, join(isolatedBin, binaryName));

  try {
    return callback({
      encoding: "utf8",
      env: {
        ...process.env,
        AZURE_CONFIG_DIR: isolatedConfig,
        DOTNET_BUNDLE_EXTRACT_BASE_DIR: dotnetCache,
      },
    });
  } finally {
    rmSync(isolatedConfig, { recursive: true, force: true });
  }
}
