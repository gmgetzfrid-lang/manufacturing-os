// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS:
// roles-and-permissions GAP-4, "ownership means being the approver of
// revision and supersession".
//
//   An optional `ownerMustApprove` on ReviewControl. A policy that sets it
//   opens every roster from then on with the document's EFFECTIVE owner as a
//   REQUIRED primary in a slot of their own (`owner:<uid>`, which no
//   alternate backs). The acceptance:
//     1. an owner-must-approve policy opens rosters that include the
//        effective owner as a required primary;
//     2. rosters opened before the change are unaffected and still complete;
//     3. OWN-11 holds separately: completing a roster never publishes it.
//   The database completion gate counts primary rows per slot group, so the
//   owner's row is required there with no change to the guard — pinned
//   against the NEWEST guard body, found by scanning the migrations.
//   P14 review fix: the owner is resolved from rows read CHECKED at every
//   rung (document, folder, library, owning team, active membership) through
//   the real one chain — a read that fails withdraws the submission instead
//   of rostering the next rung's owner, no owner, or a departed one.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  owner: { userId: "own1", name: "Olive Owner" } as { userId: string | null; name: string | null },
  /** Reads (selects) that answer an error: table, optionally the exact
   *  select list, and the message. Writes go through. */
  failRead: [] as Array<{ table: string; cols?: string; message: string }>,
  notified: [] as Array<Record<string, unknown>>,
  audited: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => {
        if (state.failRead.some((f) => f.table === t)) {
          const real = base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
          // The matching reads fail; writes (the withdrawal) go through.
          return new Proxy(real, {
            get(target, prop: string) {
              if (prop === "select") {
                return (cols: string, ...rest: unknown[]) => {
                  const hit = state.failRead.find((f) => f.table === t && (f.cols === undefined || f.cols === cols));
                  if (!hit) return target.select(cols, ...rest);
                  const answer = { data: null, error: { message: hit.message } };
                  const chain: Record<string, unknown> = {};
                  for (const m of ["eq", "in", "is", "order", "limit"]) chain[m] = () => chain;
                  chain.maybeSingle = async () => answer;
                  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res);
                  return chain;
                };
              }
              return target[prop];
            },
          });
        }
        return base.from(t);
      },
    };
  },
}));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async (n: Record<string, unknown>) => { state.notified.push(n); }) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (e: Record<string, unknown>) => { state.audited.push(e); return { error: null }; }) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn() }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/ownership", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ownership")>();
  return {
    // the ONE chain is the real one: the owner slot resolves from the rows
    resolveEffectiveOwner: vi.fn(real.resolveEffectiveOwner),
    // the gap notice's (unchecked) recipient lookup
    effectiveOwnerForDocument: vi.fn(async () => state.owner),
    getOrgControllers: vi.fn(async () => ["ctl1"]),
    teamSupervisorMap: vi.fn(async () => new Map()),
  };
});

import { openReviewRoster, placeOwnerSlot, slotGroupKey, evaluateSlotCompletion, reviewCompletionForDraft, type Reviewer } from "@/lib/reviewControl";
import { effectiveOwnerForDocument, resolveEffectiveOwner } from "@/lib/ownership";
import type { ReviewControl } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const T = (t: string) => (state.db.tables[t] ??= []);
const MIGS = join(process.cwd(), "supabase", "migrations");
/** The NEWEST migration that defines `marker` (scanned at test time). */
function newestDefining(marker: string): { file: string; text: string } {
  const files = readdirSync(MIGS).filter((f) => f.endsWith(".sql")).sort();
  let hit: { file: string; text: string } | null = null;
  for (const f of files) {
    const text = readFileSync(join(MIGS, f), "utf8");
    if (text.includes(marker)) hit = { file: f, text };
  }
  expect(hit, `no migration defines ${marker}`).not.toBeNull();
  return hit!;
}
function between(text: string, from: string, to: string): string {
  const a = text.lastIndexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
}

