import { NextResponse } from "next/server";
import { getDatabaseHealthStatus } from "@/lib/store/postgres";
import { loadSimproConfig, publicSimproConfigStatus } from "@/lib/simpro/config";

export async function GET() {
  const database = await getDatabaseHealthStatus();
  const simpro = publicSimproConfigStatus(loadSimproConfig());

  return NextResponse.json({
    ok: database.connected,
    service: "prostar-metrics-dashboard",
    database,
    simpro,
    notes: [
      "Health does not perform broad request-time Simpro fan-out.",
      "Bounded Simpro sample pulls belong to the ingestion worker.",
    ],
  });
}
