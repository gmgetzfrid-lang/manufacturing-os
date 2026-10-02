// document-control Round F wave 3 — P19 STAMPED PUT-BACK RECORD: REV-23,
// against the guard and the put-back door 20261165 creates.
//
//   Since 20261144 a write that puts the revision a Superseded / Archived /
//   Void retirement took away back into an issue status is v_restoring, and a
//   controller passed an active hold there with nothing recorded — the app's
//   compensations and the un-archive dialog made that put-back with a bare
//   PostgREST UPDATE. Now they go through put_back_retired_issue (20261165):
//   the same write, as the caller, under the transaction-local flag for
//   Document Control's put-back of a held stamped retirement into an issue
//   status, recorded as REV_HOLD_OVERRIDDEN — and the guard binds the BARE
//   stamped put-back (the new door: refused over an active hold, a controller
//   included). On a database without the function (PGRST202 / 42883) each
//   put-back is the direct write it always was.
//
//   P19 review fix: the door forces only when the caller asks for it
//   (p_force_hold — the un-archive dialog after Document Control confirmed
//   restoring over the holds it showed; the rollbacks always), and a
//   rollback only for a retirement the caller made (superseded_by_user = the
//   session), so an override is never implied and a recorded "rollback" is
//   always one the caller's own retirement can be.
//
// There is no database here: enforce_document_publish_guard (20261165),
// put_back_retired_issue (20261165) and restore_reversed_source (20261164) are
// TRANSCRIBED below — each branch pinned to the SQL text it mirrors, in order
// — and bound to the in-memory PostgREST (the guard as the documents BEFORE
// UPDATE trigger, reading the flag at the moment each write fires; the two
// functions as its RPCs), so the REAL supersedeDocument / markSupersededAndLink
// saga / unarchiveDocument / reverseSplit run against them. All three were
// exercised on PostgreSQL 16 (REV-23's record).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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
  /** The session the RPCs run as (auth.uid()); null = no session. */
  session: "u1" as string | null,
  /** How the database answers the two functions: the transcriptions, absent (PGRST202), or a canned answer. */
  rpcMode: "real" as "real" | "absent" | "canned",
  canned: null as unknown as RpcAnswer,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  putBack: null as unknown as (args: Record<string, unknown>) => Promise<RpcAnswer>,
  restore: null as unknown as (args: Record<string, unknown>) => Promise<RpcAnswer>,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => (t === "audit_logs" ? auditLogsAsPostgres(base.from(t)) : base.from(t)),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        if (fn !== "put_back_retired_issue" && fn !== "restore_reversed_source") return { data: null, error: { code: "PGRST202", message: "not in this test" } };
        if (state.rpcMode === "absent") return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
        if (state.rpcMode === "canned") return state.canned;
        return fn === "put_back_retired_issue" ? state.putBack(args) : state.restore(args);
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
  supersedeDocument, archiveDocument, unarchiveDocument, putBackRetiredIssue, isMissingPutBackRpc,
} from "@/lib/revisions";
import { reverseSplit } from "@/lib/documentLifecycle/reverse";
import { markSupersededAndLink, withCompensation } from "@/lib/documentLifecycle/common";
import { isControlledIssueStatus, isIssueRefusal, ISSUE_REFUSAL } from "@/lib/issueStatus";
import type { DocumentRecord } from "@/types/schema";

