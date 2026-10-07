// document-control Round F wave 3 — P21 FIRST-POINTER-WRITE HOLD LIMB:
// REV-25, against the guard 20261182 re-creates.
//
//   After 20261174 the guard's hold limbs judged a pointer MOVE off a
//   current revision only, so Document Control could still put a revision
//   that was never the issued one in force over an active hold, unrecorded:
//   (i) by a FIRST pointer write (no current revision -> a revision) on a
//   held document; (ii) by clearing a held issued document's pointer, then
//   setting it; (iii) by the Draft route (restore a held archive to Draft,
//   clear it, make it Issued with no revision, set the pointer). 20261182
//   binds (i) and (ii) as unforced moves — refused over a hold, in REV-20
//   (b)'s sentence, unless the flag a recorded force sets names the
//   document — and (iii) closes at its last step, a first pointer write.
//
// REGRESSION FIRST (the user's top rule): every legitimate write that works
// today still works, driven through the REAL app functions against this
// guard — a new document's creation (createDocumentWithFile, the split /
// merge sheets — REV-17's first pointer write: no hold at that write, so
// unchanged), the review promote and its recorded force, and every put-back
// P13 / P14 / P17 / P18 / P19 / P20 keep working.
//
// There is no database here: enforce_document_publish_guard (20261182),
// put_back_retired_issue (20261165), restore_reversed_source (20261164) and
// finalize_reviewed_promote (20261151) are TRANSCRIBED below — each branch
// pinned to the SQL text it mirrors, in order — and bound to the in-memory
// PostgREST (the guard as the documents BEFORE UPDATE trigger, reading the
// flag as each write fires; the functions as its RPCs), as P20's
// dcRoundFRetiredHoldLimbs.test.ts does for 20261174. All four were
// exercised on PostgreSQL 16 (REV-25's record).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

type RpcAnswer = { data: unknown; error: { code?: string; message: string } | null };
const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  roles: ["DocCtrl"] as string[],
  /** The guard's publisher tier for a non-controller (a granted publisher or the effective owner). */
  publisher: false,
  /** lib/ownership isEffectiveOwnerOfDocument and lib/documentGuards resolveCanControlLibrary, for the app's pre-gates. */
  canControl: true,
  /** current_setting('app.publish_hold_override', true) for the call in flight. */
  flag: null as string | null,
  /** The session the writes and RPCs run as (auth.uid()); null = the service role. */
  session: "u1" as string | null,
  /** The library's review mode, as review_control_mode_for answers it. */
  requireMode: false,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  putBack: null as unknown as (args: Record<string, unknown>) => Promise<RpcAnswer>,
  restore: null as unknown as (args: Record<string, unknown>) => Promise<RpcAnswer>,
  promote: null as unknown as (args: Record<string, unknown>) => Promise<RpcAnswer>,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => (t === "audit_logs" ? auditLogsAsPostgres(base.from(t)) : base.from(t)),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        if (fn === "put_back_retired_issue") return state.putBack(args);
        if (fn === "restore_reversed_source") return state.restore(args);
        if (fn === "finalize_reviewed_promote") return state.promote(args);
        return { data: null, error: { code: "PGRST202", message: "not in this test" } };
      },
    };
  },
}));
/** audit_logs as PostgreSQL reads it: `id` is a uuid column (any spelling the type accepts matches). */
function auditLogsAsPostgres(inner: object): object {
  const wrap = (b: object): object => new Proxy(b, {
    get(target, prop) {
      const v = (target as Record<string | symbol, unknown>)[prop];
      if (prop === "then" || typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (prop === "eq" && args[0] === "id" && typeof args[1] === "string") args = ["id", args[1].toLowerCase().replace(/^\{(.*)\}$/, "$1")];
        const out = (v as (...a: unknown[]) => unknown)(...args);
        return out === target ? wrap(target) : out;
      };
    },
  });
  return wrap(inner);
}

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
  return { ...real, resolveCanControlLibrary: vi.fn(async () => state.canControl) };
});
vi.mock("@/lib/ownership", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ownership")>();
  return { ...real, isEffectiveOwnerOfDocument: vi.fn(async () => state.canControl) };
});
vi.mock("@/lib/reviewControl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviewControl")>();
  return { ...real, effectiveReviewControlForDocument: vi.fn(async () => ({ mode: state.requireMode ? "require" : "none" })) };
});
vi.mock("@/lib/effectiveDate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/effectiveDate")>();
  return { ...real, applyEffectiveDate: vi.fn(async () => undefined) };
});
vi.mock("@/lib/checklists", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/checklists")>();
  return { ...real, sweepEvidenceForDocument: vi.fn(async () => ({ projects: 0 })) };
});
vi.mock("@/lib/unitCodeClient", () => ({ requestUnitCodeDecode: vi.fn(async () => ({ note: null })) }));
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

import {
  supersedeDocument, archiveDocument, unarchiveDocument, changeDocumentStatus, createDocumentWithFile,
} from "@/lib/revisions";
import { finalizeReviewedRevision, isFinalizeHoldRefusal } from "@/lib/reviewControl";
import { reverseSplit } from "@/lib/documentLifecycle/reverse";
import { splitDocument } from "@/lib/documentLifecycle/split";
import { mergeDocuments } from "@/lib/documentLifecycle/merge";
import { markSupersededAndLink, withCompensation } from "@/lib/documentLifecycle/common";
import { isControlledIssueStatus, isIssueRefusal } from "@/lib/issueStatus";
import type { DocumentRecord } from "@/types/schema";

