// document-control Round F wave 3 — P17 GUARD & EDITOR FOLLOW-UPS: REV-22
// against the guard 20261159 re-creates.
//
//   REV-22 (1): a controller's bare pointer move on a held document ALREADY
//   in an issue status (Issued, IFC, a library's own) passed the hold
//   unrecorded — no status became an issue, so REV-20 (b)'s v_unforced_issue
//   never fired. 20261159 judges it by the same recorded-force rule: refused
//   over an active hold unless the transaction-local flag names the document
//   (set only by publish_revision's and finalize_reviewed_promote's recorded
//   force), in REV-20 (b)'s sentence.
//   REV-22 (2): the bare un-supersede of an unstamped held Superseded
//   document stays SPARED — that exit is the legacy reversal's put-back
//   (reverse.ts restoreStatus, a bare PostgREST write that cannot carry the
//   flag) over the hold HLD-2 carries onto the source first. The real
//   reverseSplit / reverseMerge run here against the transcribed guard and
//   still complete.
//
// There is no database here: enforce_document_publish_guard (20261159) is
// TRANSCRIBED below — each branch pinned to the SQL text it mirrors, in
// order — and bound to the in-memory PostgREST as the documents BEFORE
// UPDATE trigger (the pattern of dcRoundFReversalOverCarriedHold, which
// pins 20261151's guard the same way and stays on its own base). The guard
// itself was exercised on PostgreSQL 16 (REV-22's record).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  roles: ["DocCtrl"] as string[],
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return { ...base, rpc: async () => ({ data: null, error: { code: "PGRST202", message: "not in this test" } }) };
  },
}));
vi.mock("@/lib/storage", () => ({
  uploadToPath: vi.fn(async (_f: File, path: string) => ({ url: `r2://${path}`, size: 3 })),
  makeLibraryStoragePath: (o: { filename: string }) => `org/lib/${o.filename}`,
  uniqueUploadName: (name: string) => `u_${name}`,
}));
vi.mock("@/lib/principal", () => ({
  resolveActorPrincipal: vi.fn(async (i: { uid: string; orgId?: string }) => ({
    uid: i.uid, orgId: i.orgId, role: state.roles[0], roles: state.roles,
  })),
}));
vi.mock("@/lib/documentGuards", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/documentGuards")>();
  return { ...real, resolveCanControlLibrary: vi.fn(async () => true) };
});
vi.mock("@/lib/ownership", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ownership")>();
  return { ...real, isEffectiveOwnerOfDocument: vi.fn(async () => false) };
});
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/checkoutEpisodes", () => ({
  getActiveEpisode: vi.fn(async () => null),
  postEpisodeSystemMessage: vi.fn(async () => {}),
}));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({
  runPostPublishSideEffects: vi.fn(async () => {}),
  notifyPackagesOfRetirement: vi.fn(async () => {}),
}));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));

import { reverseSplit, reverseMerge } from "@/lib/documentLifecycle/reverse";
import { isControlledIssueStatus } from "@/lib/issueStatus";

// ─── the guard, read from 20261159 ─────────────────────────────────────────
const M = readFileSync(join(process.cwd(), "supabase/migrations/20261159_dc_roundF_guard_owner_and_held_pointer.sql"), "utf8");
const G = (() => {
  const head = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
  const a = M.indexOf(head);
  return M.slice(a, M.indexOf("\n$$;", a));
})();
const RETIRED = ["Superseded", "Archived", "Void"];
/** REV-20 limb (a)'s statuses, read from the SQL — the transcription follows the file. */
const LIMB_A = (() => {
  const block = G.slice(G.indexOf("  v_new_door := v_new_door\n"), G.indexOf("  v_unforced_issue := COALESCE(v_issuing"));
  const m = /AND OLD\.status IN \(([^)]*)\)/.exec(block);
  expect(m, "limb (a) names its statuses").toBeTruthy();
  return m![1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
})();

