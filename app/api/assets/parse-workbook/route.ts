// /api/assets/parse-workbook — the master equipment list door, spreadsheet
// half (intelligence Round G, I-10; GAP-307's list half).
//
// A plant's master equipment list lives in Excel. lib/xlsxData.ts
// parseWorkbook already reads workbooks for the template generator — hardened
// (byte cap, row cap that refuses rather than truncates, prototype guard) and
// SERVER-ONLY. This route runs it for the asset importer and returns plain
// headers + rows; the client then maps columns and previews exactly as it
// does for a pasted CSV (components/assets/AssetCsvImportModal.tsx). Nothing
// is written here.
//
// Authority: the registry writer tier (the importer's own audience —
// ADMIN_SURFACES "assets".writes, read by the role COLLECTION). A member who
// cannot create assets has no reason to have the server parse a workbook.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parseWorkbook } from "@/lib/xlsxData";
import { memberHoldsAny } from "@/lib/roleHeld";
import { adminSurface } from "@/lib/adminSurfaces";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Workbooks arrive base64 in a JSON body; the platform's request cap is
 *  ~4.5 MB, so the file itself is held well under it. */
const MAX_IMPORT_WORKBOOK_BYTES = 3 * 1024 * 1024;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not authenticated", 401);

  let body: { orgId?: string; fileBase64?: string; fileName?: string; sheet?: string };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "");
  if (!orgId) return bad("orgId required");

  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", user.id)
    .eq("status", "active").maybeSingle();
  const writers = adminSurface("assets")?.writes ?? [];
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  if (!member || !memberHoldsAny(member, writers)) {
    return bad("Only the roles that create equipment can import a master list.", 403);
  }

  const b64 = String(body.fileBase64 ?? "");
  if (!b64) return bad("Pick a spreadsheet (.xlsx, .xls or .csv).");
  let bytes: Buffer;
  try { bytes = Buffer.from(b64, "base64"); } catch { return bad("The file could not be read."); }
  if (bytes.byteLength === 0) return bad("The file is empty.");
  if (bytes.byteLength > MAX_IMPORT_WORKBOOK_BYTES) {
    return bad(`That spreadsheet is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the import limit is ${MAX_IMPORT_WORKBOOK_BYTES / 1024 / 1024} MB. Save just the equipment sheet (or as CSV) and try again.`, 413);
  }

  try {
    const sheet = parseWorkbook(bytes, body.sheet ? String(body.sheet) : undefined);
    return NextResponse.json({
      sheetName: sheet.sheetName,
      sheetNames: sheet.sheetNames,
      headers: sheet.headers,
      // Row order follows the header order — the client maps by header name.
      rows: sheet.rows.map((r) => sheet.headers.map((h) => r[h] ?? "")),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // parseWorkbook refuses (never truncates) an over-cap sheet, and refuses a
    // file that tried to alter the runtime — its message says how to fix it.
    return bad((e as Error).message || "The spreadsheet could not be parsed.", 422);
  }
}
