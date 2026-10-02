// document-control Round F wave 3 — P17 GUARD & EDITOR FOLLOW-UPS: RG-14,
// the owner-must-approve rule at the database's review completion gate.
//
//   20261159 stamps every roster row with the rule its roster was OPENED
//   under (document_review_signoffs.opened_owner_slot, written by
//   trg_review_signoff_owner_stamp — 'owner:<uid>' / 'none' / 'no_owner' /
//   'author', placeOwnerSlot's outcomes) and the completion gate refuses a
//   roster stamped 'owner:<uid>' unless that slot group carries THAT owner's
//   own bound signature.
//
//   REGRESSION FIRST: the database must never demand an owner the app did not
//   roster — a roster the app opened legitimately has to complete exactly as
//   it does today. So the stamp is a TWIN of the app's roster composition
//   (resolveReviewControlChain → ownerMustApprove === true → readOwnerForApproval
//   / resolveEffectiveOwner → placeOwnerSlot with openReviewRoster's author
//   rule), and this file proves it two ways:
//     1. a transcription of the SQL stamp — pinned to the migration text
//        fragment by fragment — answers the same outcome as the app's pure
//        functions over a matrix of policies, owners, memberships, authors
//        and independence settings;
//     2. the REAL openReviewRoster runs against the in-memory PostgREST with
//        the transcribed stamp bound as the roster's BEFORE INSERT trigger:
//        the rows it writes carry the app's own outcome, a roster with every
//        primary signed passes the transcribed gate, and the same roster
//        without the owner's row (one opened through PostgREST) does not.
//   The SQL itself ran on PostgreSQL 16 (RG-14's record: G-1..G-18b, G-19..G-21).
//   Decided as DEC-44 (P17) (provisional number).
//
//   P17 review fix: the 'author' exception is granted only to the owner
//   OPENING the roster on a version that names no other author (created_by
//   NULL or the opener). created_by is writable by a library publisher
//   through PostgREST, so reading the author from it alone let a publisher
//   who is not the owner name the owner as author and open a roster without
//   them. Every app opener is one of these shapes (submitForReview opens as
//   the version's creator; the intake approve opens an external submission,
//   which has no created_by), so the twin is exact on them; on a version
//   naming someone other than its opener the stamp is stricter — never
//   'author' — and the matrix's "created_by ≠ opener" axis pins that.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  /** auth.uid() of the session that writes the roster. */
  uid: "pub1" as string | null,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() { return makeFakeSupabase(state.db); },
}));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn() }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/ownership", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ownership")>();
  return {
    // the ONE chain is the real one: the owner slot resolves from the rows
    resolveEffectiveOwner: real.resolveEffectiveOwner,
    // the gap notice's recipients only
    effectiveOwnerForDocument: vi.fn(async () => ({ userId: null, name: null, source: null })),
    getOrgControllers: vi.fn(async () => ["ctl1"]),
    teamSupervisorMap: vi.fn(async () => new Map()),
  };
});

import { openReviewRoster, placeOwnerSlot, resolveReviewControlChain } from "@/lib/reviewControl";
import { resolveEffectiveOwner } from "@/lib/ownership";
import { folderChainFromMap } from "@/lib/containerChain";
import type { ReviewControl } from "@/types/schema";

const M = readFileSync(join(process.cwd(), "supabase/migrations/20261159_dc_roundF_guard_owner_and_held_pointer.sql"), "utf8");
const body = (head: string) => { const a = M.indexOf(head); return M.slice(a, M.indexOf("\n$$;", a)); };
const HELPER = body("CREATE OR REPLACE FUNCTION review_control_owner_must_approve_for(");
const STAMP = body("CREATE OR REPLACE FUNCTION review_signoff_owner_stamp()");
const GUARD = body("CREATE OR REPLACE FUNCTION enforce_document_publish_guard()");

