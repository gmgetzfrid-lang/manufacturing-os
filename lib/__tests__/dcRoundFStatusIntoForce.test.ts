// @vitest-environment jsdom
//
// document-control Round F wave 3 — P16 STATUS-GUARD FOLLOW-UPS: REV-21,
// against the guard 20261185 re-creates (DEC-77 §4, ratified by the
// integrator under the user's delegation, 2026-10-07 — DEC-90 A3, option 1).
//
//   Before 20261185 an existing "IFC" document (or one in an empty, case- or
//   space-variant, or library-defined status) moved to Issued / Locked was
//   issue-to-issue to the guard: no publisher tier, no hold, no require
//   limb — though it is the move that puts the revision in force at the
//   print gate and on /verify. 20261185 makes that move, status-only, a
//   v_issuing write, judged as every status-only issue is.
//
// Pinned here:
//   1. the app and the database agree — the SQL limb, transcribed from the
//      file (its in-force pair read from the SQL), equals
//      lib/documentStatusOptions.ts isUnguardedEntryIntoForce, and the new
//      v_issuing equals isIssueTransition || isUnguardedEntryIntoForce (which
//      never overlap), over every status pair the editors and the import can
//      produce — the "pinned equal to the new limb" branch of done-when 2;
//   2. done-when 2's cases against the guard's transcription (every branch
//      pinned to 20261185's text, in order): IFC -> Issued / Locked refused
//      for a non-publisher, for anyone over a hold (Document Control
//      included), and under a require policy for a non-controller without a
//      complete roster — each ADMITTED by the same transcription without the
//      P16 limb (20261182's guard: the finding);
//   3. REGRESSION FIRST (the user's top rule): every flow that works today
//      works the same after the paste — Document Control's IFC -> Issued in
//      the REAL bulk editor and the REAL metadata editor, rendered, against
//      the guard bound as the in-memory PostgREST's documents BEFORE UPDATE
//      trigger, with and without the limb; a reviewed revision; Issued <->
//      Locked; a register row; the rev-up shape (pointer + Issued); the
//      service role.
//
// There is no database here; 20261185 was applied twice to a throwaway
// PostgreSQL 16 with the repository's guard chain and the cases run there
// (REV-21's record).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  /** Holds placed AFTER an editor read them (visible to the guard only): the race. */
  raceHolds: new Set<string>(),
  /** Whether the bound guard carries the P16 limb (20261185) or not (20261182). */
  p16: true,
  refusals: [] as string[],
  writes: [] as string[],
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return {
      ...real,
      from: (t: string) => {
        const b = real.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "documents") return b;
        return new Proxy(b, {
          get(target, prop: string) {
            if (prop !== "update") return target[prop];
            return (payload: Record<string, unknown>) => {
              const q = target.update(payload) as Record<string, (...a: unknown[]) => unknown>;
              return new Proxy(q, {
                get(qt, qp: string) {
                  if (qp !== "eq") return qt[qp];
                  return (col: string, val: unknown) => {
                    if (col === "id") state.writes.push(String(val));
                    return qt.eq(col, val);
                  };
                },
              });
            };
          },
        });
      },
    };
  },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn(), makeLibraryStoragePath: vi.fn(), uniqueUploadName: (n: string) => n }));
vi.mock("@/lib/principal", () => ({ resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: "DocCtrl", roles: ["DocCtrl"] })) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/checkoutEpisodes", () => ({ getActiveEpisode: vi.fn(async () => null), postEpisodeSystemMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/intents", () => ({ getMyEditBase: vi.fn(async () => undefined), recordIntent: vi.fn(async () => {}) }));
vi.mock("@/lib/branches", () => ({ announceBranchOpened: vi.fn(async () => {}) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => {}), notifyPackagesOfRetirement: vi.fn(async () => {}) }));
vi.mock("@/lib/reviewCycles", () => ({ onDocumentIssued: vi.fn(async () => {}) }));
vi.mock("@/lib/acknowledgments", () => ({ onDocumentIssuedAck: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ recomputeRetention: vi.fn(async () => {}) }));
vi.mock("@/lib/staleCopies", () => ({ recallRetiredDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/distributionAcks", () => ({ closeStaleAcksForDocument: vi.fn(async () => {}) }));
vi.mock("@/lib/docClass", () => ({ effectiveDocClassForDocument: vi.fn(async () => null) }));
vi.mock("@/lib/unitCodeClient", () => ({ requestUnitCodeDecode: vi.fn(async () => ({ note: null })) }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ uid: "ctl1", userEmail: "cara@example.com", activeRole: "DocCtrl" }) }));
vi.mock("@/components/documents/CheckoutStatusCell", () => ({ default: () => null }));
vi.mock("@/components/assets/AssetTagChip", () => ({ default: () => null }));
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) };
});