const S_NEW_DOOR_HOLD = "Document has an active hold; release the hold before issuing it.";
const S_UNFORCED_HOLD = "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.";
const S_REQUIRE = "This library requires reviewer sign-off, so a revision that was not reviewed can't be made a controlled issue; submit it for review, or ask Document Control.";
const S_AUTHORITY = "You do not have authority to publish revisions in this library.";
const S_PUBLISHER_HOLD = "Document has an active hold; release the hold before publishing a new revision.";

type GuardCtx = {
  actor: string | null;
  controller: boolean;
  publisher: boolean;
  held: (docId: string) => boolean;
  /** current_setting('app.publish_hold_override', true) — set only by the recorded forces. */
  flag?: string | null;
  requireMode?: boolean;
  rosterComplete?: boolean;
};
const raise = (message: string) => { throw { code: "23514", message }; };
/** The guard's RAISE for this write, or null when it is admitted. */
const refused = (f: () => unknown): string | null => {
  try { f(); } catch (e) { return (e as { message: string }).message; }
  return null;
};
const has = (v: unknown) => v !== null && v !== undefined;

/** enforce_document_publish_guard() (20261159), transcribed. As in P14's
 *  transcription a NULL status is outside its domain, and the review gate on
 *  a pointer move (RG-1 / RG-4 / RG-7 / RG-14 / DEC-21 / SEC-13 / SEC-14) is
 *  pinned by its own tests and admits every pointer move here. */
function publishGuard(NEW: Row, OLD: Row, ctx: GuardCtx): Row {
  if (ctx.actor === null) return NEW;
  if (!has(NEW.status) || !has(OLD.status)) throw new Error("transcription: a NULL status is outside this transcription");
  NEW = { ...NEW };
  const ns = String(NEW.status), os = String(OLD.status);
  const sameptr = (NEW.current_version_id ?? null) === (OLD.current_version_id ?? null);
  let advancing = !sameptr
    || (ns === "Superseded" && os !== "Superseded")
    || (RETIRED.includes(os) && ns !== os)
    || (ns === "Archived" && os !== "Archived");
  const issuing = has(NEW.current_version_id) && !isControlledIssueStatus(os) && isControlledIssueStatus(ns);
  let newDoor = issuing && (!advancing
    || (sameptr && RETIRED.includes(os) && OLD.retired_issue_status === "not-issued" && !has(OLD.retired_issue_version_id)));
  newDoor = newDoor || (issuing && sameptr && LIMB_A.includes(os) && !has(OLD.retired_issue_status) && ctx.controller);
  const flagNamesIt = (ctx.flag ?? null) === NEW.id;
  const unforced = issuing && !sameptr && !flagNamesIt && ctx.controller;
  // REV-22 (P17): a controller's pointer move on a document already issued
  const unforcedMove = has(OLD.current_version_id) && has(NEW.current_version_id) && !sameptr
    && isControlledIssueStatus(os) && isControlledIssueStatus(ns) && !flagNamesIt && ctx.controller;
  advancing = advancing || issuing;
  const restoring = issuing && RETIRED.includes(os) && has(OLD.retired_issue_version_id)
    && NEW.current_version_id === OLD.retired_issue_version_id && NEW.current_version_id === OLD.current_version_id;
  if (RETIRED.includes(ns)) {
    if (RETIRED.includes(os)) {
      NEW.retired_issue_status = OLD.retired_issue_status ?? null;
      NEW.retired_issue_version_id = OLD.retired_issue_version_id ?? null;
    } else if (has(OLD.current_version_id) && isControlledIssueStatus(os)) {
      NEW.retired_issue_status = os;
      NEW.retired_issue_version_id = OLD.current_version_id;
    } else {
      NEW.retired_issue_status = "not-issued";
      NEW.retired_issue_version_id = null;
    }
  } else {
    NEW.retired_issue_status = null;
    NEW.retired_issue_version_id = null;
  }
  if (!advancing) return NEW;
  const held = ctx.held(String(NEW.id));
  if (issuing) {
    if (newDoor && held) raise(S_NEW_DOOR_HOLD);
    if (unforced && held) raise(S_UNFORCED_HOLD);
    if (!ctx.controller && !restoring && ctx.requireMode && !ctx.rosterComplete) raise(S_REQUIRE);
  }
  if (unforcedMove && held) raise(S_UNFORCED_HOLD);
  if (ctx.controller) return NEW;
  if (!ctx.publisher) raise(S_AUTHORITY);
  if (held) raise(S_PUBLISHER_HOLD);
  return NEW;
}