// ─── the SQL, transcribed ─────────────────────────────────────────────────
type Db = { tables: Record<string, Row[]> };
const rows = (db: Db, t: string) => db.tables[t] ?? [];
const byId = (db: Db, t: string, id: unknown) => (id == null ? undefined : rows(db, t).find((r) => r.id === id));
/** jsonb_typeof(x) = 'object' */
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** x->'ownerMustApprove' = 'true'::jsonb (JSON true only), COALESCEd false */
const omaTrue = (v: Record<string, unknown>) => v.ownerMustApprove === true;

/** review_control_owner_must_approve_for (20261159): the nearest DEFINED
 *  level (a stored policy object) along document → folder → ancestors
 *  (path_ids, nearest first) → library decides. */
function sqlOwnerMustApproveFor(db: Db, docControl: unknown, collectionId: unknown, libraryId: unknown): boolean {
  if (isObject(docControl)) return omaTrue(docControl);
  const c = byId(db, "collections", collectionId);
  if (c && isObject(c.review_control)) return omaTrue(c.review_control);
  if (c) {
    const path = Array.isArray(c.path_ids) ? (c.path_ids as string[]) : [];
    for (const id of [...path].reverse()) {
      const a = byId(db, "collections", id);
      if (a && isObject(a.review_control)) return omaTrue(a.review_control);
    }
  }
  const l = byId(db, "libraries", libraryId);
  if (l && isObject(l.review_control)) return omaTrue(l.review_control);
  return false;
}
/** member_is_active(v_org, uid) */
const activeIn = (db: Db, org: unknown, uid: unknown) =>
  rows(db, "org_members").some((m) => m.uid === uid && m.status === "active" && (org == null || m.org_id === org));
/** The effective owner user_is_effective_owner names (20261042): document →
 *  folder → library → the owning team's supervisor, an inactive member
 *  skipped; the org is the library's. */
function sqlEffectiveOwner(db: Db, docOwner: unknown, collectionId: unknown, libraryId: unknown): string | null {
  const lib = byId(db, "libraries", libraryId);
  const org = lib?.org_id ?? null;
  if (docOwner != null && activeIn(db, org, docOwner)) return String(docOwner);
  const col = byId(db, "collections", collectionId);
  if (col?.owner_user_id != null && activeIn(db, org, col.owner_user_id)) return String(col.owner_user_id);
  if (lib?.owner_user_id != null && activeIn(db, org, lib.owner_user_id)) return String(lib.owner_user_id);
  const team = lib?.owner_team_id != null ? byId(db, "teams", lib.owner_team_id) : undefined;
  if (team?.supervisor_user_id != null && activeIn(db, org, team.supervisor_user_id)) return String(team.supervisor_user_id);
  return null;
}
/** review_signoff_owner_stamp() (20261159) for a signed-in INSERT; `table`
 *  is the roster table BEFORE this row lands. */
function sqlStamp(db: Db, NEW: Row, uid: string | null, table: Row[]): string | null {
  if (uid === null) return (NEW.opened_owner_slot as string | null) ?? null;
  const open = table.filter((s) => s.document_version_id === NEW.document_version_id);
  if (open.length > 0) {
    const stamps = open.map((s) => s.opened_owner_slot).filter((x): x is string => typeof x === "string");
    return stamps.length ? stamps.reduce((a, b) => (b > a ? b : a)) : null; // max()
  }
  const v = byId(db, "document_versions", NEW.document_version_id);
  const createdBy = (v?.created_by as string | null | undefined) ?? null; // v.created_by, raw
  const d = byId(db, "documents", v?.record_id ?? NEW.document_id);
  if (!d || !sqlOwnerMustApproveFor(db, d.review_control, d.collection_id, d.library_id)) return "none";
  const owner = sqlEffectiveOwner(db, d.owner_user_id, d.collection_id, d.library_id);
  if (owner === null) return "no_owner";
  const lib = byId(db, "libraries", d.library_id);
  const independent = !(isObject(lib?.review_control) && lib!.review_control.requireIndependentReviewer === false);
  // COALESCE(v_independent, true) AND v_owner = auth.uid() AND (v_created_by IS NULL OR v_created_by = auth.uid())
  if (independent && owner === uid && (createdBy === null || createdBy === uid)) return "author";
  return `owner:${owner}`;
}
/** The completion gate's RG-14 check (20261159): refused when a row is
 *  stamped owner:<uid> and no row of that slot group is THAT owner's,
 *  signed, with a bound signature. */
