// /api/admin/unit-identity — the unit-identity backfill (intelligence Round
// G, I-13; GAP-305).
//
// The org's own Site Codebook decodes every document number
// (lib/codebook.ts parseDrawingNumber, the one parser) and the decode is
// WRITTEN to documents.unit_code — the graph and the scope read the column,
// they never decode at assembly time (99-fix-sequencing "Do not"). A number
// that does not decode, decodes with no unit segment, or decodes to a unit
// the codebook does not hold is REPORTED (with sample numbers and the
// codebook's own reason) and left empty — never guessed. The same pass sets
// assets.unit_id to the operational unit mapped to each asset's filing
// (units.codebook_code). documents.unit_id is never written. Rules:
// lib/operationalGraph.ts planUnitIdentity.
//
// `dryRun: true` reports what would change and writes nothing (DEC-30: the
// inventory before the apply). Idempotent — re-running writes only drift.
//
// Writer: the service role — documents.unit_code is the decode's column
// (20261138's trigger refuses a person's write; the service role passes),
// so this route is its one writer. Authority: the Operational scope page's
// writer tier (ADMIN_SURFACES "scope".writes, read by the role COLLECTION —
// DEC-35: no role list here), the page that hosts the button. The pass is
// audited (UNIT_IDENTITY_BACKFILL, counts only).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { memberHoldsAny } from "@/lib/roleHeld";
import { adminSurface } from "@/lib/adminSurfaces";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { isMissingColumn } from "@/lib/orgGraph";
import {
  planUnitIdentity,
  type UnitIdentityAsset, type UnitIdentityDoc, type UnitMappingRow,
} from "@/lib/operationalGraph";

export const runtime = "nodejs";
export const maxDuration = 60;

const PAGE = 1000;
const WRITE_CHUNK = 200;
const NOT_APPLIED = "The unit-identity migration (20261138) is not applied yet — apply it, then run the decode.";

const bad = (error: string, status = 400) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

type PgErr = { code?: string; message: string };

/** Every row of an org's table, in keyset order (id ascending). */
async function readAll<T extends { id: string }>(table: string, select: string, orgId: string): Promise<{ rows: T[]; error: PgErr | null }> {
  const rows: T[] = [];
  let last: string | null = null;
  for (;;) {
    let q = supabaseAdmin.from(table).select(select).eq("org_id", orgId);
    if (last !== null) q = q.gt("id", last);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE);
    if (error) return { rows, error: error as PgErr };
    const batch = ((data ?? []) as unknown) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, error: null };
    last = String(batch[batch.length - 1].id);
  }
}

/** Apply one column's planned values in chunks; count what landed. */
async function applyWrites(
  table: "documents" | "assets", column: "unit_code" | "unit_id", orgId: string,
  writes: Map<string | null, string[]>,
): Promise<{ written: number; refused: number; firstError: string | null }> {
  let written = 0, refused = 0;
  let firstError: string | null = null;
  for (const [value, ids] of writes) {
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const chunk = ids.slice(i, i + WRITE_CHUNK);
      const { data, error } = await supabaseAdmin.from(table)
        .update({ [column]: value }).eq("org_id", orgId).in("id", chunk).select("id");
      if (error) { refused += chunk.length; firstError ??= error.message; continue; }
      const landed = ((data ?? []) as unknown[]).length;
      written += landed;
      refused += chunk.length - landed;
    }
  }
  return { written, refused, firstError };
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not authenticated", 401);

  let body: { orgId?: string; dryRun?: boolean };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "");
  if (!orgId) return bad("orgId required");
  const dryRun = body.dryRun !== false;

  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles, email").eq("org_id", orgId).eq("uid", user.id)
    .eq("status", "active").maybeSingle();
  const writers = adminSurface("scope")?.writes ?? [];
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  if (!member || !memberHoldsAny(member, writers)) {
    return bad("Only the roles that edit the operational scope can run the unit decode.", 403);
  }

  const book = await loadCodebookAdmin(supabaseAdmin, orgId);
  const units = await supabaseAdmin.from("units").select("id, codebook_code").eq("org_id", orgId).eq("archived", false);
  if (units.error) return isMissingColumn(units.error) ? bad(NOT_APPLIED, 409) : bad(`Operational units could not be read: ${units.error.message}`, 500);
  const docs = await readAll<UnitIdentityDoc>("documents", "id, document_number, unit_code, unit_id", orgId);
  if (docs.error) return isMissingColumn(docs.error) ? bad(NOT_APPLIED, 409) : bad(`Documents could not be read: ${docs.error.message}`, 500);
  const assets = await readAll<UnitIdentityAsset>("assets", "id, unit_code, unit_id", orgId);
  if (assets.error) return bad(`Equipment could not be read: ${assets.error.message}`, 500);

  const plan = planUnitIdentity({
    docs: docs.rows, assets: assets.rows, units: (units.data ?? []) as UnitMappingRow[], book, dryRun,
  });
  const report = plan.report;

  if (!dryRun) {
    const d = await applyWrites("documents", "unit_code", orgId, plan.docWrites);
    const a = await applyWrites("assets", "unit_id", orgId, plan.assetWrites);
    report.documents.written = d.written;
    report.documents.refused = d.refused;
    report.assets.written = a.written;
    report.assets.refused = a.refused;
    // A refusal is said with its reason — never a silent partial success.
    if (d.firstError) report.notes.push(`${d.refused} document write(s) were refused: ${d.firstError}`);
    else if (d.refused > 0) report.notes.push(`${d.refused} document write(s) matched no row (deleted while the decode ran).`);
    if (a.firstError) report.notes.push(`${a.refused} equipment write(s) were refused: ${a.firstError}`);
    else if (a.refused > 0) report.notes.push(`${a.refused} equipment write(s) matched no row (deleted while the decode ran).`);

    const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
      action: "UNIT_IDENTITY_BACKFILL",
      resource_type: "org", resource_id: orgId,
      org_id: orgId, user_id: user.id,
      user_email: (member as { email?: string | null }).email ?? user.email ?? null,
      details: {
        documents: { scanned: report.documents.scanned, decoded: report.documents.decoded, written: d.written, refused: d.refused, notDecoding: report.documents.notDecoding.count, unknownUnit: report.documents.unknownUnit.count, cleared: report.documents.toClear },
        assets: { scanned: report.assets.scanned, written: a.written, refused: a.refused, set: report.assets.toSet, repointed: report.assets.toRepoint, cleared: report.assets.toClear },
      },
    });
    if (auditErr) report.notes.push(`The decode ran, but its audit record could not be written: ${auditErr.message}`);
  }

  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