const OWNER_CTL: ReviewControl = { mode: "require", reviewerIds: ["rev1"], ownerMustApprove: true };
const PLAIN_CTL: ReviewControl = { mode: "require", reviewerIds: ["rev1"] };
const input = (control: ReviewControl, extra: Partial<{ actorId: string }> = {}) => ({
  orgId: "o1", documentId: "d1", libraryId: "lib1", versionId: "v2A", revisionLabel: "2A", contentHash: "h",
  control, actorId: "pub1", actorName: "Publisher", ...extra,
});
const member = (uid: string, name: string, role = "Engineer") => ({ org_id: "o1", uid, display_name: name, email: `${uid}@x`, status: "active", role, roles: [role] });
const rosterRows = () => T("document_review_signoffs");

function seed(opts: {
  author?: string; library?: ReviewControl;
  docOwner?: string | null; folder?: { owner_user_id: string | null; owner_name?: string | null } | null;
  libraryOwner?: string | null; libraryTeam?: string | null;
} = {}) {
  T("org_members").push(
    member("rev1", "Rita Reviewer"), member("own1", "Olive Owner"), member("alt1", "Alan Alternate"), member("pub1", "Pat Publisher"),
    member("fold1", "Fern Folder-Owner"), member("libown", "Lee Library-Owner"), member("sup1", "Sam Supervisor"),
  );
  T("document_versions").push({ id: "v2A", created_by: opts.author ?? "pub1", superseded_at: null });
  const docOwner = opts.docOwner === undefined ? "own1" : opts.docOwner;
  T("documents").push({
    id: "d1", org_id: "o1", library_id: "lib1", pending_version_id: "v2A",
    owner_user_id: docOwner, owner_name: docOwner === "own1" ? "Olive Owner" : null, collection_id: opts.folder ? "c1" : null,
  });
  if (opts.folder) T("collections").push({ id: "c1", org_id: "o1", library_id: "lib1", owner_name: null, ...opts.folder });
  T("libraries").push({
    id: "lib1", org_id: "o1", review_control: opts.library ?? OWNER_CTL,
    owner_user_id: opts.libraryOwner ?? null, owner_name: opts.libraryOwner ? "Lee Library-Owner" : null, owner_team_id: opts.libraryTeam ?? null,
  });
  if (opts.libraryTeam) T("teams").push({ id: opts.libraryTeam, org_id: "o1", name: "Process Engineering", supervisor_user_id: "sup1" });
}
const OWNER_READ_FAILED = /^The reviewer roster could not be opened: the document's owner, who must approve it, could not be read \(/;
function expectWithdrawnWithoutRoster() {
  expect(rosterRows()).toEqual([]);
  expect(T("documents")[0].pending_version_id).toBeNull();
  expect(T("document_versions")[0].superseded_at).toBeTruthy();
  expect(state.audited.map((a) => a.action)).toEqual(["REVIEW_ROSTER_FAILED"]);
  expect(state.notified).toEqual([]);
}

beforeEach(() => {
  state.db = newFakeDb();
  state.db.unique.document_review_signoffs = [["document_version_id", "reviewer_user_id"]];
  state.owner = { userId: "own1", name: "Olive Owner" };
  state.failRead = [];
  state.notified = [];
  state.audited = [];
  vi.mocked(effectiveOwnerForDocument).mockClear();
  vi.mocked(resolveEffectiveOwner).mockClear();
});