function sqlOwnerGateRefuses(roster: Row[], signatures: Row[]): boolean {
  return roster.some((o) => typeof o.opened_owner_slot === "string" && o.opened_owner_slot.startsWith("owner:")
    && !roster.some((s) => s.slot_group === o.opened_owner_slot
      && `owner:${s.reviewer_user_id}` === o.opened_owner_slot
      && s.status === "signed" && s.signature_id != null
      && signatures.some((e) => e.id === s.signature_id && e.signer_user_id === s.reviewer_user_id && e.org_id === s.org_id
        && (e.document_version_id === s.document_version_id || e.document_version_id == null))));
}

describe("the transcription is the SQL's", () => {
  it("the policy helper: document → folder → ancestors nearest first → library, the nearest stored object deciding, JSON true only", () => {
    for (const f of [
      "CASE WHEN jsonb_typeof(p_doc_control) = 'object' THEN COALESCE(p_doc_control->'ownerMustApprove' = 'true'::jsonb, false) END,",
      "WHERE c.id = p_collection_id AND jsonb_typeof(c.review_control) = 'object'),",
      "CROSS JOIN LATERAL unnest(c.path_ids) WITH ORDINALITY AS p(id, ord)",
      "ORDER BY p.ord DESC",
      "WHERE l.id = p_library_id AND jsonb_typeof(l.review_control) = 'object'),",
      "    false);",
    ]) expect(HELPER, f).toContain(f);
  });

  it("the stamp, in order: the service role trusted, an UPDATE keeps it, an open roster's stamp inherited, then the draft's document, the policy, the owner chain, the author rule", () => {
    const fragments = [
      "  IF auth.uid() IS NULL THEN\n    RETURN NEW;\n  END IF;",
      "  IF TG_OP = 'UPDATE' THEN\n    NEW.opened_owner_slot := OLD.opened_owner_slot;",
      "  SELECT count(*) > 0, max(s.opened_owner_slot) INTO v_open, v_inherited",
      "  IF v_open THEN\n    NEW.opened_owner_slot := v_inherited;",
      "  SELECT v.record_id, v.created_by INTO v_doc_id, v_created_by",
      "    FROM documents d WHERE d.id = COALESCE(v_doc_id, NEW.document_id);",
      "     OR NOT review_control_owner_must_approve_for(v_control, v_collection, v_library) THEN\n    NEW.opened_owner_slot := 'none';",
      "    FROM (VALUES (1, v_doc_owner),",
      "                 (2, (SELECT col.owner_user_id FROM collections col WHERE col.id = v_collection)),",
      "                 (3, (SELECT l.owner_user_id FROM libraries l WHERE l.id = v_library)),",
      "                 (4, (SELECT t.supervisor_user_id FROM libraries l JOIN teams t ON t.id = l.owner_team_id",
      "     AND user_is_effective_owner(v_doc_owner, v_collection, v_library, c.uid)\n   ORDER BY c.ord\n   LIMIT 1;",
      "  IF v_owner IS NULL THEN\n    NEW.opened_owner_slot := 'no_owner';",
      "  SELECT NOT COALESCE(l.review_control->'requireIndependentReviewer' = 'false'::jsonb, false)",
      "  IF COALESCE(v_independent, true)\n     AND v_owner = auth.uid()\n     AND (v_created_by IS NULL OR v_created_by = auth.uid()) THEN\n    NEW.opened_owner_slot := 'author';",
      "  NEW.opened_owner_slot := 'owner:' || v_owner::text;",
    ];
    let at = -1;
    for (const f of fragments) {
      const i = STAMP.indexOf(f, at + 1);
      expect(i, f.slice(0, 80)).toBeGreaterThan(at);
      at = i;
    }
  });

  it("the gate: an owner-stamped row needs that owner's own signed row in that slot group, with a signature bound as the per-slot count binds it", () => {
    for (const f of [
      "            AND o.opened_owner_slot LIKE 'owner:%'",
      "                 AND s.slot_group = o.opened_owner_slot",
      "                 AND 'owner:' || s.reviewer_user_id::text = o.opened_owner_slot",
      "                 AND s.status = 'signed'",
      "                 AND s.signature_id IS NOT NULL",
      "                     AND e.signer_user_id = s.reviewer_user_id",
      "                     AND e.org_id = s.org_id",
      "                     AND (e.document_version_id = s.document_version_id\n                          OR e.document_version_id IS NULL)",
    ]) expect(GUARD, f).toContain(f);
  });
});