describe("the transcription is the SQL's (20261159's guard, in order)", () => {
  it("every branch it mirrors is in the guard body, in this order — REV-22's limb after REV-20 (b)'s and its refusal after the issue block, before the controller return", () => {
    const fragments = [
      "  IF v_actor IS NULL THEN\n    RETURN NEW;\n  END IF;",
      "       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)\n    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded')",
      "    OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status)",
      "    OR (NEW.status = 'Archived' AND COALESCE(OLD.status, '') <> 'Archived');",
      "  v_issuing := NEW.current_version_id IS NOT NULL\n               AND NOT is_controlled_issue_status(OLD.status)\n               AND is_controlled_issue_status(NEW.status);",
      "  v_new_door := v_issuing\n                AND (NOT COALESCE(v_advancing, false)\n                     OR COALESCE(NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                                 AND OLD.retired_issue_status = 'not-issued'\n                                 AND OLD.retired_issue_version_id IS NULL, false));",
      "  v_new_door := v_new_door\n                OR COALESCE(v_issuing\n                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n",
      "                            AND OLD.retired_issue_status IS NULL\n                            AND is_org_controller(NEW.org_id), false);",
      "  v_unforced_issue := COALESCE(v_issuing\n                               AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                               AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                               AND is_org_controller(NEW.org_id), false);",
      "  v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                              AND is_controlled_issue_status(OLD.status)\n                              AND is_controlled_issue_status(NEW.status)\n                              AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                              AND is_org_controller(NEW.org_id), false);",
      "  v_advancing := v_advancing OR v_issuing;",
      "  v_restoring := COALESCE(v_issuing\n                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                 AND OLD.retired_issue_version_id IS NOT NULL\n                 AND NEW.current_version_id = OLD.retired_issue_version_id\n                 AND NEW.current_version_id = OLD.current_version_id, false);",
      "    IF COALESCE(OLD.status IN ('Superseded', 'Archived', 'Void'), false) THEN\n      NEW.retired_issue_status := OLD.retired_issue_status;",
      "    ELSIF OLD.current_version_id IS NOT NULL AND is_controlled_issue_status(OLD.status) THEN\n      NEW.retired_issue_status := OLD.status;\n      NEW.retired_issue_version_id := OLD.current_version_id;",
      "      NEW.retired_issue_status := 'not-issued';\n      NEW.retired_issue_version_id := NULL;",
      "  ELSE\n    NEW.retired_issue_status := NULL;\n    NEW.retired_issue_version_id := NULL;\n  END IF;",
      "  IF NOT v_advancing THEN\n    RETURN NEW;\n  END IF;",
      "  IF v_issuing THEN\n    IF v_new_door AND EXISTS (",
      `        '${S_NEW_DOOR_HOLD}'`,
      "    IF v_unforced_issue AND EXISTS (",
      `        '${S_UNFORCED_HOLD.replace("'", "''")}'`,
      "    IF NOT is_org_controller(NEW.org_id)\n       AND NOT v_restoring\n       AND (review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'",
      `          '${S_REQUIRE.replace("'", "''")}'`,
      "  IF v_unforced_move AND EXISTS (\n       SELECT 1 FROM document_holds h\n        WHERE h.document_id = NEW.id AND h.released_at IS NULL\n     ) THEN",
      `      '${S_UNFORCED_HOLD.replace("'", "''")}'`,
      "  IF is_org_controller(NEW.org_id) THEN\n    RETURN NEW;\n  END IF;",
      `      '${S_AUTHORITY}'`,
      `      '${S_PUBLISHER_HOLD}'`,
    ];
    let at = -1;
    for (const f of fragments) {
      const i = G.indexOf(f, at + 1);
      expect(i, f.slice(0, 80)).toBeGreaterThan(at);
      at = i;
    }
  });

  it("REV-20 limb (a) is untouched: an unstamped ARCHIVED or VOID exit is bound, an unstamped Superseded put-back spared (REV-22's open half)", () => {
    expect(LIMB_A).toEqual(["Archived", "Void"]);
  });
});

