// document-control Round F — P4 REVIEW: the review gate's ancestor-chain
// policy, per-slot completion and roster integrity.
//
//   RG-3   one container-chain resolver (lib/containerChain.ts): a policy on
//          a MID folder governs the leaf below it; scan / resolver / panel /
//          docClass all walk it.
//   RG-6   the policy read fails CLOSED (throws); RevUpModal holds publishing
//          until it resolves and offers a retry.
//   RG-4 / DRLS-6  completion per SLOT GROUP, app twin == SQL twin; a standby
//          or unpaired alternate fills nothing; primaries count in every
//          status so app and guard agree.
//   RG-7   a roster that fails to save WITHDRAWS the submission; the guard
//          refuses an in-review draft with no roster and a required-review
//          Major direct publish.
//   RG-8   the author is skipped from the roster and refused at signing.
//   REV-5  finalize refuses a retired document and a moved-on base (CAS on
//          both pointers); zero rows with the pointer still set is a conflict.
//   REV-7  branches share the active-label unique index; the branch button
//          cannot skip a required review.
//   RG-10  the intake route refuses to repoint past a roster and CASes the
//          pending pointer; reject voids the draft's sign-offs.
//   RG-11  the change type opens unset and is never remembered; the hatch
//          writes REVIEW_GATE_SKIPPED.
//   RG-13  the letter suffix is always on — the never-read useRevLetters
//          field is DELETED (a base-labelled draft would collide with its own
//          predecessor under 20261071); Z / letter bases are explicit.
//   RG-5   document-level review_control is guarded + audited (20261072).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { NextRequest } from "next/server";

// ── a filter-aware PostgREST chain mock shared by both clients ──────────────
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  writes: [] as Array<{ table: string; method: string; args: unknown[]; filters: Array<[string, string, unknown]> }>,
  /** Error queues keyed `${table}.${method}`; each call shifts one entry (null = ok). */
  errors: {} as Record<string, Array<{ message: string; code?: string } | null>>,
  insertIds: {} as Record<string, string>,
  notified: [] as Array<Record<string, unknown>>,
  audited: [] as Array<Record<string, unknown>>,
  signatures: [] as Array<Record<string, unknown>>,
}));
/** `.or("role.in.(\"A\",\"B\"),roles.ov.{\"A\",\"B\"}")` — the roleFilter shape. */
function parseOr(expr: string): (r: Record<string, unknown>) => boolean {
  const parts = expr.split(/,(?![^(]*\))(?![^{]*\})/);
  const preds = parts.map((p) => {
    let m: RegExpExecArray | null;
    if ((m = /^(\w+)\.in\.\(([^)]*)\)$/.exec(p))) { const list = m[2].split(",").map((x) => x.replace(/"/g, "")); const col = m[1]; return (r: Record<string, unknown>) => list.includes(String(r[col])); }
    if ((m = /^(\w+)\.ov\.\{([^}]*)\}$/.exec(p))) { const list = m[2].split(",").map((x) => x.replace(/"/g, "")); const col = m[1]; return (r: Record<string, unknown>) => Array.isArray(r[col]) && (r[col] as string[]).some((x) => list.includes(x)); }
    return () => false;
  });
  return (r) => preds.some((p) => p(r));
}
function chain(table: string) {
  const filters: Array<[string, string, unknown]> = [];
  let pending: { method: string; args: unknown[] } | null = null;
  const rows = () => (db.tables[table] ?? []).filter((r) => filters.every(([op, col, val]) => {
    if (op === "eq") return r[col] === val;
    if (op === "in") return (val as unknown[]).includes(r[col]);
    if (op === "is") return val === null ? r[col] == null : r[col] === val;
    if (op === "not-is") return !(val === null ? r[col] == null : r[col] === val);
    if (op === "not-in") return !(val as string[]).includes(String(r[col]));
    if (op === "or") return (val as (r: Record<string, unknown>) => boolean)(r);
    return true;
  }));
  const errFor = (method: string) => db.errors[`${table}.${method}`]?.shift() ?? null;
  const finish = (): { data: unknown; error: unknown } => {
    if (pending) {
      const w = { table, method: pending.method, args: pending.args, filters: [...filters] };
      db.writes.push(w);
      const err = errFor(pending.method);
      if (err) return { data: null, error: err };
      if (pending.method === "update") {
        const matched = rows();
        for (const r of matched) Object.assign(r, pending.args[0] as Record<string, unknown>);
        return { data: matched.map((r) => ({ id: r.id })), error: null };
      }
      const payload = pending.args[0];
      const list = Array.isArray(payload) ? payload : [payload];
      const inserted = list.map((p, i) => ({ id: db.insertIds[table] ?? `${table}-new-${i}`, ...(p as Record<string, unknown>) }));
      (db.tables[table] ??= []).push(...inserted);
      return { data: inserted, error: null };
    }
    const err = errFor("select");
    if (err) return { data: null, error: err };
    return { data: rows(), error: null };
  };
  const one = (r: { data: unknown; error: unknown }) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error });
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(finish());
      return (...args: unknown[]) => {
        switch (prop) {
          case "eq": filters.push(["eq", String(args[0]), args[1]]); break;
          case "in": filters.push(["in", String(args[0]), args[1]]); break;
          case "is": filters.push(["is", String(args[0]), args[1]]); break;
          case "or": filters.push(["or", "", parseOr(String(args[0]))]); break;
          case "not": {
            const [col, op, val] = args as [string, string, unknown];
            if (op === "is") filters.push(["not-is", col, val]);
            else if (op === "in") filters.push(["not-in", col, String(val).replace(/^\(|\)$/g, "").split(",")]);
            break;
          }
          case "update": case "insert": case "upsert": pending = { method: prop, args }; break;
          case "maybeSingle": case "single": return Promise.resolve(one(finish()));
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({
  // RG-12 (P14): a database before 20261151 has no finalize_reviewed_promote — PostgREST answers PGRST202 and the app keeps its three checked writes, which these tests pin.
  supabase: { from: (t: string) => chain(t), rpc: async (fn?: string) => (fn === "finalize_reviewed_promote" ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.finalize_reviewed_promote" } } : { data: null, error: null }) },
  // The intake route scopes the shared client to the service role around the
  // post-publish pipeline and emit() (projects Round G J1,
  // lib/serverClientScope.ts registers its request-scoped reader here).
  __registerScopedServerClient: vi.fn(),
}));
// projects-joint J16 (GAP-401): the intake door's functions (20261184) answer
// as a database before that migration, so the intake cases below run the
// door's service-role path (the door functions are intakeUploadRoute.test.ts's).
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (t: string) => chain(t), rpc: (fn?: string) => Promise.resolve(String(fn ?? "").startsWith("intake_door_") ? { data: null, error: { code: "PGRST202", message: `Could not find the function public.${String(fn)} in the schema cache` } } : { data: null, error: null }) } }));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => undefined) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/client-s3", () => ({ PutObjectCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@/lib/inAppNotifications", () => ({
  notify: vi.fn(async (n: Record<string, unknown>) => { db.notified.push(n); }),
  // emit() fans out through notifyMany (the intake route's notices).
  notifyMany: vi.fn(async (n: Record<string, unknown>) => { db.notified.push(n); }),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { db.audited.push(e); }),
  logRevisionEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async (s: Record<string, unknown>) => { db.signatures.push(s); return { id: "sig-new" }; }) }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/ownership", () => ({
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: "owner1", name: "Owner" })),
  resolveEffectiveOwner: vi.fn(() => ({ userId: null, name: null })),
  getOrgControllers: vi.fn(async () => ["ctl1"]),
  teamSupervisorMap: vi.fn(async () => new Map()),
}));

import { firstDefinedInChain, folderChainFromMap, loadContainerChain } from "@/lib/containerChain";
import {
  resolveEffectiveReviewControl, resolveReviewControlChain, effectiveReviewControlForDocument,
  evaluateSlotCompletion, reviewCompletionForDraft, listDraftRoster, expandReviewers, openReviewRoster, recordReviewSignoff,
  finalizeReviewedRevision, finalizeReasonMessage, letterLabelFor, nextLetterSuffix, slotGroupKey,
} from "@/lib/reviewControl";
import { resolveEffectiveDocClass, effectiveDocClassForDocument } from "@/lib/docClass";
import { POST as intakeUpload } from "@/app/api/intake/upload/route";
import type { ReviewControl } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}

const REQUIRE: ReviewControl = { mode: "require", reviewerIds: ["lead1"] };
const NONE_CTL: ReviewControl = { mode: "none" };