// ─── 1. the twin, over a matrix ──────────────────────────────────────────
const POLICIES: Array<ReviewControl | null> = [
  null,
  { mode: "require" },
  { mode: "require", ownerMustApprove: true },
  { mode: "publisher_choice", ownerMustApprove: false },
];
type Scenario = {
  doc: ReviewControl | null; folder: ReviewControl | null; ancestor: ReviewControl | null; library: ReviewControl | null;
  docOwner: string | null; folderOwner: string | null; libOwner: string | null; team: boolean;
  inactive: Set<string>; createdBy: string | null; actor: string; independent: boolean | undefined;
};
function world(s: Scenario): Db {
  const libControl = s.library === null && s.independent === undefined ? null
    : { ...(s.library ?? {}), ...(s.independent === undefined ? {} : { requireIndependentReviewer: s.independent }) };
  const members = ["own1", "fold1", "libown", "sup1", "pub1", "ctl1"].map((uid) => ({
    org_id: "o1", uid, display_name: uid, email: `${uid}@x`, status: s.inactive.has(uid) ? "left" : "active",
  }));
  return {
    tables: {
      org_members: members,
      teams: [{ id: "t1", org_id: "o1", name: "Piping", supervisor_user_id: "sup1" }],
      libraries: [{ id: "lib1", org_id: "o1", review_control: libControl, owner_user_id: s.libOwner, owner_name: null, owner_team_id: s.team ? "t1" : null }],
      collections: [
        { id: "root", org_id: "o1", library_id: "lib1", review_control: null, path_ids: [], owner_user_id: null },
        { id: "anc", org_id: "o1", library_id: "lib1", review_control: s.ancestor, path_ids: ["root"], owner_user_id: null },
        { id: "c1", org_id: "o1", library_id: "lib1", review_control: s.folder, path_ids: ["root", "anc"], owner_user_id: s.folderOwner, owner_name: null },
      ],
      documents: [{ id: "d1", org_id: "o1", library_id: "lib1", collection_id: "c1", owner_user_id: s.docOwner, owner_name: null, review_control: s.doc, pending_version_id: "v2A" }],
      document_versions: [{ id: "v2A", record_id: "d1", created_by: s.createdBy }],
    },
  };
}
/** What the app rosters (openReviewRoster's composition, from its pure parts). */
function appOutcome(db: Db, s: Scenario): string {
  const lib = rows(db, "libraries")[0];
  const folderMap = new Map(rows(db, "collections").map((c) => [String(c.id), { path_ids: c.path_ids, value: c.review_control as ReviewControl | null }]));
  const control = resolveReviewControlChain({ document: s.doc, folders: folderChainFromMap("c1", folderMap), library: lib.review_control as ReviewControl | null });
  if (control.ownerMustApprove !== true) return "none";
  const active = new Set(rows(db, "org_members").filter((m) => m.status === "active").map((m) => String(m.uid)));
  const owner = resolveEffectiveOwner(
    { owner_user_id: s.docOwner, owner_name: null },
    { owner_user_id: s.folderOwner, owner_name: null },
    { owner_user_id: s.libOwner, owner_name: null, owner_team_id: s.team ? "t1" : null },
    active,
    s.team ? new Map([["t1", { userId: "sup1", name: "sup1" }]]) : null,
  );
  const requireIndependent = (lib.review_control as ReviewControl | null)?.requireIndependentReviewer !== false;
  const authorUid = s.createdBy ?? s.actor;
  const placed = placeOwnerSlot({ primaries: [], alternates: [], owner: { userId: owner.userId, name: owner.name }, skipAuthorUid: requireIndependent ? authorUid : null });
  return placed.outcome === "rostered" ? `owner:${owner.userId}` : placed.outcome;
}

