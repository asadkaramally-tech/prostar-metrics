import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("only the bounded readiness endpoint is public among application APIs", async () => {
  const proxySource = await readFile(new URL("../../src/proxy.ts", import.meta.url), "utf8");
  assert.match(proxySource, /const publicPaths = new Set\(\[\s*"\/api\/health"/);
  assert.match(
    proxySource,
    /if \(pathname\.startsWith\("\/api\/"\)\) \{\s*return NextResponse\.json\(\{ error: "Authentication required" \}/,
  );
});