// ─── the harness ───────────────────────────────────────────────────────────
const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const audit = (action: string) => T("audit_logs").filter((r) => r.action === action);
const activeHolds = (id: string) => T("document_holds").filter((h) => h.document_id === id && h.released_at == null);

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: LIB, document_number: id.toUpperCase(), title: id, rev: "3", revision: "3",
    status: "Issued", current_version_id: `${id}-v3`, pending_version_id: null, checked_out_by: null, checked_out_by_name: null,
    retired_issue_status: null, retired_issue_version_id: null,
    ...extra,
  };
  T("documents").push(d);
  T("document_versions").push({ id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null });
  return d;
}
function seedHold(docId: string, reason = "Stop work") {
  T("document_holds").push({ id: `h-${docId}-${reason}`, org_id: ORG, document_id: docId, reason, notes: null, expected_release_at: null, released_at: null, opened_at: "2026-09-01" });
}
/** A split of `prefix` into `${prefix}a` / `${prefix}b`, recorded with its
 *  prior status. `stamp` is what the source's retirement carries: none (a
 *  split recorded BEFORE 20261144 was pasted — no backfill) or the issue
 *  the split took away (one recorded after). */
function seedSplit(prefix: string, stamp: "none" | "issued") {
  seedDoc(prefix, {
    status: "Superseded", uniqueness_key: `${prefix}-key`, superseded_at: "2026-09-01T10:00:00Z", supersession_reason: "split",
    ...(stamp === "issued" ? { retired_issue_status: "Issued", retired_issue_version_id: `${prefix}-v3` } : {}),
  });
  for (const x of ["a", "b"]) seedDoc(`${prefix}${x}`, { uniqueness_key: `${prefix}${x}-key` });
  T("document_supersessions").push(
    { id: `l-${prefix}a`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}a`, reason: "split", created_by: ME, created_at: "2026-09-01T10:00:00Z" },
    { id: `l-${prefix}b`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}b`, reason: "split", created_by: ME, created_at: "2026-09-01T10:00:00Z" },
  );
  T("audit_logs").push({ id: `ev-${prefix}`, action: "DOC_SPLIT", resource_id: prefix, timestamp: "2026-09-01T10:00:00Z", details: { replacementDocIds: [`${prefix}a`, `${prefix}b`], priorStatus: "Issued", auditAt: "2026-09-01T10:00:00Z" } });
}
function seedMerge(prefix: string) {
  for (const s of ["1", "2"]) seedDoc(`${prefix}${s}`, { status: "Superseded", uniqueness_key: `${prefix}${s}-key` });
  seedDoc(`${prefix}t`, { uniqueness_key: `${prefix}t-key` });
  T("document_supersessions").push(
    { id: `l-${prefix}1`, org_id: ORG, superseded_doc_id: `${prefix}1`, replacement_doc_id: `${prefix}t`, created_by: ME },
    { id: `l-${prefix}2`, org_id: ORG, superseded_doc_id: `${prefix}2`, replacement_doc_id: `${prefix}t`, created_by: ME },
  );
  T("audit_logs").push({ id: `ev-${prefix}`, action: "DOC_MERGED", resource_id: `${prefix}1`, timestamp: "2026-09-03T00:00:00Z", details: { mergedIntoDocumentId: `${prefix}t`, mergeSiblings: [`${prefix}1`, `${prefix}2`], targetWasNewlyCreated: true, priorStatuses: { [`${prefix}1`]: "Issued", [`${prefix}2`]: "Issued" }, auditAt: "2026-09-03T00:00:00Z" } });
}

/** Bind the transcribed guard as the documents BEFORE UPDATE trigger, as the
 *  signed-in controller the reversal runs as. */