beforeEach(() => {
  db.tables = {};
  db.writes = [];
  db.errors = {};
  db.insertIds = {};
  db.notified = [];
  db.audited = [];
  db.signatures = [];
});

// ── RG-3 · one resolver, whole chain ────────────────────────────────────────
describe("RG-3 — the policy resolves along the whole container chain", () => {
  it("library=none / mid-folder=require / leaf-folder=undefined resolves to require (pure)", () => {
    const res = resolveReviewControlChain({
      document: null,
      folders: [{ id: "leaf", value: null }, { id: "mid", value: REQUIRE }, { id: "root", value: null }],
      library: NONE_CTL,
    });
    expect(res).toBe(REQUIRE);
    // nearest defined level still wins over a farther one
    expect(resolveReviewControlChain({ document: null, folders: [{ id: "leaf", value: NONE_CTL }, { id: "mid", value: REQUIRE }], library: null }).mode).toBe("none");
    // and the three-level form is a chain of one folder (byte-for-byte the old contract)
    const doc = { mode: "publisher_choice" } as ReviewControl;
    expect(resolveEffectiveReviewControl(doc, REQUIRE, NONE_CTL)).toBe(doc);
    expect(resolveEffectiveReviewControl(null, null, null)).toEqual({ mode: "none" });
  });
  it("the same fixture resolves to require from the live rows (path_ids walked nearest first)", async () => {
    db.tables.collections = [
      { id: "root", path_ids: [], review_control: null },
      { id: "mid", path_ids: ["root"], review_control: REQUIRE },
      { id: "leaf", path_ids: ["root", "mid"], review_control: null },
    ];
    db.tables.libraries = [{ id: "lib1", review_control: NONE_CTL }];
    const chainRead = await loadContainerChain<ReviewControl>("review_control", { documentValue: null, collectionId: "leaf", libraryId: "lib1" });
    expect(chainRead.folders.map((f) => f.id)).toEqual(["leaf", "mid", "root"]);
    expect((await effectiveReviewControlForDocument({ collectionId: "leaf", libraryId: "lib1" })).mode).toBe("require");
    // the leaf alone (the old two-hop read) would have fallen through to the library
    expect(resolveEffectiveReviewControl(null, null, NONE_CTL).mode).toBe("none");
  });
  it("folderChainFromMap (the scan's in-memory walk) orders self → parent → root and skips unknown ids", () => {
    const map = new Map([
      ["leaf", { path_ids: ["root", "mid"], value: null }],
      ["mid", { path_ids: ["root"], value: REQUIRE }],
    ]);
    expect(folderChainFromMap("leaf", map).map((f) => f.id)).toEqual(["leaf", "mid"]);
    expect(folderChainFromMap(null, map)).toEqual([]);
    expect(firstDefinedInChain({ document: undefined, folders: folderChainFromMap("leaf", map), library: NONE_CTL }, (v): v is ReviewControl => !!v)).toBe(REQUIRE);
  });
  it("docClass walks the same chain: a mid-folder 'drawing' classifies the leaf", async () => {
    db.tables.documents = [{ id: "d1", doc_class: null }];
    db.tables.collections = [
      { id: "mid", path_ids: [], doc_class: "drawing" },
      { id: "leaf", path_ids: ["mid"], doc_class: null },
    ];
    db.tables.libraries = [{ id: "lib1", doc_class: null }];
    expect(await effectiveDocClassForDocument({ id: "d1", collectionId: "leaf", libraryId: "lib1" })).toBe("drawing");
    expect(resolveEffectiveDocClass(null, "procedure", "drawing")).toBe("procedure");
    expect(resolveEffectiveDocClass(null, "bogus", "drawing")).toBe("drawing");
  });
  it("every resolver site goes through the shared chain — no hand-rolled two-hop read survives", () => {
    const rc = src("lib/reviewControl.ts");
    expect(rc).toContain('loadContainerChain<ReviewControl>("review_control"');
    expect(rc).toContain("folderChainFromMap<ReviewControl>(doc.collection_id as string | null, folderPolicyMap)");
    expect(rc).toMatch(/from\("collections"\)\.select\("id, path_ids, review_control, owner_user_id, owner_name"\)/);
    expect(rc).not.toMatch(/from\("collections"\)\.select\("review_control"\)/);
    const panel = src("components/documents/ReviewGateSection.tsx");
    expect(panel).toContain("await effectiveReviewControlForDocument({");
    expect(panel).not.toMatch(/from\("collections"\)\.select\("review_control"\)/);
    expect(panel).not.toContain("resolveEffectiveReviewControl(");
    expect(src("lib/docClass.ts")).toContain('loadContainerChain<string>("doc_class"');
  });
});

