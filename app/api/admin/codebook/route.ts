// /api/admin/codebook — the Site Codebook's lifecycle actions (intelligence
// Round G, I-16 CODEBOOK LIFECYCLE; CB-5, CB-6).
//
//   * "redecode-preview" / "redecode-apply" (CB-6) — the server-side,
//     admin-triggered re-decode. The plan is lib/assetCategorize.ts
//     planRedecode: the Identity review's code_rederives rows (a filed
//     asset whose stored code the codebook as it stands derives
//     differently), re-derived from the asset's own tag and filing. The
//     filing is never rewritten; a code naming another unit, or a derived
//     code another asset carries, is listed and left to a person. The
//     preview returns every row and a token (sha-256 of redecodeDigest);
//     the apply recomputes the plan and refuses (409, `changed`) unless the
//     token matches — PREVIEW = APPLY: the apply writes exactly the
//     previewed rows, each only while the asset still carries the code the
//     preview read (compare-and-set), through the CALLER's session (RLS and
//     the registry guards decide, as for the Identity review's per-asset
//     accept today). At most REDECODE_WRITE_BUDGET rows per call; the rest
//     is `remaining`, and the page previews and applies again. Audited
//     (CODEBOOK_REDECODE, counts only) before and after the writes. A write
//     that matched no row is re-read with the full view: an asset that still
//     is what the preview read was REFUSED for the caller's session (RLS
//     answers 0 rows and no error, e.g. a controller who also holds Viewer /
//     Auditor under 20261045's assets UPDATE overlay); only an asset whose
//     code or filing moved, or that is gone, counts as changed.
//   * "rename-preview" / "rename" (CB-5) — 20261178's rename_codebook_code,
//     called with the CALLER's session (the function refuses a NULL
//     auth.uid(), anyone outside is_org_controller, and a controller who
//     also holds Viewer / Auditor — 403 with its sentence; one transaction
//     rewrites the filing, the site codes, the process-flow unit ends and the
//     operational-unit mapping, then removes the old code through 20261128's
//     guard). The apply passes the preview's counts as p_expected, so the
//     database refuses it if they moved. Until 20261178 is pasted the RPC is
//     missing (PGRST202 / 42883): the answer is 409 with `needsMigration`,
//     and the page says today's way (add the new code, refile, remove).
//
// AUTHORITY. lib/adminGate.ts authorizeAdminSurface(req, orgId, "codebook")
// admits any active member (the surface's entry is "*"); these actions are
// the surface's WRITES, so the route also requires the registry's writes set
// for the codebook (lib/adminSurfaces.ts adminSurface("codebook").writes),
// tested against the caller's FULL role collection — no role list here
// (DEC-35). The database stays the boundary (is_org_controller in the
// rename, RLS and the guards on every write). admin-and-org P6 carries the
// gate's writes-level intent; the integrator moves this onto it at merge.

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { adminSurface } from "@/lib/adminSurfaces";
import { memberHoldsAny } from "@/lib/roleHeld";
import { callerScopedClient } from "@/lib/serverAuth";
import { readAll } from "@/lib/unitCodeDecode";
import { isMissingColumn } from "@/lib/orgGraph";
import {
  EMPTY_CODEBOOK, renameExpectedCounts, REDECODE_WRITE_BUDGET, RENAME_NOT_APPLIED,
  type Codebook, type CodebookEntry, type DrawingNumberConfig, type IterableRule,
} from "@/lib/codebook";
import { planRedecode, redecodeDigest, type RedecodeRow } from "@/lib/assetCategorize";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Writes in flight at once. */
const WRITE_WAVE = 8;
/** Assets re-read per request when a write matched no row (ids in the URL). */
const RECHECK_CHUNK = 100;
/** A write RLS filtered out while the asset still is what the preview read. */
const RLS_REFUSED = "the registry refused the write for your session — the asset still carries the code the preview read, but row-level security let the write match no row (a writer role held together with Viewer or Auditor leaves the equipment registry read-only)";

const REFUSED = "Only the roles that edit the Site Codebook can re-decode site codes or rename a code.";

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
const ok = (body: unknown) => NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

type PgErr = { code?: string; message: string };
const isMissingRpc = (e: PgErr) =>
  e.code === "PGRST202" || e.code === "42883" || /Could not find the function|function .* does not exist/i.test(e.message ?? "");

/** The whole codebook, every read checked (an unreadable book plans nothing,
 *  never an empty plan that looks like "nothing to re-decode"). */