function bindGuard(extra: Partial<GuardCtx> = {}) {
  const refusals: string[] = [];
  state.db.beforeUpdate!.documents = (next, old) => {
    try {
      return publishGuard(next, old, {
        actor: ME,
        controller: state.roles.some((r) => r === "DocCtrl" || r === "Admin"),
        publisher: false,
        held: (id) => activeHolds(id).length > 0,
        ...extra,
      });
    } catch (e) {
      refusals.push((e as { message: string }).message);
      throw e;
    }
  };
  return refusals;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
  state.roles = ["DocCtrl"];
});

// ─── REGRESSION FIRST: the legacy reversal over a carried hold ───────────
describe("REV-22 (2) stays spared — Document Control still reverses a split or merge recorded before 20261144 over a carried hold, against 20261159's guard", () => {
  it("reverseSplit: P-101 (superseded, no stamp) comes back Issued carrying the sheet's stop-work hold; the sheets are parked; nothing is refused", async () => {
    seedSplit("p101", "none");
    seedHold("p101a");
    const refusals = bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p101", reason: "wrong split", orgId: ORG, actorUserId: ME, force: true });
    expect(refusals).toEqual([]);
    expect(docRow("p101").status).toBe("Issued");
    expect(activeHolds("p101").map((h) => h.reason)).toEqual(["Stop work"]);
    for (const s of ["p101a", "p101b"]) expect(docRow(s).status).toBe("Superseded");
    expect(audit("DOC_SPLIT_REVERSED")[0].details).toMatchObject({ proceededOverHolds: { p101a: ["Stop work"] }, holdsCarriedBack: 1 });
  });

  it("reverseMerge: both sources (superseded, no stamp) come back Issued, each carrying the parked target's hold", async () => {
    state.roles = ["Admin"];
    seedMerge("m");
    seedHold("mt", "Client Review");
    const refusals = bindGuard();
    await reverseMerge({ mergeAuditEventId: "ev-m", reason: "wrong merge", orgId: ORG, actorUserId: ME, force: true });
    expect(refusals).toEqual([]);
    for (const s of ["m1", "m2"]) {
      expect(docRow(s).status).toBe("Issued");
      expect(activeHolds(s).map((h) => h.reason)).toEqual(["Client Review"]);
    }
    expect(docRow("mt").status).toBe("Superseded");
  });

  it("a split recorded AFTER 20261144 (the source stamped) reverses over a carried hold as before", async () => {
    seedSplit("p103", "issued");
    seedHold("p103b");
    const refusals = bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p103", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    expect(refusals).toEqual([]);
    expect(docRow("p103").status).toBe("Issued");
    expect(activeHolds("p103")).toHaveLength(1);
  });

  it("the reversal's restore is status-only (no pointer in its payload), so REV-22 (1) — a POINTER move — never reaches it", () => {
    const reverse = readFileSync(join(process.cwd(), "lib/documentLifecycle/reverse.ts"), "utf8");
    const restore = reverse.slice(reverse.indexOf("async function restoreStatus("), reverse.indexOf("/** Delete this operation's supersession rows"));
    expect(restore).toContain(".update({\n    status,\n    superseded_at: null,");
    expect(restore).not.toMatch(/current_version_id/);
  });
});

