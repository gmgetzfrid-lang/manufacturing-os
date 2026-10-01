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
// assets.unit_id is KEPT CURRENT by the database, not by this pass:
// 20261138's trg_assets_unit_id_follows_filing projects the filing on every
// insert and refile, and trg_units_codebook_code_follow moves the projection
// when a unit's mapping changes. This pass only fills what those could not
// see (an item written while its unit was being mapped) — and it fills
// THROUGH the same trigger, so the value is the mapping as it stands at the
// write, never the one this call read.
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
// EVERY WRITE RE-CHECKS WHAT IT WAS PLANNED ON. The plan comes from a read
// taken before the writes, so each UPDATE carries the plan's own condition:
// an equipment item is written only while its unit_id is still EMPTY and it
// is still filed to the codebook unit the plan mapped (`.is("unit_id",
// null)`, `.eq("unit_code", …)`), and the write re-sends that filing rather
// than a unit id — 20261138's trigger fills the empty unit from the mapping
// AT THE WRITE, so a remap between this call's read and its write lands the
// new holder (or none), never the unit this call planned; a row that lands
// with another unit than planned is counted `changed`. A document's decode
// lands only while its number is still one the plan decoded to that value
// (`.in("document_number", …)` — every number in one write decodes to the
// same value, so a renumber to another of them is still right). A row that
// no longer matches is left as it is and counted `changed` (changed since it
// was read) — never refused, never overwritten. 20261138's trigger drops the
// decode on a person's renumber; this keeps the service role from writing it
// back.
//
// THE CODEBOOK IS READ WHOLE. loadCodebookAdmin is one request, which
// PostgREST cuts at max-rows (1,000 entries of every kind); a unit past the
// cut would read as "unknown" and its decodes would be CLEARED. The unit
// entries are therefore read again here in keyset pages and replace the
// book's unit list; if they cannot be read, nothing is planned. Every read
// here (units, documents, equipment, codebook units) pages until an EMPTY
// window, so a project whose max-rows is set below 1,000 is still read whole.
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
import { isMissingColumn } from "@/lib/orgGraph";
import {
  planUnitIdentity, UNIT_IDENTITY_WRITE_BUDGET as WRITE_BUDGET,
  type UnitIdentityAsset, type UnitIdentityDoc, type UnitMappingRow,
} from "@/lib/operationalGraph";
// The reader, the codebook's whole unit list and the guarded document writes
// live in lib/unitCodeDecode.ts (extracted verbatim — document-control P13,
// GAP-314 — so the create-time decode uses exactly these).
import {
  readAll, loadDecodeBook, documentChunks, applyWrites, slices, WRITE_CHUNK, type Chunk,
} from "@/lib/unitCodeDecode";

export const runtime = "nodejs";
export const maxDuration = 60;

const NOT_APPLIED = "The unit-identity migration (20261138) is not applied yet — apply it, then run the decode.";

const bad = (error: string, status = 400) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/** Take at most `budget` planned rows, in plan order; say how many were left. */
function takeBudget<V>(writes: Map<V, string[]>, budget: number): { groups: Array<[V, string[]]>; taken: number; left: number } {
  const groups: Array<[V, string[]]> = [];
  let taken = 0, left = 0;
  for (const [value, ids] of writes) {
    const mine = ids.slice(0, Math.max(0, budget - taken));
    left += ids.length - mine.length;
    taken += mine.length;
    if (mine.length > 0) groups.push([value, mine]);
  }
  return { groups, taken, left };
}

/** assets.unit_id fills: only while unit_id is still EMPTY and the item is
 *  still filed to the codebook unit the plan mapped (DEC-67 §3). The write
 *  re-sends that filing, unchanged; 20261138's trg_assets_unit_id_follows_filing
 *  fills the empty unit from the mapping as it stands at the write, so a row
 *  lands as planned only when it comes back carrying the planned unit. A
 *  planned unit whose filing is unknown (it cannot be — the plan only fills
 *  through a mapped filing) is never written. */
