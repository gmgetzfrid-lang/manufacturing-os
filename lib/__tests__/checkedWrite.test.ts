// GAP-402 (narrow) — lib/checkedWrite.ts: a write that cannot silently fail.
//
// The helper: zero matched rows is a typed refusal (no audit row follows),
// a database error is a typed failure with plain language for the two
// codes the Projects area meets, and nothing throws raw Postgres text.
//
// The census (GAP-402 acceptance 3): every `.update(` / `.delete(` on a
// supabase chain in the quality data layers (lib/checklists.ts,
// lib/turnover.ts) must be wrapped in checkedWrite(...). The money files
// (lib/costs.ts, lib/costDocs.ts, lib/changeOrders.ts) are J3's to convert
// (DEC-31: the safety-critical paths first); until they are, the census
// RATCHETS them — the count of unchecked sites may fall, never rise.
//
// projects-tab SAF-21 (J15d): the census counts writes through a client
// handed in as a parameter (`db` / `sb` / `admin` / `client` `.from(…)`) as
// well as through `supabase` — the rule J15a built for its own files
// (lib/__tests__/j15aCheckedWriteCensus.test.ts, now a pointer here).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkedWrite, describeWriteError, isMissingSchemaError, CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";

describe("checkedWrite", () => {
  it("zero rows ⇒ refused (the RLS shape: { data: [], error: null })", async () => {
    const r = await checkedWrite(Promise.resolve({ data: [], error: null }));
    expect(r).toEqual({ ok: false, code: "refused", error: CHECKED_WRITE_REFUSED });
    const n = await checkedWrite(Promise.resolve({ data: null, error: null }));
    expect(n.ok).toBe(false);
  });
  it("a database error ⇒ db failure, translated, never thrown", async () => {
    const missing = await checkedWrite(Promise.resolve({ data: null, error: { message: 'relation "public.turnover_review_events" does not exist', code: "42P01" } }));
    expect(missing).toMatchObject({ ok: false, code: "db", pgCode: "42P01" });
    expect((missing as { error: string }).error).toMatch(/latest database migration/);
    const rls = await checkedWrite(Promise.resolve({ data: null, error: { message: 'new row violates row-level security policy for table "checklist_items"', code: "42501" } }));
    expect((rls as { error: string }).error).toMatch(/don't have permission/);
    const other = await checkedWrite(Promise.resolve({ data: null, error: { message: "deadlock detected", code: "40P01" } }));
    // REL-3 (J10): raw driver text is translated too — never shown as written
    expect((other as { error: string }).error).toBe("Someone else changed this at the same moment — nothing was changed. Try again.");
    const thrown = await checkedWrite(Promise.reject(new Error("fetch failed")));
    // REL-3 (J10): a dropped connection is said in words too
    expect(thrown).toMatchObject({ ok: false, code: "db", error: "Couldn't reach the server — check your connection and try again." });
  });
  it("matched rows ⇒ ok with the ids", async () => {
    expect(await checkedWrite(Promise.resolve({ data: [{ id: "a" }, { id: "b" }], error: null }))).toEqual({ ok: true, ids: ["a", "b"] });
    expect(await checkedWrite(Promise.resolve({ data: { id: "one" }, error: null }))).toEqual({ ok: true, ids: ["one"] });
  });
  it("describeWriteError maps by code or by message", () => {
    expect(describeWriteError({ message: "x", code: "42P01" })).toMatch(/migration/);
    expect(describeWriteError({ message: 'relation "public.x" does not exist' })).toMatch(/migration/);
    expect(describeWriteError({ message: "violates row-level security policy" })).toMatch(/permission/);
    expect(describeWriteError({ message: "" })).toMatch(/write failed/);
    // 20261091: an item write gives way to a checklist delete after 500 ms instead of deadlocking
    expect(describeWriteError({ message: "canceling statement due to lock timeout", code: "55P03" })).toBe("Someone is changing or deleting this checklist right now — nothing was changed. Try again.");
  });
  it("a pending migration in PostgREST's schema-cache shapes (PGRST204 / PGRST205) and raw 42703 reads as the migration message, never raw text", async () => {
    // What setPunchStatus (closed_by_name…), a punch add with a location or
    // details, and a history read actually meet before 20261091.
    const column = { message: "Could not find the 'completed_basis' column of 'project_checklists' in the schema cache", code: "PGRST204" };
    const table = { message: "Could not find the table 'public.turnover_review_events' in the schema cache", code: "PGRST205" };
    const rawColumn = { message: 'column "closed_by_name" of relation "punch_items" does not exist', code: "42703" };
    for (const e of [column, table, rawColumn]) {
      expect(describeWriteError(e), e.code).toBe("This needs the latest database migration applied — nothing was changed.");
      const r = await checkedWrite(Promise.resolve({ data: null, error: e }));
      expect(r).toMatchObject({ ok: false, code: "db", pgCode: e.code });
      expect((r as { error: string }).error).not.toMatch(/schema cache|does not exist/);
    }
    // …by message alone too (a proxy that strips the code)
    expect(describeWriteError({ message: column.message })).toMatch(/latest database migration/);
    expect(describeWriteError({ message: rawColumn.message })).toMatch(/latest database migration/);
    // …and an unrelated PostgREST error still carries its own message
    // REL-3 (J10): PostgREST's single-row text is translated, not passed through
    expect(describeWriteError({ message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" })).toBe("That record wasn't found — it may have been removed, or you can't see it.");
  });
  it("isMissingSchemaError is true for the pending-migration shapes only — a denial or an outage is never 'not there yet'", () => {
    for (const e of [
      { message: "x", code: "42P01" }, { message: "x", code: "42703" }, { message: "x", code: "PGRST204" }, { message: "x", code: "PGRST205" },
      { message: 'relation "public.turnover_review_events" does not exist' },
      { message: "Could not find the table 'public.turnover_review_events' in the schema cache" },
    ]) expect(isMissingSchemaError(e), JSON.stringify(e)).toBe(true);
    for (const e of [
      { message: "permission denied for table turnover_review_events", code: "42501" },
      { message: "upstream request timeout", code: "PGRST000" },
      { message: "fetch failed" },
    ]) expect(isMissingSchemaError(e), JSON.stringify(e)).toBe(false);
  });
});

// ── the census ───────────────────────────────────────────────────────────

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** projects-tab SAF-21 (J15d): a write through a client handed in as a
 *  PARAMETER — `db.from(…)`, `sb.from(…)`, `admin.from(…)`, `client.from(…)`
 *  — is a supabase write too (the server drains, sweeps and bridges are
 *  handed their client). `Array.from`, a Map's / Set's `delete`, a URL's
 *  `searchParams.delete` and a member access (`auth.admin.from`) never match. */
const CLIENT_PARAM = /(?:^|[^\w.$])(?:db|sb|admin|client)\s*\.\s*from\(/;

/** Statements that carry a supabase update/delete — through `supabase` /
 *  `supabaseAdmin`, or through a client parameter (CLIENT_PARAM) — with
 *  whether the statement routes through checkedWrite. A statement runs from
 *  the previous `;` / `{` boundary to the next `;`. */
function writeSites(text: string): Array<{ line: number; checked: boolean; viaParam: boolean; snippet: string }> {
  const out: Array<{ line: number; checked: boolean; viaParam: boolean; snippet: string }> = [];
  const re = /\.(update|delete)\(/g;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    const start = Math.max(text.lastIndexOf(";", at), text.lastIndexOf("{", at)) + 1;
    const end = text.indexOf(";", at);
    const stmt = text.slice(start, end < 0 ? text.length : end);
    const viaParam = !stmt.includes("supabase");
    if (viaParam && !CLIENT_PARAM.test(stmt)) continue;
    // Checked = routed through checkedWrite, or J3 MONEY-LEDGER's shape: the
    // statement returns the matched rows (`.select("id")`) and the code right
    // after it tests their count (a zero-row match is a refusal, never success).
    const after = text.slice(end < 0 ? text.length : end, (end < 0 ? text.length : end) + 400);
    // (A builder assigned in one statement and awaited with its .select("id")
    // in the next — the change-order decision claim — counts the same way.)
    const countChecked = /\.select\("id"\)/.test(stmt + after.slice(0, 200)) && /\.length\b/.test(after);
    out.push({ line: text.slice(0, at).split("\n").length, checked: stmt.includes("checkedWrite(") || countChecked, viaParam, snippet: stmt.trim().slice(0, 80) });
  }
  return out;
}

describe("census — no raw discarded write result in the quality data layers (GAP-402 acceptance 3)", () => {
  it("lib/checklists.ts and lib/turnover.ts route every update/delete through checkedWrite", () => {
    for (const f of ["lib/checklists.ts", "lib/turnover.ts"]) {
      const sites = writeSites(src(f));
      expect(sites.length, `${f} should have write sites`).toBeGreaterThan(0);
      const raw = sites.filter((s) => !s.checked);
      expect(raw, `${f}: unchecked write(s): ${raw.map((s) => `L${s.line} ${s.snippet}`).join(" | ")}`).toEqual([]);
    }
  });
  it("neither file destructures `{ error }` off a bare update/delete any more (the SAF-3 shape)", () => {
    for (const f of ["lib/checklists.ts", "lib/turnover.ts"]) {
      expect(src(f)).not.toMatch(/const \{ error[^}]*\} = await supabase\.from\("[^"]+"\)\.(update|delete)\(/);
    }
  });
  it("the census itself: a bare update whose result is discarded is flagged; the count-checked and checkedWrite shapes are not", () => {
    const bare = 'async function a() {\n  const { error } = await supabase.from("t").update({ x: 1 }).eq("id", id);\n  if (error) throw error;\n  return rows.length;\n}';
    const counted = 'async function b() {\n  const { data: hit, error } = await supabase.from("t").update({ x: 1 }).eq("id", id).select("id");\n  if (!hit || hit.length === 0) return NO_ROW;\n}';
    const helper = 'async function c() {\n  const r = await checkedWrite(supabase.from("t").update({ x: 1 }).eq("id", id).select("id"));\n}';
    expect(writeSites(bare).map((w) => w.checked)).toEqual([false]);
    expect(writeSites(counted).map((w) => w.checked)).toEqual([true]);
    expect(writeSites(helper).map((w) => w.checked)).toEqual([true]);
  });
  it("SAF-21: a write through a client parameter is counted — a bare one flagged, a checked one not; Array.from, Map / Set delete and searchParams.delete never match", () => {
    for (const p of ["db", "sb", "admin", "client"]) {
      expect(writeSites(`async function a(${p}) {\n  await ${p}.from("t").update({ x: 1 }).eq("id", id);\n}`).map((s) => [s.checked, s.viaParam]), p).toEqual([[false, true]]);
      expect(writeSites(`async function a(${p}) {\n  await ${p}\n    .from("t")\n    .delete().eq("id", id);\n}`).map((s) => s.checked), `${p}, split over lines`).toEqual([false]);
      expect(writeSites(`async function b(${p}) {\n  const w = await checkedWrite(${p}.from("t").delete().eq("id", id).select("id"));\n}`).map((s) => s.checked), p).toEqual([true]);
      expect(writeSites(`async function c(${p}) {\n  const { data: hit } = await ${p}.from("t").update({ x: 1 }).eq("id", id).select("id");\n  if (!hit || hit.length === 0) return NO_ROW;\n}`).map((s) => s.checked), p).toEqual([true]);
    }
    expect(writeSites('function c() {\n  Array.from(keys).forEach((k) => cache.delete(k));\n  next.delete(id);\n  url.searchParams.delete("q");\n  const h = createHash("sha256").update(buf).digest("hex");\n}')).toEqual([]);
    // a member access is not a parameter (nor a name that merely ends in one)
    expect(writeSites('async function d() {\n  await auth.admin.from("t").update({ x: 1 }).eq("id", id);\n  await mydb.from("t").delete().eq("id", id);\n}')).toEqual([]);
    // the `supabase` rule is unchanged
    expect(writeSites('function e() {\n  const r = await supabase.from("t").update({ x: 1 }).eq("id", id);\n}').map((s) => [s.checked, s.viaParam])).toEqual([[false, false]]);
  });
  it("SAF-21: the client-parameter writes the census now sees are all checked — lib/checkoutEpisodes.ts's five (J15a) and every file SAF-21 named", () => {
    const ce = writeSites(src("lib/checkoutEpisodes.ts")).filter((s) => s.viaParam);
    expect(ce.map((s) => s.checked)).toEqual([true, true, true, true, true]);
    // Measured at b138efc7 by this rule: 37 unchecked client-parameter sites.
    const SAF21: Record<string, number> = {
      "lib/equipmentBridgeServer.ts": 14, "lib/serverCollections.ts": 3, "lib/exportRunner.ts": 3, "lib/auditOutboxDrain.ts": 3,
      "lib/projects.ts": 2, "lib/linkProposerServer.ts": 2, "lib/dataRestore.ts": 2, "lib/consentWindowScan.ts": 2,
      "lib/ticketSla.ts": 1, "lib/ticketPreauthorizationApply.ts": 1, "lib/serverRetention.ts": 1, "lib/intakeStaging.ts": 1,
      "lib/archiveCatalog.ts": 1, "lib/aclIndexRebuild.ts": 1,
    };
    for (const [f, before] of Object.entries(SAF21)) {
      const viaParam = writeSites(src(f)).filter((s) => s.viaParam);
      expect(viaParam.length, `${f}: its client-parameter writes are counted (${before} were unchecked)`).toBeGreaterThanOrEqual(before);
      expect(viaParam.filter((s) => !s.checked).map((s) => `L${s.line} ${s.snippet}`), f).toEqual([]);
    }
  });
  it("the money files check every update/delete's matched rows (J3 converted them; the ratchet is at zero)", () => {
    // Baseline at 8276cad was costs 3, costDocs 5, changeOrders 3 unchecked
    // sites; J3 MONEY-LEDGER converted every one (SAF-3's money half).
    for (const f of ["lib/costs.ts", "lib/costDocs.ts", "lib/changeOrders.ts"]) {
      const sites = writeSites(src(f));
      expect(sites.length, `${f} should have write sites`).toBeGreaterThan(0);
      const raw = sites.filter((s) => !s.checked);
      expect(raw, `${f}: unchecked write(s): ${raw.map((s) => `L${s.line} ${s.snippet}`).join(" | ")}`).toEqual([]);
    }
  });
});

// ── the census, widened (projects Round G J12 — GAP-402's remainder) ─────
// GAP-402 converted the safety-critical paths and asked for "a finding for
// the remainder" (DEC-31). The remainder is SAF-18 (projects-tab 02-safety-compliance.md):
// the files below still carry unchecked update/delete sites. This census
// holds the line while it is worked: a file that is clean stays clean, a
// file on the ratchet may only FALL, and a file not named here (new code)
// must be clean. Counts measured at 2af813b + J12 by this file's writeSites.
const walkTs = (dir: string): string[] => {
  const abs = join(process.cwd(), dir);
  return readdirSync(abs).flatMap((f) => {
    if (f === "__tests__") return [];
    const rel = `${dir}/${f}`;
    return statSync(join(abs, f)).isDirectory() ? walkTs(rel) : /\.tsx?$/.test(f) ? [rel] : [];
  });
};
const unchecked = (f: string) => writeSites(src(f)).filter((s) => !s.checked);
/** lib files with no unchecked update/delete — they stay that way. */
const CLEAN_LIB = [
    "lib/answerSkills.ts", "lib/assetAliases.ts", "lib/changeOrders.ts", "lib/checkedWrite.ts", "lib/checklists.ts",
    "lib/codebook.ts", "lib/costDocs.ts", "lib/costs.ts", "lib/distributionAcks.ts", "lib/documentLifecycle/merge.ts",
    "lib/linkProposals.ts", "lib/linkRules.ts", "lib/orchestrator/proposals.ts", "lib/ownership.ts", "lib/relatedResources.ts",
    "lib/transitionIn.ts", "lib/turnover.ts", "lib/workPackages.ts",
    // J15b (SAF-18, 2026-11-18): the intelligence, knowledge, notes and notification files.
    "lib/knowledgeIngest.ts", "lib/knowledge.ts", "lib/knowledgeEmbedCore.ts", "lib/knowledgeSourceSync.ts", "lib/operationalGraph.ts",
    "lib/processFlows.ts", "lib/plotPlans.ts", "lib/aiInstructions.ts", "lib/ai/usageServer.ts", "lib/intents.ts",
    "lib/mentionIndexer.ts", "lib/whiteboard.ts", "lib/notes.ts", "lib/activityThread.ts", "lib/inAppNotifications.ts",
    // J15c (SAF-18, 2026-11-18): the projects and admin lib files.
    "lib/milestones.ts", "lib/projects.ts", "lib/projectReport.ts", "lib/companies.ts",
    "lib/teams.ts", "lib/accessRecert.ts",
    // J15a (SAF-18, 2026-11-18): the document-control and library files.
    "lib/acknowledgments.ts", "lib/assets.ts", "lib/branches.ts", "lib/checkoutEpisodes.ts",
    "lib/collections.ts", "lib/docClass.ts", "lib/documentLifecycle/common.ts", "lib/documentLifecycle/renumber.ts",
    "lib/documentLifecycle/reverse.ts", "lib/documentLifecycle/split.ts", "lib/documentOrigin.ts", "lib/documentShares.ts",
    "lib/effectiveDate.ts", "lib/favorites.ts", "lib/holds.ts", "lib/libraryCollections.ts",
    "lib/libraryViews.ts", "lib/markupRequests.ts", "lib/markups.ts", "lib/retention.ts",
    "lib/reviewControl.ts", "lib/reviewCycles.ts", "lib/revisions.ts", "lib/watches.ts",
    "lib/tableViews.ts", "lib/transmittals.ts", "lib/unitCodeDecode.ts",
    // J15d (SAF-21, 2026-11-18): the files whose writes go through a client
    // parameter (lib/projects.ts is listed above).
    "lib/equipmentBridgeServer.ts", "lib/serverCollections.ts", "lib/exportRunner.ts", "lib/auditOutboxDrain.ts",
    "lib/linkProposerServer.ts", "lib/dataRestore.ts", "lib/consentWindowScan.ts", "lib/ticketSla.ts",
    "lib/ticketPreauthorizationApply.ts", "lib/serverRetention.ts", "lib/intakeStaging.ts", "lib/archiveCatalog.ts",
    "lib/aclIndexRebuild.ts",
];
/** lib files still carrying unchecked sites (SAF-18): the count may fall, never rise. */
const LIB_RATCHET: Record<string, number> = {};
/** Files packages running BESIDE this one (projects Round G wave of
 *  2026-10-01) are editing: the census does not judge them until their
 *  package merges, so a raw write they add fails their own review, not this
 *  census at the merge. Their measured counts stay in the lists above; the
 *  integrator removes a file from here when its package merges (and lowers
 *  or re-measures its number if the package changed it). Emptied by the
 *  integrator at the J12 merge (2026-10-07): J10b, DC P14, DC P15 and I-09 had
 *  all merged, and each file's measured count matched the lists above. */
const IN_FLIGHT: Record<string, string> = {};
const judged = (f: string) => !(f in IN_FLIGHT);
/** The Projects surface outside lib (components/projects, the project and intake routes). */
const PROJECTS_UI_CLEAN = [
    "components/projects/ProjectDocumentsCard.tsx", "components/projects/cost/QuotesPanel.tsx",
    // J15c (SAF-18, 2026-11-18): the Projects surface.
    "components/projects/EditProjectModal.tsx", "components/projects/IntakePanel.tsx", "components/projects/ProjectWizard.tsx", "components/projects/cost/ChangeOrdersPanel.tsx",
    "app/api/intake/upload/route.ts", "app/api/projects/cost-docs/route.ts",
];
const PROJECTS_UI_RATCHET: Record<string, number> = {};

describe("census, widened — every lib file and the Projects surface (GAP-402 remainder → SAF-18)", () => {
  it("the clean files stay clean", () => {
    for (const f of [...CLEAN_LIB, ...PROJECTS_UI_CLEAN].filter(judged)) {
      const raw = unchecked(f);
      expect(raw, `${f}: unchecked write(s): ${raw.map((s) => `L${s.line} ${s.snippet}`).join(" | ")}`).toEqual([]);
    }
  });
  it("the ratcheted files may only fall (lower the number here when one does)", () => {
    for (const [f, max] of Object.entries({ ...LIB_RATCHET, ...PROJECTS_UI_RATCHET }).filter(([f]) => judged(f))) {
      const raw = unchecked(f);
      expect(raw.length, `${f}: ${raw.length} unchecked (was ${max}): ${raw.map((s) => `L${s.line} ${s.snippet}`).join(" | ")}`).toBeLessThanOrEqual(max);
    }
  });
  it("a lib or Projects file not named here (new code) has no unchecked update/delete", () => {
    const known = new Set([...CLEAN_LIB, ...Object.keys(LIB_RATCHET), ...PROJECTS_UI_CLEAN, ...Object.keys(PROJECTS_UI_RATCHET)]);
    const scope = [
      ...walkTs("lib"), ...walkTs("components/projects"),
      ...walkTs("app/api/projects"), ...walkTs("app/api/intake"), ...walkTs("app/(protected)/projects"),
    ];
    const offenders = scope.filter((f) => !known.has(f) && judged(f)).filter((f) => unchecked(f).length > 0);
    expect(offenders).toEqual([]);
  });
  it("every in-flight file is one the lists above measured (it is set aside, never forgotten)", () => {
    const known = new Set([...CLEAN_LIB, ...Object.keys(LIB_RATCHET), ...PROJECTS_UI_CLEAN, ...Object.keys(PROJECTS_UI_RATCHET)]);
    for (const f of Object.keys(IN_FLIGHT)) expect(known.has(f), f).toBe(true);
  });
});

// ── the census, widened to components/ (projects-joint J15e, SAF-22) ─────
// SAF-22: the census never read components/ outside components/projects.
// Measured at c3520544 by writeSites: 7 unchecked sites in 3 files
// (CheckoutFlowModal 2, LibraryOrderModal 2, SetManager 3) — J15e's
// components batch converted them, so every file here is at zero and a new
// unchecked update / delete under components/ fails this test. (The app/
// scope is the J15e app batch's; components/projects is read above.)
const COMPONENTS_SCOPE = ["components"];
const componentFiles = () => COMPONENTS_SCOPE.flatMap(walkTs).filter((f) => !f.startsWith("components/projects/"));

describe("census, widened — components/ (SAF-22, J15e components batch)", () => {
  it("every components/ file outside components/projects has no unchecked update/delete", () => {
    const offenders = componentFiles().filter(judged).flatMap((f) => unchecked(f).map((s) => `${f} L${s.line} ${s.snippet}`));
    expect(offenders).toEqual([]);
  });
  it("the scope is real: it reads the files J15e converted, and their writes are counted (and checked)", () => {
    const files = new Set(componentFiles());
    for (const [f, n] of Object.entries({
      "components/documents/CheckoutFlowModal.tsx": 2, "components/documents/LibraryOrderModal.tsx": 2, "components/documents/SetManager.tsx": 3,
    })) {
      expect(files.has(f), f).toBe(true);
      const sites = writeSites(src(f));
      expect(sites.length, f).toBeGreaterThanOrEqual(n);
      expect(sites.filter((s) => !s.checked), f).toEqual([]);
    }
    expect([...files].some((f) => f.startsWith("components/projects/"))).toBe(false);
  });
});
