// document-control Round F wave 3 — P20 RETIRED-DOCUMENT HOLD LIMBS: REV-24,
// against the guard 20261174 re-creates.
//
//   After 20261165 two controller writes on a held RETIRED document
//   (Superseded, Archived, Void) still passed an active hold with nothing
//   recorded: (b) a bare move of its current_version_id — to another
//   revision, or cleared to NULL (fix pass 2) — v_unforced_move bound only a
//   move out of an issue status — and (a) the exit into an issue
//   status of a retirement whose stamp names ANOTHER revision (what such a
//   move, or a service-role write, leaves behind), which is neither
//   v_restoring nor the new door. 20261174 binds (b) as an unforced move
//   (refused over a hold unless a recorded force's flag names the document)
//   and judges (a) as the new door (refused over a hold for everyone; no flag
//   passes it — never a recorded controller pass, REV-18).
//
// REGRESSION FIRST (the user's top rule): every put-back P13 / P14 / P17 /
// P18 / P19 keep working — the un-archive, the supersede / split / merge /
// reversal rollbacks, the legacy reversal's restore, the status editors —
// is driven through the REAL app functions against this guard, and still
// completes.
//
// There is no database here: enforce_document_publish_guard (20261174),
// put_back_retired_issue (20261165) and restore_reversed_source (20261164)
// are TRANSCRIBED below — each branch pinned to the SQL text it mirrors, in
// order — and bound to the in-memory PostgREST (the guard as the documents
// BEFORE UPDATE trigger, reading the flag as each write fires; the two
// functions as its RPCs), as P19's dcRoundFStampedPutBack.test.ts does for
// 20261165. All three were exercised on PostgreSQL 16 (REV-24's record).

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
  supersedeDocument, archiveDocument, unarchiveDocument, changeDocumentStatus,
} from "@/lib/revisions";
import { reverseSplit } from "@/lib/documentLifecycle/reverse";
import { markSupersededAndLink, withCompensation } from "@/lib/documentLifecycle/common";
import { isControlledIssueStatus, isIssueRefusal } from "@/lib/issueStatus";
import type { DocumentRecord } from "@/types/schema";

