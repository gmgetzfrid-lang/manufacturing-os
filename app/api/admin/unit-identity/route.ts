// /api/admin/unit-identity — the unit-identity backfill (intelligence Round
// G, I-13; GAP-305).
//
// The org's own Site Codebook decodes every document number
// (lib/codebook.ts parseDrawingNumber, the one parser) and the decode is
// WRITTEN to documents.unit_code — the graph and the scope read the column,
// they never decode at assembly time (99-fix-sequencing "Do not"). A number
// that does not decode, decodes with no unit segment, or decodes to a unit
// the codebook does not hold is REPORTED (with sample numbers and the
// codebook's own reason) and left empty — never guessed. The same pass
// FILLS an empty assets.unit_id with the operational unit mapped to the
// asset's filing (units.codebook_code); a value already there is never
// rewritten (a disagreement is counted). documents.unit_id is never
// written. Rules: lib/operationalGraph.ts planUnitIdentity.
//
// `dryRun: true` reports what would change and writes nothing (DEC-30: the
// inventory before the apply). Idempotent — re-running writes only drift.
//
// WHAT THE REPORT NAMES. The pass reads every document with the service role
// (RLS bypassed), but its report goes back to the caller: a document's
// number — or the unknown unit code it decodes to — is listed only when the
// caller may read that document. A caller in the controller tier (the
// held collection, lib/permissions isControllerRole — is_org_controller's
// set) sees every document; anyone else gets open-visibility numbers only
// (node_visible's NULL / 'normal' arm) and a count of the rest ("not
// listed"). The Operational scope writer tier also holds roles that see a
// private document only through a grant.
//
// BOUNDED PER CALL. An apply writes at most WRITE_BUDGET rows (documents
// first), in parallel waves, and reports `remaining`; the panel calls again
// until it is 0 (lib/operationalGraph.ts runUnitIdentityBackfill), so a
// large org's first run never meets the function's time limit half-written.
// The audit row is written BEFORE the writes (what this call will write)
// and again after them (what landed) — an interrupted call still leaves its
// "started" row. If the "started" row cannot be written nothing is written.
//
// Writer: the service role — documents.unit_code is the decode's column
// (20261138's trigger refuses a person's write; the service role passes),
// so this route is its one writer. Authority: the Operational scope page's
// writer tier (ADMIN_SURFACES "scope".writes, read by the role COLLECTION —
// DEC-35: no role list here), the page that hosts the button. The pass is
// audited (UNIT_IDENTITY_BACKFILL, counts only).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { memberHoldsAny, heldRoles } from "@/lib/roleHeld";
import { isControllerRole } from "@/lib/permissions";
import type { Role } from "@/types/schema";
import { adminSurface } from "@/lib/adminSurfaces";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { isMissingColumn } from "@/lib/orgGraph";
import {
  planUnitIdentity, UNIT_IDENTITY_WRITE_BUDGET as WRITE_BUDGET,
  type UnitIdentityAsset, type UnitIdentityDoc, type UnitMappingRow,
} from "@/lib/operationalGraph";

export const runtime = "nodejs";
export const maxDuration = 60;

const PAGE = 1000;
const WRITE_CHUNK = 200;
/** Write chunks in flight at once. */
const WRITE_WAVE = 4;
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

type Chunk = { value: string | null; ids: string[] };

/** Cut one column's planned values into chunks, taking at most `budget` rows
 *  (in plan order); return the chunks and how many rows were left out. */
function takeChunks(writes: Map<string | null, string[]>, budget: number): { chunks: Chunk[]; taken: number; left: number } {
  const chunks: Chunk[] = [];
  let taken = 0, left = 0;
  for (const [value, ids] of writes) {
    const room = Math.max(0, budget - taken);
    const mine = ids.slice(0, room);
    left += ids.length - mine.length;
    for (let i = 0; i < mine.length; i += WRITE_CHUNK) chunks.push({ value, ids: mine.slice(i, i + WRITE_CHUNK) });
    taken += mine.length;
  }
  return { chunks, taken, left };
}