describe("GAP-4 — placeOwnerSlot puts the effective owner on the roster as a required primary of their own", () => {
  const rev: Reviewer = { uid: "rev1", name: "Rita", role: null, source: "person", groupKey: slotGroupKey.person("rev1") };
  const owner = { userId: "own1", name: "Olive" };

  it("an owner the policy did not name is added as a primary in the owner:<uid> slot (role label says why)", () => {
    const r = placeOwnerSlot({ primaries: [rev], alternates: [], owner, skipAuthorUid: null });
    expect(r.outcome).toBe("rostered");
    expect(r.primaries).toEqual([
      { uid: "own1", name: "Olive", role: "Owner (must approve)", source: "person", groupKey: "owner:own1" },
      rev,
    ]);
    expect(r.warning).toBeNull();
  });

  it("an owner already on the roster keeps ONE row, re-slotted so only their own signature fills it; an owner who was only an alternate is promoted (primary wins)", () => {
    const asPrimary: Reviewer = { uid: "own1", name: "Olive O.", role: "Engineer", source: "role", groupKey: slotGroupKey.role("Engineer") };
    let r = placeOwnerSlot({ primaries: [rev, asPrimary], alternates: [], owner, skipAuthorUid: null });
    expect(r.primaries.map((p) => [p.uid, p.groupKey])).toEqual([["own1", "owner:own1"], ["rev1", "person:rev1"]]);
    expect(r.primaries[0].name).toBe("Olive O.");
    const asAlt: Reviewer = { uid: "own1", name: "Olive", role: null, source: "person", groupKey: "person:rev1" };
    r = placeOwnerSlot({ primaries: [rev], alternates: [asAlt], owner, skipAuthorUid: null });
    expect(r.alternates).toEqual([]);
    expect(r.primaries.map((p) => p.groupKey)).toEqual(["owner:own1", "person:rev1"]);
  });

  it("the owner who AUTHORED the revision is skipped under DEC-21 (a reviewer never signs their own work); no owner at all is a named gap", () => {
    expect(placeOwnerSlot({ primaries: [rev], alternates: [], owner, skipAuthorUid: "own1" })).toMatchObject({ outcome: "author", primaries: [rev], warning: null });
    // the library opted out of independent review: the author is not skipped, so the owner-author is rostered
    expect(placeOwnerSlot({ primaries: [rev], alternates: [], owner, skipAuthorUid: null }).outcome).toBe("rostered");
    const none = placeOwnerSlot({ primaries: [rev], alternates: [], owner: { userId: null, name: null }, skipAuthorUid: null });
    expect(none).toMatchObject({ outcome: "no_owner", primaries: [rev] });
    expect(none.warning).toMatch(/requires the owner's approval, but no active owner resolves/);
  });
});

describe("GAP-4 acceptance 1 — an owner-must-approve policy opens rosters with the effective owner as a required primary", () => {
  it("the roster carries the owner's row (primary, active, owner slot), the owner is asked as the owner, and the record says so", async () => {
    seed();
    await openReviewRoster(input(OWNER_CTL));
    const owners = rosterRows().filter((r) => r.reviewer_user_id === "own1");
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ slot: "primary", activated: true, status: "pending", slot_group: "owner:own1", source: "person", reviewer_role: "Owner (must approve)", document_version_id: "v2A" });
    expect(rosterRows().map((r) => r.reviewer_user_id).sort()).toEqual(["own1", "rev1"]);
    const ask = state.notified.find((n) => n.userId === "own1");
    expect(ask).toMatchObject({ kind: "review_requested" });
    expect(String(ask?.body)).toMatch(/as the document's owner, your approval is required/);
    expect(state.audited.find((a) => a.action === "REVIEW_REQUESTED")).toMatchObject({ details: { primaries: 2, ownerSlot: "rostered" } });
    // resolved through the ONE chain from checked reads — not the unchecked effectiveOwnerForDocument
    expect(vi.mocked(resolveEffectiveOwner)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(effectiveOwnerForDocument)).not.toHaveBeenCalled();
    // nothing escalated: the roster has no gap
    expect(state.notified.filter((n) => n.kind === "review_overdue")).toEqual([]);
  });

  it("the owner's slot is REQUIRED: the reviewer's signature alone does not complete it, an alternate cannot fill it, the owner's own signature does", () => {
    const row = (uid: string, slot: "primary" | "alternate", group: string, signed: boolean, activated = true) =>
      ({ slot, activated, status: signed ? "signed" : "pending", signatureId: signed ? `sig-${uid}` : null, slotGroup: group });
    const reviewerOnly = [row("rev1", "primary", "person:rev1", true), row("own1", "primary", "owner:own1", false)];
    expect(evaluateSlotCompletion(reviewerOnly)).toMatchObject({ requiredPrimaries: 2, satisfied: 1, complete: false, unsatisfiedGroups: ["owner:own1"] });
    // an activated alternate paired with the person slot the owner used to hold fills nothing for the owner
    const altTried = [...reviewerOnly, row("alt1", "alternate", "person:own1", true)];
    expect(evaluateSlotCompletion(altTried)).toMatchObject({ satisfied: 1, complete: false });
    const ownerSigned = [row("rev1", "primary", "person:rev1", true), row("own1", "primary", "owner:own1", true)];
    expect(evaluateSlotCompletion(ownerSigned)).toMatchObject({ requiredPrimaries: 2, satisfied: 2, complete: true });
  });

  it("the owner who authored the revision is skipped like any author; a library that opted out of independent review rosters them", async () => {
    seed({ author: "own1" });
    await openReviewRoster(input(OWNER_CTL, { actorId: "own1" }));
    expect(rosterRows().map((r) => r.reviewer_user_id)).toEqual(["rev1"]);
    expect(state.audited.find((a) => a.action === "REVIEW_REQUESTED")).toMatchObject({ details: { ownerSlot: "author", authorSkipped: "own1" } });

    state.db = newFakeDb();
    seed({ author: "own1", library: { ...OWNER_CTL, requireIndependentReviewer: false } });
    state.audited = [];
    await openReviewRoster(input({ ...OWNER_CTL, requireIndependentReviewer: false }, { actorId: "own1" }));
    expect(rosterRows().find((r) => r.reviewer_user_id === "own1")).toMatchObject({ slot_group: "owner:own1" });
  });

  it("no active owner: the roster opens with the reviewers and Document Control is told the owner slot could not be filled", async () => {
    // the document's owner left the org; nothing above it is owned
    seed();
    T("org_members").find((m) => m.uid === "own1")!.status = "inactive";
    state.owner = { userId: null, name: null };
    await openReviewRoster(input(OWNER_CTL));
    expect(rosterRows().map((r) => r.reviewer_user_id)).toEqual(["rev1"]);
    expect(state.audited.find((a) => a.action === "REVIEW_REQUESTED")).toMatchObject({ details: { ownerSlot: "no_owner" } });
    const gap = state.notified.filter((n) => n.kind === "review_overdue");
    expect(gap.map((n) => n.userId)).toEqual(["ctl1"]);
    expect(String(gap[0].body)).toMatch(/requires the owner's approval, but no active owner resolves for this document/);
  });

  it("an owner that cannot be READ never opens a roster without them: the submission is withdrawn (RG-7) and the publisher is told", async () => {
    seed();
    state.failRead = [{ table: "documents", message: "statement timeout" }];
    await expect(openReviewRoster(input(OWNER_CTL))).rejects.toThrow(/the document's owner, who must approve it, could not be read \(the document's own owner could not be read: statement timeout\)\. The submission was withdrawn: nothing is in review/);
    state.failRead = [];
    expectWithdrawnWithoutRoster();
  });

  it("the inherited rungs: a document with no owner of its own rosters its FOLDER's owner (not the library's); a team-owned library's supervisor; an inactive document owner falls through (GAP-5)", async () => {
    seed({ docOwner: null, folder: { owner_user_id: "fold1", owner_name: "Fern Folder-Owner" }, libraryOwner: "libown" });
    await openReviewRoster(input(OWNER_CTL));
    expect(rosterRows().filter((r) => String(r.slot_group).startsWith("owner:")).map((r) => [r.reviewer_user_id, r.reviewer_name])).toEqual([["fold1", "Fern Folder-Owner"]]);

    state.db = newFakeDb();
    seed({ docOwner: null, libraryTeam: "team1" });
    await openReviewRoster(input(OWNER_CTL));
    expect(rosterRows().find((r) => r.slot_group === "owner:sup1")).toMatchObject({ reviewer_user_id: "sup1", reviewer_name: "Sam Supervisor", slot: "primary" });

    state.db = newFakeDb();
    seed({ folder: { owner_user_id: "fold1" } });
    T("org_members").find((m) => m.uid === "own1")!.status = "inactive";
    await openReviewRoster(input(OWNER_CTL));
    expect(rosterRows().filter((r) => String(r.slot_group).startsWith("owner:")).map((r) => r.reviewer_user_id)).toEqual(["fold1"]);
  });

  it("P14 review fix — the FOLDER read fails while the folder owner is the effective owner: withdrawn, never the library owner rostered in the owner's slot", async () => {
    seed({ docOwner: null, folder: { owner_user_id: "fold1" }, libraryOwner: "libown" });
    state.failRead = [{ table: "collections", message: "connection reset" }];
    await expect(openReviewRoster(input(OWNER_CTL))).rejects.toThrow(OWNER_READ_FAILED);
    state.failRead = [];
    expect(rosterRows().map((r) => r.reviewer_user_id)).not.toContain("libown");
    expectWithdrawnWithoutRoster();
  });

  it("P14 review fix — a folder row that is not there (unreadable to the caller) is no answer either: withdrawn", async () => {
    seed({ docOwner: null, folder: { owner_user_id: "fold1" }, libraryOwner: "libown" });
    state.db.tables.collections = [];
    await expect(openReviewRoster(input(OWNER_CTL))).rejects.toThrow(/the folder's owner could not be read: no row was returned/);
    expectWithdrawnWithoutRoster();
  });

  it("P14 review fix — the LIBRARY read fails with no document or folder owner: withdrawn, never a roster opened without an owner slot", async () => {
    seed({ docOwner: null, libraryOwner: "libown" });
    state.failRead = [{ table: "libraries", cols: "owner_user_id, owner_name, owner_team_id", message: "permission denied for table libraries" }];
    await expect(openReviewRoster(input(OWNER_CTL))).rejects.toThrow(/the library's owner could not be read: permission denied for table libraries/);
    state.failRead = [];
    expectWithdrawnWithoutRoster();
  });

  it("P14 review fix — the owning TEAM read fails: withdrawn", async () => {
    seed({ docOwner: null, libraryTeam: "team1" });
    state.failRead = [{ table: "teams", cols: "supervisor_user_id, name", message: "statement timeout" }];
    await expect(openReviewRoster(input(OWNER_CTL))).rejects.toThrow(/the owning team's supervisor could not be read: statement timeout/);
    state.failRead = [];
    expectWithdrawnWithoutRoster();
  });

  it("P14 review fix — the MEMBERSHIP read fails: withdrawn, never a possibly departed owner rostered (the review could never complete)", async () => {
    seed();
    state.failRead = [{ table: "org_members", cols: "uid, display_name, email", message: "connection reset" }];
    await expect(openReviewRoster(input(OWNER_CTL))).rejects.toThrow(/whether the owner is an active member could not be read: connection reset/);
    state.failRead = [];
    expectWithdrawnWithoutRoster();
  });

  it("regression — a policy without the flag opens the roster exactly as before (no owner read, no owner row)", async () => {
    seed({ library: PLAIN_CTL });
    await openReviewRoster(input(PLAIN_CTL));
    expect(rosterRows().map((r) => [r.reviewer_user_id, r.slot_group])).toEqual([["rev1", "person:rev1"]]);
    expect(vi.mocked(effectiveOwnerForDocument)).not.toHaveBeenCalled();
    expect(vi.mocked(resolveEffectiveOwner)).not.toHaveBeenCalled();
    expect(state.db.calls.filter((c) => c.method === "select" && /owner_team_id|supervisor_user_id/.test(String(c.args[0])))).toEqual([]);
    expect(state.audited.find((a) => a.action === "REVIEW_REQUESTED")).toMatchObject({ details: { primaries: 1, ownerSlot: null } });
  });
});

describe("GAP-4 acceptance 2 — rosters opened before the change are unaffected and still complete", () => {
  it("a roster opened without an owner slot completes under a policy that now requires the owner: completion reads the roster's rows, never the policy", async () => {
    seed({ library: OWNER_CTL });
    T("document_review_signoffs").push(
      { id: "s1", org_id: "o1", document_id: "d1", document_version_id: "v2A", reviewer_user_id: "rev1", slot: "primary", activated: true, status: "signed", signature_id: "sig1", slot_group: "person:rev1", assigned_at: "2026-09-01T00:00:00Z" },
    );
    const c = await reviewCompletionForDraft("d1", "v2A", "pub1");
    expect(c).toMatchObject({ requiredPrimaries: 1, signed: 1, complete: true });
    // nothing outside the roster open reads the flag: finalize, sign-off, completion and the scan never add the owner to an open roster
    const lib = src("lib/reviewControl.ts");
    const uses = lib.split("\n").filter((l) => l.includes(".ownerMustApprove"));
    expect(uses).toEqual(["  if (input.control.ownerMustApprove === true) {"]);
    expect(lib.indexOf("if (input.control.ownerMustApprove === true) {")).toBeGreaterThan(lib.indexOf("export async function openReviewRoster("));
    expect(lib.indexOf("if (input.control.ownerMustApprove === true) {")).toBeLessThan(lib.indexOf("export async function invalidateDraftSignoffs("));
  });
});

describe("GAP-4 acceptance 3 — OWN-11 holds: the owner's signature (or anyone's) never publishes", () => {
  it("recordReviewSignoff routes a completed roster to the publishing authority and never promotes", () => {
    const lib = src("lib/reviewControl.ts");
    const body = lib.slice(lib.indexOf("export async function recordReviewSignoff("), lib.indexOf("export async function listDraftRoster("));
    expect(body).toContain('action: "REVIEW_COMPLETE_AWAITING_PUBLISH"');
    expect(body).not.toMatch(/await finalizeReviewedRevision\(/);
    expect(body).not.toMatch(/promoteReviewedDraftAtomically\(|promoteThreeStep\(|rpc\("finalize_reviewed_promote"/);
  });
});

describe("GAP-4 — the database already requires the owner's row (no migration): pinned against the NEWEST bodies", () => {
  it("the newest publish guard counts every PRIMARY row per slot group, so the owner's slot must be filled before the pointer moves", () => {
    const g = newestDefining("CREATE OR REPLACE FUNCTION enforce_document_publish_guard()");
    const body = between(g.text, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "$$;");
    expect(body).toContain("count(*) FILTER (WHERE s.slot = 'primary') AS reqs");
    expect(body).toContain("GROUP BY COALESCE(s.slot_group, '')");
    expect(body).toContain("IF COALESCE(v_primary_reqs, 0) > 0 AND COALESCE(v_signed, 0) < v_primary_reqs THEN");
  });

  it("the newest roster INSERT policy and source CHECK admit the owner's row as written (a pending, active primary, source 'person', any slot_group)", () => {
    const p = newestDefining("CREATE POLICY doc_review_signoff_insert ON document_review_signoffs");
    const policy = between(p.text, "CREATE POLICY doc_review_signoff_insert ON document_review_signoffs", ");\n\n");
    expect(policy).not.toContain("slot_group");
    expect(policy).toContain("(document_review_signoffs.slot = 'primary' AND document_review_signoffs.activated)");
    const c = newestDefining("ADD CONSTRAINT document_review_signoffs_source_check");
    expect(c.text).toContain("CHECK (source IN ('person', 'role', 'team'))");
    // the signing guard keeps the author refusal the owner-author skip mirrors
    const s = newestDefining("CREATE OR REPLACE FUNCTION enforce_review_signoff_guard()");
    expect(s.text).toContain("You authored this revision, so you can''t sign it as its reviewer");
  });
});

describe("GAP-4 — the policy editor sets it", () => {
  it("ReviewControlModal loads, shows and saves ownerMustApprove (only when set), and a policy with only the owner is not 'no reviewers'", () => {
    const m = src("components/documents/ReviewControlModal.tsx");
    expect(m).toContain("setOwnerMustApprove(c.ownerMustApprove === true);");
    expect(m).toContain("...(ownerMustApprove ? { ownerMustApprove: true } : {}),");
    expect(m).toContain("The owner must approve.</span>");
    expect(m).toContain("Reviews already in progress keep the roster they opened with.");
    expect(m).toContain("const noReviewers = gated && !ownerMustApprove && reviewers.length === 0");
    expect(src("types/schema.ts")).toMatch(/ownerMustApprove\?: boolean;/);
  });
});