describe("1. the stamp is the app's roster composition (GAP-4) — over a matrix of policies, owners, memberships, authors and independence", () => {
  it("every scenario an app opener produces: the database's opened-under stamp names exactly the owner slot the app rosters (or the same reason it rosters none); a version naming someone other than its opener is never 'author'", () => {
    let n = 0;
    let forgeriesRefused = 0;
    const seen = new Set<string>();
    const owners: Array<Pick<Scenario, "docOwner" | "folderOwner" | "libOwner" | "team">> = [
      { docOwner: "own1", folderOwner: null, libOwner: null, team: false },
      { docOwner: null, folderOwner: "fold1", libOwner: "libown", team: false },
      { docOwner: null, folderOwner: null, libOwner: "libown", team: true },
      { docOwner: null, folderOwner: null, libOwner: null, team: true },
      { docOwner: "own1", folderOwner: "fold1", libOwner: "libown", team: true },
      { docOwner: null, folderOwner: null, libOwner: null, team: false },
    ];
    const inactives = [new Set<string>(), new Set(["own1"]), new Set(["own1", "fold1", "libown"]), new Set(["own1", "fold1", "libown", "sup1"])];
    // The "created_by ≠ opener" axis. AN APP OPENER: submitForReview inserts the draft with created_by =
    // the actor it opens the roster as; the intake approve opens an external submission's roster (the
    // intake route inserts no created_by). FOREIGN: a version naming someone other than the person
    // opening its roster — no app door writes one; a library publisher can, through PostgREST (RG-14's
    // review: PATCH created_by to the owner, then open a roster without them).
    const authors: Array<Pick<Scenario, "createdBy" | "actor"> & { appOpener: boolean }> = [
      { createdBy: "pub1", actor: "pub1", appOpener: true },   // a publisher submits their draft
      { createdBy: "own1", actor: "own1", appOpener: true },   // the owner submits their own draft
      { createdBy: "fold1", actor: "fold1", appOpener: true },
      { createdBy: null, actor: "own1", appOpener: true },     // an external submission whose roster the owner opens
      { createdBy: null, actor: "ctl1", appOpener: true },     // …or Document Control opens
      { createdBy: "own1", actor: "pub1", appOpener: false },  // the forgery: the owner named as author by a publisher
      { createdBy: "sup1", actor: "ctl1", appOpener: false },
      { createdBy: "pub1", actor: "own1", appOpener: false },  // the owner opens a draft someone else is named on
    ];
    for (const doc of POLICIES) for (const folder of POLICIES) for (const ancestor of POLICIES) for (const library of POLICIES)
      for (const o of owners) for (const inactive of inactives) for (const { appOpener, ...a } of authors) for (const independent of [undefined, true, false]) {
        const s: Scenario = { doc, folder, ancestor, library, ...o, inactive, ...a, independent };
        const db = world(s);
        const sql = sqlStamp(db, { document_version_id: "v2A", document_id: "d1" }, a.actor, []);
        const app = appOutcome(db, s);
        // an app opener: exactly the app's outcome. Foreign: the app's, except that the database never
        // grants 'author' — where the app would skip the named owner as author, the owner must approve.
        const expected = appOpener || app !== "author" ? app : `owner:${a.createdBy}`;
        if (sql !== expected) expect({ sql, app, expected, appOpener, scenario: { ...s, inactive: [...inactive] } }).toBeUndefined();
        if (!appOpener) expect(sql).not.toBe("author");
        if (!appOpener && app === "author") forgeriesRefused += 1;
        seen.add(sql!.startsWith("owner:") ? "owner" : sql!);
        n += 1;
      }
    expect(n).toBeGreaterThan(100_000);
    // every outcome is reached, and the forgery axis is exercised
    expect([...seen].sort()).toEqual(["author", "no_owner", "none", "owner"]);
    expect(forgeriesRefused).toBeGreaterThan(1_000);
  });
});