// ─── the guard and the functions, read from 20261182 / 20261165 / 20261164 / 20261151 ─
const read = (f: string) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8");
const M182 = read("20261182_dc_roundF_first_pointer_hold_limb.sql");
const M165 = read("20261165_dc_roundF_stamped_put_back.sql");
const M164 = read("20261164_dc_roundF_reversal_restore.sql");
const M151 = read("20261151_dc_roundF_promote_transaction_and_hold_override.sql");
const body = (M: string, head: string) => {
  const a = M.indexOf(head);
  expect(a, head).toBeGreaterThanOrEqual(0);
  return M.slice(a, M.indexOf("\n$$;", a));
};
const G = body(M182, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()");
const P = body(M165, "CREATE OR REPLACE FUNCTION put_back_retired_issue(");
const R = body(M164, "CREATE OR REPLACE FUNCTION restore_reversed_source(");
const F = body(M151, "CREATE OR REPLACE FUNCTION finalize_reviewed_promote(");
const RETIRED = ["Superseded", "Archived", "Void"];
const ISSUES = ["Issued", "IFC", "Locked", "For Construction"];
const WORK = ["Draft", "In Review"];
/** put_back_retired_issue's issue test: btrim (spaces) NOT IN these — read from the SQL. */
const PB_NOT_ISSUE = (() => {
  const m = /AND btrim\(p_status\) NOT IN \(([^)]*)\)/.exec(P);
  expect(m, "the door names its non-issue statuses").toBeTruthy();
  return m![1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
})();

const S_NEW_DOOR_HOLD = "Document has an active hold; release the hold before issuing it.";
const S_UNFORCED_HOLD = "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.";
const S_REQUIRE = "This library requires reviewer sign-off, so a revision that was not reviewed can't be made a controlled issue; submit it for review, or ask Document Control.";
const S_FIRST_ISSUE_REQUIRE = "This library requires reviewer sign-off, so a new document can't be issued unreviewed; create it as a Draft and submit it for review, or ask Document Control.";
const S_AUTHORITY = "You do not have authority to publish revisions in this library.";
const S_PUBLISHER_HOLD = "Document has an active hold; release the hold before publishing a new revision.";

type GuardCtx = {
  actor: string | null;
  controller: boolean;
  publisher: boolean;
  held: (docId: string) => boolean;
  flag?: string | null;
  requireMode?: boolean;
  rosterComplete?: boolean;
  /** No intake link on the revision made current (REV-17's first-issue rule reads it). */
  intake?: boolean;
};
const raise = (message: string) => { throw { code: "23514", message }; };
const refused = (f: () => unknown): string | null => {
  try { f(); } catch (e) { return (e as { message: string }).message; }
  return null;
};
const has = (v: unknown) => v !== null && v !== undefined;

/** enforce_document_publish_guard() (20261182), transcribed: 20261174's
 *  branches (as P20's transcription) plus the two P21 limbs, and REV-17's
 *  first-issue rule from the review gate (the one branch of it a creation's
 *  first pointer write meets). A NULL status is outside its domain; the rest
 *  of the review gate admits every pointer move here (pinned by its own
 *  tests). */
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
  // REV-20 (a): the unstamped Archived / Void exit
  newDoor = newDoor || (issuing && sameptr && ["Archived", "Void"].includes(os) && !has(OLD.retired_issue_status) && ctx.controller);
  const flagNamesIt = (ctx.flag ?? null) === NEW.id;
  // REV-22 (P18): the unstamped Superseded exit, unless the flag names the document
  newDoor = newDoor || (issuing && sameptr && os === "Superseded" && !has(OLD.retired_issue_status) && !flagNamesIt && ctx.controller);
  const unforced = issuing && !sameptr && !flagNamesIt && ctx.controller;
  // REV-22 (P17): a pointer move on a document already issued
  let unforcedMove = has(OLD.current_version_id) && has(NEW.current_version_id) && !sameptr
    && isControlledIssueStatus(os) && isControlledIssueStatus(ns) && !flagNamesIt && ctx.controller;
  advancing = advancing || issuing;
  const restoring = issuing && RETIRED.includes(os) && has(OLD.retired_issue_version_id)
    && NEW.current_version_id === OLD.retired_issue_version_id && NEW.current_version_id === OLD.current_version_id;
  // REV-23 (P19): the stamped put-back, unless the flag names the document
  newDoor = newDoor || (restoring && !flagNamesIt && ctx.controller);
  // REV-24 (P20) (b): a pointer move on a retired document — to another revision or cleared — unless the flag names it
  unforcedMove = unforcedMove || (has(OLD.current_version_id) && !sameptr
    && RETIRED.includes(os) && !flagNamesIt && ctx.controller);
  // REV-24 (P20) (a): the exit of a retirement whose stamp names another revision — for everyone, no flag
  newDoor = newDoor || (issuing && sameptr && RETIRED.includes(os) && has(OLD.retired_issue_version_id)
    && OLD.retired_issue_version_id !== (OLD.current_version_id ?? null));
  // REV-25 (P21) (i): a FIRST pointer write (no current revision -> a revision), in any status, unless the flag names it
  unforcedMove = unforcedMove || (!has(OLD.current_version_id) && has(NEW.current_version_id) && !flagNamesIt && ctx.controller);
  // REV-25 (P21) (ii): a CLEAR of the pointer of a document in an issue status, whatever status the write leaves, unless the flag names it
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
  // REV-17 (the review gate's zero-roster branch): a non-controller's first issue under require
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

describe("the transcriptions are the SQL's (20261182 / 20261165 / 20261164 / 20261151, in order)", () => {
  it("the guard: every branch it mirrors is in 20261182's body, in this order — the two P21 limbs right after P20's and before the stamp is written", () => {
    const fragments = [
      "  IF v_actor IS NULL THEN\n    RETURN NEW;\n  END IF;",
      "       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)\n    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded')",
      "    OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status)",
      "    OR (NEW.status = 'Archived' AND COALESCE(OLD.status, '') <> 'Archived');",
      "  v_issuing := NEW.current_version_id IS NOT NULL\n               AND NOT is_controlled_issue_status(OLD.status)\n               AND is_controlled_issue_status(NEW.status);",
      "  v_new_door := v_issuing\n                AND (NOT COALESCE(v_advancing, false)\n                     OR COALESCE(NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                                 AND OLD.retired_issue_status = 'not-issued'\n                                 AND OLD.retired_issue_version_id IS NULL, false));",
      "                            AND OLD.status IN ('Archived', 'Void')\n                            AND OLD.retired_issue_status IS NULL\n                            AND is_org_controller(NEW.org_id), false);",
      "                            AND OLD.status = 'Superseded'\n                            AND OLD.retired_issue_status IS NULL\n                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                            AND is_org_controller(NEW.org_id), false);",
      "  v_unforced_issue := COALESCE(v_issuing\n                               AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                               AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                               AND is_org_controller(NEW.org_id), false);",
      "  v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                              AND is_controlled_issue_status(OLD.status)\n                              AND is_controlled_issue_status(NEW.status)\n                              AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                              AND is_org_controller(NEW.org_id), false);",
      "  v_advancing := v_advancing OR v_issuing;",
      "  v_restoring := COALESCE(v_issuing\n                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                 AND OLD.retired_issue_version_id IS NOT NULL\n                 AND NEW.current_version_id = OLD.retired_issue_version_id\n                 AND NEW.current_version_id = OLD.current_version_id, false);",
      "  v_new_door := v_new_door\n                OR COALESCE(v_restoring\n                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                            AND is_org_controller(NEW.org_id), false);",
      // P20 (b)
      "  v_unforced_move := v_unforced_move\n                     OR COALESCE(OLD.current_version_id IS NOT NULL\n                                 AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                                 AND is_org_controller(NEW.org_id), false);",
      // P20 (a)
      "  v_new_door := v_new_door\n                OR COALESCE(v_issuing\n                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                            AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                            AND OLD.retired_issue_version_id IS NOT NULL\n                            AND OLD.retired_issue_version_id IS DISTINCT FROM OLD.current_version_id, false);",
      // P21 (i) — the first pointer write, any status
      "  v_unforced_move := v_unforced_move\n                     OR COALESCE(OLD.current_version_id IS NULL\n                                 AND NEW.current_version_id IS NOT NULL\n                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                                 AND is_org_controller(NEW.org_id), false);",
      // P21 (ii) — the clear out of an issue status
      "  v_unforced_move := v_unforced_move\n                     OR COALESCE(OLD.current_version_id IS NOT NULL\n                                 AND NEW.current_version_id IS NULL\n                                 AND is_controlled_issue_status(OLD.status)\n                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                                 AND is_org_controller(NEW.org_id), false);",
      "  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN\n    IF COALESCE(OLD.status IN ('Superseded', 'Archived', 'Void'), false) THEN\n      NEW.retired_issue_status := OLD.retired_issue_status;",
      "    ELSIF OLD.current_version_id IS NOT NULL AND is_controlled_issue_status(OLD.status) THEN\n      NEW.retired_issue_status := OLD.status;\n      NEW.retired_issue_version_id := OLD.current_version_id;",
      "      NEW.retired_issue_status := 'not-issued';\n      NEW.retired_issue_version_id := NULL;",
      "  ELSE\n    NEW.retired_issue_status := NULL;\n    NEW.retired_issue_version_id := NULL;\n  END IF;",
      "  IF NOT v_advancing THEN\n    RETURN NEW;\n  END IF;",
      // REV-17 — a creation's first pointer write, decided as before
      "      IF OLD.current_version_id IS NULL AND v_intake_link IS NULL\n         AND COALESCE(NEW.status, '') NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')\n         AND NOT is_org_controller(NEW.org_id)",
      `          '${S_FIRST_ISSUE_REQUIRE.replace("'", "''")}'`,
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

  it("the put-back door (20261165) and the reversal's restore (20261164), unchanged: each sets the flag around a STATUS write only — neither writes the pointer", () => {
    expect(P).toContain("     AND v_stamped IS NOT NULL\n     AND v_stamped = v_version\n");
    expect(PB_NOT_ISSUE).toEqual(["Draft", "In Review", "Superseded", "Void", "Archived"]);
    expect(R).toContain("  IF v_status = 'Superseded'\n     AND v_action IS NOT NULL\n     AND is_org_controller(v_org)\n");
    for (const fn of [P, R]) expect(fn).not.toMatch(/current_version_id\s*=/);
  });

  it("the review promote (20261151, unchanged): a controller's force while a hold is active sets the flag around its compare-and-set promote (the first pointer write included: p_expected_current NULL), clears it, and records REV_HOLD_OVERRIDDEN — the branches this file's transcription mirrors, in order", () => {
    const fragments = [
      "  IF p_force_hold THEN\n    SELECT d.org_id INTO v_org FROM documents d WHERE d.id = p_document_id;",
      "       AND (CASE WHEN auth.uid() IS NOT NULL THEN is_org_controller(v_org)",
      "       AND EXISTS (SELECT 1 FROM document_holds h\n                    WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n      v_hold_forced := TRUE;",
      "  IF v_hold_forced THEN\n    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);\n  END IF;",
      "  UPDATE documents\n     SET current_version_id = p_pending_id,\n         rev = p_base_rev,\n         revision = p_base_rev,\n         status = 'Issued',\n         pending_version_id = NULL,",
      "   WHERE id = p_document_id\n     AND pending_version_id = p_pending_id\n     AND current_version_id IS NOT DISTINCT FROM p_expected_current;",
      "  IF v_hold_forced THEN\n    PERFORM set_config('app.publish_hold_override', '', true);\n  END IF;\n  IF v_n = 0 THEN\n    RETURN 'no_match';",
      "  UPDATE document_versions\n     SET review_state = 'approved',",
      "  IF v_hold_forced THEN\n    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)\n    VALUES ('REV_HOLD_OVERRIDDEN',",
      "              'via', 'review_promote',",
      "  RETURN 'promoted';",
    ];
    let at = -1;
    for (const f of fragments) {
      const i = F.indexOf(f, at + 1);
      expect(i, f.slice(0, 80)).toBeGreaterThan(at);
      at = i;
    }
  });
});

// ─── the harness ───────────────────────────────────────────────────────────
const ORG = "o1";
const LIB = "lib1";
const ME = "u1";
const T = (t: string) => (state.db.tables[t] ??= []);
const docRow = (id: string) => T("documents").find((d) => d.id === id)!;
const audit = (action: string) => T("audit_logs").filter((r) => r.action === action);
const overrides = (id?: string) => audit("REV_HOLD_OVERRIDDEN").filter((r) => !id || r.resource_id === id);
const activeHolds = (id: string) => T("document_holds").filter((h) => h.document_id === id && h.released_at == null);
const isController = () => state.roles.some((r) => r === "DocCtrl" || r === "Admin");
type Chain = {
  eq: (k: string, v: unknown) => Chain;
  is: (k: string, v: null) => Chain;
  select: (c: string) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
};
type Docs = { update: (p: Row) => Chain };
const docs = () => makeFakeSupabase(state.db).from("documents") as unknown as Docs;
const rows = (d: unknown) => ((d as unknown[] | null) ?? []).length;

/** put_back_retired_issue (20261165), transcribed as P19's and P20's tests do. */
async function putBackRetiredIssueSql(a: Record<string, unknown>): Promise<RpcAnswer> {
  const uid = state.session;
  if (uid === null) return { data: null, error: { code: "42501", message: "put_back_retired_issue: a put-back is a signed-in act, and this call has no session." } };
  const via = String(a.p_via ?? "");
  const doc = T("documents").find((d) => d.id === a.p_document_id && d.org_id === ORG);
  if (!doc) return { data: "no_match", error: null };
  const before = { status: doc.status, stamp: doc.retired_issue_status ?? null, version: doc.current_version_id, rev: doc.rev };
  const forced = a.p_force_hold === true
    && doc.status === (via === "unarchive" ? "Archived" : "Superseded")
    && (via === "unarchive" || (has(doc.superseded_by_user) && doc.superseded_by_user === uid))
    && has(doc.retired_issue_version_id) && doc.retired_issue_version_id === doc.current_version_id
    && !PB_NOT_ISSUE.includes(String(a.p_status).replace(/^ +| +$/g, ""))
    && isController() && activeHolds(String(doc.id)).length > 0;
  if (forced) state.flag = String(doc.id);
  const patch: Row = via === "unarchive"
    ? { status: a.p_status, archived_at: null, archived_by: null, archive_reason: null, updated_at: "now()", updated_by: uid }
    : {
        status: a.p_status, superseded_at: a.p_superseded_at ?? null, superseded_by_user: a.p_superseded_by_user ?? null,
        supersession_reason: a.p_supersession_reason ?? null, supersession_moc: a.p_supersession_moc ?? null, updated_at: "now()", updated_by: uid,
      };
  const res = await docs().update(patch).eq("id", doc.id).select("id");
  if (forced) state.flag = "";
  if (res.error) { state.flag = null; return { data: null, error: res.error }; }
  if (rows(res.data) === 0) return { data: "no_match", error: null };
  if (forced) {
    T("audit_logs").push({
      id: `pbo-${doc.id}-${T("audit_logs").length}`, action: "REV_HOLD_OVERRIDDEN", resource_id: doc.id, resource_type: "document", org_id: ORG, user_id: uid,
      details: {
        via, holds: activeHolds(String(doc.id)).map((h) => ({ id: h.id, reason: h.reason })),
        reason: String(a.p_reason ?? "").trim() || null, stampedPutBack: true, retiredIssueStatus: before.stamp,
        versionId: before.version, revisionLabel: before.rev, priorStatus: before.status, newStatus: a.p_status, branch: false,
      },
    });
  }
  return { data: forced ? "restored_over_hold" : "restored", error: null };
}

/** restore_reversed_source (20261164), transcribed as P18's, P19's and P20's tests do. */
async function restoreReversedSourceSql(a: Record<string, unknown>): Promise<RpcAnswer> {
  const uid = state.session;
  if (uid === null) return { data: null, error: { code: "42501", message: "restore_reversed_source: a reversal's restore is a signed-in act, and this call has no session." } };
  const doc = T("documents").find((d) => d.id === a.p_document_id && d.org_id === ORG);
  if (!doc) return { data: "no_match", error: null };
  const ev = T("audit_logs").find((r) => r.id === a.p_reversal_of && r.org_id === doc.org_id
    && (r.action === "DOC_SPLIT" || r.action === "DOC_MERGED")
    && (r.resource_id === doc.id
      || (Array.isArray((r.details as Row | null)?.mergeSiblings) && ((r.details as Row).mergeSiblings as unknown[]).includes(doc.id)))
    && !T("audit_logs").some((x) => x.org_id === doc.org_id && x.resource_id === r.resource_id
      && (x.action === "DOC_SPLIT_REVERSED" || x.action === "DOC_MERGE_REVERSED")
      && String((x.details as Row | null)?.reversedAuditEventId ?? "").toLowerCase().replace(/[{}-]/g, "") === String(a.p_reversal_of).replace(/-/g, "")));
  const before = { status: doc.status, stamp: doc.retired_issue_status ?? null };
  const forced = doc.status === "Superseded" && !!ev && isController() && activeHolds(String(doc.id)).length > 0;
  if (forced) state.flag = String(doc.id);
  const res = await docs().update({
    status: a.p_status, superseded_at: null, superseded_by_user: null, supersession_reason: null, supersession_moc: null,
    updated_at: "now()", updated_by: uid,
  }).eq("id", doc.id).select("id");
  if (forced) state.flag = "";
  if (res.error) { state.flag = null; return { data: null, error: res.error }; }
  if (rows(res.data) === 0) return { data: "no_match", error: null };
  if (forced) {
    T("audit_logs").push({
      id: `ovr-${doc.id}-${T("audit_logs").length}`, action: "REV_HOLD_OVERRIDDEN", resource_id: doc.id, resource_type: "document", org_id: ORG, user_id: uid,
      details: { via: "reversal_restore", reversedAuditEventId: a.p_reversal_of, reversedAction: ev!.action, retirementStamped: before.stamp !== null, priorStatus: before.status, newStatus: a.p_status },
    });
  }
  return { data: forced ? "restored_over_hold" : "restored", error: null };
}

/** finalize_reviewed_promote (20261151), transcribed: the controller's force
 *  while a hold is active sets the flag around the compare-and-set promote
 *  (the guard decides it as the caller), clears it, then the bookkeeping and
 *  the record. A refusal rolls the whole call back. */
async function finalizeReviewedPromoteSql(a: Record<string, unknown>): Promise<RpcAnswer> {
  const uid = state.session;
  const doc = T("documents").find((d) => d.id === a.p_document_id);
  const forced = a.p_force_hold === true && !!doc && (uid !== null ? isController() : false) && activeHolds(String(doc.id)).length > 0;
  if (forced) state.flag = String(a.p_document_id);
  let q = docs().update({
    current_version_id: a.p_pending_id, rev: a.p_base_rev, revision: a.p_base_rev, status: "Issued", pending_version_id: null,
    updated_at: "now()", updated_by: uid ?? a.p_actor,
  }).eq("id", a.p_document_id).eq("pending_version_id", a.p_pending_id);
  q = has(a.p_expected_current) ? q.eq("current_version_id", a.p_expected_current) : q.is("current_version_id", null);
  const res = await q.select("id");
  if (forced) state.flag = "";
  if (res.error) { state.flag = null; return { data: null, error: res.error }; }
  if (rows(res.data) === 0) return { data: "no_match", error: null };
  const v = T("document_versions").find((x) => x.id === a.p_pending_id);
  if (v) Object.assign(v, { review_state: "approved", revision_label: a.p_base_rev, released_at: "now()", supersedes_version_id: a.p_expected_current ?? null });
  if (forced) {
    T("audit_logs").push({
      id: `rpo-${String(a.p_document_id)}-${T("audit_logs").length}`, action: "REV_HOLD_OVERRIDDEN", resource_id: a.p_document_id, resource_type: "document", org_id: ORG, user_id: uid,
      details: {
        via: "review_promote", holds: activeHolds(String(a.p_document_id)).map((h) => ({ id: h.id, reason: h.reason })),
        reason: String(a.p_override_reason ?? "").trim() || null, versionId: a.p_pending_id, revisionLabel: a.p_base_rev, newStatus: "Issued", branch: false,
      },
    });
  }
  return { data: "promoted", error: null };
}

function seedDoc(id: string, extra: Row = {}): Row {
  const d: Row = {
    id, org_id: ORG, library_id: LIB, document_number: id.toUpperCase(), title: id, rev: "3", revision: "3",
    status: "Issued", current_version_id: `${id}-v3`, pending_version_id: null, checked_out_by: null, checked_out_by_name: null,
    retired_issue_status: null, retired_issue_version_id: null,
    ...extra,
  };
  T("documents").push(d);
  T("document_versions").push(
    { id: `${id}-v2`, org_id: ORG, record_id: id, revision_label: "2", superseded_at: "2026-01-01" },
    { id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null },
  );
  return d;
}
/** A document with NO current revision (its pointer cleared by the service role, or a register row): two revisions on file. */
function seedNoRevision(id: string, extra: Row = {}): Row {
  return seedDoc(id, { current_version_id: null, ...extra });
}
/** A reviewed draft pending on a document, built on `base` (its current revision then). */
function seedPendingDraft(docId: string, base: string | null, label = "4A") {
  docRow(docId).pending_version_id = `${docId}-p`;
  T("document_versions").push({ id: `${docId}-p`, org_id: ORG, record_id: docId, revision_label: label, base_rev: label.replace(/A$/, ""), review_state: "in_review", superseded_at: null, supersedes_version_id: base });
}
function seedHold(docId: string, reason = "Stop work") {
  T("document_holds").push({ id: `h-${docId}-${reason}`, org_id: ORG, document_id: docId, reason, notes: null, expected_release_at: null, released_at: null, opened_at: "2026-09-01" });
}
/** Bind the transcribed guard as the documents BEFORE UPDATE trigger, as the session (the flag read as each write fires). */
function bindGuard(extra: Partial<GuardCtx> = {}) {
  const refusals: string[] = [];
  state.db.beforeUpdate!.documents = (next, old) => {
    try {
      return publishGuard(next, old, {
        actor: state.session,
        controller: isController(),
        publisher: state.publisher,
        held: (id) => activeHolds(id).length > 0,
        flag: state.flag,
        requireMode: state.requireMode,
        ...extra,
      });
    } catch (e) {
      refusals.push((e as { message: string }).message);
      throw e;
    }
  };
  return refusals;
}
/** A stamped retirement, made as the app makes it: the document Issued, retired by a signed-in controller through the guard (which writes the stamp). */
async function retire(id: string, status: "Archived" | "Superseded" | "Void", from = "Issued"): Promise<void> {
  seedDoc(id, { status: from });
  if (!state.db.beforeUpdate!.documents) bindGuard();
  const saved = { roles: state.roles, session: state.session };
  state.roles = ["DocCtrl"]; state.session = ME;
  const res = await docs().update(status === "Archived"
    ? { status, archived_at: "2026-09-10T00:00:00Z", archived_by: ME, archive_reason: "retired" }
    : status === "Superseded" ? { status, superseded_at: "2026-09-10T00:00:00Z", superseded_by_user: ME, supersession_reason: "replaced" }
    : { status }).eq("id", id).select("id");
  state.roles = saved.roles; state.session = saved.session;
  expect(res.error, id).toBeNull();
}
/** A split of `prefix` into `${prefix}a` / `${prefix}b` (the sheets Issued, the source Superseded; `stamp` the source's). */
function seedSplit(prefix: string, stamp: "none" | "issued") {
  seedDoc(prefix, {
    status: "Superseded", uniqueness_key: `${prefix}-key`, superseded_at: "2025-09-01T10:00:00Z", supersession_reason: "split",
    ...(stamp === "none" ? {} : { retired_issue_status: "Issued", retired_issue_version_id: `${prefix}-v3` }),
  });
  for (const x of ["a", "b"]) seedDoc(`${prefix}${x}`, { uniqueness_key: `${prefix}${x}-key` });
  T("document_supersessions").push(
    { id: `l-${prefix}a`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}a`, reason: "split", created_by: ME, created_at: "2025-09-01T10:00:00Z" },
    { id: `l-${prefix}b`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}b`, reason: "split", created_by: ME, created_at: "2025-09-01T10:00:00Z" },
  );
  T("audit_logs").push({ id: `ev-${prefix}`, org_id: ORG, action: "DOC_SPLIT", resource_id: prefix, timestamp: "2025-09-01T10:00:00Z", details: { replacementDocIds: [`${prefix}a`, `${prefix}b`], priorStatus: "Issued", auditAt: "2025-09-01T10:00:00Z" } });
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: LIB, documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id, collectionId: null,
}) as unknown as DocumentRecord;
const pdf = (n: string) => new File([new Uint8Array([1, 2, 3])], n, { type: "application/pdf" });
const sheet = (n: string) => ({ documentNumber: n, title: n, assetTags: [], file: pdf(`${n}.pdf`), initialRevLabel: "0", changeLog: "" });
/** How many first pointer writes a creation door made (a documents UPDATE carrying only the pointer and updated_at). */
const firstPointerWrites = () => state.db.calls
  .filter((c) => c.table === "documents" && c.method === "update" && has((c.args[0] as Row).current_version_id) && Object.keys(c.args[0] as Row).every((k) => ["current_version_id", "updated_at"].includes(k)))
  .length;

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
  state.roles = ["DocCtrl"];
  state.publisher = false;
  state.canControl = true;
  state.flag = null;
  state.session = ME;
  state.requireMode = false;
  state.rpcCalls = [];
  state.putBack = putBackRetiredIssueSql;
  state.restore = restoreReversedSourceSql;
  state.promote = finalizeReviewedPromoteSql;
});

