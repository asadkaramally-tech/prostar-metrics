import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import {
  createOrGetCommissionExport,
  downloadCommissionExport,
  getCurrentCommissionRunForExport,
  type CommissionExportType,
} from "@/lib/store/commission-exports";
import { CommissionRevisionConflictError } from "@/lib/store/commission-lifecycle";
import { clearPageLoadCache } from "@/lib/store/page-cache";

const exportTypes = new Set<CommissionExportType>(["payroll_csv", "worksheet_pdf", "calculation_detail_csv"]);

export async function GET(request: Request) {
  const user = await getCurrentUser();
  try {
    assertRole(user, ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const exportId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isSafeInteger(exportId) || exportId <= 0) {
    return NextResponse.json({ error: "id must be a positive integer." }, { status: 400 });
  }
  try {
    const result = await downloadCommissionExport({ exportId, actorEmail: user.email });
    return attachment(result.bytes, result.export.contentType, result.export.filename, result.export.id, result.export.fileHash);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Export is unavailable." }, { status: 404 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  try {
    assertRole(user, ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const periodStart = typeof body.periodStart === "string" ? body.periodStart : "";
  const exportType = typeof body.exportType === "string" ? body.exportType as CommissionExportType : "" as CommissionExportType;
  const expectedRevision = Number(body.expectedRevision);
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) {
    return NextResponse.json({ error: "periodStart must be YYYY-MM-01." }, { status: 400 });
  }
  if (!exportTypes.has(exportType)) {
    return NextResponse.json({ error: "exportType must be payroll_csv, worksheet_pdf, or calculation_detail_csv." }, { status: 400 });
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return NextResponse.json({ error: "expectedRevision must be a nonnegative integer." }, { status: 400 });
  }
  try {
    const run = await getCurrentCommissionRunForExport(periodStart);
    if (!run) return NextResponse.json({ error: "No current immutable run exists for this period." }, { status: 404 });
    const result = await createOrGetCommissionExport({ run, expectedRevision, exportType, actorEmail: user.email });
    clearPageLoadCache();
    const response = attachment(result.bytes, result.export.contentType, result.export.filename, result.export.id, result.export.fileHash);
    response.headers.set("x-commission-edit-revision", String(result.editRevision));
    response.headers.set("x-commission-period-status", result.periodStatus);
    response.headers.set("x-commission-export-idempotent", String(result.idempotent));
    return response;
  } catch (error) {
    if (error instanceof CommissionRevisionConflictError) {
      return NextResponse.json({ error: error.message, currentRevision: error.currentRevision }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to export commission run." }, { status: 400 });
  }
}

function attachment(bytes: Uint8Array, contentType: string, filename: string, id: number, hash: string) {
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename.replaceAll('"', '')}"`,
      "content-length": String(bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-commission-export-id": String(id),
      "x-commission-export-sha256": hash,
    },
  });
}