// ─── 2. the REAL openReviewRoster, with the stamp bound as its trigger ────
const OWNER_CTL: ReviewControl = { mode: "require", reviewerIds: ["rev1"], ownerMustApprove: true };
const PLAIN_CTL: ReviewControl = { mode: "require", reviewerIds: ["rev1"] };
const T = (t: string) => (state.db.tables[t] ??= []);
const member = (uid: string) => ({ org_id: "o1", uid, display_name: uid, email: `${uid}@x`, status: "active", role: "Engineer", roles: ["Engineer"] });
function seed(opts: { library?: ReviewControl; author?: string | null; docOwner?: string | null } = {}) {
  T("org_members").push(member("rev1"), member("own1"), member("pub1"), member("ctl1"));
  T("document_versions").push({ id: "v2A", record_id: "d1", created_by: opts.author === undefined ? "pub1" : opts.author, superseded_at: null });
  T("documents").push({ id: "d1", org_id: "o1", library_id: "lib1", collection_id: null, pending_version_id: "v2A",
    owner_user_id: opts.docOwner === undefined ? "own1" : opts.docOwner, owner_name: null, review_control: null });
  T("libraries").push({ id: "lib1", org_id: "o1", review_control: opts.library ?? OWNER_CTL, owner_user_id: null, owner_name: null, owner_team_id: null });
}
/** Bind the transcribed stamp as the roster's BEFORE INSERT trigger, for the session `state.uid`. */
function bindStamp() {
  state.db.beforeInsert!.document_review_signoffs = (row, table) => ({ ...row, opened_owner_slot: sqlStamp(state.db, row, state.uid, table) });
}
/** Every primary signs with a signature bound to the draft. */
function signAll(roster: Row[]) {
  for (const r of roster.filter((x) => x.slot === "primary")) {
    const sig = { id: `sig-${r.reviewer_user_id}`, org_id: r.org_id, signer_user_id: r.reviewer_user_id, document_version_id: r.document_version_id };
    T("e_signatures").push(sig);
    Object.assign(r, { status: "signed", signature_id: sig.id });
  }
}
const input = (control: ReviewControl, actorId = "pub1") => ({
  orgId: "o1", documentId: "d1", libraryId: "lib1", versionId: "v2A", revisionLabel: "2A", contentHash: "h", control, actorId, actorName: actorId,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_review_signoffs = [["document_version_id", "reviewer_user_id"]];
  state.uid = "pub1";
  bindStamp();
});

