import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { quoteDashboardReadModelOptions } from "@/lib/api/dashboard-route-params";
import { getQuoteMetricsReadModel } from "@/lib/store/quote-dashboard-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const options = quoteDashboardReadModelOptions(url.searchParams);
  if (!options) return NextResponse.json({ error: "month is outside the supported reporting range." }, { status: 400 });
  return NextResponse.json(await cachedPageLoad(`api:quotes:${JSON.stringify(options)}`, 120_000, () =>
    getQuoteMetricsReadModel(options),
  ));
}