// ─── REGRESSION FIRST: every legitimate write that works today still works ──
describe("REV-25 (P21) — regression first: a new document's creation (REV-17's first pointer write) is unchanged", () => {
  it("createDocumentWithFile — Draft and Issued, by Document Control and by a publisher — writes its first pointer with no hold on the document, and lands exactly as before (nothing refused, nothing recorded)", async () => {
    const refusals = bindGuard();
    for (const [roles, publisher] of [[["DocCtrl"], false], [["Engineer"], true]] as const) {
      state.roles = [...roles]; state.publisher = publisher;
      for (const status of ["Draft", "Issued"] as const) {
        const n = `${roles[0]}-${status}`;
        const r = await createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: n, file: pdf(`${n}.pdf`), status, actorUserId: ME, decodeUnitCode: false });
        expect(docRow(r.documentId), n).toMatchObject({ status, current_version_id: expect.any(String) });
        expect(activeHolds(r.documentId)).toEqual([]);
      }
    }
    expect(refusals).toEqual([]);
    expect(firstPointerWrites()).toBe(4);
    expect(overrides()).toEqual([]);
  });

  it("REV-17's rule still decides a creation: a non-controller's Issued first pointer write under require is refused in its own words; Document Control's lands", async () => {
    bindGuard();
    state.requireMode = true;
    const base: Row = { id: "k1", status: "Issued", current_version_id: null };
    const owner: GuardCtx = { actor: "owner", controller: false, publisher: true, held: () => false, requireMode: true };
    expect(refused(() => publishGuard({ ...base, current_version_id: "k1-v0" }, base, owner))).toBe(S_FIRST_ISSUE_REQUIRE);
    expect(publishGuard({ ...base, current_version_id: "k1-v0" }, base, { ...owner, controller: true }).current_version_id).toBe("k1-v0");
    expect(publishGuard({ ...base, status: "Draft", current_version_id: "k1-v0" }, { ...base, status: "Draft" }, owner).current_version_id).toBe("k1-v0");
  });

  it("a split of a HELD source by Document Control over the hold (explicit force): every new sheet's first pointer write lands with no hold on the sheet, THEN the source's hold is carried onto it — nothing refused", async () => {
    const s = seedDoc("sp1"); seedHold("sp1");
    const refusals = bindGuard();
    const r = await splitDocument({ source: asRecord(s), libraryId: LIB, targets: [sheet("SP1A"), sheet("SP1B")], reason: "declutter", orgId: ORG, actorUserId: ME, force: true });
    expect(refusals).toEqual([]);
    expect(r.holdsCopied).toBe(2);
    for (const id of r.newDocumentIds) {
      expect(docRow(id).current_version_id).toBeTruthy();
      expect(activeHolds(id)).toHaveLength(1);
    }
    // each sheet's first pointer write precedes the first hold placed on any sheet
    const order = state.db.calls.filter((c) => (c.table === "document_holds" && c.method === "insert") || (c.table === "documents" && c.method === "update" && has((c.args[0] as Row).current_version_id)))
      .map((c) => (c.table === "document_holds" ? "hold" : "pointer"));
    expect(order).toEqual(["pointer", "pointer", "hold", "hold"]);
    expect(docRow("sp1").status).toBe("Superseded");
  });

  it("a merge of a held source into a NEW target by Document Control over the hold: the target's first pointer write lands, the hold is carried after — nothing refused", async () => {
    const a = seedDoc("mg1"); const b = seedDoc("mg2"); seedHold("mg2");
    const refusals = bindGuard();
    const r = await mergeDocuments({
      sources: [asRecord(a), asRecord(b)],
      target: { kind: "create_new", documentNumber: "MG-NEW", title: "merged", assetTags: [], file: pdf("m.pdf"), initialRevLabel: "0", changeLog: "", libraryId: LIB },
      reason: "combine", orgId: ORG, actorUserId: ME, force: true,
    });
    expect(refusals).toEqual([]);
    expect(r.holdsCopied).toBe(1);
    const target = T("documents").find((d) => d.document_number === "MG-NEW")!;
    expect(target.current_version_id).toBeTruthy();
    expect(activeHolds(String(target.id))).toHaveLength(1);
  });

  it("the review promote of an UNHELD document with no current revision (an intake submission's first approval) lands through finalize_reviewed_promote, unrecorded", async () => {
    seedNoRevision("ip1", { status: "Draft" });
    seedPendingDraft("ip1", null, "0A");
    const refusals = bindGuard();
    const r = await finalizeReviewedRevision({ orgId: ORG, documentId: "ip1", actorId: ME, requireRosterComplete: false });
    expect(r).toEqual({ published: true });
    expect(refusals).toEqual([]);
    expect(docRow("ip1")).toMatchObject({ status: "Issued", current_version_id: "ip1-p", pending_version_id: null });
    expect(overrides()).toEqual([]);
  });
});