function assetChunks(groups: Array<[string, string[]]>, codeOfUnit: Map<string, string>): { chunks: Chunk[]; unplaceable: number } {
  const chunks: Chunk[] = [];
  let unplaceable = 0;
  for (const [unitId, ids] of groups) {
    const filing = codeOfUnit.get(unitId) ?? null;
    if (filing === null) { unplaceable += ids.length; continue; }
    for (const part of slices(ids, WRITE_CHUNK)) {
      chunks.push({
        patch: { unit_code: filing }, ids: part,
        guard: (q) => q.is("unit_id", null).eq("unit_code", filing),
        returning: "id, unit_id",
        landed: (r) => r.unit_id === unitId,
      });
    }
  }
  return { chunks, unplaceable };
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

  // The book, its unit list from a whole read (never the one cut request).
  const whole = await loadDecodeBook(orgId);
  if (whole.error) return bad(`The Site Codebook's units could not be read: ${whole.error.message} — nothing was planned.`, 500);
  const book = whole.book;
  const units = await readAll<UnitMappingRow>("units", "id, codebook_code", orgId, (q) => q.eq("archived", false));
  if (units.error) return isMissingColumn(units.error) ? bad(NOT_APPLIED, 409) : bad(`Operational units could not be read: ${units.error.message}`, 500);
  const docs = await readAll<UnitIdentityDoc>("documents", "id, document_number, unit_code, unit_id, visibility", orgId);
  if (docs.error) return isMissingColumn(docs.error) ? bad(NOT_APPLIED, 409) : bad(`Documents could not be read: ${docs.error.message}`, 500);
  const assets = await readAll<UnitIdentityAsset>("assets", "id, unit_code, unit_id", orgId);
  if (assets.error) return bad(`Equipment could not be read: ${assets.error.message}`, 500);

  const plan = planUnitIdentity({
    docs: docs.rows, assets: assets.rows, units: units.rows, book, dryRun, seesRestricted,
  });
  const report = plan.report;

  if (!dryRun) {
    const dc = takeBudget(plan.docWrites, WRITE_BUDGET);
    const ac = takeBudget(plan.assetWrites, WRITE_BUDGET - dc.taken);
    report.remaining = dc.left + ac.left;
    const numberOf = new Map(docs.rows.map((d) => [d.id, d.document_number ?? null] as const));
    const codeOfUnit = new Map<string, string>();
    for (const u of units.rows) {
      const c = (u.codebook_code ?? "").trim();
      if (c) codeOfUnit.set(u.id, c);
    }
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

    const d = await applyWrites("documents", orgId, documentChunks(dc.groups, numberOf));
    const placed = assetChunks(ac.groups, codeOfUnit);
    const a = await applyWrites("assets", orgId, placed.chunks);
    a.changed += placed.unplaceable;
    report.documents.written = d.written;
    report.documents.changed = d.changed;
    report.documents.refused = d.refused;
    report.assets.written = a.written;
    report.assets.changed = a.changed;
    report.assets.refused = a.refused;
    // A refusal is said with its reason — never a silent partial success; a
    // row that changed since the read is said too, and left as it is.
    if (d.firstError) report.notes.push(`${d.refused} document write(s) were refused: ${d.firstError}`);
    if (d.changed > 0) report.notes.push(`${d.changed} document(s) changed since they were read (renumbered or deleted while the decode ran) — left as they are; run the decode again to place them.`);
    if (a.firstError) report.notes.push(`${a.refused} equipment write(s) were refused: ${a.firstError}`);
    if (a.changed > 0) report.notes.push(`${a.changed} equipment item(s) changed since they were read (a unit set, refiled, remapped or deleted while the decode ran) — a unit already set is never overwritten, and an item whose unit was remapped took the unit its filing maps to now.`);

    const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert(auditRow("finished", {
      documents: { written: d.written, changed: d.changed, refused: d.refused },
      assets: { written: a.written, changed: a.changed, refused: a.refused },
      remaining: report.remaining,
    }));
    if (auditErr) report.notes.push(`The decode ran, but its closing audit record could not be written: ${auditErr.message}`);
  }

  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
