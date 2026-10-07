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
//   v_issuing write, judged as every status-only issue is. Its review fix
//   closes the same move out of a retirement: IFC -> Archived -> Issued (the
//   un-archive dialog's default), IFC -> Void -> Locked, IFC -> Superseded ->
//   Issued were put-backs (v_restoring: no require limb, and a controller's
//   recorded pass over a hold); a put-back INTO Issued / Locked of a stamp
//   outside them is now judged as an issue (the require limb; the new door,
//   whatever flag is set).
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
//      service role;
//   4. the retirement exit (review fix): every put-back pair against the
//      guard, and the REAL lib/revisions.ts unarchiveDocument (through a
//      transcription of put_back_retired_issue's un-archive door) before and
//      after — the IFC-stamped un-archive into Issued now judged, every other
//      put-back (to the stamped status, of an Issued / Locked stamp, to a
//      Draft) landing as before;
//   5. (second review fix) the second app result that changes: the REAL
//      rollbacks — lib/revisions.ts undoFailedSupersede (through
//      supersedeDocument) and lib/documentLifecycle/common.ts
//      restoreSupersededSource (through markSupersededAndLink) — of a
//      NULL-status document, which put back "Issued" (`?? "Issued"`), through
//      put_back_retired_issue's rollback doors, before and after; the guard's
//      transcription now answers a NULL status with SQL's three-valued logic.
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
  /** Who the bound guard sees (the session) — Document Control unless a test says otherwise. */
  as: {} as { actor?: string; controller?: boolean; publisher?: boolean; requireMode?: boolean; rosterComplete?: boolean },
  /** The transaction-local app.publish_hold_override, as a recording function sets it around its own write. */
  flag: null as string | null,
  /** PostgREST's rpc: no function in this database unless a test installs one. */
  rpc: (async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } })) as
    (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const real = makeFakeSupabase(state.db);
    return {
      ...real,
      rpc: (fn: string, args: Record<string, unknown>) => state.rpc(fn, args),
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
import { unarchiveDocument, unarchiveRestoreDefault, supersedeDocument } from "@/lib/revisions";
import { markSupersededAndLink, withCompensation } from "@/lib/documentLifecycle/common";
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
/** The review fix's two statements (the retirement exit), right after v_restoring. */
const EXIT_RESTORING_SQL = "  v_restoring := v_restoring\n                 AND NOT COALESCE(NEW.status IN ('Issued', 'Locked')\n                                  AND COALESCE(OLD.retired_issue_status, '') NOT IN ('Issued', 'Locked'), false);";
const EXIT_NEW_DOOR_SQL = "  v_new_door := v_new_door\n                OR COALESCE(v_issuing\n                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                            AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                            AND OLD.retired_issue_version_id IS NOT NULL\n                            AND COALESCE(OLD.retired_issue_status, '') NOT IN ('Issued', 'Locked')\n                            AND NEW.status IN ('Issued', 'Locked'), false);";
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

/** SQL's three-valued AND / OR, and a comparison of a value that may be NULL (null: unknown). */
type B3 = boolean | null;
const and3 = (...xs: B3[]): B3 => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or3 = (...xs: B3[]): B3 => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const eq3 = (x: string | null, v: string): B3 => (x === null ? null : x === v);
const in3 = (x: string | null, vs: string[]): B3 => (x === null ? null : vs.includes(x));
/** `COALESCE(x IN ('Superseded', 'Archived', 'Void'), false)` — a NULL status is not retired. */
const isRetired = (x: string | null) => x !== null && RETIRED.includes(x);

/** enforce_document_publish_guard() (20261185), transcribed: P21's
 *  transcription of 20261182 (dcRoundFFirstPointerHoldLimb.test.ts) plus the
 *  REV-21 limb right after v_issuing, and the retirement exit right after
 *  v_restoring (review fix). A NULL status is SQL's NULL (second review fix):
 *  v_advancing is three-valued — unknown when no term is true and a NULL
 *  status leaves one unknown — so `IF NOT v_advancing THEN RETURN` does not
 *  return on it (PostgreSQL 16's A-12); every other test of a NULL status
 *  sits inside COALESCE(…, false) or an IF, where unknown is false. Those
 *  answers were run on PostgreSQL 16 (REV-21's record: A-12, A-15, N-1..N-7);
 *  the rest of the review gate admits every pointer move here. */
function publishGuard(NEW: Row, OLD: Row, ctx: GuardCtx): Row {
  if (ctx.actor === null) return NEW;
  NEW = { ...NEW };
  const ns = has(NEW.status) ? String(NEW.status) : null, os = has(OLD.status) ? String(OLD.status) : null;
  const sameptr = (NEW.current_version_id ?? null) === (OLD.current_version_id ?? null);
  let advancing: B3 = or3(
    !sameptr,
    and3(eq3(ns, "Superseded"), (os ?? "") !== "Superseded"),
    and3(in3(os, RETIRED), ns !== os), // IS DISTINCT FROM: never unknown
    and3(eq3(ns, "Archived"), (os ?? "") !== "Archived"),
  );
  let issuing = has(NEW.current_version_id) && !isControlledIssueStatus(os) && isControlledIssueStatus(ns);
  // REV-21 (P16): a status-only move INTO Issued / Locked out of an issue status outside them
  if (ctx.p16 !== false) issuing = issuing || sqlLimb(os, ns, has(NEW.current_version_id), !sameptr);
  let newDoor = issuing && (advancing !== true // NOT COALESCE(v_advancing, false)
    || (sameptr && isRetired(os) && OLD.retired_issue_status === "not-issued" && !has(OLD.retired_issue_version_id)));
  newDoor = newDoor || (issuing && sameptr && (os === "Archived" || os === "Void") && !has(OLD.retired_issue_status) && ctx.controller);
  const flagNamesIt = (ctx.flag ?? null) === NEW.id;
  newDoor = newDoor || (issuing && sameptr && os === "Superseded" && !has(OLD.retired_issue_status) && !flagNamesIt && ctx.controller);
  const unforced = issuing && !sameptr && !flagNamesIt && ctx.controller;
  let unforcedMove = has(OLD.current_version_id) && has(NEW.current_version_id) && !sameptr
    && isControlledIssueStatus(os) && isControlledIssueStatus(ns) && !flagNamesIt && ctx.controller;
  advancing = or3(advancing, issuing);
  let restoring = issuing && isRetired(os) && has(OLD.retired_issue_version_id)
    && NEW.current_version_id === OLD.retired_issue_version_id && NEW.current_version_id === OLD.current_version_id;
  // REV-21 (P16 review fix): a put-back INTO Issued / Locked of a stamp outside them is not v_restoring, and is the new door
  if (ctx.p16 !== false) {
    const stampInForce = SQL_IN_FORCE.has(String(OLD.retired_issue_status ?? ""));
    restoring = restoring && !(SQL_IN_FORCE.has(ns ?? "") && !stampInForce);
    newDoor = newDoor || (issuing && sameptr && isRetired(os) && has(OLD.retired_issue_version_id)
      && !stampInForce && SQL_IN_FORCE.has(ns ?? ""));
  }
  newDoor = newDoor || (restoring && !flagNamesIt && ctx.controller);
  unforcedMove = unforcedMove || (has(OLD.current_version_id) && !sameptr && isRetired(os) && !flagNamesIt && ctx.controller);
  newDoor = newDoor || (issuing && sameptr && isRetired(os) && has(OLD.retired_issue_version_id)
    && OLD.retired_issue_version_id !== (OLD.current_version_id ?? null));
  unforcedMove = unforcedMove || (!has(OLD.current_version_id) && has(NEW.current_version_id) && !flagNamesIt && ctx.controller);
  unforcedMove = unforcedMove || (has(OLD.current_version_id) && !has(NEW.current_version_id)
    && isControlledIssueStatus(os) && !flagNamesIt && ctx.controller);
  if (isRetired(ns)) {
    if (isRetired(os)) {
      NEW.retired_issue_status = OLD.retired_issue_status ?? null;
      NEW.retired_issue_version_id = OLD.retired_issue_version_id ?? null;
    } else if (has(OLD.current_version_id) && isControlledIssueStatus(os)) {
      NEW.retired_issue_status = os; // a NULL-status document's retirement: the stamp is NULL WITH its revision
      NEW.retired_issue_version_id = OLD.current_version_id;
    } else {
      NEW.retired_issue_status = "not-issued";
      NEW.retired_issue_version_id = null;
    }
  } else {
    NEW.retired_issue_status = null;
    NEW.retired_issue_version_id = null;
  }
  if (advancing === false) return NEW; // IF NOT v_advancing: an unknown does not return
  if (has(NEW.current_version_id) && !sameptr && !ctx.rosterComplete && !has(OLD.current_version_id) && !ctx.intake
      && !["Draft", "In Review", "Superseded", "Void", "Archived"].includes(ns ?? "") && !ctx.controller && ctx.requireMode) {
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
      EXIT_RESTORING_SQL,
      EXIT_NEW_DOOR_SQL,
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
    // the base (20261182) has every fragment but the two P16 additions — the transcription with p16: false is that guard
    const P16_ONLY = [LIMB_SQL, EXIT_RESTORING_SQL, EXIT_NEW_DOOR_SQL];
    for (const f of P16_ONLY) expect(G182).not.toContain(f);
    for (const f of fragments.filter((x) => !P16_ONLY.includes(x))) expect(G182, f.slice(0, 60)).toContain(f);
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

  it("a NULL status answers as PostgreSQL 16 answered it (three-valued v_advancing): A-12 the Viewer's NULL -> Issued refused before and after; A-15 Document Control's held NULL -> Issued admitted before, the new door after; a NULL-status document's retirement stamped NULL WITH its revision; its put-back into Issued judged after (N-1 / N-2)", () => {
    const nul = OLD(null as unknown as string);
    expect(both(nul, to(nul, "Issued"), VIEWER)).toEqual({ after: S_AUTHORITY, before: S_AUTHORITY });
    expect(both(nul, to(nul, "Issued"), { ...DOCCTRL, held: heldAll })).toEqual({ after: S_NEW_DOOR_HOLD, before: "ADMITTED" });
    // a metadata-only write on a NULL-status document still meets the publisher tier (v_advancing unknown: no early return)
    expect(both(nul, to(nul, null as unknown as string, { title: "x" }), VIEWER)).toEqual({ after: S_AUTHORITY, before: S_AUTHORITY });
    expect(both(nul, to(nul, null as unknown as string, { title: "x" }), OWNER)).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    // the retirement (the supersede's flip, the owner): stamped with the NULL status and the revision
    const sup = publishGuard(to(nul, "Superseded"), nul, { ...OWNER, requireMode: true, rosterComplete: false, p16: true });
    expect([sup.retired_issue_status, sup.retired_issue_version_id]).toEqual([null, "d1-v3"]);
    // its put-back to 'Issued' (the app's rollback of a NULL prior status): a put-back before; judged as an issue after
    expect(both(sup, to(sup, "Issued"), { ...OWNER, requireMode: true, rosterComplete: false })).toEqual({ after: S_REQUIRE, before: "ADMITTED" });
    expect(both(sup, to(sup, "Issued"), { ...DOCCTRL, held: heldAll, flag: "d1" })).toEqual({ after: S_NEW_DOOR_HOLD, before: "ADMITTED" });
    expect(both(sup, to(sup, "Issued"), OWNER)).toEqual({ after: "ADMITTED", before: "ADMITTED" }); // a none library
    expect(both(sup, to(sup, "Issued"), { ...DOCCTRL, requireMode: true, rosterComplete: false })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
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
  state.as = {};
  state.flag = null;
  state.rpc = async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } });
  // the guard, as the signed-in Document Controller (DocCtrl in the role collection) writes — or whoever state.as names
  state.db.beforeUpdate!.documents = (next, old) => {
    try {
      return publishGuard(next, old, {
        actor: ME, controller: true, publisher: false,
        held: (id) => activeHolds(id).length > 0 || state.raceHolds.has(id),
        ...state.as,
        flag: state.flag,
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

// ─── 4. the retirement exit (review fix) ───────────────────────────────────
describe("REV-21 (review fix) — the same move out of a retirement: a put-back INTO Issued / Locked of a stamp outside them is judged as an issue; every other put-back answers as before", () => {
  const RET = (status: string, stamp: string | null, extra: Row = {}): Row => ({
    id: "d1", org_id: "o1", status, current_version_id: "d1-v3", retired_issue_status: stamp, retired_issue_version_id: "d1-v3", ...extra,
  });
  const to = (old: Row, status: string): Row => ({ ...old, status });
  const none = () => false;
  const heldAll = () => true;
  const both = (old: Row, next: Row, ctx: Omit<GuardCtx, "p16">) => ({
    after: verdict(() => publishGuard(next, old, { ...ctx, p16: true })),
    before: verdict(() => publishGuard(next, old, { ...ctx, p16: false })),
  });
  const OWNER_RQ = { actor: "w1", controller: false, publisher: true, held: none, requireMode: true, rosterComplete: false };
  const DOCCTRL = { actor: "c1", controller: true, publisher: false, held: none };

  it("the finding's second route: the owner's IFC -> Archived / Void / Superseded -> Issued / Locked of an unreviewed revision in a require library — admitted before (a put-back), refused after (the require sentence)", () => {
    // the retirement itself, through the guard: the stamp is IFC and the revision
    const archived = publishGuard({ ...RET("IFC", null, { retired_issue_version_id: null }), status: "Archived" }, RET("IFC", null, { retired_issue_version_id: null }), { ...OWNER_RQ, p16: true });
    expect([archived.retired_issue_status, archived.retired_issue_version_id]).toEqual(["IFC", "d1-v3"]);
    for (const [from, target] of [["Archived", "Issued"], ["Void", "Locked"], ["Superseded", "Issued"], ["Archived", "Locked"]] as const) {
      expect(both(RET(from, "IFC"), to(RET(from, "IFC"), target), OWNER_RQ), `${from} -> ${target}`).toEqual({ after: S_REQUIRE, before: "ADMITTED" });
    }
    // a library publisher, and every other stamp outside the pair (a variant, empty, a library's own)
    for (const stamp of ["IFC", "issued", " Issued", "", "For Construction", "Approved"]) {
      expect(both(RET("Archived", stamp), to(RET("Archived", stamp), "Issued"), { ...OWNER_RQ, actor: "p1" }), stamp).toEqual({ after: S_REQUIRE, before: "ADMITTED" });
    }
  });

  it("Document Control over a hold: the recorded override (the flag put_back_retired_issue sets for the un-archive dialog's forced restore, or a rollback's) no longer passes it — the new door, for everyone", () => {
    const old = RET("Archived", "IFC");
    expect(both(old, to(old, "Issued"), { ...DOCCTRL, held: heldAll, flag: "d1" })).toEqual({ after: S_NEW_DOOR_HOLD, before: "ADMITTED" });
    const sup = RET("Superseded", "IFC");
    expect(both(sup, to(sup, "Issued"), { ...DOCCTRL, held: heldAll, flag: "d1" })).toEqual({ after: S_NEW_DOOR_HOLD, before: "ADMITTED" });
    // the bare write was refused already (P19), and stays refused
    expect(both(old, to(old, "Locked"), { ...DOCCTRL, held: heldAll })).toEqual({ after: S_NEW_DOOR_HOLD, before: S_NEW_DOOR_HOLD });
    // below Document Control it was refused already (the publisher tier's hold); now in the new door's words, as the direct move is
    expect(both(old, to(old, "Issued"), { ...OWNER_RQ, requireMode: false, held: heldAll })).toEqual({ after: S_NEW_DOOR_HOLD, before: S_PUBLISHER_HOLD });
  });

  it("REGRESSION — every other put-back answers exactly as before: to the stamped status itself, an Issued / Locked stamp into Issued / Locked, a reviewed revision, a none library, Document Control unheld, a Draft, an unstamped retirement", () => {
    // the put-back as it was (Archived -> IFC): the require limb still spares it; Document Control's forced one still passes the hold
    expect(both(RET("Archived", "IFC"), to(RET("Archived", "IFC"), "IFC"), OWNER_RQ)).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(RET("Archived", "IFC"), to(RET("Archived", "IFC"), "IFC"), { ...DOCCTRL, held: heldAll, flag: "d1" })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(RET("Archived", "IFC"), to(RET("Archived", "IFC"), "IFC"), { ...DOCCTRL, held: heldAll })).toEqual({ after: S_NEW_DOOR_HOLD, before: S_NEW_DOOR_HOLD });
    // an issue in force put back in force
    for (const [stamp, target] of [["Issued", "Issued"], ["Issued", "Locked"], ["Locked", "Issued"], ["Locked", "Locked"]] as const) {
      expect(both(RET("Archived", stamp), to(RET("Archived", stamp), target), OWNER_RQ), `${stamp} -> ${target}`).toEqual({ after: "ADMITTED", before: "ADMITTED" });
      expect(both(RET("Superseded", stamp), to(RET("Superseded", stamp), target), { ...DOCCTRL, held: heldAll, flag: "d1" })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    }
    // the IFC stamp into force where nothing binds: a complete roster, a none library, Document Control unheld
    expect(both(RET("Archived", "IFC"), to(RET("Archived", "IFC"), "Issued"), { ...OWNER_RQ, rosterComplete: true })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(RET("Archived", "IFC"), to(RET("Archived", "IFC"), "Issued"), { ...OWNER_RQ, requireMode: false })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(RET("Archived", "IFC"), to(RET("Archived", "IFC"), "Issued"), { ...DOCCTRL, requireMode: true })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    // a Draft restore (not an issue), held or not
    expect(both(RET("Archived", "IFC"), to(RET("Archived", "IFC"), "Draft"), { ...DOCCTRL, held: heldAll })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(RET("Archived", "IFC"), to(RET("Archived", "IFC"), "Draft"), OWNER_RQ)).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    // an unstamped retirement keeps REV-20's / REV-22's limbs (the legacy reversal's flagged put-back of a held source passes)
    const unstamped = (st: string) => RET(st, null, { retired_issue_version_id: null });
    expect(both(unstamped("Superseded"), to(unstamped("Superseded"), "Issued"), { ...DOCCTRL, held: heldAll, flag: "d1" })).toEqual({ after: "ADMITTED", before: "ADMITTED" });
    expect(both(unstamped("Archived"), to(unstamped("Archived"), "Issued"), { ...DOCCTRL, held: heldAll, flag: "d1" })).toEqual({ after: S_NEW_DOOR_HOLD, before: S_NEW_DOOR_HOLD });
    // a viewer is refused either way
    expect(both(RET("Archived", "IFC"), to(RET("Archived", "IFC"), "Issued"), { ...OWNER_RQ, publisher: false, requireMode: false })).toEqual({ after: S_AUTHORITY, before: S_AUTHORITY });
  });

  it("over every stamp the guard can write and every target the editors and the import can produce: the paste changes a put-back's answer exactly when it moves INTO Issued / Locked out of a stamp outside them (the owner, require, unreviewed, no hold)", () => {
    const stamps = UNIVERSE.filter((x) => isControlledIssueStatus(x));
    const targets = UNIVERSE.filter((x): x is string => x !== null);
    let changed = 0;
    for (const stamp of stamps) for (const target of targets) {
      const old = RET("Archived", stamp);
      const v = both(old, to(old, target), OWNER_RQ);
      const judged = IN_FORCE_STATUSES.has(target) && !IN_FORCE_STATUSES.has(stamp ?? "");
      expect(v.before, `${stamp} -> ${target}`).toBe("ADMITTED");
      expect(v.after, `${stamp} -> ${target}`).toBe(judged ? S_REQUIRE : "ADMITTED");
      if (judged) changed += 1;
    }
    expect(changed).toBeGreaterThan(20);
  });
});

// ─── the app's un-archive door against the guard, before and after ────────
const M165 = read("20261165_dc_roundF_stamped_put_back.sql");
/** put_back_retired_issue's recorded door (20261165), the condition this transcription mirrors — read from the SQL. */
const PUT_BACK_DOOR_SQL = "  IF COALESCE(p_force_hold, false)\n     AND v_status = (CASE WHEN p_via = 'unarchive' THEN 'Archived' ELSE 'Superseded' END)\n     AND (p_via = 'unarchive' OR v_retired_by = v_uid)\n     AND v_stamped IS NOT NULL\n     AND v_stamped = v_version\n     AND btrim(p_status) NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN";

/** put_back_retired_issue's blank-status refusal (20261165) and its rollback write — read from the SQL. */
const PUT_BACK_BLANK_SQL = "  IF btrim(COALESCE(p_status, '')) = '' THEN\n    RAISE EXCEPTION 'put_back_retired_issue: name the status to put the document back to.'";
const S_PB_STATUS = "put_back_retired_issue: name the status to put the document back to.";
const PUT_BACK_ROLLBACK_WRITE_SQL = "    UPDATE documents\n       SET status = p_status,\n           superseded_at = p_superseded_at,\n           superseded_by_user = p_superseded_by_user,\n           supersession_reason = p_supersession_reason,\n           supersession_moc = p_supersession_moc,";

/** put_back_retired_issue (20261165), transcribed for its four doors (P19's
 *  full transcription is pinned in dcRoundFStampedPutBack.test.ts): a blank
 *  status refused; the flag names the document around its own write when
 *  Document Control asks for the force over a hold on a stamped retirement —
 *  for a rollback, one the caller made (superseded_by_user = the session) —
 *  and the pass is recorded after the write (a refused write records
 *  nothing: the transaction rolls back). The un-archive clears the archive
 *  fields; a rollback puts the supersession fields back as given. */
async function putBackRetiredIssueSql(args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
  if (!String(args.p_status ?? "").trim()) return { data: null, error: { code: "23514", message: S_PB_STATUS } };
  const id = String(args.p_document_id);
  const via = String(args.p_via ?? "");
  const uid = state.as.actor ?? ME;
  const d = T("documents").find((x) => x.id === id);
  if (!d || !["unarchive", "supersede_rollback", "lifecycle_rollback", "reversal_rollback"].includes(via)) return { data: "no_match", error: null };
  const forced = args.p_force_hold === true && d.status === (via === "unarchive" ? "Archived" : "Superseded")
    && (via === "unarchive" || (has(d.superseded_by_user) && d.superseded_by_user === uid))
    && has(d.retired_issue_version_id) && d.retired_issue_version_id === d.current_version_id
    && !["Draft", "In Review", "Superseded", "Void", "Archived"].includes(String(args.p_status).trim())
    && (state.as.controller ?? true) && activeHolds(id).length > 0;
  state.flag = forced ? id : null;
  let res: { data: unknown; error: unknown };
  try {
    // the function's own UPDATE, as the caller (SECURITY INVOKER): the guard, bound as the BEFORE UPDATE trigger, reads the flag
    const payload: Record<string, unknown> = via === "unarchive"
      ? { status: args.p_status, archived_at: null, archived_by: null, archive_reason: null, updated_by: uid }
      : {
          status: args.p_status, superseded_at: args.p_superseded_at ?? null, superseded_by_user: args.p_superseded_by_user ?? null,
          supersession_reason: args.p_supersession_reason ?? null, supersession_moc: args.p_supersession_moc ?? null, updated_by: uid,
        };
    res = await supabase.from("documents").update(payload).eq("id", id).select("id");
  } finally {
    state.flag = null;
  }
  if (res.error) return { data: null, error: res.error };
  if (((res.data as unknown[] | null) ?? []).length === 0) return { data: "no_match", error: null };
  if (forced) T("audit_logs").push({ id: `ovr-${id}`, action: "REV_HOLD_OVERRIDDEN", resource_id: id, resource_type: "document", org_id: ORG, details: { via } });
  return { data: forced ? "restored_over_hold" : "restored", error: null };
}

describe("REV-21 (review fix) — the REAL un-archive (lib/revisions.ts unarchiveDocument, through put_back_retired_issue) against the guard, before and after 20261185", () => {
  const OWNER_RQ = { actor: "w1", controller: false, publisher: true, requireMode: true, rosterComplete: false };
  const archivedFrom = (id: string, stamp: string, extra: Row = {}) =>
    seedDoc(id, { status: "Archived", archived_at: "2026-09-30", retired_issue_status: stamp, retired_issue_version_id: `${id}-v2`, ...extra });
  const unarchive = (id: string, restoreStatus: string, forceHold?: boolean) =>
    unarchiveDocument({ doc: asRecord(docRow(id)), reason: "", orgId: ORG, actorUserId: state.as.actor ?? ME, restoreStatus, forceHold });
  const overrides = (id: string) => T("audit_logs").filter((a) => a.action === "REV_HOLD_OVERRIDDEN" && a.resource_id === id).length;
  beforeEach(() => {
    state.rpc = async (fn: string, args: Record<string, unknown>) => fn === "put_back_retired_issue"
      ? putBackRetiredIssueSql(args)
      : { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
  });

  it("the transcribed door is 20261165's", () => {
    expect(M165).toContain(PUT_BACK_DOOR_SQL);
    expect(M165).toContain("    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);");
    expect(M165).toContain(PUT_BACK_BLANK_SQL);
    expect(M165).toContain(PUT_BACK_ROLLBACK_WRITE_SQL);
  });

  for (const p16 of [false, true]) {
    it(`${p16 ? "after" : "before"} the paste: the owner's un-archive of an IFC drawing's unreviewed revision into Issued in a require library is ${p16 ? "REFUSED in the require sentence (the dialog then offers the Draft restore)" : "ADMITTED — the finding's second route"}`, async () => {
      state.p16 = p16;
      state.as = OWNER_RQ;
      archivedFrom("u1", "IFC");
      if (p16) {
        await expect(unarchive("u1", "Issued")).rejects.toThrow(`The document was NOT restored (${S_REQUIRE}) — nothing was changed.`);
        expect([docRow("u1").status, docRow("u1").retired_issue_status]).toEqual(["Archived", "IFC"]);
        expect(T("audit_logs").filter((a) => a.action === "DOCUMENT_ISSUED")).toEqual([]);
      } else {
        await unarchive("u1", "Issued");
        expect(docRow("u1").status).toBe("Issued");
      }
    });

    it(`${p16 ? "after" : "before"} the paste: Document Control's confirmed override (forceHold) of a held IFC-stamped archive into Issued is ${p16 ? "REFUSED in the new door's sentence, nothing recorded" : "ADMITTED and recorded as REV_HOLD_OVERRIDDEN"}`, async () => {
      state.p16 = p16;
      archivedFrom("u2", "IFC");
      seedHold("u2");
      if (p16) {
        await expect(unarchive("u2", "Issued", true)).rejects.toThrow(`The document was NOT restored (${S_NEW_DOOR_HOLD}) — nothing was changed.`);
        expect(docRow("u2").status).toBe("Archived");
        expect(overrides("u2")).toBe(0);
      } else {
        await unarchive("u2", "Issued", true);
        expect(docRow("u2").status).toBe("Issued");
        expect(overrides("u2")).toBe(1);
      }
      expect(state.flag).toBeNull();
    });

    it(`REGRESSION ${p16 ? "after" : "before"} the paste: an Issued-stamped archive comes back Issued (the owner, require, unreviewed; Document Control's override over a hold, recorded); an IFC-stamped one comes back a Draft, or Issued where nothing binds`, async () => {
      state.p16 = p16;
      state.as = OWNER_RQ;
      archivedFrom("k1", "Issued");
      await unarchive("k1", "Issued");
      expect(docRow("k1").status).toBe("Issued");
      archivedFrom("k2", "IFC");
      await unarchive("k2", "Draft");
      expect(docRow("k2").status).toBe("Draft");
      archivedFrom("k3", "IFC", { library_id: "lib-none" });
      state.as = { ...OWNER_RQ, requireMode: false };
      await unarchive("k3", "Issued");
      expect(docRow("k3").status).toBe("Issued");
      state.as = {};
      archivedFrom("k4", "Issued");
      seedHold("k4");
      await unarchive("k4", "Issued", true);
      expect([docRow("k4").status, overrides("k4")]).toEqual(["Issued", 1]);
      archivedFrom("k5", "IFC");
      seedHold("k5");
      await unarchive("k5", "Draft");
      expect(docRow("k5").status).toBe("Draft");
      archivedFrom("k6", "IFC");
      state.as = { requireMode: true, rosterComplete: false };
      await unarchive("k6", "Issued"); // Document Control, unheld, require, unreviewed: DEC-63 §2
      expect(docRow("k6").status).toBe("Issued");
    });
  }

  // REV-27 (opened by this fix, DEC-31): the dialog still calls an IFC-stamped archive's restore into Issued
  // "the put-back of that issue" (basis "issued", Issued pre-selected) and offers no restore to the stamped
  // status. When REV-27 lands this tripwire fails: flip it to `it`.
  it.fails("REV-27 tripwire: the un-archive dialog does not offer an IFC-stamped archive's restore into Issued as the put-back of its issue", async () => {
    archivedFrom("t1", "IFC");
    const d = await unarchiveRestoreDefault("t1");
    expect(d).not.toEqual({ status: "Issued", basis: "issued" });
  });
});

// ─── 5. the second app result that changes: the rollback of a NULL-status document (second review fix) ───
describe("REV-21 (second review fix) — the REAL rollbacks of a NULL-status document (undoFailedSupersede, restoreSupersededSource) put back 'Issued', which the guard judges as an issue after 20261185", () => {
  const OWNER_RQ = { actor: "w1", controller: false, publisher: true, requireMode: true, rosterComplete: false };
  const supersede = (id: string, replacements: string[], force?: boolean) =>
    supersedeDocument({ doc: asRecord(docRow(id)), replacementDocNumbers: replacements, libraryId: "lib1", reason: "replaced", orgId: ORG, actorUserId: state.as.actor ?? ME, force });
  const lineage = (id: string) => T("document_supersessions").filter((r) => r.superseded_doc_id === id).map((r) => r.replacement_doc_id);
  const overrides = (id: string) => T("audit_logs").filter((a) => a.action === "REV_HOLD_OVERRIDDEN" && a.resource_id === id).length;
  const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  beforeEach(() => {
    state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
    state.rpc = async (fn: string, args: Record<string, unknown>) => fn === "put_back_retired_issue"
      ? putBackRetiredIssueSql(args)
      : { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
  });

  it("the population: the three fallbacks that turn a NULL prior status into 'Issued' (REV-29 — when it lands, this pin moves with it)", () => {
    expect(src("lib/revisions.ts")).toContain("  const priorStatus = String(prior.status ?? \"Issued\");\n  let restoreProblem: string | null = null;");
    expect(src("lib/documentLifecycle/common.ts")).toContain("  const priorStatus = String(prior.status ?? \"Issued\");\n\n  // The pairs that already exist are not this attempt's to remove.");
    expect(src("lib/documentLifecycle/merge.ts")).toContain("priorStatuses[r.id] = String(r.status ?? \"Issued\");");
  });

  for (const p16 of [false, true]) {
    it(`${p16 ? "after" : "before"} the paste: the owner's failed supersede of a NULL-status document with an unreviewed revision in a require library is ${p16 ? "NOT put back — the require sentence; the document stays Superseded and the lineage pair the attempt added is left" : "put back as 'Issued' (not NULL: REV-29) and the pair it added removed"}`, async () => {
      state.p16 = p16;
      state.as = OWNER_RQ;
      seedDoc("n1", { status: null }); seedDoc("n1a"); seedDoc("n1b");
      // one pair lands, the other is refused: the lineage is incomplete, so undoFailedSupersede runs
      state.db.beforeInsert!.document_supersessions = (row) => (row.replacement_doc_id === "n1b" ? null : row);
      const run = supersede("n1", ["N1A", "N1B"]);
      if (p16) {
        await expect(run).rejects.toThrow(`The document is now Superseded and its previous status could not be restored (${S_REQUIRE}) — ask Doc Control to restore it to Issued or record the replacement links.`);
        expect(docRow("n1")).toMatchObject({ status: "Superseded", retired_issue_status: null, retired_issue_version_id: "n1-v2", supersession_reason: "replaced" });
        expect(lineage("n1")).toEqual(["n1a"]);
        expect(state.refusals).toEqual([S_REQUIRE]);
      } else {
        await expect(run).rejects.toThrow(/^Nothing was superseded: .* The document is back to Issued\. Fix the cause and supersede it again\.$/);
        expect(docRow("n1")).toMatchObject({ status: "Issued", retired_issue_status: null, supersession_reason: null });
        expect(lineage("n1")).toEqual([]);
        expect(state.refusals).toEqual([]);
      }
    });

    it(`${p16 ? "after" : "before"} the paste: Document Control's failed supersede of a held NULL-status document (forced over the hold) — its forced rollback is ${p16 ? "REFUSED in the new door's sentence, nothing recorded (C-9 / N-2)" : "put back as 'Issued', one REV_HOLD_OVERRIDDEN"}`, async () => {
      state.p16 = p16;
      seedDoc("n2", { status: null }); seedDoc("n2a"); seedHold("n2");
      state.db.refuseWrites.add("document_supersessions");
      const run = supersede("n2", ["N2A"], true);
      if (p16) {
        await expect(run).rejects.toThrow(`The document is now Superseded and its previous status could not be restored (${S_NEW_DOOR_HOLD}) — ask Doc Control to restore it to Issued`);
        expect([docRow("n2").status, overrides("n2")]).toEqual(["Superseded", 0]);
      } else {
        await expect(run).rejects.toThrow(/The document is back to Issued\./);
        expect([docRow("n2").status, overrides("n2")]).toEqual(["Issued", 1]);
      }
      expect(state.flag).toBeNull();
    });

    it(`${p16 ? "after" : "before"} the paste: a split / merge source with a NULL status, flipped by markSupersededAndLink (which records 'Issued' as its prior status), is ${p16 ? "NOT put back by restoreSupersededSource (the require sentence, named for manual attention; the lineage pair left)" : "put back as 'Issued' by restoreSupersededSource"} when a later step fails`, async () => {
      state.p16 = p16;
      state.as = OWNER_RQ;
      seedDoc("n3", { status: null }); seedDoc("n3a");
      let recorded: string | null = null;
      const run = withCompensation(async (register) => {
        const r = await markSupersededAndLink({ sourceDocId: "n3", replacementDocIds: ["n3a"], reason: "split", actor: { orgId: ORG, actorUserId: "w1" }, register, label: "N3" });
        recorded = r.priorStatus;
        throw new Error("a later step failed");
      });
      if (p16) {
        await expect(run).rejects.toThrow(`a later step failed\n\nThe operation was rolled back, but some cleanup steps failed and may need manual attention:\n- restore N3 from Superseded: source n3 is still Superseded — restore it to Issued (${S_REQUIRE})`);
        expect(docRow("n3").status).toBe("Superseded");
        expect(lineage("n3")).toEqual(["n3a"]);
      } else {
        await expect(run).rejects.toThrow("a later step failed (the operation was rolled back — no partial changes were kept).");
        expect(docRow("n3").status).toBe("Issued");
        expect(lineage("n3")).toEqual([]);
      }
      // the event the split / merge would have written carries the same 'Issued' — a reversal restores it (N-6 on PostgreSQL 16)
      expect(recorded).toBe("Issued");
    });

    it(`REGRESSION ${p16 ? "after" : "before"} the paste: every other rollback puts back the status read before the retirement and lands — an IFC document back to IFC (the owner, require, unreviewed; Document Control's forced one over a hold, recorded), an Issued one back to Issued; a NULL-status one where nothing binds (a none library; Document Control unheld)`, async () => {
      state.p16 = p16;
      state.as = OWNER_RQ;
      seedDoc("k1"); seedDoc("k1a"); // IFC
      state.db.refuseWrites.add("document_supersessions");
      await expect(supersede("k1", ["K1A"])).rejects.toThrow(/The document is back to IFC\./);
      seedDoc("k2", { status: "Issued" }); seedDoc("k2a");
      await expect(supersede("k2", ["K2A"])).rejects.toThrow(/The document is back to Issued\./);
      state.as = { ...OWNER_RQ, requireMode: false };
      seedDoc("k3", { status: null, library_id: "lib-none" }); seedDoc("k3a");
      await expect(supersede("k3", ["K3A"])).rejects.toThrow(/The document is back to Issued\./);
      state.as = { requireMode: true, rosterComplete: false };
      seedDoc("k4", { status: null }); seedDoc("k4a");
      await expect(supersede("k4", ["K4A"])).rejects.toThrow(/The document is back to Issued\./);
      seedDoc("k5"); seedDoc("k5a"); seedHold("k5");
      await expect(supersede("k5", ["K5A"], true)).rejects.toThrow(/The document is back to IFC\./);
      expect([docRow("k1").status, docRow("k2").status, docRow("k3").status, docRow("k4").status, docRow("k5").status]).toEqual(["IFC", "Issued", "Issued", "Issued", "IFC"]);
      expect(overrides("k5")).toBe(1);
      expect(state.refusals).toEqual([]);
      state.db.refuseWrites.delete("document_supersessions");
      state.as = OWNER_RQ;
      seedDoc("k6"); seedDoc("k6a"); // IFC, through the split / merge rollback
      await expect(withCompensation(async (register) => {
        await markSupersededAndLink({ sourceDocId: "k6", replacementDocIds: ["k6a"], reason: "merge", actor: { orgId: ORG, actorUserId: "w1" }, register, label: "K6" });
        throw new Error("later");
      })).rejects.toThrow("later (the operation was rolled back — no partial changes were kept).");
      expect(docRow("k6").status).toBe("IFC");
    });
  }

  // REV-29 (opened by this fix, DEC-31): a NULL prior status goes back as "Issued" (the three fallbacks above), and
  // put_back_retired_issue refuses a blank status, so it cannot go back as what it was. When REV-29 lands this fails: flip it to `it`.
  it.fails("REV-29 tripwire: the owner's failed supersede of a NULL-status document is put back as NULL — what it was — after the paste", async () => {
    state.as = OWNER_RQ;
    seedDoc("z1", { status: null }); seedDoc("z1a");
    state.db.refuseWrites.add("document_supersessions");
    await supersede("z1", ["Z1A"]).catch(() => undefined);
    expect(docRow("z1").status).toBeNull();
  });
});
