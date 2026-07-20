#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

const scanRoots = ["src", "workers", "infra/db/migrations", "tests"];
const excludedFiles = new Set(["scripts/no-mirror-guard.mjs"]);
const excludedDirs = new Set(["node_modules", ".next", ".git", "coverage", "dist"]);

const forbiddenRuntimeTerms = [
  "lutuohzzbcxbpdhybsgd",
  "simpro-sync",
  "quote_data",
  "ops_commissions",
  "ops_commission_cache",
  "simpro_mobile_status_log",
  "NEXT_PUBLIC_SUPABASE",
  "SUPABASE_DB_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const forbiddenLegacyTablePatterns = [
  /\bfrom\s+["'`]?simpro_[a-z0-9_]+/i,
  /\bjoin\s+["'`]?simpro_[a-z0-9_]+/i,
  /\bfrom\s+["'`]?v_[a-z0-9_]+/i,
  /\bjoin\s+["'`]?v_[a-z0-9_]+/i,
];

const forbiddenRoutePatterns = [
  /new\s+SimproClient\b/,
  /@\/lib\/simpro\/client/,
  /simprosuite\.com/,
];

const forbiddenBrowserPatterns = [
  /NEXT_PUBLIC_SIMPRO/i,
  /SIMPRO_BEARER_TOKEN.*console\./i,
];

const forbiddenProductionDataPatterns = [
  /mock[A-Z_a-z0-9]*Business/i,
  /demo[A-Z_a-z0-9]*Business/i,
  /placeholder[A-Z_a-z0-9]*Business/i,
];

const findings = [];

for (const file of filesToScan(root)) {
  const relative = path.relative(root, file);
  const text = fs.readFileSync(file, "utf8");

  for (const term of forbiddenRuntimeTerms) {
    if (text.includes(term)) {
      findings.push({ file: relative, reason: `legacy mirror term: ${term}` });
    }
  }

  for (const pattern of forbiddenLegacyTablePatterns) {
    if (pattern.test(text)) {
      findings.push({ file: relative, reason: `legacy table/view pattern: ${pattern}` });
    }
  }

  for (const pattern of forbiddenBrowserPatterns) {
    if (pattern.test(text)) {
      findings.push({ file: relative, reason: `browser-exposed Simpro secret/log pattern: ${pattern}` });
    }
  }

  for (const pattern of forbiddenProductionDataPatterns) {
    if (pattern.test(text)) {
      findings.push({ file: relative, reason: `production demo/static business data pattern: ${pattern}` });
    }
  }

  if (relative.startsWith(`src${path.sep}app${path.sep}`)) {
    for (const pattern of forbiddenRoutePatterns) {
      if (pattern.test(text)) {
        findings.push({ file: relative, reason: `dashboard route/page Simpro fan-out pattern: ${pattern}` });
      }
    }
  }
}

if (findings.length > 0) {
  console.error("No-mirror guard failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.reason}`);
  }
  process.exit(1);
}

console.log("No-mirror guard passed.");

function* filesToScan(base) {
  for (const entry of scanRoots) {
    const absolute = path.join(base, entry);
    if (!fs.existsSync(absolute)) {
      continue;
    }

    yield* walk(absolute);
  }
}

function* walk(dir) {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excludedDirs.has(dirent.name)) {
      continue;
    }

    const file = path.join(dir, dirent.name);
    const relative = path.relative(root, file);
    if (dirent.isDirectory()) {
      yield* walk(file);
    } else if (shouldScanFile(file) && !excludedFiles.has(relative)) {
      yield file;
    }
  }
}

function shouldScanFile(file) {
  return /\.(ts|tsx|mjs|js|sql|json|md)$/.test(file);
}