describe("REV-25 (P21) — regression first: the put-backs, compensations, reversals and status edits P13 / P14 / P17 / P18 / P19 / P20 keep working still complete against 20261182's guard", () => {
  it("a controller's failed supersede of a held document (forced over the hold) is put back to Issued by undoFailedSupersede — exactly one REV_HOLD_OVERRIDDEN (supersede_rollback), nothing refused", async () => {
    const d = seedDoc("p1"); seedDoc("p1a"); seedHold("p1");
    const refusals = bindGuard();
    state.db.refuseWrites.add("document_supersessions");
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["P1A"], libraryId: LIB, reason: "replaced", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/^Nothing was superseded: The replacement links could not be recorded \(.*\)\. The document is back to Issued\./);
    expect(refusals).toEqual([]);
    expect(docRow("p1")).toMatchObject({ status: "Issued", retired_issue_status: null });
    expect(overrides("p1").map((o) => (o.details as Row).via)).toEqual(["supersede_rollback"]);
  });

  it("a split / merge source flipped by the saga (markSupersededAndLink) is put back by restoreSupersededSource when a later step fails — held: recorded once (lifecycle_rollback); the owner's unheld one: unrecorded", async () => {
    seedDoc("s1"); seedDoc("s1a"); seedHold("s1");
    const refusals = bindGuard();
    await expect(withCompensation(async (register) => {
      await markSupersededAndLink({ sourceDocId: "s1", replacementDocIds: ["s1a"], reason: "split", actor: { orgId: ORG, actorUserId: ME }, register, label: "S1" });
      throw new Error("a later step failed");
    })).rejects.toThrow("a later step failed (the operation was rolled back — no partial changes were kept).");
    expect(refusals).toEqual([]);
    expect(docRow("s1").status).toBe("Issued");
    expect(overrides("s1").map((o) => (o.details as Row).via)).toEqual(["lifecycle_rollback"]);
    state.roles = ["Engineer"]; state.publisher = true;
    seedDoc("s2"); seedDoc("s2a");
    await expect(withCompensation(async (register) => {
      await markSupersededAndLink({ sourceDocId: "s2", replacementDocIds: ["s2a"], reason: "merge", actor: { orgId: ORG, actorUserId: ME }, register, label: "S2" });
      throw new Error("later");
    })).rejects.toThrow(/no partial changes were kept/);
    expect(refusals).toEqual([]);
    expect(docRow("s2").status).toBe("Issued");
    expect(overrides("s2")).toEqual([]);
  });

  it("the un-archive: Document Control's confirmed un-archive of a held stamped archive is the recorded pass; unconfirmed it is refused in the new-door sentence; the Draft restore lands; unheld un-archives by Document Control and the owner land; the owner's held one is refused in the publisher tier's words", async () => {
    const d = seedDoc("a1");
    const refusals = bindGuard();
    await archiveDocument({ doc: asRecord(d), reason: "superseded on site", orgId: ORG, actorUserId: ME });
    seedHold("a1");
    await expect(unarchiveDocument({ doc: asRecord(docRow("a1")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" }))
      .rejects.toThrow(`The document was NOT restored (${S_NEW_DOOR_HOLD}) — nothing was changed.`);
    await unarchiveDocument({ doc: asRecord(docRow("a1")), reason: "back in force", orgId: ORG, actorUserId: ME, restoreStatus: "Issued", forceHold: true });
    expect(docRow("a1")).toMatchObject({ status: "Issued", archived_at: null });
    expect(overrides("a1")).toHaveLength(1);
    expect(refusals).toEqual([S_NEW_DOOR_HOLD]);
    await retire("a2", "Archived"); seedHold("a2");
    await unarchiveDocument({ doc: asRecord(docRow("a2")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    expect(docRow("a2").status).toBe("Draft");
    await retire("a3", "Archived");
    await unarchiveDocument({ doc: asRecord(docRow("a3")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    state.roles = ["Engineer"]; state.publisher = true;
    await retire("a4", "Archived");
    await unarchiveDocument({ doc: asRecord(docRow("a4")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    for (const id of ["a3", "a4"]) expect(docRow(id).status, id).toBe("Issued");
    await retire("a5", "Archived"); seedHold("a5");
    await expect(unarchiveDocument({ doc: asRecord(docRow("a5")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" }))
      .rejects.toThrow(`The document was NOT restored (${S_PUBLISHER_HOLD}) — nothing was changed.`);
    expect(overrides()).toHaveLength(1);
  });

  it("a reversal whose lineage delete is refused rolls back whole over a held parked sheet — the sheet's un-park recorded (reversal_rollback); P18's reversals of a stamped and an unstamped source come back over a carried hold, recorded once each", async () => {
    seedSplit("r1", "none");
    seedHold("r1a");
    const refusals = bindGuard();
    state.db.deleteErrors!.document_supersessions = { code: "42501", message: "only Document Control may delete supersession rows" };
    await expect(reverseSplit({ splitAuditEventId: "ev-r1", reason: "wrong split", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/supersession link\(s\) could not be removed[\s\S]*rolled back — no partial changes were kept/);
    expect(refusals).toEqual([]);
    for (const s of ["r1a", "r1b"]) expect(docRow(s)).toMatchObject({ status: "Issued", retired_issue_status: null });
    expect(overrides("r1a").map((o) => (o.details as Row).via)).toEqual(["reversal_rollback"]);
    delete state.db.deleteErrors!.document_supersessions;
    seedSplit("r2", "none"); seedHold("r2a");
    seedSplit("r3", "issued"); seedHold("r3b");
    await reverseSplit({ splitAuditEventId: "ev-r2", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    await reverseSplit({ splitAuditEventId: "ev-r3", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    expect(refusals).toEqual([]);
    expect(docRow("r2").status).toBe("Issued");
    expect(docRow("r3").status).toBe("Issued");
    expect(overrides("r2").map((o) => (o.details as Row).via)).toEqual(["reversal_restore"]);
    expect(overrides("r3").map((o) => (o.details as Row).via)).toEqual(["reversal_restore"]);
  });

  it("the status editors (changeDocumentStatus) for a non-controller: a publisher issues a Draft and restores an unheld retirement as before; the require limb decides a non-restoring issue as before", async () => {
    state.roles = ["Engineer"]; state.publisher = true;
    seedDoc("m1", { status: "Draft" });
    await retire("m3", "Void");
    bindGuard();
    for (const id of ["m1", "m3"]) {
      const outcome = await changeDocumentStatus({ orgId: ORG, documentId: id, toStatus: "Issued", door: "metadata", actorUserId: ME });
      expect(docRow(id).status, id).toBe("Issued");
      expect(outcome.issued, id).toBe(true);
    }
    seedDoc("m4", { status: "Draft" });
    state.requireMode = true;
    await expect(changeDocumentStatus({ orgId: ORG, documentId: "m4", toStatus: "Issued", door: "bulk", actorUserId: ME })).rejects.toThrow(S_REQUIRE);
    state.roles = ["DocCtrl"];
    await changeDocumentStatus({ orgId: ORG, documentId: "m4", toStatus: "Issued", door: "bulk", actorUserId: ME });
    expect(docRow("m4").status).toBe("Issued");
  });

  it("the earlier limbs keep their rules: P17's pointer move on a held Issued document, REV-20's pointer-and-issue, P20's move / clear of a held retired document — each refused unforced, admitted under the flag naming the document", () => {
    const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
    const issued: Row = { id: "d1", status: "Issued", current_version_id: "v3", retired_issue_status: null, retired_issue_version_id: null };
    expect(refused(() => publishGuard({ ...issued, current_version_id: "v4" }, issued, ctl))).toBe(S_UNFORCED_HOLD);
    expect(publishGuard({ ...issued, current_version_id: "v4" }, issued, { ...ctl, flag: "d1" }).current_version_id).toBe("v4");
    const draft: Row = { ...issued, status: "Draft" };
    expect(refused(() => publishGuard({ ...draft, status: "Issued", current_version_id: "v4" }, draft, ctl))).toBe(S_UNFORCED_HOLD);
    expect(refused(() => publishGuard({ ...draft, status: "Issued" }, draft, ctl))).toBe(S_NEW_DOOR_HOLD);
    const archived: Row = { id: "d1", status: "Archived", current_version_id: "v3", retired_issue_status: "Issued", retired_issue_version_id: "v3" };
    for (const next of ["v2", null]) {
      expect(refused(() => publishGuard({ ...archived, current_version_id: next }, archived, ctl)), String(next)).toBe(S_UNFORCED_HOLD);
      expect(publishGuard({ ...archived, current_version_id: next }, archived, { ...ctl, flag: "d1" }).current_version_id, String(next)).toBe(next);
    }
  });
});

// ─── the finding, limb (i): the first pointer write over a hold ─────────────
describe("REV-25 (P21) (i) — a controller's FIRST pointer write over an active hold passes only under a recorded force's flag", () => {
  const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
  const owner: GuardCtx = { actor: "owner", controller: false, publisher: true, held: () => true };
  const noRevision = (status: string, stamp: Row = {}): Row => ({ id: "d1", status, current_version_id: null, retired_issue_status: null, retired_issue_version_id: null, ...stamp });

  it("refused over an active hold for Document Control in EVERY status — a Draft / In Review, an issue status (Issued, IFC, Locked, a library's own), a retirement of any stamp — in REV-20 (b)'s sentence; admitted under the flag naming the document; refused under another's or a cleared one", () => {
    const cases: Array<[string, Row]> = [
      ...WORK.map((s) => [s, noRevision(s)] as [string, Row]),
      ...ISSUES.map((s) => [s, noRevision(s)] as [string, Row]),
      ...RETIRED.flatMap((s) => [
        [`${s} (stamp naming a revision)`, noRevision(s, { retired_issue_status: "Issued", retired_issue_version_id: "v3" })],
        [`${s} (not-issued)`, noRevision(s, { retired_issue_status: "not-issued" })],
        [`${s} (unstamped)`, noRevision(s)],
      ] as Array<[string, Row]>),
    ];
    for (const [name, OLD] of cases) {
      expect(refused(() => publishGuard({ ...OLD, current_version_id: "v2" }, OLD, ctl)), name).toBe(S_UNFORCED_HOLD);
      expect(publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, flag: "d1" }).current_version_id, name).toBe("v2");
      expect(refused(() => publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, flag: "d2" })), name).toBe(S_UNFORCED_HOLD);
      expect(refused(() => publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, flag: "" })), name).toBe(S_UNFORCED_HOLD);
    }
    expect(isIssueRefusal(S_UNFORCED_HOLD)).toBe(true);
    expect(isFinalizeHoldRefusal(S_UNFORCED_HOLD)).toBe(true);
  });

  it("a first pointer write that also changes the status keeps the rule it had (REV-20 (b) for Draft -> Issued, the same sentence) and the new limb for every other status; the flag passes both", () => {
    for (const [from, to] of [["Draft", "Issued"], ["In Review", "IFC"], ["Issued", "Draft"], ["Archived", "Draft"], ["Archived", "Issued"]]) {
      const OLD = noRevision(from);
      expect(refused(() => publishGuard({ ...OLD, status: to, current_version_id: "v2" }, OLD, ctl)), `${from} -> ${to}`).toBe(S_UNFORCED_HOLD);
      expect(publishGuard({ ...OLD, status: to, current_version_id: "v2" }, OLD, { ...ctl, flag: "d1" }).status, `${from} -> ${to}`).toBe(to);
    }
  });

  it("regression: no hold — admitted for Document Control and the owner (a creation, a register row's first file); the owner over a hold — refused in the publisher tier's words as before, a flag passing nothing; the service role — untouched", () => {
    for (const status of [...WORK, ...ISSUES]) {
      const OLD = noRevision(status);
      expect(publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, held: () => false }).current_version_id, status).toBe("v2");
      expect(publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...owner, held: () => false }).current_version_id, status).toBe("v2");
      expect(refused(() => publishGuard({ ...OLD, current_version_id: "v2" }, OLD, owner)), status).toBe(S_PUBLISHER_HOLD);
      expect(refused(() => publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...owner, flag: "d1" })), status).toBe(S_PUBLISHER_HOLD);
      expect(publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, actor: null }).current_version_id, status).toBe("v2");
    }
  });

  it("the decision, pinned: a creation is told apart by the hold, so a hold that lands on a new document BEFORE its first pointer write (a race) refuses Document Control's createDocumentWithFile as it already refused the owner's — the error names the hold and nothing reads as created", async () => {
    const refusals = bindGuard();
    state.db.beforeInsert!.document_versions = (row) => { seedHold(String(row.record_id), "Placed before the file was attached"); return row; };
    await expect(createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "RACE-1", file: pdf("r.pdf"), status: "Issued", actorUserId: ME, decodeUnitCode: false }))
      .rejects.toThrow(`The document was created but its file could not be attached (${S_UNFORCED_HOLD})`);
    state.roles = ["Engineer"]; state.publisher = true;
    await expect(createDocumentWithFile({ orgId: ORG, libraryId: LIB, documentNumber: "RACE-2", file: pdf("r.pdf"), status: "Issued", actorUserId: ME, decodeUnitCode: false }))
      .rejects.toThrow(`The document was created but its file could not be attached (${S_PUBLISHER_HOLD})`);
    expect(refusals).toEqual([S_UNFORCED_HOLD, S_PUBLISHER_HOLD]);
    for (const n of ["RACE-1", "RACE-2"]) expect(T("documents").find((d) => d.document_number === n)!.current_version_id ?? null, n).toBeNull();
  });

  it("route (i) through the app (P-25): the service role clears held archive A1's pointer; Document Control's un-archive to Issued puts nothing in force and lands as before (no revision, no issue); its first pointer write by PATCH is then REFUSED and nothing is written", async () => {
    await retire("a1", "Archived");
    seedHold("a1");
    const refusals = bindGuard();
    state.session = null;
    expect((await docs().update({ current_version_id: null }).eq("id", "a1").select("id")).error).toBeNull();
    state.session = ME;
    await unarchiveDocument({ doc: asRecord(docRow("a1")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    expect(docRow("a1")).toMatchObject({ status: "Issued", current_version_id: null });
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase.from("documents").update({ current_version_id: "a1-v2" }).eq("id", "a1").select("id");
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: S_UNFORCED_HOLD });
    expect(refusals).toEqual([S_UNFORCED_HOLD]);
    expect(docRow("a1").current_version_id).toBeNull();
    expect(overrides()).toEqual([]);
  });

  it("the review promote — the app's one first pointer write on an existing document — goes through its recorded door: on a held Issued document with no current revision Document Control's unforced promote is now refused in REV-20 (b)'s sentence (the inspector offers its force on exactly that), and the forced one lands, recorded once (review_promote)", async () => {
    seedNoRevision("n3");
    seedPendingDraft("n3", null);
    seedHold("n3");
    const refusals = bindGuard();
    const r = await finalizeReviewedRevision({ orgId: ORG, documentId: "n3", actorId: ME, requireRosterComplete: false });
    expect(r).toEqual({ published: false, reason: S_UNFORCED_HOLD });
    expect(isFinalizeHoldRefusal(r.reason)).toBe(true);
    expect(docRow("n3")).toMatchObject({ current_version_id: null, pending_version_id: "n3-p" });
    const forced = await finalizeReviewedRevision({ orgId: ORG, documentId: "n3", actorId: ME, requireRosterComplete: false, forceHold: true, overrideReason: "shutdown pack" });
    expect(forced).toEqual({ published: true });
    expect(docRow("n3")).toMatchObject({ status: "Issued", current_version_id: "n3-p", pending_version_id: null });
    expect(overrides("n3").map((o) => (o.details as Row).via)).toEqual(["review_promote"]);
    expect(refusals).toEqual([S_UNFORCED_HOLD]);
    expect(state.flag).toBe("");
  });

  it("…and a held intake Draft with no current revision is unchanged: its unforced promote was already REV-20 (b)'s refusal, its forced one lands, recorded; below Document Control the promote is refused in the publisher tier's words, a force notwithstanding", async () => {
    seedNoRevision("id1", { status: "Draft" });
    seedPendingDraft("id1", null, "0A");
    seedHold("id1");
    const refusals = bindGuard();
    expect(await finalizeReviewedRevision({ orgId: ORG, documentId: "id1", actorId: ME, requireRosterComplete: false })).toEqual({ published: false, reason: S_UNFORCED_HOLD });
    state.roles = ["Engineer"]; state.publisher = true;
    expect(await finalizeReviewedRevision({ orgId: ORG, documentId: "id1", actorId: ME, requireRosterComplete: false, forceHold: true })).toEqual({ published: false, reason: S_PUBLISHER_HOLD });
    state.roles = ["DocCtrl"]; state.publisher = false;
    expect(await finalizeReviewedRevision({ orgId: ORG, documentId: "id1", actorId: ME, requireRosterComplete: false, forceHold: true })).toEqual({ published: true });
    expect(docRow("id1")).toMatchObject({ status: "Issued", current_version_id: "id1-p" });
    expect(overrides("id1")).toHaveLength(1);
    expect(refusals).toEqual([S_UNFORCED_HOLD, S_PUBLISHER_HOLD]);
  });
});

// ─── the finding, limb (ii): the clear on a held issued document ────────────
describe("REV-25 (P21) (ii) — a controller's CLEAR of a held document's pointer in an issue status passes only under a recorded force's flag", () => {
  const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
  const owner: GuardCtx = { actor: "owner", controller: false, publisher: true, held: () => true };
  const issued = (status: string): Row => ({ id: "d1", status, current_version_id: "v3", retired_issue_status: null, retired_issue_version_id: null });

  it("refused over an active hold for Document Control — out of Issued, IFC, Locked or a library's own status, staying there or into another issue, a Draft / In Review or a retirement — in REV-20 (b)'s sentence; admitted under the flag naming the document; refused under another's or a cleared one", () => {
    for (const from of ISSUES) {
      const OLD = issued(from);
      for (const to of [from, ...ISSUES.filter((s) => s !== from), ...WORK, ...RETIRED]) {
        expect(refused(() => publishGuard({ ...OLD, status: to, current_version_id: null }, OLD, ctl)), `${from} -> ${to}, cleared`).toBe(S_UNFORCED_HOLD);
      }
      expect(publishGuard({ ...OLD, current_version_id: null }, OLD, { ...ctl, flag: "d1" }).current_version_id, from).toBeNull();
      expect(refused(() => publishGuard({ ...OLD, current_version_id: null }, OLD, { ...ctl, flag: "d2" })), from).toBe(S_UNFORCED_HOLD);
      expect(refused(() => publishGuard({ ...OLD, current_version_id: null }, OLD, { ...ctl, flag: "" })), from).toBe(S_UNFORCED_HOLD);
    }
  });

  it("regression: no hold — admitted; the owner over a hold — refused in the publisher tier's words as before, and admitted without one; the service role — untouched", () => {
    const OLD = issued("Issued");
    const cleared = { ...OLD, current_version_id: null };
    expect(publishGuard(cleared, OLD, { ...ctl, held: () => false }).current_version_id).toBeNull();
    expect(refused(() => publishGuard(cleared, OLD, owner))).toBe(S_PUBLISHER_HOLD);
    expect(publishGuard(cleared, OLD, { ...owner, held: () => false }).current_version_id).toBeNull();
    expect(publishGuard(cleared, OLD, { ...ctl, actor: null }).current_version_id).toBeNull();
  });

  it("the failure scenario through the in-memory PostgREST (P-21): Document Control's PATCH clearing held Issued I1's pointer is refused and nothing is written; after the service role clears it, Document Control's PATCH setting it to an earlier revision is refused too — no revision in force over the hold, nothing recorded", async () => {
    seedDoc("i1"); seedHold("i1");
    const refusals = bindGuard();
    const { supabase } = await import("@/lib/supabase");
    const clear = await supabase.from("documents").update({ current_version_id: null }).eq("id", "i1").select("id");
    expect(clear.data).toBeNull();
    expect(clear.error).toMatchObject({ message: S_UNFORCED_HOLD });
    expect(docRow("i1").current_version_id).toBe("i1-v3");
    state.session = null;
    expect((await docs().update({ current_version_id: null }).eq("id", "i1").select("id")).error).toBeNull();
    state.session = ME;
    const set = await supabase.from("documents").update({ current_version_id: "i1-v2" }).eq("id", "i1").select("id");
    expect(set.error).toMatchObject({ message: S_UNFORCED_HOLD });
    expect(docRow("i1")).toMatchObject({ status: "Issued", current_version_id: null });
    expect(refusals).toEqual([S_UNFORCED_HOLD, S_UNFORCED_HOLD]);
    expect(overrides()).toEqual([]);
  });
});

// ─── (iii) the Draft route, closed by (i) ──────────────────────────────────
describe("REV-25 (P21) (iii) — the Draft route is closed at its last step, a first pointer write", () => {
  it("through the app and the in-memory PostgREST (P-23): Document Control restores held archive A6 to Draft (lands, as before), clears the Draft's pointer (lands — not (ii): a Draft is not an issue), makes it Issued with no revision (lands — nothing in force), and its pointer write is REFUSED: A6 ends Issued with no revision in force, nothing recorded", async () => {
    await retire("a6", "Archived");
    seedHold("a6");
    const refusals = bindGuard();
    await unarchiveDocument({ doc: asRecord(docRow("a6")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    expect(docRow("a6").status).toBe("Draft");
    const { supabase } = await import("@/lib/supabase");
    expect((await supabase.from("documents").update({ current_version_id: null }).eq("id", "a6").select("id")).error).toBeNull();
    expect((await supabase.from("documents").update({ status: "Issued" }).eq("id", "a6").select("id")).error).toBeNull();
    const set = await supabase.from("documents").update({ current_version_id: "a6-v2" }).eq("id", "a6").select("id");
    expect(set.error).toMatchObject({ message: S_UNFORCED_HOLD });
    expect(docRow("a6")).toMatchObject({ status: "Issued", current_version_id: null });
    expect(refusals).toEqual([S_UNFORCED_HOLD]);
    expect(overrides()).toEqual([]);
  });

  it("every shape of the route's last step is refused: the pointer set alone, set with a move back to Draft, or set in the same write that makes the Draft Issued (REV-20 (b)); only the flag a recorded force sets passes it", () => {
    const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
    const issuedNone: Row = { id: "a6", status: "Issued", current_version_id: null, retired_issue_status: null, retired_issue_version_id: null };
    const draftNone: Row = { ...issuedNone, status: "Draft" };
    expect(refused(() => publishGuard({ ...issuedNone, current_version_id: "a6-v2" }, issuedNone, ctl))).toBe(S_UNFORCED_HOLD);
    expect(refused(() => publishGuard({ ...issuedNone, status: "Draft", current_version_id: "a6-v2" }, issuedNone, ctl))).toBe(S_UNFORCED_HOLD);
    expect(refused(() => publishGuard({ ...draftNone, status: "Issued", current_version_id: "a6-v2" }, draftNone, ctl))).toBe(S_UNFORCED_HOLD);
    expect(refused(() => publishGuard({ ...draftNone, current_version_id: "a6-v2" }, draftNone, ctl))).toBe(S_UNFORCED_HOLD);
    expect(publishGuard({ ...issuedNone, current_version_id: "a6-v7" }, issuedNone, { ...ctl, flag: "a6" }).current_version_id).toBe("a6-v7");
  });

  it("outside (ii), by design: a held Draft / In Review document's clear and its status-only move to Issued with no revision put nothing in force and are admitted for Document Control as before (the route closes at the pointer write)", () => {
    const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
    for (const s of WORK) {
      const withRevision: Row = { id: "d1", status: s, current_version_id: "v3", retired_issue_status: null, retired_issue_version_id: null };
      expect(publishGuard({ ...withRevision, current_version_id: null }, withRevision, ctl).current_version_id, s).toBeNull();
      const none = { ...withRevision, current_version_id: null };
      expect(publishGuard({ ...none, status: "Issued" }, none, ctl).status, s).toBe("Issued");
    }
  });
});