async function loadBook(orgId: string): Promise<{ book: Codebook; version: number | null } | { error: string }> {
  const entries = await readAll<{ id: string; kind: string; code: string; label: string; meta: CodebookEntry["meta"] | null; sort: number | null; origin: string | null }>(
    "codebook_entries", "id, kind, code, label, meta, sort, origin", orgId);
  if (entries.error) return { error: entries.error.message };
  const { data: cfgRow, error: cfgErr } = await supabaseAdmin.from("codebook_config").select("*").eq("org_id", orgId).maybeSingle();
  if (cfgErr) return { error: cfgErr.message };
  const all = entries.rows.map((r): CodebookEntry => ({
    id: String(r.id), kind: r.kind as CodebookEntry["kind"], code: String(r.code), label: String(r.label),
    meta: r.meta ?? {}, sort: Number(r.sort ?? 0), origin: r.origin === "import" ? "import" : "manual",
  })).sort((a, b) => (a.sort - b.sort) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const cfg = cfgRow as Record<string, unknown> | null;
  const dn = (cfg?.drawing_number ?? null) as DrawingNumberConfig | null;
  const rule = cfg?.iterable_rule as IterableRule | undefined;
  const version = typeof cfg?.codebook_version === "number" ? cfg.codebook_version : null;
  return {
    version,
    book: {
      ...EMPTY_CODEBOOK,
      units: all.filter((e) => e.kind === "unit"),
      equipmentTypes: all.filter((e) => e.kind === "equipment_type"),
      drawingTypes: all.filter((e) => e.kind === "drawing_type"),
      drawingNumber: dn && Array.isArray(dn.segments) && dn.segments.length > 0 ? dn : null,
      iterableRule: { mirrorsTag: rule?.mirrorsTag ?? true, padTo: rule?.padTo ?? 0 },
      legendDocIds: Array.isArray(cfg?.legend_doc_ids) ? (cfg!.legend_doc_ids as string[]) : [],
    },
  };
}

type AssetRow = { id: string; tag: string; unit_code: string | null; code: string | null; archived: boolean | null; codebook_version?: number | null };

/** Every asset of the org (archived included — they hold codes). Before
 *  20261178 there is no codebook_version column (42703): read without it. */
async function loadAssets(orgId: string): Promise<{ rows: AssetRow[]; versioned: boolean } | { error: string }> {
  const first = await readAll<AssetRow>("assets", "id, tag, unit_code, code, archived, codebook_version", orgId);
  if (!first.error) return { rows: first.rows, versioned: true };
  if (!isMissingColumn(first.error)) return { error: first.error.message };
  const again = await readAll<AssetRow>("assets", "id, tag, unit_code, code, archived", orgId);
  if (again.error) return { error: again.error.message };
  return { rows: again.rows, versioned: false };
}

async function plan(orgId: string) {
  const loaded = await loadBook(orgId);
  if ("error" in loaded) return { error: `The Site Codebook could not be read (${loaded.error}) — nothing was planned.` };
  const assets = await loadAssets(orgId);
  if ("error" in assets) return { error: `The equipment registry could not be read (${assets.error}) — nothing was planned.` };
  const active = assets.rows.filter((a) => !a.archived);
  const p = planRedecode(active, loaded.book, assets.rows.map((a) => ({ ...a, archived: !!a.archived })));
  const token = createHash("sha256").update(redecodeDigest(p.rows)).digest("hex");
  const writtenUnderEarlier = assets.versioned && loaded.version !== null
    ? active.filter((a) => (a.code ?? "").trim() && typeof a.codebook_version === "number" && a.codebook_version < loaded.version!).length
    : null;
  return { plan: p, token, codebookVersion: loaded.version, writtenUnderEarlier };
}

export async function POST(req: NextRequest) {
  let body: { orgId?: unknown; action?: unknown; token?: unknown; kind?: unknown; from?: unknown; to?: unknown; expected?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = typeof body.orgId === "string" ? body.orgId : "";
  if (!orgId) return bad("orgId required");

  const actor = await authorizeAdminSurface(req, orgId, "codebook");
  if ("error" in actor) return bad(actor.error, actor.status);
  // The surface admits any member; these are its writes (no role list here).
  const writes = adminSurface("codebook")?.writes ?? [];
  if (writes.length === 0 || !memberHoldsAny({ roles: actor.roles }, writes)) return bad(REFUSED, 403);

  const action = typeof body.action === "string" ? body.action : "";

  if (action === "redecode-preview") {
    const r = await plan(orgId);
    if ("error" in r) return bad(r.error!, 500);
    return ok({ rows: r.plan.rows, skipped: r.plan.skipped, token: r.token, codebookVersion: r.codebookVersion, writtenUnderEarlier: r.writtenUnderEarlier });
  }

  if (action === "redecode-apply") {
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) return bad("Preview the re-decode first — an apply writes exactly what a preview showed.");
    const r = await plan(orgId);
    if ("error" in r) return bad(r.error!, 500);
    if (r.token !== token) {
      return bad("The registry or the Site Codebook changed since the preview, so nothing was written — preview again.", 409, { changed: true });
    }
    const batch: RedecodeRow[] = r.plan.rows.slice(0, REDECODE_WRITE_BUDGET);
    const remaining = r.plan.rows.length - batch.length;
    const caller = callerScopedClient(req);
    if ("error" in caller) return bad(caller.error, caller.status);
    const auditRow = (phase: "started" | "finished", details: Record<string, unknown>) => ({
      action: "CODEBOOK_REDECODE", resource_type: "org", resource_id: orgId, org_id: orgId,
      user_id: actor.userId, user_email: actor.email || null, user_role: actor.admittedRole,
      details: { phase, codebookVersion: r.codebookVersion, ...details },
    });
    // Counts only, BEFORE the writes: a call stopped half-way still leaves
    // the record of what it set out to write. No record, no writes.
    const { error: startErr } = await supabaseAdmin.from("audit_logs").insert(auditRow("started", { planned: r.plan.rows.length, thisCall: batch.length, skipped: r.plan.skipped.length }));
    if (startErr) return bad(`The re-decode did not run: its audit record could not be written (${startErr.message}).`, 500);

    let written = 0, changed = 0, taken = 0, refused = 0;
    let firstError: string | null = null;
    // A write that matched no row, with no error: the compare-and-set found
    // the asset changed — OR the caller's RLS hid it (a controller who also
    // holds Viewer / Auditor: 20261045's RESTRICTIVE assets UPDATE overlay).
    // PostgREST answers both the same way; the re-check below tells them apart.
    const unmatched: RedecodeRow[] = [];
    const now = new Date().toISOString();
    for (let i = 0; i < batch.length; i += WRITE_WAVE) {
      const wave = batch.slice(i, i + WRITE_WAVE);
      const results = await Promise.all(wave.map((row) => caller.from("assets")
        .update({ code: row.to, updated_by: actor.userId, updated_at: now })
        .eq("org_id", orgId).eq("id", row.assetId)
        // compare-and-set: only while the asset still is what the preview read
        .eq("code", row.from).eq("unit_code", row.unitCode)
        .select("id")));
      results.forEach(({ data, error }, k) => {
        if (error) {
          if (error.code === "23505" || /assets_org_code_unique/.test(error.message ?? "")) taken += 1;
          else { refused += 1; firstError ??= error.message; }
          return;
        }
        if (Array.isArray(data) && data.length > 0) written += 1; else unmatched.push(wave[k]);
      });
    }
    // Re-read the unmatched assets with the full view: still what the preview
    // read means the write was refused for this session, not changed.
    for (let i = 0; i < unmatched.length; i += RECHECK_CHUNK) {
      const part = unmatched.slice(i, i + RECHECK_CHUNK);
      const { data: fresh, error: readErr } = await supabaseAdmin.from("assets")
        .select("id, code, unit_code").eq("org_id", orgId).in("id", part.map((r) => r.assetId));
      if (readErr) {
        refused += part.length;
        firstError ??= `${part.length} write(s) did not land, and the registry could not be re-read to tell a refusal from a change (${readErr.message}) — preview again`;
        continue;
      }
      const stored = new Map(((fresh ?? []) as Array<{ id: string; code: string | null; unit_code: string | null }>).map((a) => [String(a.id), a]));
      for (const row of part) {
        const a = stored.get(row.assetId);
        if (a && a.code === row.from && a.unit_code === row.unitCode) {
          refused += 1;
          firstError ??= RLS_REFUSED;
        } else changed += 1;
      }
    }
    const { error: endErr } = await supabaseAdmin.from("audit_logs").insert(auditRow("finished", { written, changed, taken, refused, remaining }));
    if (endErr) firstError ??= `The re-decode ran, but its closing audit record could not be written: ${endErr.message}`;
    return ok({ written, changed, taken, refused, firstError, remaining });
  }

  if (action === "rename-preview" || action === "rename") {
    const kind = body.kind === "unit" || body.kind === "equipment_type" ? body.kind : null;
    const from = typeof body.from === "string" ? body.from.trim() : "";
    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!kind || !from || !to) return bad("kind (unit or equipment_type), from and to are required.");
    const dryRun = action === "rename-preview";
    const expected = dryRun ? null : renameExpectedCounts(body.expected as Record<string, unknown> | null);
    if (!dryRun && !expected) return bad("Preview the rename first — the apply carries the counts you confirmed.");
    const caller = callerScopedClient(req);
    if ("error" in caller) return bad(caller.error, caller.status);
    const { data, error } = await caller.rpc("rename_codebook_code", {
      p_org_id: orgId, p_kind: kind, p_old_code: from, p_new_code: to, p_dry_run: dryRun, p_expected: expected,
    });
    if (error) {
      const e = error as PgErr;
      if (isMissingRpc(e)) return bad(RENAME_NOT_APPLIED, 409, { needsMigration: true });
      const said = (e.message ?? "").replace(/^rename_codebook_code:\s*/, "");
      if (e.code === "42501") return bad(said, 403);
      if (e.code === "40001") return bad(said, 409, { changed: true });
      if (/codebook_entries_in_use/.test(e.message ?? "")) {
        return bad(`Refused — ${(e.message ?? "").replace(/^[\s\S]*?codebook_entries_in_use:\s*/, "")}. Something still referenced the old code when the rename finished (written meanwhile) — nothing was changed; preview again.`, 409);
      }
      if (["23505", "23514", "22023", "P0002", "23503"].includes(e.code ?? "")) return bad(said, 409);
      return bad(`The rename did not run: ${e.message}`, 500);
    }
    return ok(data);
  }

  return bad(`Unknown action: ${action || "(none)"}`);
}