// ─── the guard and the two functions, read from 20261165 / 20261164 ─────────
const read = (f: string) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8");
const M165 = read("20261165_dc_roundF_stamped_put_back.sql");
const M164 = read("20261164_dc_roundF_reversal_restore.sql");
const body = (M: string, head: string) => {
  const a = M.indexOf(head);
  expect(a, head).toBeGreaterThanOrEqual(0);
  return M.slice(a, M.indexOf("\n$$;", a));
};
const G = body(M165, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()");
const P = body(M165, "CREATE OR REPLACE FUNCTION put_back_retired_issue(");
const R = body(M164, "CREATE OR REPLACE FUNCTION restore_reversed_source(");
const RETIRED = ["Superseded", "Archived", "Void"];
/** put_back_retired_issue's issue test: btrim (spaces) NOT IN these — read from the SQL. */
const PB_NOT_ISSUE = (() => {
  const m = /AND btrim\(p_status\) NOT IN \(([^)]*)\)/.exec(P);
  expect(m, "the door names its non-issue statuses").toBeTruthy();
  return m![1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
})();
const PB_DOORS = (() => {
  const m = /IF p_via IS NULL OR p_via NOT IN \(([^)]*)\) THEN/.exec(P);
  expect(m, "the function names its doors").toBeTruthy();
  return m![1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
})();

const S_NEW_DOOR_HOLD = "Document has an active hold; release the hold before issuing it.";
const S_UNFORCED_HOLD = "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.";
const S_REQUIRE = "This library requires reviewer sign-off, so a revision that was not reviewed can't be made a controlled issue; submit it for review, or ask Document Control.";
const S_AUTHORITY = "You do not have authority to publish revisions in this library.";
const S_PUBLISHER_HOLD = "Document has an active hold; release the hold before publishing a new revision.";
const S_PB_NO_SESSION = "put_back_retired_issue: a put-back is a signed-in act, and this call has no session.";
const S_PB_DOOR = "put_back_retired_issue: name the put-back (unarchive, supersede_rollback, lifecycle_rollback or reversal_rollback).";
const S_PB_STATUS = "put_back_retired_issue: name the status to put the document back to.";
const S_RR_NO_SESSION = "restore_reversed_source: a reversal's restore is a signed-in act, and this call has no session.";

type GuardCtx = {
  actor: string | null;
  controller: boolean;
  publisher: boolean;
  held: (docId: string) => boolean;
  flag?: string | null;
  requireMode?: boolean;
  rosterComplete?: boolean;
};
const raise = (message: string) => { throw { code: "23514", message }; };
const refused = (f: () => unknown): string | null => {
  try { f(); } catch (e) { return (e as { message: string }).message; }
  return null;
};
const has = (v: unknown) => v !== null && v !== undefined;
const sqlTranslateLower = (v: unknown): string | null => (has(v) ? String(v).toLowerCase().replace(/[{}-]/g, "") : null);

/** enforce_document_publish_guard() (20261165), transcribed: 20261164's
 *  branches (as P18's transcription) plus the P19 limb. A NULL status is
 *  outside its domain, and the review gate on a pointer move admits every
 *  pointer move here (pinned by its own tests). */
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
  const unforcedMove = has(OLD.current_version_id) && has(NEW.current_version_id) && !sameptr
    && isControlledIssueStatus(os) && isControlledIssueStatus(ns) && !flagNamesIt && ctx.controller;
  advancing = advancing || issuing;
  const restoring = issuing && RETIRED.includes(os) && has(OLD.retired_issue_version_id)
    && NEW.current_version_id === OLD.retired_issue_version_id && NEW.current_version_id === OLD.current_version_id;
  // REV-23 (P19): the stamped put-back, unless the flag names the document
  newDoor = newDoor || (restoring && !flagNamesIt && ctx.controller);
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

describe("the transcriptions are the SQL's (20261165 / 20261164, in order)", () => {
  it("the guard: every branch it mirrors is in 20261165's body, in this order — the P19 limb right after v_restoring and before the stamp is written", () => {
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

  it("the put-back: every branch the RPC transcription mirrors is in put_back_retired_issue, in this order", () => {
    const fragments = [
      "  p_force_hold boolean DEFAULT false,",
      "LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$",
      "  v_uid     uuid := auth.uid();",
      "  IF v_uid IS NULL THEN\n    RAISE EXCEPTION",
      `'${S_PB_NO_SESSION.replace("'", "''")}'`,
      "      USING ERRCODE = 'insufficient_privilege';",
      "  IF p_via IS NULL OR p_via NOT IN ('unarchive', 'supersede_rollback', 'lifecycle_rollback', 'reversal_rollback') THEN",
      `'${S_PB_DOOR}'`,
      "  IF btrim(COALESCE(p_status, '')) = '' THEN",
      `'${S_PB_STATUS}'`,
      "  SELECT true, d.org_id, d.status, d.retired_issue_status, d.retired_issue_version_id, d.current_version_id, d.rev, d.superseded_by_user\n    INTO v_found, v_org, v_status, v_stamp, v_stamped, v_version, v_rev, v_retired_by\n    FROM documents d WHERE d.id = p_document_id;\n  IF v_found IS NULL THEN\n    RETURN 'no_match';\n  END IF;",
      "  IF COALESCE(p_force_hold, false)\n     AND v_status = (CASE WHEN p_via = 'unarchive' THEN 'Archived' ELSE 'Superseded' END)\n     AND (p_via = 'unarchive' OR v_retired_by = v_uid)\n     AND v_stamped IS NOT NULL\n     AND v_stamped = v_version\n     AND btrim(p_status) NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n    v_forced := true;\n  END IF;",
      "  IF v_forced THEN\n    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);\n  END IF;\n  IF p_via = 'unarchive' THEN\n    UPDATE documents\n       SET status = p_status,\n           archived_at = NULL,\n           archived_by = NULL,\n           archive_reason = NULL,\n           updated_at = now(),\n           updated_by = v_uid\n     WHERE id = p_document_id;\n    GET DIAGNOSTICS v_n = ROW_COUNT;\n  ELSE\n    UPDATE documents\n       SET status = p_status,\n           superseded_at = p_superseded_at,\n           superseded_by_user = p_superseded_by_user,\n           supersession_reason = p_supersession_reason,\n           supersession_moc = p_supersession_moc,\n           updated_at = now(),\n           updated_by = v_uid\n     WHERE id = p_document_id;\n    GET DIAGNOSTICS v_n = ROW_COUNT;\n  END IF;\n  IF v_forced THEN\n    PERFORM set_config('app.publish_hold_override', '', true);\n  END IF;\n  IF v_n = 0 THEN\n    RETURN 'no_match';\n  END IF;",
      "  IF v_forced THEN\n    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)\n    VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,",
      "              'via', p_via,",
      "              'reason', NULLIF(btrim(COALESCE(p_reason, '')), ''),",
      "              'stampedPutBack', true,",
      "              'retiredIssueStatus', v_stamp,",
      "              'priorStatus', v_status,",
      "              'newStatus', p_status,",
      "  RETURN CASE WHEN v_forced THEN 'restored_over_hold' ELSE 'restored' END;",
    ];
    let at = -1;
    for (const f of fragments) {
      const i = P.indexOf(f, at + 1);
      expect(i, f.slice(0, 80)).toBeGreaterThan(at);
      at = i;
    }
    expect(PB_NOT_ISSUE).toEqual(["Draft", "In Review", "Superseded", "Void", "Archived"]);
    expect(PB_DOORS).toEqual(["unarchive", "supersede_rollback", "lifecycle_rollback", "reversal_rollback"]);
  });

  it("the reversal's restore (20261164, unchanged here): the branches its transcription mirrors, in order", () => {
    const fragments = [
      "  IF v_uid IS NULL THEN\n    RAISE EXCEPTION",
      "  SELECT a.action INTO v_action\n    FROM audit_logs a\n   WHERE a.id = p_reversal_of\n     AND a.org_id = v_org\n     AND a.action IN ('DOC_SPLIT', 'DOC_MERGED')",
      "     AND NOT EXISTS (SELECT 1 FROM audit_logs r\n                      WHERE r.org_id = v_org\n                        AND r.resource_id = a.resource_id\n                        AND r.action IN ('DOC_SPLIT_REVERSED', 'DOC_MERGE_REVERSED')",
      "  IF v_status = 'Superseded'\n     AND v_action IS NOT NULL\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n    v_forced := true;\n  END IF;",
      "    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);",
      "         superseded_at = NULL,",
      "    PERFORM set_config('app.publish_hold_override', '', true);",
      "    VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,",
      "  RETURN CASE WHEN v_forced THEN 'restored_over_hold' ELSE 'restored' END;",
    ];
    let at = -1;
    for (const f of fragments) {
      const i = R.indexOf(f, at + 1);
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
type Docs = { update: (p: Row) => { eq: (k: string, v: unknown) => { select: (c: string) => Promise<{ data: unknown; error: unknown }> } } };

/** put_back_retired_issue (20261165), transcribed: its reads, its door, its
 *  write (through the in-memory PostgREST, so the transcribed guard fires on
 *  it) and its record. A RAISE rolls the call back whole, the flag with it. */
async function putBackRetiredIssueSql(a: Record<string, unknown>): Promise<RpcAnswer> {
  const uid = state.session;
  if (uid === null) return { data: null, error: { code: "42501", message: S_PB_NO_SESSION } };
  const via = String(a.p_via ?? "");
  if (!PB_DOORS.includes(via)) return { data: null, error: { code: "23514", message: S_PB_DOOR } };
  if (!String(a.p_status ?? "").trim()) return { data: null, error: { code: "23514", message: S_PB_STATUS } };
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
  const docs = makeFakeSupabase(state.db).from("documents") as unknown as Docs;
  const patch: Row = via === "unarchive"
    ? { status: a.p_status, archived_at: null, archived_by: null, archive_reason: null, updated_at: "now()", updated_by: uid }
    : {
        status: a.p_status, superseded_at: a.p_superseded_at ?? null, superseded_by_user: a.p_superseded_by_user ?? null,
        supersession_reason: a.p_supersession_reason ?? null, supersession_moc: a.p_supersession_moc ?? null, updated_at: "now()", updated_by: uid,
      };
  const res = await docs.update(patch).eq("id", doc.id).select("id");
  if (forced) state.flag = "";
  if (res.error) { state.flag = null; return { data: null, error: res.error as { code?: string; message: string } }; }
  if (((res.data as unknown[] | null) ?? []).length === 0) return { data: "no_match", error: null };
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

/** restore_reversed_source (20261164), transcribed as P18's test does. */
async function restoreReversedSourceSql(a: Record<string, unknown>): Promise<RpcAnswer> {
  const uid = state.session;
  if (uid === null) return { data: null, error: { code: "42501", message: S_RR_NO_SESSION } };
  const doc = T("documents").find((d) => d.id === a.p_document_id && d.org_id === ORG);
  if (!doc) return { data: "no_match", error: null };
  const ev = T("audit_logs").find((r) => r.id === a.p_reversal_of && r.org_id === doc.org_id
    && (r.action === "DOC_SPLIT" || r.action === "DOC_MERGED")
    && (r.resource_id === doc.id
      || (Array.isArray((r.details as Row | null)?.mergeSiblings) && ((r.details as Row).mergeSiblings as unknown[]).includes(doc.id)))
    && !T("audit_logs").some((x) => x.org_id === doc.org_id && x.resource_id === r.resource_id
      && (x.action === "DOC_SPLIT_REVERSED" || x.action === "DOC_MERGE_REVERSED")
      && sqlTranslateLower((x.details as Row | null)?.reversedAuditEventId) === String(a.p_reversal_of).replace(/-/g, "")));
  const before = { status: doc.status, stamp: doc.retired_issue_status ?? null };
  const forced = doc.status === "Superseded" && !!ev && isController() && activeHolds(String(doc.id)).length > 0;
  if (forced) state.flag = String(doc.id);
  const docs = makeFakeSupabase(state.db).from("documents") as unknown as Docs;
  const res = await docs.update({
    status: a.p_status, superseded_at: null, superseded_by_user: null, supersession_reason: null, supersession_moc: null,
    updated_at: "now()", updated_by: uid,
  }).eq("id", doc.id).select("id");
  if (forced) state.flag = "";
  if (res.error) { state.flag = null; return { data: null, error: res.error as { code?: string; message: string } }; }
  if (((res.data as unknown[] | null) ?? []).length === 0) return { data: "no_match", error: null };
  if (forced) {
    T("audit_logs").push({
      id: `ovr-${doc.id}-${T("audit_logs").length}`, action: "REV_HOLD_OVERRIDDEN", resource_id: doc.id, resource_type: "document", org_id: ORG, user_id: uid,
      details: { via: "reversal_restore", reversedAuditEventId: a.p_reversal_of, reversedAction: ev!.action, retirementStamped: before.stamp !== null, priorStatus: before.status, newStatus: a.p_status },
    });
  }
  return { data: forced ? "restored_over_hold" : "restored", error: null };
}

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
/** A stamped retirement, made as the app makes it: the document Issued, retired by a signed-in controller through the guard (which writes the stamp). */
async function retire(id: string, status: "Archived" | "Superseded" | "Void", from = "Issued"): Promise<void> {
  seedDoc(id, { status: from });
  if (!state.db.beforeUpdate!.documents) bindGuard(); // the stamp is the guard's to write
  const docs = makeFakeSupabase(state.db).from("documents") as unknown as Docs;
  const saved = state.roles;
  state.roles = ["DocCtrl"];
  const res = await docs.update(status === "Archived"
    ? { status, archived_at: "2026-09-10T00:00:00Z", archived_by: ME, archive_reason: "retired" }
    : status === "Superseded" ? { status, superseded_at: "2026-09-10T00:00:00Z", superseded_by_user: ME, supersession_reason: "replaced" }
    : { status }).eq("id", id).select("id");
  state.roles = saved;
  expect(res.error, id).toBeNull();
}
/** A split of `prefix` into `${prefix}a` / `${prefix}b` (the sheets Issued, the source Superseded; `stamp` the source's). */
function seedSplit(prefix: string, stamp: "none" | "issued") {
  seedDoc(prefix, {
    status: "Superseded", uniqueness_key: `${prefix}-key`, superseded_at: "2025-09-01T10:00:00Z", supersession_reason: "split",
    ...(stamp === "issued" ? { retired_issue_status: "Issued", retired_issue_version_id: `${prefix}-v3` } : {}),
  });
  for (const x of ["a", "b"]) seedDoc(`${prefix}${x}`, { uniqueness_key: `${prefix}${x}-key` });
  T("document_supersessions").push(
    { id: `l-${prefix}a`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}a`, reason: "split", created_by: ME, created_at: "2025-09-01T10:00:00Z" },
    { id: `l-${prefix}b`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}b`, reason: "split", created_by: ME, created_at: "2025-09-01T10:00:00Z" },
  );
  T("audit_logs").push({ id: `ev-${prefix}`, org_id: ORG, action: "DOC_SPLIT", resource_id: prefix, timestamp: "2025-09-01T10:00:00Z", details: { replacementDocIds: [`${prefix}a`, `${prefix}b`], priorStatus: "Issued", auditAt: "2025-09-01T10:00:00Z" } });
}

/** Bind the transcribed guard as the documents BEFORE UPDATE trigger, as the signed-in actor (the flag read as each write fires). */
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
        ...extra,
      });
    } catch (e) {
      refusals.push((e as { message: string }).message);
      throw e;
    }
  };
  return refusals;
}
const asRecord = (d: Row) => ({
  id: d.id, orgId: ORG, libraryId: LIB, documentNumber: d.document_number, title: d.title, rev: d.rev,
  status: d.status, currentVersionId: d.current_version_id, collectionId: null,
}) as unknown as DocumentRecord;
const putBackCalls = () => state.rpcCalls.filter((c) => c.fn === "put_back_retired_issue");

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
  state.roles = ["DocCtrl"];
  state.publisher = false;
  state.canControl = true;
  state.flag = null;
  state.session = ME;
  state.rpcMode = "real";
  state.rpcCalls = [];
  state.putBack = putBackRetiredIssueSql;
  state.restore = restoreReversedSourceSql;
});

// ─── REGRESSION FIRST: every legitimate put-back still lands, now recorded ──
describe("REV-23 (P19) — the app's put-backs still complete over a hold, through the recorded door", () => {
  it("a controller's failed supersede of a held document (forced over the hold) is put back to Issued by undoFailedSupersede — exactly one REV_HOLD_OVERRIDDEN (supersede_rollback), nothing refused, the flag cleared", async () => {
    const d = seedDoc("p1"); seedDoc("p1a"); seedHold("p1");
    const refusals = bindGuard();
    state.db.refuseWrites.add("document_supersessions");
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["P1A"], libraryId: LIB, reason: "replaced", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/^Nothing was superseded: The replacement links could not be recorded \(.*\)\. The document is back to Issued\./);
    expect(refusals).toEqual([]);
    expect(docRow("p1")).toMatchObject({ status: "Issued", superseded_at: null, supersession_reason: null, retired_issue_status: null });
    expect(overrides()).toHaveLength(1);
    expect(overrides("p1")[0].details).toMatchObject({
      via: "supersede_rollback", stampedPutBack: true, retiredIssueStatus: "Issued", priorStatus: "Superseded", newStatus: "Issued",
      holds: [{ reason: "Stop work" }], reason: expect.stringContaining("The supersede was rolled back: The replacement links could not be recorded"),
    });
    expect(state.flag).toBe("");
    expect(audit("SUPERSEDE_DOC")).toHaveLength(0);
    expect(putBackCalls()[0].args).toMatchObject({ p_document_id: "p1", p_status: "Issued", p_via: "supersede_rollback", p_force_hold: true, p_superseded_at: null, p_supersession_reason: null });
  });

  it("a publisher's failed supersede (no hold) is put back as before — through the function, the bare write, nothing recorded; a re-run on a Superseded document keeps its first supersession", async () => {
    state.roles = ["Engineer"]; state.publisher = true;
    const d = seedDoc("p2"); seedDoc("p2a"); seedDoc("p2b");
    const refusals = bindGuard();
    await supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["P2A"], libraryId: LIB, reason: "first", orgId: ORG, actorUserId: ME });
    const first = { ...docRow("p2") };
    state.db.beforeInsert!.document_supersessions = (row) => (row.replacement_doc_id === "p2b" ? null : row);
    await expect(supersedeDocument({ doc: asRecord(docRow("p2")), replacementDocNumbers: ["P2A", "P2B"], libraryId: LIB, reason: "second", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/back to Superseded/);
    expect(refusals).toEqual([]);
    expect(docRow("p2")).toMatchObject({ status: "Superseded", superseded_at: first.superseded_at, supersession_reason: "first" });
    expect(overrides()).toEqual([]);
    expect(putBackCalls().map((c) => c.args.p_supersession_reason)).toEqual(["first"]);
  });

  it("a split / merge source flipped by the saga (markSupersededAndLink) is put back by restoreSupersededSource when a later step fails — a held source recorded (lifecycle_rollback), the lineage pair removed, the rollback clean", async () => {
    seedDoc("s1"); seedDoc("s1a"); seedHold("s1");
    const refusals = bindGuard();
    await expect(withCompensation(async (register) => {
      await markSupersededAndLink({ sourceDocId: "s1", replacementDocIds: ["s1a"], reason: "split", actor: { orgId: ORG, actorUserId: ME }, register, label: "S1" });
      expect(docRow("s1")).toMatchObject({ status: "Superseded", retired_issue_status: "Issued", retired_issue_version_id: "s1-v3" });
      throw new Error("a later step failed");
    })).rejects.toThrow("a later step failed (the operation was rolled back — no partial changes were kept).");
    expect(refusals).toEqual([]);
    expect(docRow("s1")).toMatchObject({ status: "Issued", superseded_at: null });
    expect(T("document_supersessions")).toEqual([]);
    expect(overrides("s1")).toHaveLength(1);
    expect(overrides("s1")[0].details).toMatchObject({ via: "lifecycle_rollback", priorStatus: "Superseded", newStatus: "Issued", stampedPutBack: true });
    expect(state.flag).toBe("");
  });

  it("the same compensation for the owner with no hold: restored, nothing recorded (a non-controller's put-back keeps today's rule)", async () => {
    state.roles = ["Engineer"]; state.publisher = true;
    seedDoc("s2"); seedDoc("s2a");
    const refusals = bindGuard();
    await expect(withCompensation(async (register) => {
      await markSupersededAndLink({ sourceDocId: "s2", replacementDocIds: ["s2a"], reason: "merge", actor: { orgId: ORG, actorUserId: ME }, register, label: "S2" });
      throw new Error("the merge target could not be created");
    })).rejects.toThrow(/no partial changes were kept/);
    expect(refusals).toEqual([]);
    expect(docRow("s2").status).toBe("Issued");
    expect(overrides()).toEqual([]);
  });

  it("Document Control un-archives a held, stamped document (archived through archiveDocument, then held), having confirmed restoring over the hold (forceHold — the dialog's confirmation): restored to Issued, exactly one REV_HOLD_OVERRIDDEN (unarchive, the reason), the ARCHIVE_DOC un-archive event says so, the put-back keeps its clocks", async () => {
    const d = seedDoc("a1");
    const refusals = bindGuard();
    await archiveDocument({ doc: asRecord(d), reason: "superseded on site", orgId: ORG, actorUserId: ME });
    expect(docRow("a1")).toMatchObject({ status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "a1-v3" });
    seedHold("a1");
    const outcome = await unarchiveDocument({ doc: asRecord(docRow("a1")), reason: "  back in force  ", orgId: ORG, actorUserId: ME, restoreStatus: "Issued", forceHold: true });
    expect(refusals).toEqual([]);
    expect(docRow("a1")).toMatchObject({ status: "Issued", archived_at: null, archived_by: null, archive_reason: null, retired_issue_status: null });
    expect(overrides("a1")).toHaveLength(1);
    expect(overrides("a1")[0].details).toMatchObject({ via: "unarchive", reason: "back in force", priorStatus: "Archived", newStatus: "Issued", retiredIssueStatus: "Issued", holds: [{ reason: "Stop work" }] });
    const unarchived = audit("ARCHIVE_DOC").filter((r) => (r.details as Row).action === "unarchive");
    expect(unarchived).toHaveLength(1);
    expect(unarchived[0].details).toMatchObject({ restoredStatus: "Issued", holdOverridden: "REV_HOLD_OVERRIDDEN" });
    expect(outcome).toMatchObject({ issued: true, putBack: true });
    expect(putBackCalls()[0].args).toEqual({ p_document_id: "a1", p_status: "Issued", p_via: "unarchive", p_reason: "back in force", p_force_hold: true });
  });

  it("un-archive with no hold — by Document Control and by the owner (publisher tier) — restored, nothing recorded, the event carries no hold mark", async () => {
    await retire("a2", "Archived");
    await retire("a3", "Archived");
    bindGuard();
    await unarchiveDocument({ doc: asRecord(docRow("a2")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    state.roles = ["Engineer"]; state.publisher = true;
    await unarchiveDocument({ doc: asRecord(docRow("a3")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    for (const id of ["a2", "a3"]) expect(docRow(id).status).toBe("Issued");
    expect(overrides()).toEqual([]);
    for (const r of audit("ARCHIVE_DOC")) expect(r.details).not.toHaveProperty("holdOverridden");
  });

  it("the owner's un-archive of a held document is refused as before — in the publisher tier's words, nothing written or recorded; Document Control's Draft restore of it passes, unrecorded", async () => {
    await retire("a4", "Archived");
    seedHold("a4");
    state.roles = ["Engineer"]; state.publisher = true;
    bindGuard();
    await expect(unarchiveDocument({ doc: asRecord(docRow("a4")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" }))
      .rejects.toThrow(`The document was NOT restored (${S_PUBLISHER_HOLD}) — nothing was changed.`);
    expect(docRow("a4").status).toBe("Archived");
    state.roles = ["DocCtrl"];
    await unarchiveDocument({ doc: asRecord(docRow("a4")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    expect(docRow("a4").status).toBe("Draft");
    expect(overrides()).toEqual([]);
  });

  it("a reversal whose lineage delete is refused rolls back whole over a held parked sheet: the sheet's un-park (a stamped put-back) goes through the door, recorded (reversal_rollback); the source back Superseded, its own record corrected (P18)", async () => {
    seedSplit("r1", "none");
    seedHold("r1a");
    const refusals = bindGuard();
    state.db.deleteErrors!.document_supersessions = { code: "42501", message: "only Document Control may delete supersession rows" };
    await expect(reverseSplit({ splitAuditEventId: "ev-r1", reason: "wrong split", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/supersession link\(s\) could not be removed[\s\S]*rolled back — no partial changes were kept/);
    expect(refusals).toEqual([]);
    for (const s of ["r1a", "r1b"]) expect(docRow(s)).toMatchObject({ status: "Issued", retired_issue_status: null });
    expect(docRow("r1").status).toBe("Superseded");
    expect(overrides("r1a")).toHaveLength(1);
    expect(overrides("r1a")[0].details).toMatchObject({ via: "reversal_rollback", priorStatus: "Superseded", newStatus: "Issued", stampedPutBack: true });
    expect(overrides("r1b")).toEqual([]); // not held: the bare write
    expect(overrides("r1")[0].details).toMatchObject({ via: "reversal_restore" });
    expect(audit("REV_HOLD_OVERRIDE_UNDONE").map((r) => r.resource_id)).toEqual(["r1"]);
    expect(state.flag).toBe("");
  });

  it("the legacy reversal through restore_reversed_source (P18) is unchanged under this guard: stamped and unstamped sources come back over a carried hold, recorded once each; no put-back is called when nothing rolls back", async () => {
    seedSplit("r2", "none");
    seedSplit("r3", "issued");
    seedHold("r2a");
    seedHold("r3b");
    const refusals = bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-r2", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    await reverseSplit({ splitAuditEventId: "ev-r3", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    expect(refusals).toEqual([]);
    expect(docRow("r2").status).toBe("Issued");
    expect(docRow("r3").status).toBe("Issued");
    expect(overrides().map((o) => [o.resource_id, (o.details as Row).via])).toEqual([["r2", "reversal_restore"], ["r3", "reversal_restore"]]);
    expect((overrides("r3")[0].details as Row).retirementStamped).toBe(true);
    expect(putBackCalls()).toEqual([]);
  });
});

// ─── the database without the function: the direct writes, as before ──────
describe("REV-23 (P19) — put_back_retired_issue absent (PGRST202 / 42883): each put-back is the direct write it always was", () => {
  it("with no hold every put-back lands by its direct write, even against this guard — the un-archive, the supersede rollback, the split / merge rollback, the reversal's un-park", async () => {
    state.rpcMode = "absent";
    const refusals = bindGuard();
    await retire("b1", "Archived");
    await unarchiveDocument({ doc: asRecord(docRow("b1")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    const d = seedDoc("b2"); seedDoc("b2a");
    state.db.refuseWrites.add("document_supersessions");
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["B2A"], libraryId: LIB, reason: "r", orgId: ORG, actorUserId: ME })).rejects.toThrow(/back to Issued/);
    state.db.refuseWrites.delete("document_supersessions");
    seedDoc("b3"); seedDoc("b3a");
    await expect(withCompensation(async (register) => {
      await markSupersededAndLink({ sourceDocId: "b3", replacementDocIds: ["b3a"], reason: "s", actor: { orgId: ORG, actorUserId: ME }, register, label: "B3" });
      throw new Error("later");
    })).rejects.toThrow(/no partial changes were kept/);
    expect(refusals).toEqual([]);
    for (const id of ["b1", "b2", "b3"]) expect(docRow(id).status, id).toBe("Issued");
    expect(overrides()).toEqual([]);
    expect(putBackCalls().length).toBe(3);
  });

  it("42883 (undefined_function) falls back the same way", async () => {
    state.rpcMode = "canned";
    state.canned = { data: null, error: { code: "42883", message: "function put_back_retired_issue(uuid, text, text, text) does not exist" } };
    await retire("b4", "Archived");
    bindGuard();
    await unarchiveDocument({ doc: asRecord(docRow("b4")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    expect(docRow("b4").status).toBe("Issued");
  });

  it("the deploy order, stated: with 20261165's guard but no function (an app before P19, or the schema cache still reloading) Document Control's held put-backs are refused — the un-archive in the new-door sentence the dialog answers, the supersede left Superseded with 'ask Doc Control', the split / merge rollback named for manual attention", async () => {
    state.rpcMode = "absent";
    const refusals = bindGuard();
    await retire("b5", "Archived");
    seedHold("b5");
    await expect(unarchiveDocument({ doc: asRecord(docRow("b5")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" }))
      .rejects.toThrow(`The document was NOT restored (${S_NEW_DOOR_HOLD}) — nothing was changed.`);
    expect(docRow("b5").status).toBe("Archived");
    const d = seedDoc("b6"); seedDoc("b6a"); seedHold("b6");
    state.db.refuseWrites.add("document_supersessions");
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["B6A"], libraryId: LIB, reason: "r", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(`The document is now Superseded and its previous status could not be restored (${S_NEW_DOOR_HOLD}) — ask Doc Control to restore it to Issued`);
    state.db.refuseWrites.delete("document_supersessions");
    seedDoc("b7"); seedDoc("b7a"); seedHold("b7");
    await expect(withCompensation(async (register) => {
      await markSupersededAndLink({ sourceDocId: "b7", replacementDocIds: ["b7a"], reason: "s", actor: { orgId: ORG, actorUserId: ME }, register, label: "B7" });
      throw new Error("later");
    })).rejects.toThrow(/some cleanup steps failed and may need manual attention:\n- restore B7 from Superseded: source b7 is still Superseded — restore it to Issued \(Document has an active hold; release the hold before issuing it\.\)/);
    expect(refusals).toEqual([S_NEW_DOOR_HOLD, S_NEW_DOOR_HOLD, S_NEW_DOOR_HOLD]);
    expect(isIssueRefusal(S_NEW_DOOR_HOLD)).toBe(true);
  });
});

// ─── the finding: the BARE stamped put-back of a held retirement ──────────
describe("REV-23 (P19) — a controller's BARE put-back of a held stamped retirement is the new door", () => {
  const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
  const owner: GuardCtx = { actor: "owner", controller: false, publisher: true, held: () => true };
  const stamped = (status: string, extra: Row = {}): Row => ({ id: "d1", status, current_version_id: "v3", retired_issue_status: "Issued", retired_issue_version_id: "v3", ...extra });

  it("refused over an active hold for a controller — out of Superseded, Archived or Void, into Issued, IFC, Locked or a library's own status — in the new-door sentence the editors and the un-archive dialog recognise; admitted under the flag naming it; refused under another's or a cleared one", () => {
    for (const from of RETIRED) {
      for (const to of ["Issued", "IFC", "Locked", "For Construction"]) {
        expect(refused(() => publishGuard({ ...stamped(from), status: to }, stamped(from), ctl)), `${from} -> ${to}`).toBe(S_NEW_DOOR_HOLD);
      }
      expect(publishGuard({ ...stamped(from), status: "Issued" }, stamped(from), { ...ctl, flag: "d1" }).status).toBe("Issued");
      expect(refused(() => publishGuard({ ...stamped(from), status: "Issued" }, stamped(from), { ...ctl, flag: "d2" }))).toBe(S_NEW_DOOR_HOLD);
      expect(refused(() => publishGuard({ ...stamped(from), status: "Issued" }, stamped(from), { ...ctl, flag: "" }))).toBe(S_NEW_DOOR_HOLD);
    }
    expect(isIssueRefusal(S_NEW_DOOR_HOLD)).toBe(true);
    expect(S_NEW_DOOR_HOLD).toContain(ISSUE_REFUSAL.newDoorHold);
  });

  it("regression: no hold — admitted; a Draft / In Review restore — admitted; the service role — untouched; the require limb still spares a put-back (an owner's unheld put-back in a require library, no roster, admitted)", () => {
    expect(publishGuard({ ...stamped("Archived"), status: "Issued" }, stamped("Archived"), { ...ctl, held: () => false }).status).toBe("Issued");
    for (const s of ["Draft", "In Review"]) expect(publishGuard({ ...stamped("Superseded"), status: s }, stamped("Superseded"), ctl).status).toBe(s);
    expect(publishGuard({ ...stamped("Archived"), status: "Issued" }, stamped("Archived"), { ...ctl, actor: null }).status).toBe("Issued");
    expect(publishGuard({ ...stamped("Archived"), status: "Issued" }, stamped("Archived"), { ...owner, held: () => false, requireMode: true, rosterComplete: false }).status).toBe("Issued");
    // the stamp is cleared as the document leaves its retirement
    expect(publishGuard({ ...stamped("Archived"), status: "Issued" }, stamped("Archived"), { ...ctl, flag: "d1" })).toMatchObject({ retired_issue_status: null, retired_issue_version_id: null });
  });

  it("below a controller nothing changed: the owner is refused in the publisher tier's words, flag or no flag; anyone without the tier in the authority sentence", () => {
    expect(refused(() => publishGuard({ ...stamped("Archived"), status: "Issued" }, stamped("Archived"), owner))).toBe(S_PUBLISHER_HOLD);
    expect(refused(() => publishGuard({ ...stamped("Archived"), status: "Issued" }, stamped("Archived"), { ...owner, flag: "d1" }))).toBe(S_PUBLISHER_HOLD);
    expect(refused(() => publishGuard({ ...stamped("Archived"), status: "Issued" }, stamped("Archived"), { ...owner, publisher: false, held: () => false }))).toBe(S_AUTHORITY);
  });

  it("outside v_restoring the earlier rules decide, unchanged: an unstamped exit (REV-20 (a), P18), a 'not-issued' stamp (20261144), a pointer-moving put-back (REV-20 (b)); and the residual this finding does not cover — a stamp naming ANOTHER revision — is still admitted for a controller (recorded on REV-23's Scope)", () => {
    const unstamped = (status: string): Row => stamped(status, { retired_issue_status: null, retired_issue_version_id: null });
    for (const s of RETIRED) expect(refused(() => publishGuard({ ...unstamped(s), status: "Issued" }, unstamped(s), ctl)), s).toBe(S_NEW_DOOR_HOLD);
    const notIssued = stamped("Archived", { retired_issue_status: "not-issued", retired_issue_version_id: null });
    expect(refused(() => publishGuard({ ...notIssued, status: "Issued" }, notIssued, { ...ctl, flag: "d1" }))).toBe(S_NEW_DOOR_HOLD);
    expect(refused(() => publishGuard({ ...stamped("Archived"), status: "Issued", current_version_id: "v4" }, stamped("Archived"), ctl))).toBe(S_UNFORCED_HOLD);
    const otherRevision = stamped("Archived", { current_version_id: "v4" });
    expect(publishGuard({ ...otherRevision, status: "Issued" }, otherRevision, ctl).status).toBe("Issued");
  });

  it("20261164's, 20261159's and 20261151's rules on the re-created guard are unchanged", () => {
    const doc = (status: string, extra: Row = {}): Row => ({ id: "d1", status, current_version_id: "v3", retired_issue_status: null, retired_issue_version_id: null, ...extra });
    expect(refused(() => publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), ctl))).toBe(S_UNFORCED_HOLD);
    expect(publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), { ...ctl, flag: "d1" }).current_version_id).toBe("v4");
    expect(refused(() => publishGuard({ ...doc("Draft"), status: "Issued", current_version_id: "v4" }, doc("Draft"), ctl))).toBe(S_UNFORCED_HOLD);
    expect(publishGuard({ ...doc("Superseded"), status: "Issued" }, doc("Superseded"), { ...ctl, flag: "d1" }).status).toBe("Issued");
    expect(refused(() => publishGuard({ ...doc("Draft"), status: "Issued" }, doc("Draft"), ctl))).toBe(S_NEW_DOOR_HOLD);
    expect(publishGuard({ ...doc("Issued"), status: "Archived" }, doc("Issued"), ctl)).toMatchObject({ status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "v3" });
    expect(publishGuard({ ...doc("Issued"), status: "Superseded" }, doc("Issued"), ctl).status).toBe("Superseded");
  });

  it("through the in-memory PostgREST: a controller's direct PATCH of held, stamped A9 back to Issued is refused and nothing is written", async () => {
    await retire("a9", "Archived");
    seedHold("a9");
    const refusals = bindGuard();
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase.from("documents").update({ status: "Issued", archived_at: null }).eq("id", "a9").select("id");
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: S_NEW_DOOR_HOLD });
    expect(refusals).toEqual([S_NEW_DOOR_HOLD]);
    expect(docRow("a9")).toMatchObject({ status: "Archived", retired_issue_status: "Issued" });
  });
});

// ─── the door's own edges ────────────────────────────────────────────────
describe("REV-23 (P19) — put_back_retired_issue sets the flag only for its door", () => {
  it("exactly one REV_HOLD_OVERRIDDEN for the recorded pass, the flag cleared after its write — and it does not leak to the next write in the same transaction", async () => {
    await retire("e1", "Archived");
    await retire("e2", "Superseded");
    seedHold("e1"); seedHold("e2");
    bindGuard();
    expect(await putBackRetiredIssueSql({ p_document_id: "e1", p_status: "Issued", p_via: "unarchive", p_reason: " r ", p_force_hold: true })).toEqual({ data: "restored_over_hold", error: null });
    expect(overrides("e1")).toHaveLength(1);
    expect(state.flag).toBe("");
    const { supabase } = await import("@/lib/supabase");
    const { error } = await supabase.from("documents").update({ status: "Issued" }).eq("id", "e2").select("id");
    expect(error).toMatchObject({ message: S_NEW_DOOR_HOLD });
    expect(overrides()).toHaveLength(1);
  });

  it("anyone below a controller gets the bare write: refused over a hold in the publisher tier's words, nothing recorded; unheld, restored", async () => {
    await retire("e3", "Archived");
    await retire("e4", "Archived");
    seedHold("e3");
    state.roles = ["Engineer"]; state.publisher = true;
    bindGuard();
    expect((await putBackRetiredIssueSql({ p_document_id: "e3", p_status: "Issued", p_via: "unarchive", p_force_hold: true })).error?.message).toBe(S_PUBLISHER_HOLD);
    expect(await putBackRetiredIssueSql({ p_document_id: "e4", p_status: "Issued", p_via: "unarchive" })).toEqual({ data: "restored", error: null });
    expect(docRow("e3").status).toBe("Archived");
    expect(overrides()).toEqual([]);
  });

  it("no flag (refused over the hold, nothing recorded) for: the wrong door for the retirement, an unstamped or 'not-issued' retirement, a stamp naming another revision, a Void; and a non-issue target is the bare write, unrecorded", async () => {
    await retire("f1", "Archived");
    await retire("f2", "Superseded");
    await retire("f3", "Void");
    await retire("f6", "Archived");
    seedDoc("f4", { status: "Archived" });
    await retire("f5", "Archived", "Draft");
    for (const id of ["f1", "f2", "f3", "f4", "f5", "f6"]) seedHold(id);
    docRow("f6").current_version_id = "f6-v4";
    T("document_versions").push({ id: "f6-v4", org_id: ORG, record_id: "f6", revision_label: "4" });
    bindGuard();
    const cases: Array<[string, string]> = [["f1", "supersede_rollback"], ["f2", "unarchive"], ["f3", "supersede_rollback"], ["f4", "unarchive"], ["f5", "unarchive"]];
    for (const [id, via] of cases) {
      expect((await putBackRetiredIssueSql({ p_document_id: id, p_status: "Issued", p_via: via, p_force_hold: true })).error?.message, `${id} ${via}`).toBe(S_NEW_DOOR_HOLD);
    }
    // the residual: a stamp naming another revision is not v_restoring — no flag, and the guard admits the bare write as before (REV-23's Scope)
    expect(await putBackRetiredIssueSql({ p_document_id: "f6", p_status: "Issued", p_via: "unarchive", p_force_hold: true })).toEqual({ data: "restored", error: null });
    expect(await putBackRetiredIssueSql({ p_document_id: "f1", p_status: "Draft", p_via: "unarchive", p_force_hold: true })).toEqual({ data: "restored", error: null });
    expect(overrides()).toEqual([]);
  });

  it("no session: refused before anything is read; an unknown door or a blank status: refused; an unknown document: no_match", async () => {
    state.session = null;
    expect((await putBackRetiredIssueSql({ p_document_id: "x", p_status: "Issued", p_via: "unarchive" })).error).toMatchObject({ code: "42501", message: S_PB_NO_SESSION });
    state.session = ME;
    expect((await putBackRetiredIssueSql({ p_document_id: "x", p_status: "Issued", p_via: "status_edit" })).error).toMatchObject({ message: S_PB_DOOR });
    expect((await putBackRetiredIssueSql({ p_document_id: "x", p_status: "  ", p_via: "unarchive" })).error).toMatchObject({ message: S_PB_STATUS });
    expect((await putBackRetiredIssueSql({ p_document_id: "x", p_status: "Issued", p_via: "unarchive" })).data).toBe("no_match");
  });
});

// ─── P19 review fix: the force is chosen; a rollback names only the caller's own retirement ─
describe("REV-23 (P19 review fix) — an override over a hold is chosen, never implied; a recorded rollback is the caller's own", () => {
  it("Document Control's un-archive of a held, stamped document WITHOUT the dialog's confirmation sends no force: refused in the new-door sentence (the dialog then offers the Draft restore), nothing written or recorded; the Draft restore lands, unrecorded; with the confirmation, the recorded pass", async () => {
    await retire("k1", "Archived");
    seedHold("k1");
    const refusals = bindGuard();
    await expect(unarchiveDocument({ doc: asRecord(docRow("k1")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" }))
      .rejects.toThrow(`The document was NOT restored (${S_NEW_DOOR_HOLD}) — nothing was changed.`);
    expect(refusals).toEqual([S_NEW_DOOR_HOLD]);
    expect(docRow("k1")).toMatchObject({ status: "Archived", retired_issue_status: "Issued" });
    expect(putBackCalls()[0].args).toMatchObject({ p_via: "unarchive", p_force_hold: false });
    expect(overrides()).toEqual([]);
    expect(audit("ARCHIVE_DOC")).toEqual([]);
    expect(isIssueRefusal(S_NEW_DOOR_HOLD)).toBe(true); // the sentence the dialog answers (afterIssueRefusal: the Draft restore for a controller)
    // forceHold on a Draft restore asks nothing: no issue, no flag, no record
    await unarchiveDocument({ doc: asRecord(docRow("k1")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Draft", forceHold: true });
    expect(docRow("k1").status).toBe("Draft");
    expect(overrides()).toEqual([]);
    // the confirmed restore of another held archive is the recorded pass
    await retire("k2", "Archived");
    seedHold("k2");
    await unarchiveDocument({ doc: asRecord(docRow("k2")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued", forceHold: true });
    expect(docRow("k2").status).toBe("Issued");
    expect(overrides("k2")).toHaveLength(1);
  });

  it("the door without p_force_hold sets no flag for any door: a held stamped Archived or Superseded document put back to Issued is refused over the hold, nothing recorded", async () => {
    await retire("k3", "Archived");
    await retire("k4", "Superseded");
    seedHold("k3"); seedHold("k4");
    bindGuard();
    expect((await putBackRetiredIssueSql({ p_document_id: "k3", p_status: "Issued", p_via: "unarchive" })).error?.message).toBe(S_NEW_DOOR_HOLD);
    for (const via of ["supersede_rollback", "lifecycle_rollback", "reversal_rollback"]) {
      expect((await putBackRetiredIssueSql({ p_document_id: "k4", p_status: "Issued", p_via: via, p_force_hold: false })).error?.message, via).toBe(S_NEW_DOOR_HOLD);
    }
    expect(docRow("k3").status).toBe("Archived");
    expect(docRow("k4").status).toBe("Superseded");
    expect(overrides()).toEqual([]);
    expect(state.flag).toBeNull();
  });

  it("a rollback door over a retirement SOMEONE ELSE made sets no flag — Document Control cannot label a deliberate un-supersede over a hold as an automatic compensation: refused over the hold, nothing recorded; the controller who made the retirement gets the recorded rollback", async () => {
    await retire("k5", "Superseded"); // retired by u1 (superseded_by_user = u1)
    seedHold("k5");
    bindGuard();
    state.session = "u2"; // another Document Control member
    for (const via of ["supersede_rollback", "lifecycle_rollback", "reversal_rollback"]) {
      expect((await putBackRetiredIssueSql({ p_document_id: "k5", p_status: "Issued", p_via: via, p_reason: "rollback", p_force_hold: true })).error?.message, via).toBe(S_NEW_DOOR_HOLD);
    }
    expect(docRow("k5").status).toBe("Superseded");
    expect(overrides()).toEqual([]);
    // a supersession that names nobody (retired by the service role, or written before superseded_by_user) is nobody's rollback either
    docRow("k5").superseded_by_user = null;
    state.session = ME;
    expect((await putBackRetiredIssueSql({ p_document_id: "k5", p_status: "Issued", p_via: "supersede_rollback", p_force_hold: true })).error?.message).toBe(S_NEW_DOOR_HOLD);
    docRow("k5").superseded_by_user = ME;
    expect(await putBackRetiredIssueSql({ p_document_id: "k5", p_status: "Issued", p_via: "supersede_rollback", p_force_hold: true })).toEqual({ data: "restored_over_hold", error: null });
    expect(overrides("k5")).toHaveLength(1);
    expect((overrides("k5")[0].details as Row).via).toBe("supersede_rollback");
  });

  it("the un-archive is not bound to who archived the document — it is the dialog's explicit confirmation, not a compensation: another controller's confirmed restore of a held archive is recorded", async () => {
    await retire("k6", "Archived"); // archived by u1
    seedHold("k6");
    bindGuard();
    state.session = "u2";
    expect(await putBackRetiredIssueSql({ p_document_id: "k6", p_status: "Issued", p_via: "unarchive", p_force_hold: true })).toEqual({ data: "restored_over_hold", error: null });
    expect(overrides("k6")[0]).toMatchObject({ user_id: "u2" });
  });
});

// ─── the app's handling ──────────────────────────────────────────────────
describe("REV-23 (P19) — the app reads the door's answers, and every stamped put-back it makes goes through it", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("isMissingPutBackRpc: only a missing function (PGRST202, 42883, the schema-cache sentence) — never a refusal", () => {
    expect(isMissingPutBackRpc({ code: "PGRST202", message: "x" })).toBe(true);
    expect(isMissingPutBackRpc({ code: "42883", message: "x" })).toBe(true);
    expect(isMissingPutBackRpc({ message: "Could not find the function public.put_back_retired_issue(p_document_id) in the schema cache" })).toBe(true);
    expect(isMissingPutBackRpc({ code: "23514", message: S_NEW_DOOR_HOLD })).toBe(false);
    expect(isMissingPutBackRpc({ code: "42501", message: "permission denied for function put_back_retired_issue" })).toBe(false);
    expect(isMissingPutBackRpc(null)).toBe(false);
  });

  it("putBackRetiredIssue maps the answers: restored / restored_over_hold land (recorded only for the latter), no_match and anything else refuse, an error refuses, a missing function is absent; the un-archive sends its five arguments, a rollback the supersession fields too — p_force_hold false unless the caller asks", async () => {
    state.rpcMode = "canned";
    const ask = (door: "unarchive" | "supersede_rollback" = "unarchive") => putBackRetiredIssue({ documentId: "d", status: "Issued", door, reason: "  r  ", supersession: { supersession_reason: "first" } });
    state.canned = { data: "restored", error: null };
    expect(await ask()).toEqual({ kind: "landed", recorded: false });
    state.canned = { data: "restored_over_hold", error: null };
    expect(await ask()).toEqual({ kind: "landed", recorded: true });
    state.canned = { data: "no_match", error: null };
    expect(await ask()).toEqual({ kind: "refused", reason: "the write was refused", noRow: true });
    state.canned = { data: "weird", error: null };
    expect(await ask()).toEqual({ kind: "refused", reason: 'the database answered "weird"' });
    state.canned = { data: null, error: { code: "23514", message: S_NEW_DOOR_HOLD } };
    expect(await ask()).toEqual({ kind: "refused", reason: S_NEW_DOOR_HOLD });
    state.canned = { data: null, error: { code: "PGRST202", message: "x" } };
    expect(await ask()).toEqual({ kind: "absent" });
    await ask("supersede_rollback");
    await putBackRetiredIssue({ documentId: "d", status: "Issued", door: "unarchive", forceHold: true });
    const calls = putBackCalls();
    expect(calls[0].args).toEqual({ p_document_id: "d", p_status: "Issued", p_via: "unarchive", p_reason: "r", p_force_hold: false });
    expect(calls[calls.length - 2].args).toEqual({
      p_document_id: "d", p_status: "Issued", p_via: "supersede_rollback", p_reason: "r", p_force_hold: false,
      p_superseded_at: null, p_superseded_by_user: null, p_supersession_reason: "first", p_supersession_moc: null,
    });
    expect(calls[calls.length - 1].args).toEqual({ p_document_id: "d", p_status: "Issued", p_via: "unarchive", p_reason: null, p_force_hold: true });
  });

  it("a refusal from the door is the put-back's refusal — no direct write is tried (the un-archive's, with its no-row sentence)", async () => {
    state.rpcMode = "canned";
    await retire("g1", "Archived");
    const refusals = bindGuard();
    state.canned = { data: "no_match", error: null };
    await expect(unarchiveDocument({ doc: asRecord(docRow("g1")), reason: "", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow("The document was NOT restored — you don't have authority to change it, or it is no longer visible to you. Nothing was changed.");
    state.canned = { data: null, error: { code: "08006", message: "connection reset" } };
    await expect(unarchiveDocument({ doc: asRecord(docRow("g1")), reason: "", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow("The document was NOT restored (connection reset) — nothing was changed.");
    expect(refusals).toEqual([]);
    expect(docRow("g1").status).toBe("Archived");
    expect(state.db.calls.filter((c) => c.table === "documents" && c.method === "update").length).toBe(1); // the retirement only
  });

  it("the four stamped put-backs call the door before their direct write, which runs only while the function is absent; only lib/revisions.ts calls the RPC, once", () => {
    const rev = src("lib/revisions.ts");
    const fn = (text: string, head: string) => text.slice(text.indexOf(head), text.indexOf("\n}\n", text.indexOf(head)));
    const unarchive = fn(rev, "export async function unarchiveDocument(");
    const undo = fn(rev, "async function undoFailedSupersede(");
    const restore = fn(src("lib/documentLifecycle/common.ts"), "export async function restoreSupersededSource(");
    const putBack = fn(src("lib/documentLifecycle/reverse.ts"), "async function putStatusBack(");
    for (const [name, text, door] of [["unarchiveDocument", unarchive, "unarchive"], ["undoFailedSupersede", undo, "supersede_rollback"], ["restoreSupersededSource", restore, "lifecycle_rollback"], ["putStatusBack", putBack, "reversal_rollback"]] as const) {
      const call = text.indexOf("await putBackRetiredIssue(");
      const direct = text.indexOf('.from("documents")');
      expect(call, name).toBeGreaterThan(0);
      expect(direct, name).toBeGreaterThan(call);
      expect(text, name).toContain(`door: "${door}"`);
      expect(text.slice(call, direct), name).toMatch(/door\.kind === "(absent|refused|landed)"/);
    }
    for (const text of [unarchive, undo, restore]) expect(text.slice(0, text.indexOf('.from("documents")'))).toContain('if (door.kind === "absent") {');
    expect(putBack.slice(0, putBack.indexOf('.from("documents")'))).toMatch(/if \(door\.kind === "landed"\) return;\n\s+if \(door\.kind === "refused"\) throw/);
    const rpcCallers = ["lib", "components", "app"].flatMap((d) => {
      const out: string[] = [];
      const walk = (p: string) => {
        for (const e of readdirSync(join(process.cwd(), p), { withFileTypes: true })) {
          const q = `${p}/${e.name}`;
          if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(q); }
          else if (/\.(ts|tsx)$/.test(e.name) && /rpc\("put_back_retired_issue"/.test(src(q))) out.push(q);
        }
      };
      walk(d);
      return out;
    });
    expect(rpcCallers).toEqual(["lib/revisions.ts"]);
    expect(rev.match(/rpc\("put_back_retired_issue"/g)).toHaveLength(1);
    const helperCallers = ["lib/revisions.ts", "lib/documentLifecycle/common.ts", "lib/documentLifecycle/reverse.ts"].map((f) => (src(f).match(/await putBackRetiredIssue\(/g) ?? []).length);
    expect(helperCallers).toEqual([2, 1, 1]);
  });
});