describe("2. the real openReviewRoster under the stamp — a legitimate roster completes exactly as before; the same roster without the owner does not", () => {
  it("an owner-must-approve roster: every row stamped owner:<owner>; the app's owner row fills it; signed, the gate passes — without the owner's row it refuses", async () => {
    seed();
    await openReviewRoster(input(OWNER_CTL));
    const roster = T("document_review_signoffs");
    expect(roster.map((r) => [r.reviewer_user_id, r.slot_group, r.opened_owner_slot])).toEqual([
      ["own1", "owner:own1", "owner:own1"],
      ["rev1", "person:rev1", "owner:own1"],
    ]);
    signAll(roster);
    expect(sqlOwnerGateRefuses(roster, T("e_signatures"))).toBe(false);
    // the same roster opened through PostgREST without the owner (RG-14's failure scenario)
    expect(sqlOwnerGateRefuses(roster.filter((r) => r.reviewer_user_id !== "own1"), T("e_signatures"))).toBe(true);
    // …or with the owner's group held by someone else
    expect(sqlOwnerGateRefuses(roster.map((r) => (r.reviewer_user_id === "own1" ? { ...r, reviewer_user_id: "rev1" } : r)), T("e_signatures"))).toBe(true);
  });

  it("regression: a policy without the rule stamps none — the roster completes on the per-slot count alone", async () => {
    seed({ library: PLAIN_CTL });
    await openReviewRoster(input(PLAIN_CTL));
    const roster = T("document_review_signoffs");
    expect(roster.map((r) => r.opened_owner_slot)).toEqual(["none"]);
    signAll(roster);
    expect(sqlOwnerGateRefuses(roster, T("e_signatures"))).toBe(false);
  });

  it("regression: the owner authored the draft and submits it (DEC-21 skips them) — stamp author, no owner row, completes; with independence off the owner is rostered and required", async () => {
    // submitForReview opens the roster as the draft's creator: the owner here
    seed({ author: "own1" });
    state.uid = "own1";
    await openReviewRoster(input(OWNER_CTL, "own1"));
    let roster = T("document_review_signoffs");
    expect(roster.map((r) => [r.reviewer_user_id, r.opened_owner_slot])).toEqual([["rev1", "author"]]);
    signAll(roster);
    expect(sqlOwnerGateRefuses(roster, T("e_signatures"))).toBe(false);

    state.db = newFakeDb(); bindStamp();
    const optOut: ReviewControl = { ...OWNER_CTL, requireIndependentReviewer: false };
    seed({ author: "own1", library: optOut });
    await openReviewRoster(input(optOut, "own1"));
    roster = T("document_review_signoffs");
    expect(roster.map((r) => [r.reviewer_user_id, r.slot_group, r.opened_owner_slot])).toEqual([
      ["own1", "owner:own1", "owner:own1"], ["rev1", "person:rev1", "owner:own1"],
    ]);
  });

  it("regression: an EXTERNAL submission (no created_by) — the author is whoever opens the roster, in the app and in the stamp alike", async () => {
    // the owner opens it (the intake approve): the owner is the author → skipped → stamp author → completes without them
    seed({ author: null });
    state.uid = "own1";
    await openReviewRoster(input(OWNER_CTL, "own1"));
    let roster = T("document_review_signoffs");
    expect(roster.map((r) => [r.reviewer_user_id, r.opened_owner_slot])).toEqual([["rev1", "author"]]);
    signAll(roster);
    expect(sqlOwnerGateRefuses(roster, T("e_signatures"))).toBe(false);
    // Document Control opens it: the owner is rostered and required
    state.db = newFakeDb(); bindStamp();
    seed({ author: null });
    state.uid = "ctl1";
    await openReviewRoster(input(OWNER_CTL, "ctl1"));
    roster = T("document_review_signoffs");
    expect(roster.map((r) => [r.reviewer_user_id, r.opened_owner_slot])).toEqual([["own1", "owner:own1"], ["rev1", "owner:own1"]]);
  });

  it("RG-14 review: a publisher who names the OWNER as the draft's author (created_by, writable through PostgREST) and opens the roster is stamped owner:<owner> — the forged author never skips the owner", async () => {
    // P PATCHes created_by to the owner W, then opens the roster: openReviewRoster reads created_by and skips
    // W as author; the stamp does not (W does not open the roster), so the roster cannot publish without W
    seed({ author: "own1" });
    state.uid = "pub1";
    await openReviewRoster(input(OWNER_CTL, "pub1"));
    const roster = T("document_review_signoffs");
    expect(roster.map((r) => [r.reviewer_user_id, r.opened_owner_slot])).toEqual([["rev1", "owner:own1"]]);
    signAll(roster);
    expect(sqlOwnerGateRefuses(roster, T("e_signatures"))).toBe(true);
    // the same row through PostgREST, the stamp read directly: created_by naming the owner, a non-owner opener
    const row = { org_id: "o1", document_id: "d1", document_version_id: "v2A", reviewer_user_id: "rev1", slot: "primary", slot_group: "person:rev1", status: "pending" };
    expect(sqlStamp(state.db, row, "pub1", [])).toBe("owner:own1");
    expect(sqlStamp(state.db, row, "ctl1", [])).toBe("owner:own1");
    // only the owner opening it is the author exception — on a version naming them or nobody
    expect(sqlStamp(state.db, row, "own1", [])).toBe("author");
    T("document_versions")[0].created_by = null;
    expect(sqlStamp(state.db, row, "own1", [])).toBe("author");
    expect(sqlStamp(state.db, row, "pub1", [])).toBe("owner:own1");
    // and a version naming someone else, opened by the owner: the owner approves (as the app rosters them)
    T("document_versions")[0].created_by = "pub1";
    expect(sqlStamp(state.db, row, "own1", [])).toBe("owner:own1");
  });

  it("regression: no active owner — stamp no_owner, no owner row, completes", async () => {
    seed({ docOwner: null });
    await openReviewRoster(input(OWNER_CTL));
    const roster = T("document_review_signoffs");
    expect(roster.map((r) => [r.reviewer_user_id, r.opened_owner_slot])).toEqual([["rev1", "no_owner"]]);
    signAll(roster);
    expect(sqlOwnerGateRefuses(roster, T("e_signatures"))).toBe(false);
  });

  it("no retrofit: a roster opened before 20261159 (unstamped) keeps NULL when a row is added after the paste, and completes without the owner", async () => {
    seed();
    T("document_review_signoffs").push({ id: "old1", org_id: "o1", document_id: "d1", document_version_id: "v2A", reviewer_user_id: "rev1", slot: "primary", slot_group: "person:rev1", status: "pending", opened_owner_slot: null });
    // openReviewRoster's upsert (ignoreDuplicates) adds the owner row; it takes the open roster's NULL
    await openReviewRoster(input(OWNER_CTL));
    const roster = T("document_review_signoffs");
    expect(roster.map((r) => r.opened_owner_slot)).toEqual([null, null]);
    // signed by the reviewer alone, the RG-14 limb asks nothing (the per-slot count still counts the owner row the app added)
    expect(sqlOwnerGateRefuses(roster.filter((r) => r.reviewer_user_id === "rev1").map((r) => ({ ...r, status: "signed" })), [])).toBe(false);
  });

  it("no retrofit: the policy set after a roster opened never reaches it — a row added later takes the stamp the roster opened under", async () => {
    seed({ library: PLAIN_CTL });
    await openReviewRoster(input(PLAIN_CTL));
    expect(T("document_review_signoffs").map((r) => r.opened_owner_slot)).toEqual(["none"]);
    T("libraries")[0].review_control = OWNER_CTL;
    await openReviewRoster(input(OWNER_CTL)); // a re-open (the intake panel's, when no primary was found) adds the owner's row
    const roster = T("document_review_signoffs");
    expect(roster.map((r) => [r.reviewer_user_id, r.opened_owner_slot])).toEqual([["rev1", "none"], ["own1", "none"]]);
  });

  it("a client's own value is overwritten on INSERT: a PostgREST roster sending 'none' in an owner-must-approve library is stamped owner:<owner>", () => {
    seed();
    const row = { org_id: "o1", document_id: "d1", document_version_id: "v2A", reviewer_user_id: "rev1", slot: "primary", slot_group: "person:rev1", status: "pending", opened_owner_slot: "none" };
    expect(sqlStamp(state.db, row, "pub1", [])).toBe("owner:own1");
    // the service role (a restore) is trusted with the stamp it exported
    expect(sqlStamp(state.db, row, null, [])).toBe("none");
  });
});