import BulkEditModal from "@/components/documents/BulkEditModal";
import MetadataEditor from "@/components/documents/MetadataEditor";
import { supabase } from "@/lib/supabase";
import { isControlledIssueStatus, isIssueTransition, isIssueRefusal } from "@/lib/issueStatus";
import { isUnguardedEntryIntoForce, BULK_EDIT_STATUS_OPTIONS, METADATA_EDITOR_STATUS_OPTIONS, IMPORT_STATUSES, RETIRED_STATUS_OPTIONS } from "@/lib/documentStatusOptions";
import { IN_FORCE_STATUSES } from "@/lib/verifyVerdict";
import type { DocumentRecord, LibraryConfig } from "@/types/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── the guard, read from 20261185 (and its base, 20261182) ────────────────
const read = (f: string) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8");
const body = (M: string, head: string) => {
  const a = M.indexOf(head);
  expect(a, head).toBeGreaterThanOrEqual(0);
  return M.slice(a, M.indexOf("\n$$;", a));
};
const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
const G = body(read("20261185_dc_roundF_status_into_force_issue.sql"), GUARD_HEAD);
const G182 = body(read("20261182_dc_roundF_first_pointer_hold_limb.sql"), GUARD_HEAD);
const LIMB_SQL = "  v_issuing := v_issuing\n               OR COALESCE(NEW.current_version_id IS NOT NULL\n                           AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                           AND is_controlled_issue_status(OLD.status)\n                           AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked')\n                           AND NEW.status IN ('Issued', 'Locked'), false);";
/** The limb's in-force pair, read from its two IN lists. */
const SQL_IN_FORCE = (() => {
  const lists = [...LIMB_SQL.matchAll(/IN \(([^)]*)\)/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")));
  expect(lists).toHaveLength(2);
  expect(lists[0]).toEqual(lists[1]);
  return new Set(lists[0]);
})();

const RETIRED = ["Superseded", "Archived", "Void"];
const S_NEW_DOOR_HOLD = "Document has an active hold; release the hold before issuing it.";
const S_UNFORCED_HOLD = "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.";
const S_REQUIRE = "This library requires reviewer sign-off, so a revision that was not reviewed can't be made a controlled issue; submit it for review, or ask Document Control.";
const S_FIRST_ISSUE_REQUIRE = "This library requires reviewer sign-off, so a new document can't be issued unreviewed; create it as a Draft and submit it for review, or ask Document Control.";
const S_AUTHORITY = "You do not have authority to publish revisions in this library.";
const S_PUBLISHER_HOLD = "Document has an active hold; release the hold before publishing a new revision.";

/** 20261144's v_issuing (REV-18) — isControlledIssueStatus is its SQL twin (pinned in dcRoundFStatusTransition.test.ts). */
const sqlBaseIssuing = (from: string | null, to: string | null, hasCurrent: boolean) =>
  hasCurrent && !isControlledIssueStatus(from) && isControlledIssueStatus(to);
/** 20261185's REV-21 limb, transcribed: SQL's NULL semantics (COALESCE(OLD.status, '') NOT IN …; a NULL NEW.status IN … is NULL → false). */
const sqlLimb = (from: string | null, to: string | null, hasCurrent: boolean, pointerMoved = false) =>
  hasCurrent && !pointerMoved
  && isControlledIssueStatus(from)
  && !SQL_IN_FORCE.has(from ?? "")
  && to !== null && SQL_IN_FORCE.has(to);

type GuardCtx = {
  actor: string | null;
  controller: boolean;
  publisher: boolean;
  held: (docId: string) => boolean;
  flag?: string | null;
  requireMode?: boolean;
  rosterComplete?: boolean;
  intake?: boolean;
  /** false: 20261182's guard (no REV-21 limb) — the database before this paste. */
  p16?: boolean;
};
const raise = (message: string) => { throw { code: "23514", message }; };
const has = (v: unknown) => v !== null && v !== undefined;

/** enforce_document_publish_guard() (20261185), transcribed: P21's
 *  transcription of 20261182 (dcRoundFFirstPointerHoldLimb.test.ts) plus the
 *  REV-21 limb right after v_issuing. A NULL status is outside it (the SQL's
 *  three-valued answers for one were run on PostgreSQL 16 — REV-21's
 *  record); the rest of the review gate admits every pointer move here. */
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
  let issuing = has(NEW.current_version_id) && !isControlledIssueStatus(os) && isControlledIssueStatus(ns);
  // REV-21 (P16): a status-only move INTO Issued / Locked out of an issue status outside them
  if (ctx.p16 !== false) issuing = issuing || sqlLimb(os, ns, has(NEW.current_version_id), !sameptr);
  let newDoor = issuing && (!advancing
    || (sameptr && RETIRED.includes(os) && OLD.retired_issue_status === "not-issued" && !has(OLD.retired_issue_version_id)));
  newDoor = newDoor || (issuing && sameptr && ["Archived", "Void"].includes(os) && !has(OLD.retired_issue_status) && ctx.controller);
  const flagNamesIt = (ctx.flag ?? null) === NEW.id;
  newDoor = newDoor || (issuing && sameptr && os === "Superseded" && !has(OLD.retired_issue_status) && !flagNamesIt && ctx.controller);
  const unforced = issuing && !sameptr && !flagNamesIt && ctx.controller;
  let unforcedMove = has(OLD.current_version_id) && has(NEW.current_version_id) && !sameptr
    && isControlledIssueStatus(os) && isControlledIssueStatus(ns) && !flagNamesIt && ctx.controller;
  advancing = advancing || issuing;
  const restoring = issuing && RETIRED.includes(os) && has(OLD.retired_issue_version_id)
    && NEW.current_version_id === OLD.retired_issue_version_id && NEW.current_version_id === OLD.current_version_id;
  newDoor = newDoor || (restoring && !flagNamesIt && ctx.controller);
  unforcedMove = unforcedMove || (has(OLD.current_version_id) && !sameptr && RETIRED.includes(os) && !flagNamesIt && ctx.controller);
  newDoor = newDoor || (issuing && sameptr && RETIRED.includes(os) && has(OLD.retired_issue_version_id)
    && OLD.retired_issue_version_id !== (OLD.current_version_id ?? null));
  unforcedMove = unforcedMove || (!has(OLD.current_version_id) && has(NEW.current_version_id) && !flagNamesIt && ctx.controller);
  unforcedMove = unforcedMove || (has(OLD.current_version_id) && !has(NEW.current_version_id)
    && isControlledIssueStatus(os) && !flagNamesIt && ctx.controller);
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
  if (has(NEW.current_version_id) && !sameptr && !ctx.rosterComplete && !has(OLD.current_version_id) && !ctx.intake
      && !["Draft", "In Review", "Superseded", "Void", "Archived"].includes(ns) && !ctx.controller && ctx.requireMode) {
    raise(S_FIRST_ISSUE_REQUIRE);
  }
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
const verdict = (f: () => unknown): string => {
  try { f(); return "ADMITTED"; } catch (e) { return (e as { message: string }).message; }
};

describe("the transcription is 20261185's guard (every branch it mirrors, in order — the REV-21 limb right after v_issuing, before the new door)", () => {
  it("the fragments, in order", () => {
    const fragments = [
      "  IF v_actor IS NULL THEN\n    RETURN NEW;\n  END IF;",
      "       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)\n    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded')",
      "    OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status)",
      "    OR (NEW.status = 'Archived' AND COALESCE(OLD.status, '') <> 'Archived');",
      "  v_issuing := NEW.current_version_id IS NOT NULL\n               AND NOT is_controlled_issue_status(OLD.status)\n               AND is_controlled_issue_status(NEW.status);",
      LIMB_SQL,
      "  v_new_door := v_issuing\n                AND (NOT COALESCE(v_advancing, false)\n                     OR COALESCE(NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                                 AND OLD.retired_issue_status = 'not-issued'\n                                 AND OLD.retired_issue_version_id IS NULL, false));",
      "                            AND OLD.status IN ('Archived', 'Void')\n                            AND OLD.retired_issue_status IS NULL\n                            AND is_org_controller(NEW.org_id), false);",
      "                            AND OLD.status = 'Superseded'\n                            AND OLD.retired_issue_status IS NULL\n                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                            AND is_org_controller(NEW.org_id), false);",
      "  v_unforced_issue := COALESCE(v_issuing\n                               AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n",
      "  v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                              AND is_controlled_issue_status(OLD.status)\n                              AND is_controlled_issue_status(NEW.status)\n",
      "  v_advancing := v_advancing OR v_issuing;",
      "  v_restoring := COALESCE(v_issuing\n                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                 AND OLD.retired_issue_version_id IS NOT NULL\n                 AND NEW.current_version_id = OLD.retired_issue_version_id\n                 AND NEW.current_version_id = OLD.current_version_id, false);",
      "  v_new_door := v_new_door\n                OR COALESCE(v_restoring\n",
      "                                 AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n",
      "                            AND OLD.retired_issue_version_id IS NOT NULL\n                            AND OLD.retired_issue_version_id IS DISTINCT FROM OLD.current_version_id, false);",
      "                     OR COALESCE(OLD.current_version_id IS NULL\n                                 AND NEW.current_version_id IS NOT NULL\n",
      "                     OR COALESCE(OLD.current_version_id IS NOT NULL\n                                 AND NEW.current_version_id IS NULL\n                                 AND is_controlled_issue_status(OLD.status)\n",
      "  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN",
      "  IF NOT v_advancing THEN\n    RETURN NEW;\n  END IF;",
      "      IF OLD.current_version_id IS NULL AND v_intake_link IS NULL\n         AND COALESCE(NEW.status, '') NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')\n         AND NOT is_org_controller(NEW.org_id)",
      `          '${S_FIRST_ISSUE_REQUIRE.replace("'", "''")}'`,
      "  IF v_issuing THEN\n    IF v_new_door AND EXISTS (",
      `        '${S_NEW_DOOR_HOLD}'`,
      "    IF v_unforced_issue AND EXISTS (",
      `        '${S_UNFORCED_HOLD.replace("'", "''")}'`,
      "    IF NOT is_org_controller(NEW.org_id)\n       AND NOT v_restoring\n       AND (review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'",
      `          '${S_REQUIRE.replace("'", "''")}'`,
      "  IF v_unforced_move AND EXISTS (",
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
    // the base (20261182) has every fragment but the limb — the transcription with p16: false is that guard
    expect(G182).not.toContain(LIMB_SQL);
    for (const f of fragments.filter((x) => x !== LIMB_SQL)) expect(G182, f.slice(0, 60)).toContain(f);
  });
  it("the refusals the move meets are sentences the app already recognises (the status editors and the un-archive dialog answer them)", () => {
    for (const s of [S_NEW_DOOR_HOLD, S_REQUIRE, S_AUTHORITY]) expect(isIssueRefusal(s), s).toBe(true);
  });
});

// ─── 1. the app and the database agree ─────────────────────────────────────
/** Every status the editors offer or show, the import can write, and the variants the gates compare exactly. */
const UNIVERSE: Array<string | null> = [...new Set<string | null>([
  ...BULK_EDIT_STATUS_OPTIONS, ...METADATA_EDITOR_STATUS_OPTIONS, ...IMPORT_STATUSES, ...RETIRED_STATUS_OPTIONS,
  "In Review", "IFC", "ifc", "issued", "ISSUED", "locked", " Issued", "Issued ", " Issued", "Issued\t",
  "Approved", "Approved for Construction", "For Construction", "IFA", "", "   ", null, "  Draft ", "draft", "　Void",
])];

describe("REV-21 — the app and the database agree (done-when 2: isUnguardedEntryIntoForce pinned equal to the new limb)", () => {
  it("the limb's in-force pair is lib/verifyVerdict.ts IN_FORCE_STATUSES (the print gate's and the verify allow-list's)", () => {
    expect([...SQL_IN_FORCE]).toEqual([...IN_FORCE_STATUSES]);
  });

  it("for every status pair, with and without a current revision: the SQL limb (status-only) IS isUnguardedEntryIntoForce, and 20261144's v_issuing IS isIssueTransition", () => {
    let n = 0;
    for (const from of UNIVERSE) for (const to of UNIVERSE) for (const hasCurrentRevision of [true, false]) {
      const x = { fromStatus: from, toStatus: to, hasCurrentRevision };
      expect(sqlLimb(from, to, hasCurrentRevision), JSON.stringify(x)).toBe(isUnguardedEntryIntoForce(x));
      expect(sqlBaseIssuing(from, to, hasCurrentRevision), JSON.stringify(x)).toBe(isIssueTransition(x));
      n += 1;
    }
    expect(n).toBe(UNIVERSE.length * UNIVERSE.length * 2);
  });

  it("…so the new v_issuing (status-only) IS isIssueTransition || isUnguardedEntryIntoForce — two predicates that never overlap — and that is exactly the ratified rule: an issue as before, or a move INTO Issued / Locked from any status outside them", () => {
    for (const from of UNIVERSE) for (const to of UNIVERSE) for (const hasCurrentRevision of [true, false]) {
      const x = { fromStatus: from, toStatus: to, hasCurrentRevision };
      const sql = sqlBaseIssuing(from, to, hasCurrentRevision) || sqlLimb(from, to, hasCurrentRevision);
      expect(sql, JSON.stringify(x)).toBe(isIssueTransition(x) || isUnguardedEntryIntoForce(x));
      expect(isIssueTransition(x) && isUnguardedEntryIntoForce(x), JSON.stringify(x)).toBe(false);
      const ratified = sqlBaseIssuing(from, to, hasCurrentRevision)
        || (hasCurrentRevision && to !== null && IN_FORCE_STATUSES.has(to) && !IN_FORCE_STATUSES.has(from ?? ""));
      expect(sql, JSON.stringify(x)).toBe(ratified);
    }
  });

  it("the move the finding names, and its neighbours", () => {
    const t = (from: string | null, to: string | null, cur = true) => sqlBaseIssuing(from, to, cur) || sqlLimb(from, to, cur);
    for (const to of ["Issued", "Locked"]) {
      for (const from of ["IFC", "", null, "issued", " Issued", "For Construction", "Approved"]) expect(t(from, to), `${from} → ${to}`).toBe(true);
      expect(t("IFC", to, false)).toBe(false); // a register row: nothing to put in force
    }
    expect(t("Issued", "Locked")).toBe(false); // already in force
    expect(t("Locked", "Issued")).toBe(false);
    expect(t("IFC", " Issued")).toBe(false); // the gates compare exactly: not in force
    expect(t("IFC", "For Construction")).toBe(false); // issue to issue, not in force
    expect(t("IFC", "Draft")).toBe(false);
    // and a pointer move with the status is not this limb (the rev-up shape keeps the pointer move's rules)
    expect(sqlLimb("IFC", "Issued", true, true)).toBe(false);
  });
});

// ─── 2. done-when 2's cases against the guard ──────────────────────────────
describe("REV-21 — IFC -> Issued / Locked against the guard (20261185), and against its base (20261182: the finding)", () => {
  const OLD = (status: string, extra: Row = {}): Row => ({ id: "d1", org_id: "o1", status, current_version_id: "d1-v3", retired_issue_status: null, retired_issue_version_id: null, ...extra });
  const to = (old: Row, status: string, extra: Row = {}): Row => ({ ...old, status, ...extra });
  const none = () => false;
  const heldAll = () => true;
  const both = (old: Row, next: Row, ctx: Omit<GuardCtx, "p16">) => ({
    after: verdict(() => publishGuard(next, old, { ...ctx, p16: true })),
    before: verdict(() => publishGuard(next, old, { ...ctx, p16: false })),
  });
  const VIEWER = { actor: "v1", controller: false, publisher: false, held: none };
  const OWNER = { actor: "w1", controller: false, publisher: true, held: none };
  const DOCCTRL = { actor: "c1", controller: true, publisher: false, held: none };

  for (const target of ["Issued", "Locked"]) {
    it(`a non-publisher's IFC -> ${target} is refused (the publisher tier) — admitted before the paste`, () => {
      expect(both(OLD("IFC"), to(OLD("IFC"), target), VIEWER)).toEqual({ after: S_AUTHORITY, before: "ADMITTED" });
    });
    it(`a held document's IFC -> ${target} is refused for Document Control too (the new door's hold) — and for its owner; admitted before`, () => {
      expect(both(OLD("IFC"), to(OLD("IFC"), target), { ...DOCCTRL, held: heldAll })).toEqual({ after: S_NEW_DOOR_HOLD, before: "ADMITTED" });
      expect(both(OLD("IFC"), to(OLD("IFC"), target), { ...OWNER, held: heldAll })).toEqual({ after: S_NEW_DOOR_HOLD, before: "ADMITTED" });
    });
    it(`under a require policy an unreviewed revision's IFC -> ${target} is refused for a non-controller (the owner, a library publisher) — admitted before`, () => {
      expect(both(OLD("IFC"), to(OLD("IFC"), target), { ...OWNER, requireMode: true, rosterComplete: false })).toEqual({ after: S_REQUIRE, before: "ADMITTED" });
      expect(both(OLD("IFC"), to(OLD("IFC"), target), { ...VIEWER, requireMode: true, rosterComplete: false })).toEqual({ after: S_REQUIRE, before: "ADMITTED" });
    });
    it(`REGRESSION — IFC -> ${target} still lands for Document Control (no hold; require or not: DEC-63 §2), for a publisher (none library, or a complete roster), and for the service role over a hold`, () => {
      expect(both(OLD("IFC"), to(OLD("IFC"), target), DOCCTRL)).toEqual({ after: "ADMITTED", before: "ADMITTED" });
      expect(both(OLD("IFC"), to(OLD("IFC"), target), { ...DOCCTRL, requireMode: true, rosterComplete: false })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
      expect(both(OLD("IFC"), to(OLD("IFC"), target), OWNER)).toEqual({ after: "ADMITTED", before: "ADMITTED" });
      expect(both(OLD("IFC"), to(OLD("IFC"), target), { ...OWNER, requireMode: true, rosterComplete: true })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
      expect(both(OLD("IFC"), to(OLD("IFC"), target), { actor: null, controller: false, publisher: false, held: heldAll })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    });
  }

  it("the same for every issue status no gate reads as in force (a case / space variant, an empty status, a library's own)", () => {
    for (const from of ["issued", " Issued", "", "For Construction", "Approved"]) {
      expect(both(OLD(from), to(OLD(from), "Issued"), VIEWER), from).toEqual({ after: S_AUTHORITY, before: "ADMITTED" });
      expect(both(OLD(from), to(OLD(from), "Locked"), { ...DOCCTRL, held: heldAll }), from).toEqual({ after: S_NEW_DOOR_HOLD, before: "ADMITTED" });
    }
  });

  it("REGRESSION — what the limb does not touch answers as before: a register row, Issued <-> Locked, IFC -> Draft / ' Issued' / another issue status, a metadata write, Draft -> Issued (REV-18)", () => {
    const reg = OLD("IFC", { current_version_id: null });
    expect(both(reg, to(reg, "Issued"), VIEWER)).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(OLD("Issued"), to(OLD("Issued"), "Locked"), { ...VIEWER, held: heldAll })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(OLD("Locked"), to(OLD("Locked"), "Issued"), { ...VIEWER, held: heldAll })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    for (const s of ["Draft", " Issued", "For Construction", "IFC"]) {
      expect(both(OLD("IFC"), to(OLD("IFC"), s), { ...VIEWER, held: heldAll }), s).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    }
    expect(both(OLD("Draft"), to(OLD("Draft"), "Issued"), VIEWER)).toEqual({ after: S_AUTHORITY, before: S_AUTHORITY });
    expect(both(OLD("Draft"), to(OLD("Draft"), "Issued"), OWNER)).toEqual({ after: "ADMITTED", before: "ADMITTED" });
  });

  it("REGRESSION — a write that ALSO moves the pointer is not this limb: the owner's Minor rev-up shape on an IFC document in a require library lands; Document Control's unforced pointer + Issued over a hold is refused by P17's limb, as before; under its recorded force it lands", () => {
    const next = to(OLD("IFC"), "Issued", { current_version_id: "d1-v4" });
    expect(both(OLD("IFC"), next, { ...OWNER, requireMode: true, rosterComplete: false })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(OLD("IFC"), next, { ...DOCCTRL, held: heldAll })).toEqual({ after: S_UNFORCED_HOLD, before: S_UNFORCED_HOLD });
    expect(both(OLD("IFC"), next, { ...DOCCTRL, held: heldAll, flag: "d1" })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
  });

  it("REGRESSION — the retired put-backs keep their rules (an un-archive of a stamped issue by its owner lands; Document Control's bare one over a hold is refused, P19)", () => {
    const arch = OLD("Archived", { retired_issue_status: "Issued", retired_issue_version_id: "d1-v3" });
    expect(both(arch, to(arch, "Issued"), OWNER)).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(arch, to(arch, "Issued"), { ...DOCCTRL, held: heldAll })).toEqual({ after: S_NEW_DOOR_HOLD, before: S_NEW_DOOR_HOLD });
  });
});

// ─── 3. the REAL editors against the guard, before and after the paste ─────
const ORG = "o1";
const ME = "ctl1";
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const activeHolds = (id: string) => T("document_holds").filter((h) => h.document_id === id && h.released_at == null);
function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: "lib1", collection_id: null, document_number: id.toUpperCase(), title: id, rev: "2",
    status: "IFC", current_version_id: `${id}-v2`, pending_version_id: null, review_control: null, metadata: {},
    retired_issue_status: null, retired_issue_version_id: null, uniqueness_key: `${id}-key`, ...extra,
  };
  T("documents").push(d);
  T("document_versions").push({ id: `${id}-v2`, org_id: ORG, record_id: id, revision_label: "2" });
  return d;
}
const seedHold = (id: string) => T("document_holds").push({ id: `h-${id}`, org_id: ORG, document_id: id, reason: "Other", notes: "Stop work — MOC-77", released_at: null, opened_at: "2026-09-01" });
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, documentNumber: d.document_number, title: d.title, rev: d.rev, status: d.status,
  metadata: d.metadata ?? {}, libraryId: "lib1", currentVersionId: (d.current_version_id as string | null) ?? undefined,
}) as unknown as DocumentRecord;
const LIB = { id: "lib1", orgId: ORG, customColumns: [], uniquenessKeys: ["documentNumber"] } as unknown as LibraryConfig;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.raceHolds = new Set();
  state.refusals = [];
  state.writes = [];
  state.p16 = true;
  // the guard, as the signed-in Document Controller (DocCtrl in the role collection) writes
  state.db.beforeUpdate!.documents = (next, old) => {
    try {
      return publishGuard(next, old, {
        actor: ME, controller: true, publisher: false,
        held: (id) => activeHolds(id).length > 0 || state.raceHolds.has(id),
        p16: state.p16,
      });
    } catch (e) {
      state.refusals.push((e as { message: string }).message);
      throw e;
    }
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => {
  const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.trim() === label || x.textContent?.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
const labelled = (label: string) => {
  const l = Array.from(host.querySelectorAll("label")).find((x) => x.textContent?.trim() === label);
  if (!l) throw new Error(`no label "${label}"`);
  return l.parentElement!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
};
const refusedRows = () => Array.from(host.querySelectorAll('[data-testid="bulk-refused-rows"] li')).map((li) => li.textContent ?? "");

async function bulkApply(docs: DocumentRecord[], value: string) {
  await act(async () => {
    root.render(React.createElement(BulkEditModal, { isOpen: true, onClose: () => {}, docs, library: LIB, actorUserId: ME, onApplied: vi.fn() }));
  });
  await act(async () => setValue(labelled("New value") as HTMLSelectElement, value));
  await act(async () => { button(`Apply to ${docs.length}`).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

/** The library page's saveMetadata, as it writes (one checked UPDATE; a refusal thrown in the database's words). */
async function pageSave(id: string, next: { core?: { title?: string; documentNumber?: string; status?: string } }) {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: ME };
  if (next.core?.title !== undefined) payload.title = next.core.title;
  if (next.core?.documentNumber !== undefined) payload.document_number = next.core.documentNumber;
  if (next.core?.status !== undefined) payload.status = next.core.status;
  const { data, error } = await supabase.from("documents").update(payload).eq("id", id).select("id");
  if (error) throw new Error(`Save refused — nothing was saved: ${(error as { message: string }).message}`);
  if (!data || (data as unknown[]).length === 0) throw new Error("Save refused — nothing was saved: the database updated no document.");
}
async function metadataSave(doc: Row, value: string) {
  const onClose = vi.fn();
  await act(async () => {
    root.render(React.createElement(MetadataEditor, {
      isOpen: true, onClose, document: asRecord(doc), columns: [] as never,
      userRole: "Manager", userRoles: ["Manager", "DocCtrl"], orgId: ORG,
      onSave: ((n: { core?: { status?: string } }) => pageSave(String(doc.id), n)) as never,
    }));
  });
  await act(async () => setValue(labelled("Status") as HTMLSelectElement, value));
  await act(async () => { button("Save").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
  return onClose;
}

describe("REGRESSION FIRST — Document Control's move into force in the REAL bulk editor works the same before and after 20261185", () => {
  for (const p16 of [false, true]) {
    it(`${p16 ? "after" : "before"} the paste: a free IFC row is put in force (written once, nothing recorded as a REV-19 issue); a held one is refused by the editor before any write, with the hold named`, async () => {
      state.p16 = p16;
      const free = seedDoc("f1");
      const held = seedDoc("f2");
      seedHold("f2");
      await bulkApply([asRecord(free), asRecord(held)], "Issued");
      expect(state.writes).toEqual(["f1"]);
      expect(docRow("f1").status).toBe("Issued");
      expect(docRow("f2").status).toBe("IFC");
      expect(refusedRows()).toEqual([expect.stringMatching(/^F2 — Document has an active hold \(Other: Stop work — MOC-77\); release the hold before putting it in force/)]);
      expect(state.refusals).toEqual([]); // the guard refused nothing: the editor did not send the held row
      expect(T("audit_logs").filter((a) => a.action === "DOCUMENT_ISSUED")).toEqual([]);
    });
  }

  it("the race the editor cannot see — a hold placed after its hold read — is refused by the database after the paste (named in the guard's words, the row left IFC); before it, the row was put in force over the hold", async () => {
    state.p16 = false;
    seedDoc("r1");
    state.raceHolds.add("r1");
    await bulkApply([asRecord(docRow("r1"))], "Issued");
    expect(docRow("r1").status).toBe("Issued"); // the finding, through the app's own door

    act(() => root.unmount());
    root = createRoot(host);
    state.db = newFakeDb();
    state.db.beforeUpdate!.documents = (next, old) => {
      try {
        return publishGuard(next, old, { actor: ME, controller: true, publisher: false, held: (id) => activeHolds(id).length > 0 || state.raceHolds.has(id), p16: true });
      } catch (e) { state.refusals.push((e as { message: string }).message); throw e; }
    };
    state.p16 = true;
    seedDoc("r1");
    await bulkApply([asRecord(docRow("r1"))], "Issued");
    expect(docRow("r1").status).toBe("IFC");
    expect(state.refusals).toEqual([S_NEW_DOOR_HOLD]);
    expect(refusedRows()).toEqual([`R1 — ${S_NEW_DOOR_HOLD}`]);
  });
});

describe("REGRESSION FIRST — Document Control's move into force in the REAL metadata editor works the same before and after 20261185", () => {
  for (const p16 of [false, true]) {
    it(`${p16 ? "after" : "before"} the paste: IFC -> Issued saves and closes; a held IFC document -> Locked is refused by the editor before any write`, async () => {
      state.p16 = p16;
      const free = seedDoc("m1");
      const closed = await metadataSave(free, "Issued");
      expect(closed).toHaveBeenCalledTimes(1);
      expect(docRow("m1").status).toBe("Issued");
      act(() => root.unmount());
      root = createRoot(host);
      const held = seedDoc("m2");
      seedHold("m2");
      const stayed = await metadataSave(held, "Locked");
      expect(stayed).not.toHaveBeenCalled();
      expect(docRow("m2").status).toBe("IFC");
      expect(state.writes).toEqual(["m1"]);
      expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/^Document has an active hold \(Other: Stop work — MOC-77\); release the hold before putting it in force\./);
      expect(state.refusals).toEqual([]);
    });
  }

  it("after the paste, the race (a hold placed after the editor's read) is refused by the database: the dialog stays open with the guard's sentence and the document stays IFC", async () => {
    seedDoc("m3");
    state.raceHolds.add("m3");
    const onClose = await metadataSave(docRow("m3"), "Issued");
    expect(onClose).not.toHaveBeenCalled();
    expect(docRow("m3").status).toBe("IFC");
    expect(state.refusals).toEqual([S_NEW_DOOR_HOLD]);
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(S_NEW_DOOR_HOLD);
  });
});