// ── RG-6 · fail closed ──────────────────────────────────────────────────────
describe("RG-6 — a policy that cannot be read is unknown, never 'none'", () => {
  it("effectiveReviewControlForDocument throws on a PostgREST error on any read", async () => {
    db.tables.collections = [{ id: "leaf", path_ids: [], review_control: null }];
    db.tables.libraries = [{ id: "lib1", review_control: NONE_CTL }];
    db.errors["collections.select"] = [{ message: "schema cache miss", code: "PGRST204" }];
    await expect(effectiveReviewControlForDocument({ collectionId: "leaf", libraryId: "lib1" })).rejects.toThrow(/Couldn't resolve the review policy: schema cache miss/);
    db.errors["libraries.select"] = [{ message: "permission denied" }];
    await expect(effectiveReviewControlForDocument({ collectionId: null, libraryId: "lib1" })).rejects.toThrow(/permission denied/);
  });
  it("RevUpModal: publishing is held until the policy RESOLVES; a failure is 'unknown' with a retry, never mode none", () => {
    const m = src("components/documents/RevUpModal.tsx");
    expect(m).toContain('useState<"loading" | "resolved" | "unknown">("loading")');
    expect(m).toMatch(/catch \(e\) \{\s*\n\s*if \(alive\) \{ setReviewControl\(null\); setReviewPolicyStatus\("unknown"\)/);
    expect(m).toContain('const policyResolved = reviewPolicyStatus === "resolved";');
    // (P13 second review fix: a retired document holds it too — REV-18)
    expect(m).toMatch(/disabled=\{submitting \|\| !file \|\| !policyResolved(?: \|\| !!retiredRefusal)?\}/);
    expect(m).toMatch(/if \(!policyResolved\) \{\s*\n\s*return setError\(/);
    expect(m).toContain("setPolicyAttempt((n) => n + 1)");
    expect(m).not.toMatch(/catch \{ if \(alive\) setReviewControl\(null\); \}/);
  });
  it("ReviewGateSection renders an unreadable policy as exactly that", () => {
    const p = src("components/documents/ReviewGateSection.tsx");
    expect(p).toContain("Pre-publish review policy could not be read");
    expect(p).toMatch(/setPolicyUnknown\(\(e as Error\)\.message/);
  });
  it("setLevelRevUp (the batch path) refuses a sheet whose policy could not be read — never a direct publish", () => {
    const b = src("lib/documentLifecycle/setRevUp.ts");
    expect(b).toMatch(/\} catch \(e\) \{[\s\S]*?throw new Error\(`Couldn't verify the pre-publish review policy for \$\{sheet\.doc\.documentNumber/);
    expect(b).not.toMatch(/unresolved policy → direct publish/);
    // the throw is caught by the per-sheet handler and lands in `failed`, like every other refusal
    expect(b.indexOf("Couldn't verify the pre-publish review policy")).toBeLessThan(b.indexOf("failed.push({"));
  });
});

// ── RG-4 / DRLS-6 · per-slot completion ─────────────────────────────────────
describe("RG-4 / DRLS-6 — completion is evaluated per slot group", () => {
  const row = (o: Partial<{ slot: "primary" | "alternate"; activated: boolean; status: string; signatureId: string | null; slotGroup: string | null }>) =>
    ({ slot: "primary" as const, activated: true, status: "pending", signatureId: null, slotGroup: null, ...o });

  it("the failure scenario: Piping + I&E primaries, a piping alternate activated and signed — NOT complete", () => {
    const rows = [
      row({ slotGroup: "role:Piping", status: "signed", signatureId: "s1" }),
      row({ slotGroup: "role:I&E" }),
      row({ slot: "alternate", activated: true, slotGroup: "role:Piping", status: "signed", signatureId: "s2" }),
    ];
    const r = evaluateSlotCompletion(rows);
    expect(r).toMatchObject({ requiredPrimaries: 2, satisfied: 1, complete: false, unsatisfiedGroups: ["role:I&E"] });
    // the OLD arithmetic (2 signatures >= 2 primaries) would have said complete
    expect(rows.filter((x) => x.status === "signed").length).toBeGreaterThanOrEqual(2);
  });
  it("a paired alternate fills the slot it backs; a standby or unpaired one fills nothing", () => {
    const base = [row({ slotGroup: "person:lead1" }), row({ slotGroup: "person:lead2", status: "signed", signatureId: "s2" })];
    expect(evaluateSlotCompletion([...base, row({ slot: "alternate", activated: true, slotGroup: "person:lead1", status: "signed", signatureId: "s3" })]).complete).toBe(true);
    expect(evaluateSlotCompletion([...base, row({ slot: "alternate", activated: false, slotGroup: "person:lead1", status: "signed", signatureId: "s3" })]).complete).toBe(false);
    expect(evaluateSlotCompletion([...base, row({ slot: "alternate", activated: true, slotGroup: null, status: "signed", signatureId: "s3" })]).complete).toBe(false);
    // one alternate signature fills ONE slot, never two
    expect(evaluateSlotCompletion([
      row({ slotGroup: "role:Eng" }), row({ slotGroup: "role:Eng" }),
      row({ slot: "alternate", activated: true, slotGroup: "role:Eng", status: "signed", signatureId: "s9" }),
    ])).toMatchObject({ requiredPrimaries: 2, satisfied: 1, complete: false });
  });
  it("legacy rows (no group) keep the aggregate arithmetic; a signature-less 'signed' row never counts (RG-1)", () => {
    expect(evaluateSlotCompletion([row({ status: "signed", signatureId: "s1" }), row({}), row({ slot: "alternate", activated: true, status: "signed", signatureId: "s2" })]).complete).toBe(true);
    expect(evaluateSlotCompletion([row({}), row({ slot: "alternate", status: "signed", signatureId: null })])).toMatchObject({ satisfied: 0, complete: false });
    expect(evaluateSlotCompletion([]).complete).toBe(false);
  });
  it("DRLS-6 done-when 3: a VOIDED primary is still a required slot in the app, exactly as the guard counts it", async () => {
    db.tables.document_review_signoffs = [
      { id: "r1", document_id: "d1", document_version_id: "v1", reviewer_user_id: "u1", slot: "primary", activated: true, status: "signed", signature_id: "s1", slot_group: "person:u1", assigned_at: "2026-09-01" },
      { id: "r2", document_id: "d1", document_version_id: "v1", reviewer_user_id: "u2", slot: "primary", activated: true, status: "void", signature_id: null, slot_group: "person:u2", assigned_at: "2026-09-01" },
    ];
    const res = await reviewCompletionForDraft("d1", "v1");
    expect(res.requiredPrimaries).toBe(2);
    expect(res.signed).toBe(1);
    expect(res.complete).toBe(false);
    expect(res.roster.map((r) => r.id)).toEqual(["r1"]); // the displayable rows exclude the voided one
    // the SQL twin counts primaries with no status filter
    const guard = between(mig("20261070_dc_roundF_review_gate_slots.sql"), "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "COMMIT;");
    expect(guard).toContain("count(*) FILTER (WHERE s.slot = 'primary') AS reqs,");
    expect(guard).not.toMatch(/FILTER \(WHERE s\.slot = 'primary' AND s\.status/);
  });
  it("the list pill and the panel run the same evaluator over the same UNFILTERED input (every row, all statuses)", () => {
    const rc = src("lib/reviewControl.ts");
    const summaries = rc.slice(rc.indexOf("export async function getReviewSummaries"), rc.indexOf("export function reviewStatusFor"));
    expect(summaries).toContain("evaluateSlotCompletion(agg.rows)");
    expect(summaries).not.toMatch(/agg\.signed >= agg\.primaries/);
    const panel = src("components/documents/ReviewGateSection.tsx");
    expect(panel).toContain("listDraftRoster(doc.id, pv, { allStatuses: true })");
    expect(panel).toContain("const completion = evaluateSlotCompletion(rosterAll);");
    expect(panel).toContain('setRoster(all.filter((r) => r.status === "pending" || r.status === "signed"));');
    expect(panel).not.toMatch(/evaluateSlotCompletion\(roster\)/);
    expect(panel).not.toMatch(/signedCount >= primaries\.length/);
  });
  it("listDraftRoster filters for display unless asked for every status; a voided primary flips the panel's verdict exactly as it flips finalize's", async () => {
    db.tables.document_review_signoffs = [
      { id: "r1", document_id: "d1", document_version_id: "v1", reviewer_user_id: "u1", slot: "primary", activated: true, status: "signed", signature_id: "s1", slot_group: "person:u1", assigned_at: "2026-09-01" },
      { id: "r2", document_id: "d1", document_version_id: "v1", reviewer_user_id: "u2", slot: "primary", activated: true, status: "void", signature_id: null, slot_group: "person:u2", assigned_at: "2026-09-01" },
    ];
    const shown = await listDraftRoster("d1", "v1");
    expect(shown.map((r) => r.id)).toEqual(["r1"]);
    const all = await listDraftRoster("d1", "v1", { allStatuses: true });
    expect(all.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(evaluateSlotCompletion(shown).complete).toBe(true);  // the displayable subset alone would have enabled Publish
    expect(evaluateSlotCompletion(all).complete).toBe(false);   // what finalize and the guard see — and now the panel
    expect((await reviewCompletionForDraft("d1", "v1")).complete).toBe(false);
  });
  it("DEC-37: a person holding two listed roles fills ONE slot (the first listed role they hold); the other role is not silently covered by them", async () => {
    db.tables.org_members = [
      { org_id: "o1", uid: "a", display_name: "A", email: "a@x", status: "active", role: "I&E", roles: ["I&E", "Piping"] },
      { org_id: "o1", uid: "b", display_name: "B", email: "b@x", status: "active", role: "I&E", roles: ["I&E"] },
    ];
    const r = await expandReviewers("o1", { mode: "require", reviewerRoles: ["I&E", "Piping"] });
    expect(r.primaries.map((x) => [x.uid, x.groupKey])).toEqual([["a", "role:I&E"], ["b", "role:I&E"]]);
    expect(r.warnings).toEqual([expect.stringMatching(/role "Piping" opens no slot — everyone holding it already fills another listed role's slot/)]);
    // list order decides which slot a multi-role holder takes: Piping first places A there and B still covers I&E
    const swapped = await expandReviewers("o1", { mode: "require", reviewerRoles: ["Piping", "I&E"] });
    expect(swapped.primaries.map((x) => [x.uid, x.groupKey])).toEqual([["a", "role:Piping"], ["b", "role:I&E"]]);
    expect(swapped.warnings).toEqual([]);
    // a role nobody holds keeps its own message
    const empty = await expandReviewers("o1", { mode: "require", reviewerRoles: ["I&E", "Civil"] });
    expect(empty.warnings).toEqual([expect.stringMatching(/role "Civil" has no active members/)]);
  });
  it("slot group keys are stamped from the policy entry that resolved each reviewer", async () => {
    db.tables.org_members = [
      { org_id: "o1", uid: "p1", display_name: "P One", email: "p1@x", status: "active", role: "Viewer", roles: ["Viewer"] },
      { org_id: "o1", uid: "e1", display_name: "Eng One", email: "e1@x", status: "active", role: "Engineer", roles: ["Engineer"] },
      { org_id: "o1", uid: "a1", display_name: "Alt One", email: "a1@x", status: "active", role: "Viewer", roles: ["Viewer"] },
      { org_id: "o1", uid: "a2", display_name: "Alt Two", email: "a2@x", status: "active", role: "Viewer", roles: ["Viewer"] },
    ];
    const control: ReviewControl = { mode: "require", reviewerIds: ["p1"], reviewerRoles: ["Engineer"], alternateIds: ["a1", "a2"], alternateBacks: { a1: "person:p1" } };
    const { primaries, alternates, warnings } = await expandReviewers("o1", control);
    expect(primaries.map((r) => [r.uid, r.groupKey])).toEqual([["p1", "person:p1"], ["e1", "role:Engineer"]]);
    expect(alternates.map((r) => [r.uid, r.groupKey])).toEqual([["a1", "person:p1"], ["a2", null]]);
    expect(warnings.join(" ")).toMatch(/Alt Two is not paired with a primary reviewer/);
    expect(slotGroupKey.team("t1")).toBe("team:t1");
  });
});

// ── RG-7 · a roster that fails to save withdraws the submission ─────────────
describe("RG-7 — no stranded reviews", () => {
  const rosterCtl: ReviewControl = { mode: "require", reviewerIds: ["lead1"] };
  const seed = () => {
    db.tables.org_members = [{ org_id: "o1", uid: "lead1", display_name: "Lead", email: "lead@x", status: "active", role: "Engineer", roles: ["Engineer"] }];
    db.tables.document_versions = [{ id: "v2A", created_by: "pub1", superseded_at: null }];
    db.tables.documents = [{ id: "d1", library_id: "lib1", pending_version_id: "v2A", owner_user_id: null, owner_name: null, collection_id: null }];
    db.tables.libraries = [{ id: "lib1", review_control: rosterCtl }];
  };
  const input = { orgId: "o1", documentId: "d1", libraryId: "lib1", versionId: "v2A", revisionLabel: "2A", contentHash: "h", control: rosterCtl, actorId: "pub1", actorName: "Publisher" };

  it("a failed upsert throws, releases the pending pointer (CAS on the draft), retires the draft, audits, notifies nobody", async () => {
    seed();
    db.errors["document_review_signoffs.upsert"] = [{ message: "new row violates row-level security policy" }];
    await expect(openReviewRoster(input)).rejects.toThrow(/could not be saved .*withdrawn: nothing is in review/);
    const ptr = db.writes.find((w) => w.table === "documents" && w.method === "update");
    expect(ptr?.args[0]).toMatchObject({ pending_version_id: null });
    expect(ptr?.filters).toContainEqual(["eq", "pending_version_id", "v2A"]);
    expect(db.tables.documents[0].pending_version_id).toBeNull();
    const retire = db.writes.find((w) => w.table === "document_versions" && w.method === "update");
    expect(retire?.args[0]).toHaveProperty("superseded_at");
    expect(db.audited.map((a) => a.action)).toEqual(["REVIEW_ROSTER_FAILED"]);
    expect(db.notified.filter((n) => n.kind === "review_requested")).toEqual([]);
  });
  it("a pre-20261070 database (no slot_group column) still opens the roster, without groups", async () => {
    seed();
    db.errors["document_review_signoffs.upsert"] = [{ message: "column \"slot_group\" of relation \"document_review_signoffs\" does not exist", code: "42703" }, null];
    await openReviewRoster(input);
    const ups = db.writes.filter((w) => w.table === "document_review_signoffs" && w.method === "upsert");
    expect(ups.length).toBe(2);
    expect((ups[0].args[0] as Array<Record<string, unknown>>)[0]).toHaveProperty("slot_group", "person:lead1");
    expect((ups[1].args[0] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("slot_group");
    expect(db.audited.map((a) => a.action)).toEqual(["REVIEW_REQUESTED"]);
  });
  it("the success alert in RevUpModal is reachable only after submitForReview resolves (the throw aborts it)", () => {
    const m = src("components/documents/RevUpModal.tsx");
    const submitAt = m.indexOf("const submitted = await submitForReview(common);");
    const alertAt = m.indexOf("Submitted for review — draft");
    expect(submitAt).toBeGreaterThan(0);
    expect(alertAt).toBeGreaterThan(submitAt);
  });
  it("the guard refuses an in-review draft with no roster and a required-review Major direct publish (20261070)", () => {
    const guard = between(mig("20261070_dc_roundF_review_gate_slots.sql"), "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "COMMIT;");
    expect(guard).toMatch(/IF COALESCE\(v_primary_reqs, 0\) = 0 THEN\s*\n\s*SELECT v\.review_state, v\.change_type, v\.intake_link_id/);
    expect(guard).toMatch(/IF v_review_state = 'in_review' AND v_intake_link IS NULL THEN\s*\n\s*RAISE EXCEPTION\s*\n\s*'This draft was submitted for review but has no reviewer roster/);
    expect(guard).toMatch(/IF OLD\.current_version_id IS NOT NULL AND v_intake_link IS NULL\s*\n\s*AND COALESCE\(v_change_type, ''\) NOT IN \('Minor', 'Correction'\) THEN/);
    expect(guard).toContain("review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id)");
    // the rails sit inside the version-advance block, before the DEC-21 clause and the controller short-circuit
    expect(guard.indexOf("has no reviewer roster")).toBeLessThan(guard.indexOf("-- DEC-21: reviewer independence"));
    expect(guard.indexOf("has no reviewer roster")).toBeLessThan(guard.indexOf("IF is_org_controller(NEW.org_id) THEN"));
  });
});

// ── RG-8 · reviewer independence at the roster and at signing ───────────────
describe("RG-8 — the author is not a reviewer of their own revision", () => {
  const seed = (libraryControl: ReviewControl) => {
    db.tables.org_members = [
      { org_id: "o1", uid: "eng1", display_name: "Eng One", email: "e1@x", status: "active", role: "Engineer", roles: ["Engineer"] },
      { org_id: "o1", uid: "eng2", display_name: "Eng Two", email: "e2@x", status: "active", role: "Engineer", roles: ["Engineer"] },
    ];
    db.tables.document_versions = [{ id: "v2A", created_by: "eng1" }];
    db.tables.documents = [{ id: "d1", library_id: "lib1", pending_version_id: "v2A", owner_user_id: null, owner_name: null, collection_id: null }];
    db.tables.libraries = [{ id: "lib1", review_control: libraryControl }];
  };
  const ctl: ReviewControl = { mode: "require", reviewerRoles: ["Engineer"] };
  const input = { orgId: "o1", documentId: "d1", libraryId: "lib1", versionId: "v2A", revisionLabel: "2A", contentHash: "h", control: ctl, actorId: "eng1", actorName: "Eng One" };

  it("openReviewRoster skips the author from the roster and records the skip", async () => {
    seed(ctl);
    await openReviewRoster(input);
    const up = db.writes.find((w) => w.table === "document_review_signoffs" && w.method === "upsert");
    expect((up?.args[0] as Array<Record<string, unknown>>).map((r) => r.reviewer_user_id)).toEqual(["eng2"]);
    expect(db.audited[0]).toMatchObject({ action: "REVIEW_REQUESTED", details: { primaries: 1, authorSkipped: "eng1" } });
  });
  it("when skipping the author empties the roster, the zero-primary escalation says why", async () => {
    seed(ctl);
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid === "eng1");
    await openReviewRoster(input);
    expect(db.writes.filter((w) => w.table === "document_review_signoffs")).toEqual([]);
    const esc = db.notified.filter((n) => n.kind === "review_overdue");
    expect(esc.map((n) => n.userId).sort()).toEqual(["ctl1", "owner1"]);
    expect(String(esc[0].body)).toMatch(/no reviewer resolved/);
    expect(String(esc[0].body)).toMatch(/authored this revision and was skipped/);
  });
  it("a library that opted out of independent review keeps the author on the roster (DEC-21)", async () => {
    seed({ ...ctl, requireIndependentReviewer: false });
    await openReviewRoster(input);
    const up = db.writes.find((w) => w.table === "document_review_signoffs" && w.method === "upsert");
    expect((up?.args[0] as Array<Record<string, unknown>>).map((r) => r.reviewer_user_id).sort()).toEqual(["eng1", "eng2"]);
  });
  it("recordReviewSignoff refuses the author BEFORE minting a signature; a refused read fails closed", async () => {
    seed(ctl);
    const sign = { orgId: "o1", documentId: "d1", libraryId: "lib1", versionId: "v2A", revisionLabel: "2A", signoffId: "r1", signerUserId: "eng1", signerName: "Eng One", statement: "Reviewed" };
    await expect(recordReviewSignoff(sign)).rejects.toThrow(/You authored this revision/);
    expect(db.signatures).toEqual([]);
    db.errors["document_versions.select"] = [{ message: "timeout" }];
    await expect(recordReviewSignoff(sign)).rejects.toThrow(/Couldn't verify who authored this draft: timeout/);
    expect(db.signatures).toEqual([]);
  });
  it("the policy editor says so, and the database guard holds the same rule", () => {
    expect(src("components/documents/ReviewControlModal.tsx")).toContain("A reviewer who authors a revision is skipped on that revision");
    const g = between(mig("20261070_dc_roundF_review_gate_slots.sql"), "CREATE OR REPLACE FUNCTION enforce_review_signoff_guard()", "-- ── RG-4 / RG-7: the publish guard");
    expect(g).toMatch(/v\.created_by::text = auth\.uid\(\)::text/);
    expect(g).toMatch(/requireIndependentReviewer'\)::boolean/);
    expect(g).toContain("You authored this revision, so you can''t sign it as its reviewer");
  });
});

// ── REV-5 · finalize refuses retired records and moved-on bases ─────────────
describe("REV-5 — finalizeReviewedRevision has an expected-base and a status guard", () => {
  const seedDoc = (over: Record<string, unknown>) => {
    db.tables.documents = [{ id: "d1", library_id: "lib1", rev: "3", status: "Issued", current_version_id: "v3", pending_version_id: "v4A", ...over }];
    db.tables.document_versions = [{ id: "v4A", base_rev: "4", revision_label: "4A", effective_date: null, supersedes_version_id: "v3" }];
  };
  it("refuses every not-current status (the shared NOT_CURRENT_STATUSES set) instead of writing Issued", async () => {
    for (const status of ["Superseded", "Archived", "Void"]) {
      seedDoc({ status });
      const res = await finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "ctl1", requireRosterComplete: false });
      expect(res, status).toEqual({ published: false, reason: "retired" });
      expect(db.writes.filter((w) => w.table === "documents")).toEqual([]);
    }
    expect(src("lib/reviewControl.ts")).toContain("NOT_CURRENT_STATUSES.has(String(docRow.status ?? \"\"))");
  });
  it("refuses a draft whose recorded base is no longer the controlled revision; an UNRECORDED base is refused for a roster-reviewed draft", async () => {
    seedDoc({ current_version_id: "v3b" }); // the document moved past v3 — refused on the intake path too
    expect(await finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "ctl1", requireRosterComplete: false })).toEqual({ published: false, reason: "stale_base" });
    seedDoc({});
    db.tables.document_versions[0].supersedes_version_id = null; // unknown base on a draft the reviewers signed
    db.tables.document_review_signoffs = [{ id: "r1", document_id: "d1", document_version_id: "v4A", reviewer_user_id: "u1", slot: "primary", activated: true, status: "signed", signature_id: "s1", slot_group: "person:u1" }];
    expect(await finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "ctl1" })).toEqual({ published: false, reason: "stale_base" });
    expect(db.writes.filter((w) => w.table === "documents")).toEqual([]);
  });
  it("an intake approval (no roster — the approve click IS the review) binds an UNRECORDED base to the current revision atomically through the CAS", async () => {
    seedDoc({});
    db.tables.document_versions[0].supersedes_version_id = null; // a vendor revision submitted before the route stamped its base
    db.tables.document_versions.push({ id: "v3", revision_label: "3", superseded_at: null });
    db.errors["document_versions.update"] = [{ message: "stop after the promote" }]; // the bookkeeping past this point is RG-12's
    await expect(finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "ctl1", requireRosterComplete: false })).rejects.toThrow(/could not be relabeled/);
    const promote = db.writes.find((w) => w.table === "documents" && w.method === "update");
    expect(promote?.filters).toContainEqual(["eq", "current_version_id", "v3"]); // bound to the revision the approver is looking at
    expect(promote?.filters).toContainEqual(["eq", "pending_version_id", "v4A"]);
    expect(src("lib/reviewControl.ts")).toContain('if (draftBase !== previousVersionId && !(draftBase === null && intakeApproval)) return { published: false, reason: "stale_base" };');
  });
  it("the promote compare-and-sets BOTH pointers, and zero rows with the pointer still set is a conflict, not success", async () => {
    seedDoc({});
    db.errors["documents.update"] = [null];
    // simulate a concurrent move: the update matches nothing because we seed the CAS to miss
    db.tables.documents[0].current_version_id = "v3";
    // force the match to fail by making the row change between read and write:
    const original = db.tables.documents[0];
    let reads = 0;
    const origFrom = db.tables.documents;
    Object.defineProperty(db.tables, "documents", {
      configurable: true,
      get() { reads += 1; if (reads === 2) return [{ ...original, current_version_id: "v3-moved" }]; return origFrom; },
      set(v) { Object.defineProperty(db.tables, "documents", { value: v, writable: true, configurable: true }); },
    });
    const res = await finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "ctl1", requireRosterComplete: false });
    expect(res).toEqual({ published: false, reason: "conflict" });
    const promote = db.writes.find((w) => w.table === "documents" && w.method === "update");
    expect(promote?.filters).toContainEqual(["eq", "pending_version_id", "v4A"]);
    expect(promote?.filters).toContainEqual(["eq", "current_version_id", "v3"]);
  });
  it("every refusal has a human message shared by the panel and the intake approve", () => {
    for (const r of ["incomplete", "needs_independent_reviewer", "retired", "stale_base", "conflict", "no_pending_draft", "not_found"]) {
      expect(finalizeReasonMessage(r)).not.toMatch(/^Couldn't publish: /);
    }
    expect(finalizeReasonMessage("weird")).toBe("Couldn't publish: weird");
    expect(src("components/documents/ReviewGateSection.tsx")).toContain("message: finalizeReasonMessage(res.reason)");
    expect(src("components/projects/IntakePanel.tsx")).toContain("throw new Error(finalizeReasonMessage(res.reason));");
  });
});

// ── RG-13 · letters ──────────────────────────────────────────────────────────
describe("RG-13 — the letter suffix is always on (the never-read toggle is deleted) and the letter sequence is explicit", () => {
  it("letterLabelFor has no off switch: every in-review draft gets a letter after the base", () => {
    expect(letterLabelFor("2")).toBe("2A");
    expect(letterLabelFor("2", "2A")).toBe("2B");
    expect(letterLabelFor("R3", "R3")).toBe("R3A");
    const rc = src("lib/reviewControl.ts");
    expect(rc).toMatch(/export function letterLabelFor\(baseRev: string, existingDraftLabel\?: string \| null\): string \{/);
    expect(rc).not.toMatch(/useRevLetters\?:|opts\?\.useRevLetters/);
  });
  it("exhaustion past Z and a letter-valued base are explicit, not string concatenation", () => {
    expect(nextLetterSuffix("")).toBe("A");
    expect(nextLetterSuffix("Z")).toBe("AA");
    expect(nextLetterSuffix("AZ")).toBe("BA");
    expect(nextLetterSuffix("ZZ")).toBe("AAA");
    expect(letterLabelFor("2", "2Z")).toBe("2AA");
    expect(letterLabelFor("2", "2AA")).toBe("2AB");
    expect(letterLabelFor("A")).toBe("AA");
    expect(letterLabelFor("A", "AA")).toBe("AB");
    expect(letterLabelFor("A", "AZ")).toBe("AAA");
  });
  it("neither the policy editor nor the policy type carries useRevLetters — a base-labelled draft would collide with its own predecessor under 20261071 on resubmit", () => {
    expect(src("components/documents/ReviewControlModal.tsx")).not.toMatch(/RevLetters/);
    const t = src("types/schema.ts");
    expect(t).not.toMatch(/useRevLetters\?: boolean/);
    expect(t).toContain("the former `useRevLetters` field is DELETED, not wired");
    // the index that makes a same-label resubmit impossible: one label per un-superseded row, branches included
    expect(mig("20261071_dc_roundF_active_label_index.sql")).toMatch(/document_versions_active_label_uniq_v2\s*\n\s*ON document_versions\(record_id, revision_label\)\s*\n\s*WHERE \(superseded_at IS NULL\);/);
  });
});

// ── RG-11 · the change type is declared, never defaulted ────────────────────
describe("RG-11 — the rev-up form never pre-selects the exemption", () => {
  it("changeType opens unset, is required, and is never rehydrated from memory", () => {
    const m = src("components/documents/RevUpModal.tsx");
    expect(m).toContain('useState<DocumentVersion["changeType"] | "">("")');
    expect(m).not.toMatch(/setChangeType\(remembered/);
    expect(m).toContain('localStorage.setItem(memoryKey, JSON.stringify({ issueType }))');
    expect(m).toContain('<option value="" disabled>Choose…</option>');
    expect(m).toMatch(/if \(!changeType\) return setError\("Choose the change type/);
    // an explicit launcher preset still applies (the check-in's Correction card)
    expect(m).toContain("if (presetChangeType) setChangeType(presetChangeType);");
  });
  it("taking the hatch in a gated library writes REVIEW_GATE_SKIPPED with the declared reason", () => {
    const m = src("components/documents/RevUpModal.tsx");
    const block = between(m, 'action: "REVIEW_GATE_SKIPPED"', "if (branched) {");
    expect(block).toContain("declaredReason: effectiveChangeLog.trim()");
    expect(block).toContain("policyMode: reviewControl.mode");
    // P13 third review fix: a branch is judged by its own mode (the first-issue rule does not route a branch)
    expect(m.slice(0, m.indexOf('action: "REVIEW_GATE_SKIPPED"'))).toMatch(/if \(reviewControl && reviewControl\.mode !== "none" && \(asBranch \? branchEffMode : effMode\) === "none"\) \{\s*\n\s*void logAuditAction\(\{$/m);
  });
});

// ── REV-7 · branches ────────────────────────────────────────────────────────
describe("REV-7 — a branch is still a publish", () => {
  it("the branch button and doPublish(true) refuse while review is required; a duplicate label after a conflict suggests past the interloper", () => {
    const m = src("components/documents/RevUpModal.tsx");
    // P13 third review fix: the branch's own mode (the policy's after the hatch — the first-issue rule does not route a branch)
    expect(m).toContain("disabled={submitting || branchReason.trim().length < 5 || branchWillReview || !policyResolved}");
    expect(m).toMatch(/if \(asBranch && branchWillReview\) \{\s*\n\s*return setError\("This library requires reviewer sign-off/);
    expect(m).toContain('const branchWillReview = branchEffMode === "require" || (branchEffMode === "publisher_choice" && routeThroughReview);');
    expect(m).toContain("setRevisionLabel(suggestNextRevisionLabel(conflict?.currentRev ?? doc.rev));");
  });
  it("20261071 re-creates the active-label unique index WITHOUT the branch exclusion, keeps the old one on failure, and probes existence", () => {
    const m = mig("20261071_dc_roundF_active_label_index.sql");
    expect(m).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS document_versions_active_label_uniq_v2\s*\n\s*ON document_versions\(record_id, revision_label\)\s*\n\s*WHERE \(superseded_at IS NULL\);/);
    expect(m.indexOf("DROP INDEX IF EXISTS document_versions_active_label_uniq;")).toBeGreaterThan(m.indexOf("document_versions_active_label_uniq_v2"));
    expect(m).toMatch(/EXCEPTION WHEN unique_violation OR others THEN/);
    expect(m).toMatch(/indexname = 'document_versions_active_label_uniq_v2'[\s\S]*indexdef NOT LIKE '%is_branch%'/);
    expect(m).toMatch(/CREATE TEMP TABLE IF NOT EXISTS _dc_f71_before AS/);
    expect(m).toMatch(/HAVING COUNT\(\*\) > 1 AND bool_or\(COALESCE\(is_branch, FALSE\)\)/);
  });
});

// ── RG-10 · the external intake door ────────────────────────────────────────
describe("RG-10 — the intake route never repoints past a live review", () => {
  // Document ids are UUIDs — the door refuses anything else before a read (J1).
  const D1 = "00000000-0000-4000-8000-0000000000d1";
  const TOKEN = "abcdefghijklmnop1234";
  // projects Round G J1: a trusted link's OWN document is authored_by_link_id
  // (never inferred from the version chain) and is NOT assigned; an assigned
  // document always goes through review.
  const link = { id: "lnk1", org_id: "o1", project_id: "p1", company_name: "Vendor", contact_email: "v@x", allow_auto_supersede: true, expires_at: null, revoked_at: null, assigned_doc_ids: [] as string[], created_by: "ctl1", token: null, token_hash: createHash("sha256").update(TOKEN).digest("hex"), purpose: "documents", rfq_group: null };
  const seed = () => {
    db.tables.project_intake_links = [link];
    db.tables.projects = [{ id: "p1", org_id: "o1", status: "active", name: "Proj", owner_user_id: "own1", intake_library_id: "lib1", intake_collection_id: "col1" }];
    db.tables.org_members = [{ org_id: "o1", uid: "ctl1", status: "active", role: "DocCtrl", roles: ["DocCtrl"], email: "c@x" }];
    db.insertIds.document_versions = "v-new";
  };
  const post = (fields: Record<string, string>) => {
    const fd = new FormData();
    // The bytes decide the type (J1 SEC-6): a real PDF header.
    fd.set("file", new File([new TextEncoder().encode("%PDF-1.7\n%sheet\n")], "sheet.pdf", { type: "application/pdf" }));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    // The token travels in a header, checked before the body is read (J1 INTK-8).
    return intakeUpload(new NextRequest("http://x/api/intake/upload", { method: "POST", body: fd, headers: { "x-intake-token": TOKEN } }));
  };
  const ownDoc = (over: Record<string, unknown>) => ({ id: D1, org_id: "o1", authored_by_link_id: "lnk1", document_number: "P-101", rev: "2", current_version_id: "v2", library_id: "lib1", checked_out_by: null, legal_hold: false, ...over });

  it("409 when the current pending draft carries any pending/signed roster row — even on a trusted, link-authored document", async () => {
    seed();
    db.tables.document_versions = [{ id: "v-prev", org_id: "o1", record_id: D1, intake_link_id: "lnk1" }];
    db.tables.documents = [ownDoc({ pending_version_id: "v2A" })]; // link-authored
    db.tables.document_review_signoffs = [{ id: "r1", document_version_id: "v2A", status: "signed" }];
    const res = await post({ docId: D1, revLabel: "3" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/reviewer sign-off is in progress/);
    expect(db.writes.filter((w) => w.table === "documents" || w.table === "document_versions")).toEqual([]);
  });
  it("an unreadable roster refuses (fail closed)", async () => {
    seed();
    db.tables.document_versions = [{ id: "v-prev", org_id: "o1", record_id: D1, intake_link_id: "lnk1" }];
    db.tables.documents = [ownDoc({ pending_version_id: "v2A" })];
    db.errors["document_review_signoffs.select"] = [{ message: "boom" }];
    const res = await post({ docId: D1, revLabel: "3" });
    expect(res.status).toBe(503);
  });
  it("the ordinary path stamps the base it was made against and compare-and-sets the pending pointer from NULL", async () => {
    seed();
    db.tables.project_intake_links = [{ ...link, allow_auto_supersede: false, assigned_doc_ids: [D1] }];
    db.tables.document_versions = [];
    db.tables.documents = [{ id: D1, org_id: "o1", document_number: "P-101", rev: "2", current_version_id: "v2", pending_version_id: null, library_id: "lib1", checked_out_by: null, legal_hold: false }];
    const res = await post({ docId: D1, revLabel: "3" });
    expect(res.status).toBe(200);
    const ins = db.writes.find((w) => w.table === "document_versions" && w.method === "insert");
    expect(ins?.args[0]).toMatchObject({ supersedes_version_id: "v2", review_state: "in_review", intake_link_id: "lnk1" });
    const ptr = db.writes.find((w) => w.table === "documents" && w.method === "update");
    expect(ptr?.args[0]).toMatchObject({ pending_version_id: "v-new" });
    expect(ptr?.filters).toContainEqual(["is", "pending_version_id", null]);
  });
  it("a pointer that moved between the read and the write withdraws the new version with 409", async () => {
    seed();
    db.tables.project_intake_links = [{ ...link, allow_auto_supersede: false, assigned_doc_ids: [D1] }];
    db.tables.document_versions = [];
    db.tables.documents = [{ id: D1, org_id: "o1", document_number: "P-101", rev: "2", current_version_id: "v2", pending_version_id: null, library_id: "lib1", checked_out_by: null, legal_hold: false }];
    const original = db.tables.documents;
    let reads = 0;
    Object.defineProperty(db.tables, "documents", {
      configurable: true,
      get() { reads += 1; return reads >= 2 ? [{ ...original[0], pending_version_id: "v-race" }] : original; },
      set(v) { Object.defineProperty(db.tables, "documents", { value: v, writable: true, configurable: true }); },
    });
    const res = await post({ docId: D1, revLabel: "3" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/just went into review/);
    const retire = db.writes.find((w) => w.table === "document_versions" && w.method === "update");
    expect(retire?.args[0]).toHaveProperty("superseded_at");
    expect(retire?.filters).toContainEqual(["eq", "id", "v-new"]);
  });
  it("a trusted link DEMOTED from auto-publish repoints over its own roster-free earlier draft (CAS on that pointer), retires it, and says why the promote was withheld", async () => {
    seed();
    db.tables.document_versions = [{ id: "v-prev", org_id: "o1", record_id: D1, intake_link_id: "lnk1", review_state: "in_review", superseded_at: null }]; // the link's own pending, roster-free draft
    db.tables.documents = [ownDoc({ pending_version_id: "v-prev", legal_hold: true })];
    const res = await post({ docId: D1, revLabel: "3" });
    expect(res.status).toBe(200);
    const ptr = db.writes.find((w) => w.table === "documents" && w.method === "update");
    expect(ptr?.args[0]).toMatchObject({ pending_version_id: "v-new" });
    expect(ptr?.args[0]).not.toHaveProperty("current_version_id"); // demoted: queued for review, never promoted
    expect(ptr?.filters).toContainEqual(["eq", "pending_version_id", "v-prev"]);
    expect(ptr?.filters).not.toContainEqual(["is", "pending_version_id", null]);
    // INTK-4 / SAF-10 (J1): the displaced draft is RESOLVED — review_state
    // 'superseded' + superseded_at — never left 'in_review'.
    const retire = db.writes.find((w) => w.table === "document_versions" && w.method === "update" && w.filters.some(([, c, v]) => c === "id" && v === "v-prev"));
    expect(retire?.args[0]).toMatchObject({ review_state: "superseded" });
    expect(retire?.args[0]).toHaveProperty("superseded_at");
    expect(retire?.filters).toContainEqual(["eq", "review_state", "in_review"]);
    expect(db.tables.document_versions.find((v) => v.id === "v-prev")).toMatchObject({ review_state: "superseded" });
    expect(db.tables.document_versions.find((v) => v.id === "v-new")).toMatchObject({ review_state: "in_review", supersedes_version_id: "v2" });
    expect(String((db.notified[0] as Record<string, unknown> | undefined)?.body)).toMatch(/Auto-publish was withheld: the document is under legal hold/);
  });
  it("the trusted auto path publishes through publish_revision (base CAS in the contract) and never runs over a pending draft", () => {
    // projects Round G J1 (INTK-2 / SAF-5): the raw two-pointer promote is
    // replaced by the publish contract — p_expected_base is the current
    // version read above, so a moved base is 'stale_base' inside the locked
    // row. J1 fix pass (INTK-1 dw3): a trusted link whose own submission is
    // still awaiting review never auto-publishes — the upload replaces that
    // draft IN REVIEW (the CAS repoint + retireDisplaced of the review path
    // above), so the publish branch touches no pending pointer at all.
    const r = src("app/api/intake/upload/route.ts");
    expect(r).toMatch(/supabaseAdmin\.rpc\("publish_revision", \{/);
    expect(r).toContain("expectedBase: (targetDoc.current_version_id as string | null) ?? null,");
    expect(r).toMatch(/if \(autoNow && priorPending\) \{\s*\n\s*autoNow = false; autoWithheld = "your previous submission for this document is still awaiting review";/);
    const auto = between(r, "if (published && versionId) {", "} else {");
    expect(auto).not.toMatch(/pending_version_id/);
    expect(auto).not.toMatch(/retireDisplaced/);
    expect(r).not.toMatch(/\.update\(\{ current_version_id: versionId/);
  });
  it("IntakePanel's reject voids the draft's sign-off rows and surfaces a refusal", () => {
    const p = src("components/projects/IntakePanel.tsx");
    const reject = between(p, "const reject = async", "const portalUrl");
    expect(reject).toMatch(/from\("document_review_signoffs"\)\s*\n\s*\.update\(\{ status: "void"/);
    expect(reject).toContain('.eq("document_version_id", p.pendingVersionId).in("status", ["pending", "signed"]);');
    expect(reject).toMatch(/if \(voidErr\) throw new Error\(/);
  });
});

// ── RG-12 · post-promote bookkeeping is checked; the file is resolved by pointer ──
describe("RG-12 — post-promote writes are checked and viewers resolve by current_version_id", () => {
  const seedDoc = () => {
    db.tables.documents = [{ id: "d1", library_id: "lib1", rev: "3", status: "Issued", current_version_id: "v3", pending_version_id: "v4A" }];
    db.tables.document_versions = [
      { id: "v4A", base_rev: "4", revision_label: "4A", effective_date: null, supersedes_version_id: "v3", review_state: "in_review" },
      { id: "v3", revision_label: "3", superseded_at: null },
    ];
  };
  const fin = () => finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "ctl1", requireRosterComplete: false });

  it("a refused relabel after the promote THROWS naming the inconsistent state — never a silent published:true", async () => {
    seedDoc();
    db.errors["document_versions.update"] = [{ message: 'duplicate key value violates unique constraint "document_versions_active_label_uniq_v2"' }];
    await expect(fin()).rejects.toThrow(/could not be relabeled to Rev 4 \(duplicate key value[\s\S]*Version history is inconsistent/);
    // the promote itself landed (the pointer is the switch viewers follow), so the message is about bookkeeping
    expect(db.tables.documents[0]).toMatchObject({ current_version_id: "v4A", pending_version_id: null });
  });
  it("a refused supersede stamp on the prior revision throws too", async () => {
    seedDoc();
    db.errors["document_versions.update"] = [null, { message: "permission denied" }];
    await expect(fin()).rejects.toThrow(/prior revision could not be marked superseded: permission denied/);
    expect(db.tables.document_versions[0]).toMatchObject({ review_state: "approved", revision_label: "4" });
  });
  it("every file-resolution surface follows documents.current_version_id FIRST; the review_state filter is only the no-pointer fallback", () => {
    const viewer = src("components/viewers/MultiDocViewer.tsx");
    expect(viewer).toMatch(/if \(doc\.currentVersionId\) \{\s*\n\s*const \{ data \} = await supabase\.from\("document_versions"\)\.select\("file_url"\)\.eq\("id", doc\.currentVersionId\)\.single\(\);/);
    expect(viewer.indexOf('.eq("id", doc.currentVersionId).single()')).toBeLessThan(viewer.indexOf('review_state.is.null,review_state.eq.approved'));
    // Round F wave 2 (P1 SHARE): both share routes resolve through ONE helper,
    // lib/shareServe.ts, whose version step is lib/shareRules.ts
    // resolveServedVersion (shared with the share modal's "resolves to") —
    // it follows current_version_id FIRST and applies the review_state
    // filter only on the no-pointer fallback.
    const helper = src("lib/shareRules.ts");
    expect(helper).toContain("if (d.current_version_id) {");
    expect(helper.indexOf("if (d.current_version_id) {")).toBeLessThan(helper.indexOf("review_state.is.null,review_state.eq.approved"));
    expect(src("lib/shareServe.ts")).toContain("await resolveServedVersion(sb, d)");
    for (const f of ["app/api/share/resolve/route.ts", "app/api/share/file/route.ts"]) {
      const s = src(f);
      expect(s, f).toMatch(/import \{[^}]*resolveShareForServing[^}]*\} from "@\/lib\/shareServe";/);
      expect(s, f).toMatch(/await resolveShareForServing\(sb, token[,)]/);
      expect(s, f).not.toContain("review_state.is.null,review_state.eq.approved");
    }
  });
});

// ── Migration shapes ────────────────────────────────────────────────────────
describe("20261070 — review gate slots (bodies from 20261047 / 20261060)", () => {
  const m70 = mig("20261070_dc_roundF_review_gate_slots.sql");
  const m60 = mig("20261060_rp_roundE_archive_publish_authority.sql");
  const m47 = mig("20261047_rp_phase6_sweep_integrity_rails.sql");

  it("enforce_document_publish_guard: only the completion SELECT is replaced; every other live line survives", () => {
    const live = between(m60, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "COMMIT;");
    const next = between(m70, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "COMMIT;");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA.filter((l) => l.trim() !== "")).toEqual([
      "    SELECT count(*) FILTER (WHERE s.slot = 'primary'),",
      "           count(*) FILTER (WHERE s.status = 'signed'",
      "                              AND s.signature_id IS NOT NULL",
      "                              AND EXISTS (",
      "                                SELECT 1 FROM e_signatures e",
      "                                WHERE e.id = s.signature_id",
      "                                  AND e.signer_user_id = s.reviewer_user_id",
      "                                  AND e.org_id = s.org_id",
      "                                  AND (e.document_version_id = s.document_version_id",
      "                                       OR e.document_version_id IS NULL)",
      "                              ))",
      "      FROM document_review_signoffs s",
      "     WHERE s.document_version_id = NEW.current_version_id;",
    ]);
    const added = between(next, "-- RG-4 / DRLS-6: completion is PER SLOT", "-- DEC-21: reviewer independence");
    const declares = ["  v_review_state text;", "  v_change_type  text;", "  v_intake_link  uuid;", "  v_review_mode  text;"];
    for (const l of onlyInB.filter((x) => x.trim() !== "")) {
      expect(l.trim().startsWith("--") || declares.includes(l) || added.includes(l), `unexpected new line: ${l}`).toBe(true);
    }
    // the untouched rails: service pass, OWN-15/OWN-19 disjuncts, DEC-21, controller, authority, hold
    for (const s of [
      "IF v_actor IS NULL THEN", "OR (NEW.status = 'Archived' AND COALESCE(OLD.status, '') <> 'Archived');",
      "Reviewer independence: you are on this revision''s review roster", "IF is_org_controller(NEW.org_id) THEN",
      "user_is_effective_owner(NEW.owner_user_id, NEW.collection_id, NEW.library_id, v_actor)", "Document has an active hold",
      "SECURITY DEFINER SET search_path = public",
    ]) expect(next).toContain(s);
  });

  it("enforce_review_signoff_guard: pure additions to the 20261047 body (identity, activation, standby, author)", () => {
    const live = between(m47, "CREATE OR REPLACE FUNCTION enforce_review_signoff_guard()", "-- ── 3. SURF-11");
    const next = between(m70, "CREATE OR REPLACE FUNCTION enforce_review_signoff_guard()", "-- ── RG-4 / RG-7: the publish guard");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA.filter((l) => l.trim() !== "")).toEqual([]);
    const activation = between(next, "-- RG-4: activating an alternate is a manager's act", "-- SURF-13: a signature is attached only by the act of signing.");
    const signing = between(next, "-- RG-4: a standby alternate has no slot to sign for.", "-- Strict on every axis for NEW signings");
    for (const l of onlyInB.filter((x) => x.trim() !== "")) {
      expect(
        l.trim().startsWith("--") || activation.includes(l) || signing.includes(l) || l === "     OR NEW.slot_group         IS DISTINCT FROM OLD.slot_group",
        `unexpected new line: ${l}`,
      ).toBe(true);
    }
    expect(next).toMatch(/IF NEW\.activated AND NOT OLD\.activated THEN/);
    expect(next).toMatch(/IF OLD\.slot = 'alternate' AND NOT NEW\.activated THEN/);
    expect(next.indexOf("A standby alternate cannot sign")).toBeGreaterThan(next.indexOf("Only the named reviewer can sign their own review row"));
    expect(next.indexOf("You authored this revision")).toBeLessThan(next.indexOf("-- Strict on every axis for NEW signings"));
  });

  it("INSERT policy: pending + unsigned kept, roster shape, publisher tier, org bound to the document", () => {
    const pol = between(m70, "CREATE POLICY doc_review_signoff_insert ON", "-- ── RG-7: the effective review MODE");
    expect(pol).toContain("AND document_review_signoffs.status = 'pending'");
    expect(pol).toContain("AND document_review_signoffs.signature_id IS NULL");
    expect(pol).toMatch(/\(document_review_signoffs\.slot = 'primary' AND document_review_signoffs\.activated\)\s*\n\s*OR \(document_review_signoffs\.slot = 'alternate' AND NOT document_review_signoffs\.activated\)/);
    expect(pol).toContain("is_org_controller(document_review_signoffs.org_id)");
    expect(pol).toContain("AND d.org_id = document_review_signoffs.org_id");
    expect(pol).toContain("user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())");
    expect(pol).toContain("user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id)");
    expect(m70).toMatch(/DROP POLICY IF EXISTS doc_review_signoff_insert ON document_review_signoffs;/);
  });

  it("review_control_mode_for is the SQL twin of the chain walk and is pinned; the file is one paste with inventory first", () => {
    const fn = between(m70, "CREATE OR REPLACE FUNCTION review_control_mode_for(", "REVOKE ALL ON FUNCTION review_control_mode_for");
    expect(fn).toMatch(/CASE WHEN jsonb_typeof\(p_doc_control\) = 'object'/);
    expect(fn).toMatch(/unnest\(c\.path_ids\) WITH ORDINALITY AS p\(id, ord\)[\s\S]*ORDER BY p\.ord DESC\s*\n\s*LIMIT 1/);
    expect(fn).toMatch(/FROM libraries l\s*\n\s*WHERE l\.id = p_library_id/);
    expect(fn).toContain("STABLE SET search_path = public");
    expect(fn).not.toContain("SECURITY DEFINER"); // invoker rights: no cross-org probe by id (the DEFINER guard still reads past RLS)
    const verify0 = m70.slice(m70.indexOf("-- ── Verification + inventory"));
    expect(verify0).toMatch(/SELECT NOT prosecdef AND array_to_string\(proconfig, ','\) LIKE '%search_path=public%'\s*\n\s*FROM pg_proc WHERE proname = 'review_control_mode_for'/);
    expect(m70.indexOf("CREATE TEMP TABLE IF NOT EXISTS _dc_f70_before")).toBeLessThan(m70.indexOf("\nBEGIN;"));
    expect(m70).toMatch(/ALTER TABLE document_review_signoffs ADD COLUMN IF NOT EXISTS slot_group TEXT;/);
    const verify = m70.slice(m70.indexOf("-- ── Verification + inventory"));
    expect(verify).toMatch(/NULL::boolean, n::text FROM _dc_f70_before/);
    expect(verify).not.toMatch(/pg_policies[^\n]*::text[^\n]*LIKE/); // deparsed qual/with_check, never a bare cast
    expect((verify.match(/UNION ALL/g) ?? []).length).toBeGreaterThanOrEqual(9);
  });
  it("REV-5: in-flight intake drafts with no recorded base are inventoried BEFORE apply and backfilled inside the transaction, one audit row per document", () => {
    const before = between(m70, "CREATE TEMP TABLE IF NOT EXISTS _dc_f70_before", "\nBEGIN;");
    expect(before).toMatch(/NO recorded base on a document that has a current revision \(REV-5: backfilled below, audited per document\)[\s\S]*?v\.intake_link_id IS NOT NULL\s*\n\s*AND v\.supersedes_version_id IS NULL AND d\.current_version_id IS NOT NULL/);
    const txn = between(m70, "\nBEGIN;", "\nCOMMIT;");
    expect(txn).toMatch(/UPDATE document_versions v\s*\n\s*SET supersedes_version_id = d\.current_version_id\s*\n\s*FROM documents d\s*\n\s*WHERE d\.pending_version_id = v\.id\s*\n\s*AND d\.current_version_id IS NOT NULL\s*\n\s*AND v\.intake_link_id IS NOT NULL\s*\n\s*AND v\.review_state = 'in_review'\s*\n\s*AND v\.supersedes_version_id IS NULL/);
    expect(txn).toMatch(/INSERT INTO audit_logs \(action, resource_type, resource_id, org_id, user_id, user_email, user_role, details\)\s*\n\s*SELECT 'REVIEW_BASE_BACKFILLED', 'document', document_id::text, org_id, NULL, NULL, NULL,/);
    expect(txn).toContain("'migration', '20261070'");
    const verify = m70.slice(m70.indexOf("-- ── Verification + inventory"));
    expect(verify).toContain("pending intake drafts with NO recorded base on a document with a current revision (REV-5; expect 0)");
    expect(verify).toContain("REVIEW_BASE_BACKFILLED audit rows written by this paste");
  });
});

describe("20261072 — review_control governance (RG-5)", () => {
  const m72 = mig("20261072_dc_roundF_review_control_governance.sql");
  it("document-level review_control takes a controller or the effective owner; every level audits from the database", () => {
    const guard = between(m72, "CREATE OR REPLACE FUNCTION enforce_document_review_control_change()", "DROP TRIGGER IF EXISTS trg_document_review_control_guard");
    expect(guard).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(guard).toMatch(/IF NEW\.review_control IS DISTINCT FROM OLD\.review_control THEN/);
    expect(guard).toContain("NOT is_org_controller(OLD.org_id)");
    expect(guard).toContain("NOT user_is_effective_owner(OLD.owner_user_id, OLD.collection_id, OLD.library_id, auth.uid())");
    expect(m72).toMatch(/CREATE TRIGGER trg_document_review_control_guard\s*\nBEFORE UPDATE ON documents/);
    const audit = between(m72, "CREATE OR REPLACE FUNCTION audit_review_control_change()", "DROP TRIGGER IF EXISTS trg_libraries_review_control_audit");
    expect(audit).toContain("INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)");
    expect(audit).toContain("'REVIEW_CONTROL_CHANGED'");
    expect(audit).toContain("'before', OLD.review_control, 'after', NEW.review_control");
    for (const t of ["libraries", "collections", "documents"]) {
      expect(m72).toMatch(new RegExp(`CREATE TRIGGER trg_${t}_review_control_audit\\s*\\nAFTER UPDATE ON ${t}\\s*\\nFOR EACH ROW EXECUTE FUNCTION audit_review_control_change\\(\\);`));
    }
    expect(m72).toMatch(/CREATE TEMP TABLE IF NOT EXISTS _dc_f72_before AS/);
    expect(m72).toMatch(/SECURITY DEFINER SET search_path = public AS \$\$\s*\nBEGIN\s*\n\s*-- Service-role/);
  });
  it("the library guard (20261036) and the collections policy (20261011) are relied on, not re-defined", () => {
    expect(m72).not.toMatch(/FUNCTION enforce_library_sensitive_columns/);
    expect(m72).not.toMatch(/CREATE POLICY collections_update_controllers/);
    expect(m72).toContain("tgname = 'trg_library_sensitive_columns'");
    expect(m72).toContain("policyname = 'collections_update_controllers'");
  });
});