// ─── REV-22 (1): the pointer move on an already-issued held document ─────
describe("REV-22 (1) — a controller's pointer move on a held document already in an issue status takes the recorded force, or it is refused", () => {
  const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
  const owner: GuardCtx = { actor: "owner", controller: false, publisher: true, held: () => true };
  const doc = (status: string, current: string | null = "v3"): Row => ({ id: "d1", status, current_version_id: current, retired_issue_status: null, retired_issue_version_id: null });

  it("a bare PATCH of current_version_id on held Issued / IFC / a library's own issue status: refused in REV-20 (b)'s sentence (the one the inspector answers with the review promote's force)", () => {
    for (const s of ["Issued", "IFC", "For Construction"]) {
      expect(refused(() => publishGuard({ ...doc(s), current_version_id: "v4" }, doc(s), ctl)), s).toBe(S_UNFORCED_HOLD);
    }
    // …and the review promote of a held Issued document (pointer + status Issued, pending cleared)
    expect(refused(() => publishGuard({ ...doc("Issued"), current_version_id: "v4", pending_version_id: null }, { ...doc("Issued"), pending_version_id: "v4" }, ctl))).toBe(S_UNFORCED_HOLD);
  });

  it("the recorded force passes it: the flag naming THIS document admits the move; a flag naming another admits nothing", () => {
    expect(publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), { ...ctl, flag: "d1" }).current_version_id).toBe("v4");
    expect(refused(() => publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), { ...ctl, flag: "d2" }))).toBe(S_UNFORCED_HOLD);
  });

  it("regression: no hold — admitted; not an issue status (a Draft's pointer) — admitted; a first pointer write (a creation, REV-17) — admitted; status-only writes and an archive — admitted", () => {
    expect(publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), { ...ctl, held: () => false }).current_version_id).toBe("v4");
    expect(publishGuard({ ...doc("Draft"), current_version_id: "v4" }, doc("Draft"), ctl).current_version_id).toBe("v4");
    expect(publishGuard({ ...doc("Issued", null), current_version_id: "v1" }, doc("Issued", null), ctl).current_version_id).toBe("v1");
    expect(publishGuard({ ...doc("Issued"), title: "renamed" }, doc("Issued"), ctl).title).toBe("renamed");
    expect(publishGuard({ ...doc("Issued"), status: "Archived" }, doc("Issued"), ctl).status).toBe("Archived");
    // a supersede (into Superseded with a pointer move) is not an issue status: OWN-15's rule, as before
    expect(publishGuard({ ...doc("Issued"), status: "Superseded", current_version_id: "v4" }, doc("Issued"), ctl).status).toBe("Superseded");
  });

  it("below a controller nothing changed: the publisher tier's own words; the service role is untouched", () => {
    expect(refused(() => publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), owner))).toBe(S_PUBLISHER_HOLD);
    expect(refused(() => publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), { ...owner, flag: "d1" }))).toBe(S_PUBLISHER_HOLD);
    expect(publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), { ...ctl, actor: null }).current_version_id).toBe("v4");
  });

  it("REV-20's rules on the re-created guard are unchanged: an unstamped held Archived / Void exit to Issued refused for a controller (new door), the pointer-and-issue write of a held Draft refused without the flag; the spared Superseded put-back admitted", () => {
    for (const s of ["Archived", "Void"]) expect(refused(() => publishGuard({ ...doc(s), status: "Issued" }, doc(s), ctl)), s).toBe(S_NEW_DOOR_HOLD);
    expect(refused(() => publishGuard({ ...doc("Draft"), status: "Issued", current_version_id: "v4" }, doc("Draft"), ctl))).toBe(S_UNFORCED_HOLD);
    expect(publishGuard({ ...doc("Draft"), status: "Issued", current_version_id: "v4" }, doc("Draft"), { ...ctl, flag: "d1" }).status).toBe("Issued");
    expect(publishGuard({ ...doc("Superseded"), status: "Issued" }, doc("Superseded"), ctl).status).toBe("Issued");
    expect(refused(() => publishGuard({ ...doc("Superseded"), status: "Issued" }, doc("Superseded"), owner))).toBe(S_PUBLISHER_HOLD);
  });

  it("the app answers it: the refusal is a hold refusal the inspector offers Document Control the review promote's recorded force on; the intake approve says to release the hold", async () => {
    const { isFinalizeHoldRefusal, finalizeReasonMessage } = await import("@/lib/reviewControl");
    expect(isFinalizeHoldRefusal(S_UNFORCED_HOLD)).toBe(true);
    expect(finalizeReasonMessage(S_UNFORCED_HOLD)).toContain("Release the hold, then publish the reviewed revision");
    const panel = readFileSync(join(process.cwd(), "components/documents/ReviewGateSection.tsx"), "utf8");
    expect(panel).toContain("if (!forceHold && isController && isFinalizeHoldRefusal(res.reason)) {");
  });
});