/** Apply one column's chunks in bounded parallel waves; count what landed. */
async function applyWrites(
  table: "documents" | "assets", column: "unit_code" | "unit_id", orgId: string, chunks: Chunk[],
): Promise<{ written: number; refused: number; firstError: string | null }> {
  let written = 0, refused = 0;
  let firstError: string | null = null;
  for (let w = 0; w < chunks.length; w += WRITE_WAVE) {
    const wave = chunks.slice(w, w + WRITE_WAVE);
    const results = await Promise.all(wave.map(({ value, ids }) => supabaseAdmin.from(table)
      .update({ [column]: value }).eq("org_id", orgId).in("id", ids).select("id") as unknown as PromiseLike<{ data: unknown[] | null; error: PgErr | null }>));
    results.forEach(({ data, error }, i) => {
      const n = wave[i].ids.length;
      if (error) { refused += n; firstError ??= error.message; return; }
      const landed = (data ?? []).length;
      written += landed;
      refused += n - landed;
    });
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
  // The controller tier sees every document (node_visible); anyone else is
  // shown only the numbers of documents every member may read.
  const seesRestricted = heldRoles(member).some((r) => isControllerRole(r as Role));

  const book = await loadCodebookAdmin(supabaseAdmin, orgId);
  const units = await supabaseAdmin.from("units").select("id, codebook_code").eq("org_id", orgId).eq("archived", false);
  if (units.error) return isMissingColumn(units.error) ? bad(NOT_APPLIED, 409) : bad(`Operational units could not be read: ${units.error.message}`, 500);
  const docs = await readAll<UnitIdentityDoc>("documents", "id, document_number, unit_code, unit_id, visibility", orgId);
  if (docs.error) return isMissingColumn(docs.error) ? bad(NOT_APPLIED, 409) : bad(`Documents could not be read: ${docs.error.message}`, 500);
  const assets = await readAll<UnitIdentityAsset>("assets", "id, unit_code, unit_id", orgId);
  if (assets.error) return bad(`Equipment could not be read: ${assets.error.message}`, 500);

  const plan = planUnitIdentity({
    docs: docs.rows, assets: assets.rows, units: (units.data ?? []) as UnitMappingRow[], book, dryRun, seesRestricted,
  });
  const report = plan.report;

  if (!dryRun) {
    const dc = takeChunks(plan.docWrites, WRITE_BUDGET);
    const ac = takeChunks(plan.assetWrites, WRITE_BUDGET - dc.taken);
    report.remaining = dc.left + ac.left;
    const auditRow = (phase: "started" | "finished", details: Record<string, unknown>) => ({
      action: "UNIT_IDENTITY_BACKFILL",
      resource_type: "org", resource_id: orgId,
      org_id: orgId, user_id: user.id,
      user_email: (member as { email?: string | null }).email ?? user.email ?? null,
      details: { phase, ...details },
    });
    // Counts only. Written BEFORE the writes: a call the platform stops
    // half-way still leaves the record of what it set out to write.
    const { error: startErr } = await supabaseAdmin.from("audit_logs").insert(auditRow("started", {
      documents: { scanned: report.documents.scanned, decoded: report.documents.decoded, planned: report.documents.toWrite, cleared: report.documents.toClear, thisCall: dc.taken, notDecoding: report.documents.notDecoding.count, unknownUnit: report.documents.unknownUnit.count },
      assets: { scanned: report.assets.scanned, planned: report.assets.toSet, thisCall: ac.taken, disagreeWithFiling: report.assets.disagreeWithFiling, keptWithoutFiling: report.assets.keptWithoutFiling },
      remaining: report.remaining,
    }));
    if (startErr) return bad(`The decode did not run: its audit record could not be written (${startErr.message}).`, 500);

    const d = await applyWrites("documents", "unit_code", orgId, dc.chunks);
    const a = await applyWrites("assets", "unit_id", orgId, ac.chunks);
    report.documents.written = d.written;
    report.documents.refused = d.refused;
    report.assets.written = a.written;
    report.assets.refused = a.refused;
    // A refusal is said with its reason — never a silent partial success.
    if (d.firstError) report.notes.push(`${d.refused} document write(s) were refused: ${d.firstError}`);
    else if (d.refused > 0) report.notes.push(`${d.refused} document write(s) matched no row (deleted while the decode ran).`);
    if (a.firstError) report.notes.push(`${a.refused} equipment write(s) were refused: ${a.firstError}`);
    else if (a.refused > 0) report.notes.push(`${a.refused} equipment write(s) matched no row (deleted while the decode ran).`);

    const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert(auditRow("finished", {
      documents: { written: d.written, refused: d.refused },
      assets: { written: a.written, refused: a.refused },
      remaining: report.remaining,
    }));
    if (auditErr) report.notes.push(`The decode ran, but its closing audit record could not be written: ${auditErr.message}`);
  }

  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