// ─── the guard and the two functions, read from 20261174 / 20261165 / 20261164 ─
const read = (f: string) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8");
const M174 = read("20261174_dc_roundF_retired_hold_limbs.sql");
const M165 = read("20261165_dc_roundF_stamped_put_back.sql");
const M164 = read("20261164_dc_roundF_reversal_restore.sql");
const body = (M: string, head: string) => {
  const a = M.indexOf(head);
  expect(a, head).toBeGreaterThanOrEqual(0);
  return M.slice(a, M.indexOf("\n$$;", a));
};
const G = body(M174, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()");
const P = body(M165, "CREATE OR REPLACE FUNCTION put_back_retired_issue(");
const R = body(M164, "CREATE OR REPLACE FUNCTION restore_reversed_source(");
const RETIRED = ["Superseded", "Archived", "Void"];
const ISSUES = ["Issued", "IFC", "Locked", "For Construction"];
/** put_back_retired_issue's issue test: btrim (spaces) NOT IN these — read from the SQL. */
const PB_NOT_ISSUE = (() => {
  const m = /AND btrim\(p_status\) NOT IN \(([^)]*)\)/.exec(P);
  expect(m, "the door names its non-issue statuses").toBeTruthy();
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

/** enforce_document_publish_guard() (20261174), transcribed: 20261165's
 *  branches (as P19's transcription) plus the two P20 limbs. A NULL status
 *  is outside its domain, and the review gate on a pointer move admits every
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

describe("the transcriptions are the SQL's (20261174 / 20261165 / 20261164, in order)", () => {
  it("the guard: every branch it mirrors is in 20261174's body, in this order — the two P20 limbs right after P19's and before the stamp is written", () => {
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
      // P20 (b) — a move off the current revision, to another or cleared (fix pass 2: no NEW IS NOT NULL clause)
      "  v_unforced_move := v_unforced_move\n                     OR COALESCE(OLD.current_version_id IS NOT NULL\n                                 AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                                 AND is_org_controller(NEW.org_id), false);",
      // P20 (a)
      "  v_new_door := v_new_door\n                OR COALESCE(v_issuing\n                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                            AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                            AND OLD.retired_issue_version_id IS NOT NULL\n                            AND OLD.retired_issue_version_id IS DISTINCT FROM OLD.current_version_id, false);",
      "  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN\n    IF COALESCE(OLD.status IN ('Superseded', 'Archived', 'Void'), false) THEN\n      NEW.retired_issue_status := OLD.retired_issue_status;",
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

  it("the put-back door (20261165, unchanged): it forces only a stamp naming the current revision — the branch this file's transcription mirrors", () => {
    expect(P).toContain("  IF COALESCE(p_force_hold, false)\n     AND v_status = (CASE WHEN p_via = 'unarchive' THEN 'Archived' ELSE 'Superseded' END)\n     AND (p_via = 'unarchive' OR v_retired_by = v_uid)\n     AND v_stamped IS NOT NULL\n     AND v_stamped = v_version\n     AND btrim(p_status) NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n    v_forced := true;\n  END IF;");
    expect(PB_NOT_ISSUE).toEqual(["Draft", "In Review", "Superseded", "Void", "Archived"]);
  });

  it("the reversal's restore (20261164, unchanged): it forces for a held Superseded source of the recorded split / merge it names, stamped or not", () => {
    expect(R).toContain("  IF v_status = 'Superseded'\n     AND v_action IS NOT NULL\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n    v_forced := true;\n  END IF;");
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
const docs = () => makeFakeSupabase(state.db).from("documents") as unknown as Docs;

/** put_back_retired_issue (20261165), transcribed as P19's test does. */
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

/** restore_reversed_source (20261164), transcribed as P18's and P19's tests do. */
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
  T("document_versions").push(
    { id: `${id}-v2`, org_id: ORG, record_id: id, revision_label: "2", superseded_at: "2026-01-01" },
    { id: `${id}-v3`, org_id: ORG, record_id: id, revision_label: "3", superseded_at: null },
  );
  return d;
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
/** A retirement whose stamp names ANOTHER revision, as it is reachable: retired through the guard (stamped Issued / v3),
 *  then its pointer moved to v2 while NOT held (no rule binds that — there is no hold to pass), then held when `held`. */
async function retireElsewhere(id: string, status: "Archived" | "Superseded" | "Void", held = true): Promise<void> {
  await retire(id, status);
  const saved = { roles: state.roles, session: state.session };
  state.roles = ["DocCtrl"]; state.session = ME;
  const res = await docs().update({ current_version_id: `${id}-v2` }).eq("id", id).select("id");
  state.roles = saved.roles; state.session = saved.session;
  expect(res.error, id).toBeNull();
  expect(docRow(id)).toMatchObject({ status, retired_issue_status: "Issued", retired_issue_version_id: `${id}-v3`, current_version_id: `${id}-v2` });
  if (held) seedHold(id);
}
/** A split of `prefix` into `${prefix}a` / `${prefix}b` (the sheets Issued, the source Superseded; `stamp` the source's). */
function seedSplit(prefix: string, stamp: "none" | "issued" | "elsewhere") {
  seedDoc(prefix, {
    status: "Superseded", uniqueness_key: `${prefix}-key`, superseded_at: "2025-09-01T10:00:00Z", supersession_reason: "split",
    ...(stamp === "none" ? {} : { retired_issue_status: "Issued", retired_issue_version_id: `${prefix}-v3` }),
    ...(stamp === "elsewhere" ? { current_version_id: `${prefix}-v2` } : {}),
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
  state.requireMode = false;
  state.rpcCalls = [];
  state.putBack = putBackRetiredIssueSql;
  state.restore = restoreReversedSourceSql;
});

// ─── REGRESSION FIRST: every legitimate write that works today still works ──
describe("REV-24 (P20) — regression first: the put-backs, compensations, reversals and status edits P13 / P14 / P17 / P18 / P19 keep working still complete against 20261174's guard", () => {
  it("a controller's failed supersede of a held document (forced over the hold) is put back to Issued by undoFailedSupersede — exactly one REV_HOLD_OVERRIDDEN (supersede_rollback), nothing refused", async () => {
    const d = seedDoc("p1"); seedDoc("p1a"); seedHold("p1");
    const refusals = bindGuard();
    state.db.refuseWrites.add("document_supersessions");
    await expect(supersedeDocument({ doc: asRecord(d), replacementDocNumbers: ["P1A"], libraryId: LIB, reason: "replaced", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/^Nothing was superseded: The replacement links could not be recorded \(.*\)\. The document is back to Issued\./);
    expect(refusals).toEqual([]);
    expect(docRow("p1")).toMatchObject({ status: "Issued", retired_issue_status: null });
    expect(overrides("p1")).toHaveLength(1);
    expect((overrides("p1")[0].details as Row).via).toBe("supersede_rollback");
    expect(state.flag).toBe("");
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

  it("Document Control's confirmed un-archive of a held stamped archive (archiveDocument, then held) is the recorded pass; without the confirmation it is refused in the new-door sentence; the Draft restore lands; unheld un-archives by Document Control and the owner land unrecorded", async () => {
    const d = seedDoc("a1");
    const refusals = bindGuard();
    await archiveDocument({ doc: asRecord(d), reason: "superseded on site", orgId: ORG, actorUserId: ME });
    expect(docRow("a1")).toMatchObject({ status: "Archived", retired_issue_status: "Issued", retired_issue_version_id: "a1-v3" });
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
    expect(overrides()).toHaveLength(1);
  });

  it("the owner's un-archive of a held stamped archive is refused as before, in the publisher tier's words", async () => {
    await retire("a5", "Archived"); seedHold("a5");
    state.roles = ["Engineer"]; state.publisher = true;
    bindGuard();
    await expect(unarchiveDocument({ doc: asRecord(docRow("a5")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" }))
      .rejects.toThrow(`The document was NOT restored (${S_PUBLISHER_HOLD}) — nothing was changed.`);
    expect(docRow("a5").status).toBe("Archived");
  });

  it("a reversal whose lineage delete is refused rolls back whole over a held parked sheet — the sheet's un-park recorded (reversal_rollback), the source back Superseded (P18's correction)", async () => {
    seedSplit("r1", "none");
    seedHold("r1a");
    const refusals = bindGuard();
    state.db.deleteErrors!.document_supersessions = { code: "42501", message: "only Document Control may delete supersession rows" };
    await expect(reverseSplit({ splitAuditEventId: "ev-r1", reason: "wrong split", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/supersession link\(s\) could not be removed[\s\S]*rolled back — no partial changes were kept/);
    expect(refusals).toEqual([]);
    for (const s of ["r1a", "r1b"]) expect(docRow(s)).toMatchObject({ status: "Issued", retired_issue_status: null });
    expect(docRow("r1").status).toBe("Superseded");
    expect(overrides("r1a").map((o) => (o.details as Row).via)).toEqual(["reversal_rollback"]);
    expect(audit("REV_HOLD_OVERRIDE_UNDONE").map((r) => r.resource_id)).toEqual(["r1"]);
  });

  it("P18's reversal through restore_reversed_source is unchanged: a source the app's split stamped (with its current revision) and an unstamped one come back over a carried hold, recorded once each", async () => {
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
  });

  it("the status editors (changeDocumentStatus): a publisher issues a Draft and restores an unheld retirement — its stamp naming another revision included — as before; the require limb decides a non-restoring exit for a non-controller as before", async () => {
    state.roles = ["Engineer"]; state.publisher = true;
    seedDoc("m1", { status: "Draft" });
    await retireElsewhere("m2", "Archived", false);
    await retire("m3", "Void");
    bindGuard();
    for (const id of ["m1", "m2", "m3"]) {
      const outcome = await changeDocumentStatus({ orgId: ORG, documentId: id, toStatus: "Issued", door: "metadata", actorUserId: ME });
      expect(docRow(id).status, id).toBe("Issued");
      expect(outcome.issued, id).toBe(true);
    }
    await retireElsewhere("m4", "Archived", false);
    state.requireMode = true;
    await expect(changeDocumentStatus({ orgId: ORG, documentId: "m4", toStatus: "Issued", door: "bulk", actorUserId: ME })).rejects.toThrow(S_REQUIRE);
    state.roles = ["DocCtrl"];
    await changeDocumentStatus({ orgId: ORG, documentId: "m4", toStatus: "Issued", door: "bulk", actorUserId: ME });
    expect(docRow("m4").status).toBe("Issued");
  });

  it("retiring a held document stays open to Document Control (its pointer unmoved), and stamps it; P17's issued pointer move and REV-20's pointer-and-issue keep their rules", async () => {
    seedDoc("i1"); seedHold("i1");
    bindGuard();
    for (const status of ["Archived", "Superseded", "Void"]) {
      expect(publishGuard({ ...docRow("i1"), status }, docRow("i1"), { actor: ME, controller: true, publisher: false, held: () => true }))
        .toMatchObject({ status, retired_issue_status: "Issued", retired_issue_version_id: "i1-v3" });
    }
    const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
    const issued: Row = { id: "d1", status: "Issued", current_version_id: "v3", retired_issue_status: null, retired_issue_version_id: null };
    expect(refused(() => publishGuard({ ...issued, current_version_id: "v4" }, issued, ctl))).toBe(S_UNFORCED_HOLD);
    expect(publishGuard({ ...issued, current_version_id: "v4" }, issued, { ...ctl, flag: "d1" }).current_version_id).toBe("v4");
    const draft: Row = { ...issued, status: "Draft" };
    expect(refused(() => publishGuard({ ...draft, status: "Issued", current_version_id: "v4" }, draft, ctl))).toBe(S_UNFORCED_HOLD);
    expect(refused(() => publishGuard({ ...draft, status: "Issued" }, draft, ctl))).toBe(S_NEW_DOOR_HOLD);
  });
});

// ─── the finding, limb (b): the pointer move on a held retired document ─────
describe("REV-24 (P20) (b) — a controller's pointer move on a held retired document passes the hold only under a recorded force's flag", () => {
  const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
  const owner: GuardCtx = { actor: "owner", controller: false, publisher: true, held: () => true };
  const kinds: Record<string, Row> = {
    "stamped (the current revision)": { retired_issue_status: "Issued", retired_issue_version_id: "v3" },
    "stamped (another revision)": { retired_issue_status: "Issued", retired_issue_version_id: "v1" },
    unstamped: { retired_issue_status: null, retired_issue_version_id: null },
    "not-issued": { retired_issue_status: "not-issued", retired_issue_version_id: null },
  };
  const retiredDoc = (status: string, kind: Row): Row => ({ id: "d1", status, current_version_id: "v3", ...kind });

  it("refused over an active hold for a controller — out of Superseded, Archived or Void, whatever its stamp, staying retired or into another retirement or a Draft / In Review — in REV-20 (b)'s sentence; admitted under the flag naming the document; refused under another's or a cleared one", () => {
    for (const from of RETIRED) {
      for (const [name, kind] of Object.entries(kinds)) {
        const OLD = retiredDoc(from, kind);
        for (const to of [from, ...RETIRED.filter((s) => s !== from), "Draft", "In Review"]) {
          expect(refused(() => publishGuard({ ...OLD, status: to, current_version_id: "v2" }, OLD, ctl)), `${from} (${name}) -> ${to}`).toBe(S_UNFORCED_HOLD);
        }
        expect(publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, flag: "d1" }).current_version_id, name).toBe("v2");
        expect(refused(() => publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, flag: "d2" })), name).toBe(S_UNFORCED_HOLD);
        expect(refused(() => publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, flag: "" })), name).toBe(S_UNFORCED_HOLD);
      }
    }
    expect(isIssueRefusal(S_UNFORCED_HOLD)).toBe(true);
  });

  it("a pointer-moving exit into an issue status keeps REV-20 (b)'s rule (refused unforced, admitted under the flag — publish_revision's forced revert of a held retired document); a move within a retirement keeps the stamp", () => {
    for (const from of RETIRED) {
      const OLD = retiredDoc(from, kinds["stamped (the current revision)"]);
      expect(refused(() => publishGuard({ ...OLD, status: "Issued", current_version_id: "v4" }, OLD, ctl)), from).toBe(S_UNFORCED_HOLD);
      expect(publishGuard({ ...OLD, status: "Issued", current_version_id: "v4" }, OLD, { ...ctl, flag: "d1" }).status, from).toBe("Issued");
      expect(publishGuard({ ...OLD, current_version_id: "v4" }, OLD, { ...ctl, flag: "d1" }), from)
        .toMatchObject({ status: from, retired_issue_status: "Issued", retired_issue_version_id: "v3" });
    }
  });

  it("regression: no hold — admitted; the owner (publisher tier) — refused over a hold in its own words as before, admitted without one; the service role — untouched", () => {
    const OLD = retiredDoc("Archived", kinds["stamped (the current revision)"]);
    expect(publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, held: () => false }).current_version_id).toBe("v2");
    expect(refused(() => publishGuard({ ...OLD, current_version_id: "v2" }, OLD, owner))).toBe(S_PUBLISHER_HOLD);
    expect(refused(() => publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...owner, flag: "d1" }))).toBe(S_PUBLISHER_HOLD);
    expect(publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...owner, held: () => false }).current_version_id).toBe("v2");
    expect(publishGuard({ ...OLD, current_version_id: "v2" }, OLD, { ...ctl, actor: null }).current_version_id).toBe("v2");
  });

  it("fix pass 2 — the pointer CLEARED (current_version_id set to NULL) is a move off the current revision too: refused over an active hold for a controller — out of Superseded, Archived or Void, whatever its stamp, staying retired or into another retirement, a Draft / In Review or an issue status — in REV-20 (b)'s sentence; admitted under the flag naming the document (the stamp kept while it stays retired); refused under another's or a cleared one", () => {
    for (const from of RETIRED) {
      for (const [name, kind] of Object.entries(kinds)) {
        const OLD = retiredDoc(from, kind);
        for (const to of [from, ...RETIRED.filter((s) => s !== from), "Draft", "In Review", ...ISSUES]) {
          expect(refused(() => publishGuard({ ...OLD, status: to, current_version_id: null }, OLD, ctl)), `${from} (${name}) -> ${to}, cleared`).toBe(S_UNFORCED_HOLD);
        }
        expect(publishGuard({ ...OLD, current_version_id: null }, OLD, { ...ctl, flag: "d1" }), name)
          .toMatchObject({ status: from, current_version_id: null, retired_issue_status: kind.retired_issue_status, retired_issue_version_id: kind.retired_issue_version_id });
        expect(refused(() => publishGuard({ ...OLD, current_version_id: null }, OLD, { ...ctl, flag: "d2" })), name).toBe(S_UNFORCED_HOLD);
        expect(refused(() => publishGuard({ ...OLD, current_version_id: null }, OLD, { ...ctl, flag: "" })), name).toBe(S_UNFORCED_HOLD);
      }
    }
  });

  it("fix pass 2 regression: the clear with no hold — admitted for a controller; the owner (publisher tier) — refused over a hold in its own words as before, under a flag too, and admitted without one; the service role — untouched", () => {
    const OLD = retiredDoc("Archived", kinds["stamped (the current revision)"]);
    const cleared = { ...OLD, current_version_id: null };
    expect(publishGuard(cleared, OLD, { ...ctl, held: () => false }).current_version_id).toBeNull();
    expect(refused(() => publishGuard(cleared, OLD, owner))).toBe(S_PUBLISHER_HOLD);
    expect(refused(() => publishGuard(cleared, OLD, { ...owner, flag: "d1" }))).toBe(S_PUBLISHER_HOLD);
    expect(publishGuard(cleared, OLD, { ...owner, held: () => false }).current_version_id).toBeNull();
    expect(publishGuard(cleared, OLD, { ...ctl, actor: null }).current_version_id).toBeNull();
  });

  it("outside this limb, as in P17's: a first pointer write (no current revision yet) is a creation's, not a move off a revision — admitted for a controller (the residual the integrator opens as a new finding, recorded on REV-24's Scope); an issued document's clear stays outside too (P17's limb binds a move between revisions)", () => {
    const noRevision = { ...retiredDoc("Archived", kinds["not-issued"]), current_version_id: null };
    expect(publishGuard({ ...noRevision, current_version_id: "v2" }, noRevision, ctl).current_version_id).toBe("v2");
    const issued: Row = { id: "d1", status: "Issued", current_version_id: "v3", retired_issue_status: null, retired_issue_version_id: null };
    expect(publishGuard({ ...issued, current_version_id: null }, issued, ctl).current_version_id).toBeNull();
  });

  it("an archive with NO current revision (the dialog's basis \"unknown\") restored to Issued is no issue — nothing becomes the controlled issue — so it passes Document Control over a hold, unrecorded, as the ArchiveConfirmModal note says; the owner is refused in the publisher tier's words", async () => {
    const noRevision: Row = { id: "d1", status: "Archived", current_version_id: null, retired_issue_status: "Issued", retired_issue_version_id: "v3" };
    expect(publishGuard({ ...noRevision, status: "Issued" }, noRevision, ctl)).toMatchObject({ status: "Issued", current_version_id: null, retired_issue_status: null });
    expect(refused(() => publishGuard({ ...noRevision, status: "Issued" }, noRevision, owner))).toBe(S_PUBLISHER_HOLD);
    await retire("a9", "Archived");
    seedHold("a9");
    bindGuard();
    state.session = null; // the service role's clear (its writes never touch the stamp)
    expect((await docs().update({ current_version_id: null }).eq("id", "a9").select("id")).error).toBeNull();
    state.session = ME;
    await unarchiveDocument({ doc: asRecord(docRow("a9")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued" });
    expect(docRow("a9")).toMatchObject({ status: "Issued", current_version_id: null });
    expect(overrides("a9")).toEqual([]);
  });

  it("through the in-memory PostgREST — the failure scenario's first step: Document Control's direct PATCH of held, stamped archive A6's current_version_id to its previous revision is refused and nothing is written", async () => {
    await retire("a6", "Archived");
    seedHold("a6");
    const refusals = bindGuard();
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase.from("documents").update({ current_version_id: "a6-v2" }).eq("id", "a6").select("id");
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: S_UNFORCED_HOLD });
    expect(refusals).toEqual([S_UNFORCED_HOLD]);
    expect(docRow("a6")).toMatchObject({ status: "Archived", current_version_id: "a6-v3", retired_issue_version_id: "a6-v3" });
    // …so its exit stays the stamped put-back, P19's recorded door
    await unarchiveDocument({ doc: asRecord(docRow("a6")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued", forceHold: true });
    expect(docRow("a6").status).toBe("Issued");
    expect(overrides("a6")).toHaveLength(1);
  });

  it("through the in-memory PostgREST — P-22's first step (fix pass 2): Document Control's direct PATCH clearing held, stamped archive A10's current_version_id is refused and nothing is written; the bare un-archive is then P19's (refused), and the archive comes back only through its recorded door; under the flag naming it, the clear is admitted", async () => {
    await retire("a10", "Archived");
    seedHold("a10");
    const refusals = bindGuard();
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase.from("documents").update({ current_version_id: null }).eq("id", "a10").select("id");
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: S_UNFORCED_HOLD });
    expect(docRow("a10")).toMatchObject({ status: "Archived", current_version_id: "a10-v3", retired_issue_version_id: "a10-v3" });
    expect((await supabase.from("documents").update({ status: "Issued", archived_at: null }).eq("id", "a10").select("id")).error).toMatchObject({ message: S_NEW_DOOR_HOLD });
    expect(refusals).toEqual([S_UNFORCED_HOLD, S_NEW_DOOR_HOLD]);
    await unarchiveDocument({ doc: asRecord(docRow("a10")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued", forceHold: true });
    expect(docRow("a10")).toMatchObject({ status: "Issued", current_version_id: "a10-v3" });
    expect(overrides("a10")).toHaveLength(1);
    await retire("a11", "Archived");
    seedHold("a11");
    state.flag = "a11";
    expect((await supabase.from("documents").update({ current_version_id: null }).eq("id", "a11").select("id")).error).toBeNull();
    expect(docRow("a11")).toMatchObject({ status: "Archived", current_version_id: null, retired_issue_version_id: "a11-v3" });
  });
});

// ─── the finding, limb (a): the exit of a stamp naming another revision ─────
describe("REV-24 (P20) (a) — the exit into an issue status of a retirement whose stamp names another revision is the new door: refused over a hold for everyone, no flag passing it", () => {
  const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
  const owner: GuardCtx = { actor: "owner", controller: false, publisher: true, held: () => true };
  const elsewhere = (status: string): Row => ({ id: "d1", status, current_version_id: "v2", retired_issue_status: "Issued", retired_issue_version_id: "v3" });

  it("refused over an active hold for a controller AND for the owner — out of Superseded, Archived or Void into Issued, IFC, Locked or a library's own status — in the new-door sentence; the flag naming the document passes nothing", () => {
    for (const from of RETIRED) {
      for (const to of ISSUES) {
        for (const [who, ctx] of [["controller", ctl], ["owner", owner]] as const) {
          expect(refused(() => publishGuard({ ...elsewhere(from), status: to }, elsewhere(from), ctx)), `${who}: ${from} -> ${to}`).toBe(S_NEW_DOOR_HOLD);
          expect(refused(() => publishGuard({ ...elsewhere(from), status: to }, elsewhere(from), { ...ctx, flag: "d1" })), `${who} under the flag: ${from} -> ${to}`).toBe(S_NEW_DOOR_HOLD);
        }
      }
    }
  });

  it("regression: no hold — admitted for both (the require limb deciding a non-controller's, as before); a Draft / In Review restore — admitted for a controller; the service role — untouched; the stamp cleared as it leaves", () => {
    for (const from of RETIRED) {
      expect(publishGuard({ ...elsewhere(from), status: "Issued" }, elsewhere(from), { ...ctl, held: () => false })).toMatchObject({ status: "Issued", retired_issue_status: null, retired_issue_version_id: null });
      expect(publishGuard({ ...elsewhere(from), status: "Issued" }, elsewhere(from), { ...owner, held: () => false }).status).toBe("Issued");
      expect(refused(() => publishGuard({ ...elsewhere(from), status: "Issued" }, elsewhere(from), { ...owner, held: () => false, requireMode: true, rosterComplete: false }))).toBe(S_REQUIRE);
      expect(publishGuard({ ...elsewhere(from), status: "Issued" }, elsewhere(from), { ...owner, held: () => false, requireMode: true, rosterComplete: true }).status).toBe("Issued");
      for (const s of ["Draft", "In Review"]) expect(publishGuard({ ...elsewhere(from), status: s }, elsewhere(from), ctl).status).toBe(s);
      expect(publishGuard({ ...elsewhere(from), status: "Issued" }, elsewhere(from), { ...ctl, actor: null }).status).toBe("Issued");
    }
  });

  it("the stamp naming the CURRENT revision keeps P19's rule (refused bare, admitted under the flag — put_back_retired_issue's recorded door); an exit that moves the pointer keeps REV-20 (b)'s (admitted under a recorded force's flag)", () => {
    const current: Row = { id: "d1", status: "Archived", current_version_id: "v3", retired_issue_status: "Issued", retired_issue_version_id: "v3" };
    expect(refused(() => publishGuard({ ...current, status: "Issued" }, current, ctl))).toBe(S_NEW_DOOR_HOLD);
    expect(publishGuard({ ...current, status: "Issued" }, current, { ...ctl, flag: "d1" }).status).toBe("Issued");
    expect(refused(() => publishGuard({ ...elsewhere("Archived"), status: "Issued", current_version_id: "v3" }, elsewhere("Archived"), ctl))).toBe(S_UNFORCED_HOLD);
    expect(publishGuard({ ...elsewhere("Archived"), status: "Issued", current_version_id: "v4" }, elsewhere("Archived"), { ...ctl, flag: "d1" }).status).toBe("Issued");
  });

  it("put_back_retired_issue never forces it: Document Control's forced un-archive / rollback of a held stamp-elsewhere retirement sets no flag and is refused in the new-door sentence, nothing written or recorded", async () => {
    await retireElsewhere("x1", "Archived");
    await retireElsewhere("x2", "Superseded");
    const refusals = bindGuard();
    expect((await putBackRetiredIssueSql({ p_document_id: "x1", p_status: "Issued", p_via: "unarchive", p_force_hold: true })).error?.message).toBe(S_NEW_DOOR_HOLD);
    for (const via of ["supersede_rollback", "lifecycle_rollback", "reversal_rollback"]) {
      expect((await putBackRetiredIssueSql({ p_document_id: "x2", p_status: "Issued", p_via: via, p_force_hold: true })).error?.message, via).toBe(S_NEW_DOOR_HOLD);
    }
    expect(refusals).toEqual(Array(4).fill(S_NEW_DOOR_HOLD));
    expect(docRow("x1")).toMatchObject({ status: "Archived", retired_issue_version_id: "x1-v3", current_version_id: "x1-v2" });
    expect(docRow("x2").status).toBe("Superseded");
    expect(overrides()).toEqual([]);
    expect(state.flag).toBeNull();
    // the Draft restore through the same door lands, unrecorded
    expect(await putBackRetiredIssueSql({ p_document_id: "x1", p_status: "Draft", p_via: "unarchive", p_force_hold: true })).toEqual({ data: "restored", error: null });
  });

  it("the un-archive dialog's path (unarchiveDocument), confirmed or not, is refused in the new-door sentence the dialog answers (it then offers the Draft restore), with no ARCHIVE_DOC event; the Draft restore lands", async () => {
    await retireElsewhere("x3", "Archived");
    const refusals = bindGuard();
    for (const forceHold of [undefined, true]) {
      await expect(unarchiveDocument({ doc: asRecord(docRow("x3")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued", forceHold }))
        .rejects.toThrow(`The document was NOT restored (${S_NEW_DOOR_HOLD}) — nothing was changed.`);
    }
    expect(refusals).toEqual([S_NEW_DOOR_HOLD, S_NEW_DOOR_HOLD]);
    expect(putBackCalls().map((c) => c.args.p_force_hold)).toEqual([false, true]);
    expect(audit("ARCHIVE_DOC")).toEqual([]);
    expect(overrides()).toEqual([]);
    expect(isIssueRefusal(`The document was NOT restored (${S_NEW_DOOR_HOLD}) — nothing was changed.`)).toBe(true);
    await unarchiveDocument({ doc: asRecord(docRow("x3")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Draft" });
    expect(docRow("x3").status).toBe("Draft");
  });

  it("the status editors: a controller's (and a publisher's) status edit of a held stamp-elsewhere Void into Issued is refused in the new-door sentence they answer", async () => {
    await retireElsewhere("x4", "Void");
    bindGuard();
    await expect(changeDocumentStatus({ orgId: ORG, documentId: "x4", toStatus: "Issued", door: "metadata", actorUserId: ME })).rejects.toThrow(S_NEW_DOOR_HOLD);
    state.roles = ["Engineer"]; state.publisher = true;
    await expect(changeDocumentStatus({ orgId: ORG, documentId: "x4", toStatus: "Issued", door: "bulk", actorUserId: ME })).rejects.toThrow(S_NEW_DOOR_HOLD);
    expect(docRow("x4").status).toBe("Void");
  });

  it("the legacy reversal of a split whose source's stamp names another revision (its pointer moved after the split) is refused over a carried hold — restore_reversed_source's flag passes nothing here — and rolls back: the source stays Superseded, the sheets come back, nothing recorded for the source", async () => {
    seedSplit("r4", "elsewhere");
    seedHold("r4a");
    const refusals = bindGuard();
    await expect(reverseSplit({ splitAuditEventId: "ev-r4", reason: "wrong split", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/r4 could not be restored to Issued \(Document has an active hold; release the hold before issuing it\.\)[\s\S]*rolled back/);
    expect(refusals).toContain(S_NEW_DOOR_HOLD);
    expect(docRow("r4")).toMatchObject({ status: "Superseded", current_version_id: "r4-v2", retired_issue_version_id: "r4-v3" });
    for (const s of ["r4a", "r4b"]) expect(docRow(s).status, s).toBe("Issued");
    expect(overrides("r4")).toEqual([]);
    expect(audit("DOC_SPLIT_REVERSED")).toEqual([]);
  });

  it("the failure scenario through the service role (whose writes never touch the stamp): its move of held A7's pointer is admitted as before, and Document Control's exit of A7 into an issue is then refused — bare, through the confirmed un-archive, and under a flag", async () => {
    await retire("a7", "Archived");
    seedHold("a7");
    const refusals = bindGuard();
    state.session = null;
    expect((await docs().update({ current_version_id: "a7-v2" }).eq("id", "a7").select("id")).error).toBeNull();
    state.session = ME;
    expect(docRow("a7")).toMatchObject({ current_version_id: "a7-v2", retired_issue_version_id: "a7-v3" });
    const { supabase } = await import("@/lib/supabase");
    expect((await supabase.from("documents").update({ status: "Issued", archived_at: null }).eq("id", "a7").select("id")).error).toMatchObject({ message: S_NEW_DOOR_HOLD });
    await expect(unarchiveDocument({ doc: asRecord(docRow("a7")), reason: "", orgId: ORG, actorUserId: ME, restoreStatus: "Issued", forceHold: true }))
      .rejects.toThrow(S_NEW_DOOR_HOLD);
    state.flag = "a7";
    expect((await supabase.from("documents").update({ status: "IFC" }).eq("id", "a7").select("id")).error).toMatchObject({ message: S_NEW_DOOR_HOLD });
    expect(refusals).toEqual([S_NEW_DOOR_HOLD, S_NEW_DOOR_HOLD, S_NEW_DOOR_HOLD]);
    expect(docRow("a7").status).toBe("Archived");
    expect(overrides()).toEqual([]);
  });
});
