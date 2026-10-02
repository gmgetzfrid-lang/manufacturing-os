// document-control Round F wave 3 — P18 RECORDED REVERSAL RESTORE: REV-22
// done-when 2, against the guard and the restore 20261164 creates.
//
//   The legacy reversal (reverseSplit / reverseMerge) carries a parked
//   document's hold onto the source (HLD-2) and THEN puts the source back.
//   That put-back was a bare PostgREST UPDATE, so the guard could not tell it
//   from a controller's bare un-supersede and REV-20 (a) had to spare every
//   unstamped Superseded exit. Now restoreStatus goes through
//   restore_reversed_source (20261164): the same write, as the caller, under
//   the transaction-local flag for Document Control's put-back of a held
//   source of the split / merge being reversed, recorded as
//   REV_HOLD_OVERRIDDEN — and the guard binds the BARE unstamped Superseded
//   exit (the new door: refused over an active hold, a controller included).
//   On a database without the function (PGRST202 / 42883) the restore is the
//   direct write it always was.
//   Review fix: the door opens only for an event no recorded reversal has
//   undone, and a recorded pass the saga then rolls back is corrected on the
//   record (REV_HOLD_OVERRIDE_UNDONE).
//
// There is no database here: enforce_document_publish_guard (20261164) and
// restore_reversed_source are TRANSCRIBED below — each branch pinned to the
// SQL text it mirrors, in order — and bound to the in-memory PostgREST (the
// guard as the documents BEFORE UPDATE trigger, the restore as its RPC), so
// the REAL reverseSplit / reverseMerge run against them. P14's and P17's
// transcriptions (dcRoundFReversalOverCarriedHold, dcRoundFHeldPointerMove)
// stay on their own bases and drive the same reversals with the function
// absent. Both functions were exercised on PostgreSQL 16 (REV-22's record).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

type RpcAnswer = { data: unknown; error: { code?: string; message: string } | null };
const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  roles: ["DocCtrl"] as string[],
  /** current_setting('app.publish_hold_override', true) for the call in flight. */
  flag: null as string | null,
  /** The session the RPC runs as (auth.uid()); null = no session. */
  session: "u1" as string | null,
  /** How the database answers restore_reversed_source: the transcription, or
   *  a canned answer (the function absent, a transport error, …). */
  rpcMode: "real" as "real" | "absent" | "canned",
  canned: null as unknown as RpcAnswer,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  restore: null as unknown as (args: Record<string, unknown>) => Promise<RpcAnswer>,
  /** The error audit_logs answers the lost-answer correction's look-up with (integrator fix); null = it reads. */
  auditLookupError: null as { message: string } | null,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => (t === "audit_logs" ? auditLogsAsPostgres(base.from(t)) : base.from(t)),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        if (fn !== "restore_reversed_source") return { data: null, error: { code: "PGRST202", message: "not in this test" } };
        if (state.rpcMode === "absent") return { data: null, error: { code: "PGRST202", message: "Could not find the function public.restore_reversed_source(p_document_id, p_reason, p_reversal_of, p_status) in the schema cache" } };
        if (state.rpcMode === "canned") return state.canned;
        return state.restore(args);
      },
    };
  },
}));
/** audit_logs as PostgreSQL reads it (integrator fix): `id` is a uuid
 *  column, so a filter on it takes any spelling the uuid type accepts (upper
 *  case, braces) — the in-memory rows hold the canonical lower-case one; and
 *  the lost-answer correction's look-up (it names REV_HOLD_OVERRIDE_UNDONE
 *  among its actions) answers state.auditLookupError when one is set. */
function auditLogsAsPostgres(inner: object): object {
  let lookup = false;
  const wrap = (b: object): object => new Proxy(b, {
    get(target, prop) {
      const v = (target as Record<string | symbol, unknown>)[prop];
      if (prop === "then" && lookup && state.auditLookupError) {
        return (resolve: (x: unknown) => void) => resolve({ data: null, error: state.auditLookupError });
      }
      if (prop === "then" || typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (prop === "eq" && args[0] === "id" && typeof args[1] === "string") args = ["id", args[1].toLowerCase().replace(/^\{(.*)\}$/, "$1")];
        if (prop === "in" && args[0] === "action" && Array.isArray(args[1]) && args[1].includes("REV_HOLD_OVERRIDE_UNDONE")) lookup = true;
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

import { reverseSplit, reverseMerge, isMissingRestoreRpc } from "@/lib/documentLifecycle/reverse";
import { isControlledIssueStatus, isIssueRefusal, ISSUE_REFUSAL } from "@/lib/issueStatus";

// ─── the guard and the restore, read from 20261164 ─────────────────────────
const M = readFileSync(join(process.cwd(), "supabase/migrations/20261164_dc_roundF_reversal_restore.sql"), "utf8");
const body = (head: string) => {
  const a = M.indexOf(head);
  expect(a, head).toBeGreaterThanOrEqual(0);
  return M.slice(a, M.indexOf("\n$$;", a));
};
const G = body("CREATE OR REPLACE FUNCTION enforce_document_publish_guard()");
const R = body("CREATE OR REPLACE FUNCTION restore_reversed_source(");
const RETIRED = ["Superseded", "Archived", "Void"];
/** REV-20 limb (a)'s statuses and the P18 limb's, read from the SQL — the transcription follows the file. */
const LIMBS = (() => {
  const block = G.slice(G.indexOf("  v_new_door := v_new_door\n"), G.indexOf("  v_unforced_issue := COALESCE(v_issuing"));
  const a = /AND OLD\.status IN \(([^)]*)\)/.exec(block);
  const p18 = /AND OLD\.status = '(\w+)'/.exec(block);
  expect(a, "limb (a) names its statuses").toBeTruthy();
  expect(p18, "the P18 limb names its status").toBeTruthy();
  return { a: a![1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")), p18: p18![1] };
})();

const S_NEW_DOOR_HOLD = "Document has an active hold; release the hold before issuing it.";
const S_UNFORCED_HOLD = "Document has an active hold; release the hold before issuing it, or publish over it with Document Control's recorded override.";
const S_REQUIRE = "This library requires reviewer sign-off, so a revision that was not reviewed can't be made a controlled issue; submit it for review, or ask Document Control.";
const S_AUTHORITY = "You do not have authority to publish revisions in this library.";
const S_PUBLISHER_HOLD = "Document has an active hold; release the hold before publishing a new revision.";
const S_NO_SESSION = "restore_reversed_source: a reversal's restore is a signed-in act, and this call has no session.";

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
/** translate(lower(v), '{}-', '') — NULL for a NULL (a JSON key that is absent). */
const sqlTranslateLower = (v: unknown): string | null => (has(v) ? String(v).toLowerCase().replace(/[{}-]/g, "") : null);

/** enforce_document_publish_guard() (20261164), transcribed. As in P14's and
 *  P17's transcriptions a NULL status is outside its domain, and the review
 *  gate on a pointer move is pinned by its own tests and admits every pointer
 *  move here. */
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
  newDoor = newDoor || (issuing && sameptr && LIMBS.a.includes(os) && !has(OLD.retired_issue_status) && ctx.controller);
  const flagNamesIt = (ctx.flag ?? null) === NEW.id;
  // REV-22 (P18): the unstamped Superseded exit, unless the recorded restore's flag names the document
  newDoor = newDoor || (issuing && sameptr && os === LIMBS.p18 && !has(OLD.retired_issue_status) && !flagNamesIt && ctx.controller);
  const unforced = issuing && !sameptr && !flagNamesIt && ctx.controller;
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

describe("the transcriptions are the SQL's (20261164, in order)", () => {
  it("the guard: every branch it mirrors is in the body, in this order — the P18 limb right after REV-20 (a)'s and before REV-20 (b)'s flag test", () => {
    const fragments = [
      "  IF v_actor IS NULL THEN\n    RETURN NEW;\n  END IF;",
      "       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)\n    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded')",
      "    OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status)",
      "    OR (NEW.status = 'Archived' AND COALESCE(OLD.status, '') <> 'Archived');",
      "  v_issuing := NEW.current_version_id IS NOT NULL\n               AND NOT is_controlled_issue_status(OLD.status)\n               AND is_controlled_issue_status(NEW.status);",
      "  v_new_door := v_issuing\n                AND (NOT COALESCE(v_advancing, false)\n                     OR COALESCE(NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                                 AND OLD.retired_issue_status = 'not-issued'\n                                 AND OLD.retired_issue_version_id IS NULL, false));",
      "  v_new_door := v_new_door\n                OR COALESCE(v_issuing\n                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                            AND OLD.status IN ('Archived', 'Void')\n                            AND OLD.retired_issue_status IS NULL\n                            AND is_org_controller(NEW.org_id), false);",
      "  v_new_door := v_new_door\n                OR COALESCE(v_issuing\n                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                            AND OLD.status = 'Superseded'\n                            AND OLD.retired_issue_status IS NULL\n                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                            AND is_org_controller(NEW.org_id), false);",
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
    expect(LIMBS).toEqual({ a: ["Archived", "Void"], p18: "Superseded" });
  });

  it("the restore: every branch the RPC transcription mirrors is in restore_reversed_source, in this order", () => {
    const fragments = [
      "LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$",
      "  v_uid     uuid := auth.uid();",
      "  IF v_uid IS NULL THEN\n    RAISE EXCEPTION",
      `'${S_NO_SESSION.replace("'", "''")}'`,
      "      USING ERRCODE = 'insufficient_privilege';",
      "  IF btrim(COALESCE(p_status, '')) = '' THEN",
      "  SELECT true, d.org_id, d.status, d.retired_issue_status, d.current_version_id, d.rev\n    INTO v_found, v_org, v_status, v_stamp, v_version, v_rev\n    FROM documents d WHERE d.id = p_document_id;\n  IF v_found IS NULL THEN\n    RETURN 'no_match';\n  END IF;",
      "  SELECT a.action INTO v_action\n    FROM audit_logs a\n   WHERE a.id = p_reversal_of\n     AND a.org_id = v_org\n     AND a.action IN ('DOC_SPLIT', 'DOC_MERGED')\n     AND (a.resource_id = p_document_id::text\n          OR COALESCE(jsonb_typeof(a.details->'mergeSiblings') = 'array'\n                      AND (a.details->'mergeSiblings') ? p_document_id::text, false))\n     AND NOT EXISTS (SELECT 1 FROM audit_logs r\n                      WHERE r.org_id = v_org\n                        AND r.resource_id = a.resource_id\n                        AND r.action IN ('DOC_SPLIT_REVERSED', 'DOC_MERGE_REVERSED')\n                        AND translate(lower(r.details->>'reversedAuditEventId'), '{}-', '') = replace(p_reversal_of::text, '-', ''))\n   LIMIT 1;",
      "  IF v_status = 'Superseded'\n     AND v_action IS NOT NULL\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n    v_forced := true;\n  END IF;",
      "  IF v_forced THEN\n    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);\n  END IF;\n  UPDATE documents\n     SET status = p_status,\n         superseded_at = NULL,\n         superseded_by_user = NULL,\n         supersession_reason = NULL,\n         supersession_moc = NULL,\n         updated_at = now(),\n         updated_by = v_uid\n   WHERE id = p_document_id;\n  GET DIAGNOSTICS v_n = ROW_COUNT;\n  IF v_forced THEN\n    PERFORM set_config('app.publish_hold_override', '', true);\n  END IF;\n  IF v_n = 0 THEN\n    RETURN 'no_match';\n  END IF;",
      "  IF v_forced THEN\n    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)\n    VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,",
      "              'via', 'reversal_restore',",
      "              'reason', NULLIF(btrim(COALESCE(p_reason, '')), ''),",
      "              'reversedAuditEventId', p_reversal_of,",
      "              'newStatus', p_status,",
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

/** restore_reversed_source (20261164), transcribed: its reads, its door, its
 *  write (through the in-memory PostgREST, so the transcribed guard fires on
 *  it) and its record. A RAISE (the guard's, the no-session one) rolls the
 *  call back whole, the flag with it. */
async function restoreReversedSource(a: Record<string, unknown>): Promise<RpcAnswer> {
  const uid = state.session;
  if (uid === null) return { data: null, error: { code: "42501", message: S_NO_SESSION } };
  if (!String(a.p_status ?? "").trim()) return { data: null, error: { code: "23514", message: "restore_reversed_source: name the status to restore the document to." } };
  const doc = T("documents").find((d) => d.id === a.p_document_id && d.org_id === ORG);
  if (!doc) return { data: "no_match", error: null };
  const ev = T("audit_logs").find((r) => r.id === a.p_reversal_of && r.org_id === doc.org_id
    && (r.action === "DOC_SPLIT" || r.action === "DOC_MERGED")
    && (r.resource_id === doc.id
      || (Array.isArray((r.details as Row | null)?.mergeSiblings) && ((r.details as Row).mergeSiblings as unknown[]).includes(doc.id)))
    // review fix: an event a recorded reversal (on the event's resource, naming it) already undid opens nothing —
    // integrator fix: named in any spelling the uuid type accepts (translate(lower(…), '{}-', '') = replace(p::text, '-', ''))
    && !T("audit_logs").some((x) => x.org_id === doc.org_id && x.resource_id === r.resource_id
      && (x.action === "DOC_SPLIT_REVERSED" || x.action === "DOC_MERGE_REVERSED")
      && sqlTranslateLower((x.details as Row | null)?.reversedAuditEventId) === String(a.p_reversal_of).replace(/-/g, "")));
  const before = { status: doc.status, stamp: doc.retired_issue_status ?? null, version: doc.current_version_id, rev: doc.rev };
  const forced = doc.status === "Superseded" && !!ev && isController() && activeHolds(String(doc.id)).length > 0;
  if (forced) state.flag = String(doc.id);
  type Docs = { update: (p: Row) => { eq: (k: string, v: unknown) => { select: (c: string) => Promise<{ data: unknown; error: unknown }> } } };
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
      details: {
        via: "reversal_restore",
        holds: activeHolds(String(doc.id)).map((h) => ({ id: h.id, reason: h.reason })),
        reason: String(a.p_reason ?? "").trim() || null,
        reversedAuditEventId: a.p_reversal_of, reversedAction: ev!.action,
        retirementStamped: before.stamp !== null, versionId: before.version, revisionLabel: before.rev,
        priorStatus: before.status, newStatus: a.p_status, branch: false,
      },
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
/** A split of `prefix` into `${prefix}a` / `${prefix}b`. `stamp`: none (a
 *  split recorded BEFORE 20261144 — no backfill) or the issue it took away.
 *  `prior`: the recorded prior status, or none (a legacy event — the dialog
 *  names one, REV-16). */
function seedSplit(prefix: string, stamp: "none" | "issued", prior: string | null = "Issued") {
  seedDoc(prefix, {
    status: "Superseded", uniqueness_key: `${prefix}-key`, superseded_at: "2025-09-01T10:00:00Z", supersession_reason: "split",
    ...(stamp === "issued" ? { retired_issue_status: "Issued", retired_issue_version_id: `${prefix}-v3` } : {}),
  });
  for (const x of ["a", "b"]) seedDoc(`${prefix}${x}`, { uniqueness_key: `${prefix}${x}-key` });
  T("document_supersessions").push(
    { id: `l-${prefix}a`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}a`, reason: "split", created_by: ME, created_at: "2025-09-01T10:00:00Z" },
    { id: `l-${prefix}b`, org_id: ORG, superseded_doc_id: prefix, replacement_doc_id: `${prefix}b`, reason: "split", created_by: ME, created_at: "2025-09-01T10:00:00Z" },
  );
  T("audit_logs").push({ id: `ev-${prefix}`, org_id: ORG, action: "DOC_SPLIT", resource_id: prefix, timestamp: "2025-09-01T10:00:00Z", details: { replacementDocIds: [`${prefix}a`, `${prefix}b`], ...(prior ? { priorStatus: prior } : {}), auditAt: "2025-09-01T10:00:00Z" } });
}
function seedMerge(prefix: string) {
  for (const s of ["1", "2"]) seedDoc(`${prefix}${s}`, { status: "Superseded", uniqueness_key: `${prefix}${s}-key` });
  seedDoc(`${prefix}t`, { uniqueness_key: `${prefix}t-key` });
  T("document_supersessions").push(
    { id: `l-${prefix}1`, org_id: ORG, superseded_doc_id: `${prefix}1`, replacement_doc_id: `${prefix}t`, created_by: ME },
    { id: `l-${prefix}2`, org_id: ORG, superseded_doc_id: `${prefix}2`, replacement_doc_id: `${prefix}t`, created_by: ME },
  );
  T("audit_logs").push({ id: `ev-${prefix}`, org_id: ORG, action: "DOC_MERGED", resource_id: `${prefix}1`, timestamp: "2025-09-03T00:00:00Z", details: { mergedIntoDocumentId: `${prefix}t`, mergeSiblings: [`${prefix}1`, `${prefix}2`], targetWasNewlyCreated: true, priorStatuses: { [`${prefix}1`]: "Issued", [`${prefix}2`]: "Issued" }, auditAt: "2025-09-03T00:00:00Z" } });
}

/** Bind the transcribed guard as the documents BEFORE UPDATE trigger, as the
 *  signed-in actor (the flag read at the moment each write fires). */
function bindGuard(extra: Partial<GuardCtx> = {}) {
  const refusals: string[] = [];
  state.db.beforeUpdate!.documents = (next, old) => {
    try {
      return publishGuard(next, old, {
        actor: state.session,
        controller: isController(),
        publisher: false,
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

beforeEach(() => {
  vi.clearAllMocks();
  state.db = newFakeDb();
  state.db.unique.document_supersessions = [["superseded_doc_id", "replacement_doc_id"]];
  state.roles = ["DocCtrl"];
  state.flag = null;
  state.session = ME;
  state.rpcMode = "real";
  state.rpcCalls = [];
  state.restore = restoreReversedSource;
  state.auditLookupError = null;
});

// ─── REGRESSION FIRST: every reversal still lands, now recorded ──────────
describe("REV-22 (P18) — the legacy reversal over a carried hold still restores, through the recorded door", () => {
  it("reverseSplit of a split recorded before 20261144: the unstamped source comes back Issued carrying the sheet's hold; exactly one REV_HOLD_OVERRIDDEN, on the source, naming the hold, the split and the reason; nothing refused; the flag cleared", async () => {
    seedSplit("p101", "none");
    seedHold("p101a");
    const refusals = bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p101", reason: "  wrong split  ", orgId: ORG, actorUserId: ME, force: true });
    expect(refusals).toEqual([]);
    expect(docRow("p101")).toMatchObject({ status: "Issued", superseded_at: null, supersession_reason: null, retired_issue_status: null });
    expect(activeHolds("p101").map((h) => h.reason)).toEqual(["Stop work"]);
    for (const s of ["p101a", "p101b"]) expect(docRow(s).status).toBe("Superseded");
    expect(overrides()).toHaveLength(1);
    expect(overrides("p101")[0].details).toMatchObject({
      via: "reversal_restore", reason: "wrong split", reversedAuditEventId: "ev-p101", reversedAction: "DOC_SPLIT",
      priorStatus: "Superseded", newStatus: "Issued", retirementStamped: false, holds: [{ reason: "Stop work" }],
    });
    expect(state.flag).toBe("");
    expect(audit("DOC_SPLIT_REVERSED")[0].details).toMatchObject({ proceededOverHolds: { p101a: ["Stop work"] }, holdsCarriedBack: 1, restoredStatus: "Issued" });
  });

  it("the restore is called with the document, the status, the reversed event and the reason — no pointer", async () => {
    seedSplit("p102", "none");
    seedHold("p102b");
    bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p102", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    const calls = state.rpcCalls.filter((c) => c.fn === "restore_reversed_source");
    expect(calls).toEqual([{ fn: "restore_reversed_source", args: { p_document_id: "p102", p_status: "Issued", p_reversal_of: "ev-p102", p_reason: "r" } }]);
  });

  it("reverseMerge: both unstamped sources come back Issued, each carrying the parked target's hold — one record each", async () => {
    state.roles = ["Admin"];
    seedMerge("m");
    seedHold("mt", "Client Review");
    const refusals = bindGuard();
    await reverseMerge({ mergeAuditEventId: "ev-m", reason: "wrong merge", orgId: ORG, actorUserId: ME, force: true });
    expect(refusals).toEqual([]);
    for (const s of ["m1", "m2"]) {
      expect(docRow(s).status).toBe("Issued");
      expect(activeHolds(s).map((h) => h.reason)).toEqual(["Client Review"]);
      expect(overrides(s)).toHaveLength(1);
      expect(overrides(s)[0].details).toMatchObject({ reversedAuditEventId: "ev-m", reversedAction: "DOC_MERGED" });
    }
    expect(overrides()).toHaveLength(2);
    expect(docRow("mt").status).toBe("Superseded");
  });

  it("a split recorded AFTER 20261144 (the source stamped) reverses over a carried hold as before — and that pass is recorded too", async () => {
    seedSplit("p103", "issued");
    seedHold("p103b");
    const refusals = bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p103", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    expect(refusals).toEqual([]);
    expect(docRow("p103").status).toBe("Issued");
    expect(overrides("p103")).toHaveLength(1);
    expect(overrides("p103")[0].details).toMatchObject({ retirementStamped: true });
  });

  it("a reversal with no hold anywhere restores and records nothing", async () => {
    seedSplit("p104", "none");
    const refusals = bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p104", reason: "r", orgId: ORG, actorUserId: ME });
    expect(refusals).toEqual([]);
    expect(docRow("p104").status).toBe("Issued");
    expect(overrides()).toEqual([]);
  });

  it("a legacy split (no prior status recorded) restored to the status Document Control names, over a carried hold", async () => {
    seedSplit("p105", "none", null);
    seedHold("p105a");
    const refusals = bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p105", reason: "legacy", orgId: ORG, actorUserId: ME, force: true, legacyRestoreStatus: "Draft" });
    expect(refusals).toEqual([]);
    expect(docRow("p105").status).toBe("Draft");
    expect(overrides("p105")[0].details).toMatchObject({ newStatus: "Draft" });
  });
});

// ─── the database without the function: the direct write, as before ─────
describe("REV-22 (P18) — restore_reversed_source absent (PGRST202 / 42883): the restore is the direct write it always was", () => {
  it("with no hold the direct write restores, even against this guard", async () => {
    state.rpcMode = "absent";
    seedSplit("p201", "none");
    const refusals = bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p201", reason: "r", orgId: ORG, actorUserId: ME });
    expect(refusals).toEqual([]);
    expect(docRow("p201").status).toBe("Issued");
    expect(overrides()).toEqual([]);
  });

  it("42883 (undefined_function) falls back the same way", async () => {
    state.rpcMode = "canned";
    state.canned = { data: null, error: { code: "42883", message: "function restore_reversed_source(uuid, text, uuid, text) does not exist" } };
    seedSplit("p202", "none");
    bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p202", reason: "r", orgId: ORG, actorUserId: ME });
    expect(docRow("p202").status).toBe("Issued");
  });

  it("the deploy order, stated: with 20261164's guard but no function (an app before P18, or the schema cache still reloading) the bare put-back over a carried hold is refused and the reversal rolls back whole — sheets, source, carried hold", async () => {
    state.rpcMode = "absent";
    seedSplit("p203", "none");
    seedHold("p203a");
    const refusals = bindGuard();
    await expect(reverseSplit({ splitAuditEventId: "ev-p203", reason: "r", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/p203 could not be restored to Issued \(Document has an active hold; release the hold before issuing it\.\)[\s\S]*rolled back/);
    expect(refusals).toEqual([S_NEW_DOOR_HOLD]);
    expect(docRow("p203").status).toBe("Superseded");
    for (const s of ["p203a", "p203b"]) expect(docRow(s).status).toBe("Issued");
    expect(activeHolds("p203")).toEqual([]);
    expect(T("document_supersessions").filter((l) => l.superseded_doc_id === "p203")).toHaveLength(2);
  });
});

// ─── the finding: the BARE un-supersede of a held unstamped document ─────
describe("REV-22 (P18) — a controller's BARE un-supersede of a held, unstamped Superseded document is the new door", () => {
  const ctl: GuardCtx = { actor: ME, controller: true, publisher: false, held: () => true };
  const owner: GuardCtx = { actor: "owner", controller: false, publisher: true, held: () => true };
  const sup = (extra: Row = {}): Row => ({ id: "d1", status: "Superseded", current_version_id: "v3", retired_issue_status: null, retired_issue_version_id: null, ...extra });

  it("refused over an active hold for a controller, in the new-door sentence the editors recognise; admitted under the restore's flag naming it; refused under a flag naming another", () => {
    expect(refused(() => publishGuard({ ...sup(), status: "Issued" }, sup(), ctl))).toBe(S_NEW_DOOR_HOLD);
    for (const s of ["IFC", "Locked", "For Construction"]) expect(refused(() => publishGuard({ ...sup(), status: s }, sup(), ctl)), s).toBe(S_NEW_DOOR_HOLD);
    expect(publishGuard({ ...sup(), status: "Issued" }, sup(), { ...ctl, flag: "d1" }).status).toBe("Issued");
    expect(refused(() => publishGuard({ ...sup(), status: "Issued" }, sup(), { ...ctl, flag: "d2" }))).toBe(S_NEW_DOOR_HOLD);
    expect(refused(() => publishGuard({ ...sup(), status: "Issued" }, sup(), { ...ctl, flag: "" }))).toBe(S_NEW_DOOR_HOLD);
    expect(isIssueRefusal(S_NEW_DOOR_HOLD)).toBe(true);
    expect(S_NEW_DOOR_HOLD).toContain(ISSUE_REFUSAL.newDoorHold);
  });

  it("regression: no hold — admitted; a Draft (or Void) restore — admitted; a stamped put-back (v_restoring) — admitted as before; the service role — untouched", () => {
    expect(publishGuard({ ...sup(), status: "Issued" }, sup(), { ...ctl, held: () => false }).status).toBe("Issued");
    expect(publishGuard({ ...sup(), status: "Draft" }, sup(), ctl).status).toBe("Draft");
    expect(publishGuard({ ...sup(), status: "Void" }, sup(), ctl).status).toBe("Void");
    const stamped = sup({ retired_issue_status: "Issued", retired_issue_version_id: "v3" });
    expect(publishGuard({ ...stamped, status: "Issued" }, stamped, ctl).status).toBe("Issued");
    const notIssued = sup({ retired_issue_status: "not-issued" });
    expect(refused(() => publishGuard({ ...notIssued, status: "Issued" }, notIssued, ctl))).toBe(S_NEW_DOOR_HOLD); // 20261144's own new door, unchanged
    expect(publishGuard({ ...sup(), status: "Issued" }, sup(), { ...ctl, actor: null }).status).toBe("Issued");
  });

  it("below a controller nothing changed: the owner is refused in the publisher tier's words, flag or no flag", () => {
    expect(refused(() => publishGuard({ ...sup(), status: "Issued" }, sup(), owner))).toBe(S_PUBLISHER_HOLD);
    expect(refused(() => publishGuard({ ...sup(), status: "Issued" }, sup(), { ...owner, flag: "d1" }))).toBe(S_PUBLISHER_HOLD);
    expect(publishGuard({ ...sup(), status: "Issued" }, sup(), { ...owner, held: () => false }).status).toBe("Issued");
  });

  it("20261159's and 20261151's rules on the re-created guard are unchanged (held pointer move, pointer-and-issue, unstamped Archived / Void exit)", () => {
    const doc = (status: string, extra: Row = {}): Row => ({ id: "d1", status, current_version_id: "v3", retired_issue_status: null, retired_issue_version_id: null, ...extra });
    expect(refused(() => publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), ctl))).toBe(S_UNFORCED_HOLD);
    expect(publishGuard({ ...doc("Issued"), current_version_id: "v4" }, doc("Issued"), { ...ctl, flag: "d1" }).current_version_id).toBe("v4");
    expect(refused(() => publishGuard({ ...doc("Draft"), status: "Issued", current_version_id: "v4" }, doc("Draft"), ctl))).toBe(S_UNFORCED_HOLD);
    for (const s of ["Archived", "Void"]) expect(refused(() => publishGuard({ ...doc(s), status: "Issued" }, doc(s), ctl)), s).toBe(S_NEW_DOOR_HOLD);
    expect(publishGuard({ ...doc("Archived"), status: "Draft" }, doc("Archived"), ctl).status).toBe("Draft");
    expect(refused(() => publishGuard({ ...doc("Draft"), status: "Issued" }, doc("Draft"), ctl))).toBe(S_NEW_DOOR_HOLD);
    expect(publishGuard({ ...doc("Issued"), status: "Archived" }, doc("Issued"), ctl).status).toBe("Archived");
    expect(publishGuard({ ...doc("Issued"), status: "Superseded", current_version_id: "v4" }, doc("Issued"), ctl).status).toBe("Superseded");
  });

  it("through the in-memory PostgREST: a controller's direct PATCH of held unstamped S1 back to Issued is refused and nothing is written", async () => {
    seedDoc("s1", { status: "Superseded" });
    seedHold("s1");
    const refusals = bindGuard();
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase.from("documents").update({ status: "Issued", superseded_at: null }).eq("id", "s1").select("id");
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: S_NEW_DOOR_HOLD });
    expect(refusals).toEqual([S_NEW_DOOR_HOLD]);
    expect(docRow("s1").status).toBe("Superseded");
  });
});

// ─── the restore's own edges ─────────────────────────────────────────────
describe("REV-22 (P18) — restore_reversed_source sets the flag only for its door", () => {
  it("anyone below a controller gets the bare write: refused over a hold in the publisher tier's words, nothing recorded", async () => {
    state.roles = ["Engineer"];
    seedDoc("s2", { status: "Superseded" });
    seedHold("s2");
    T("audit_logs").push({ id: "ev-s2", org_id: ORG, action: "DOC_SPLIT", resource_id: "s2", details: {} });
    bindGuard({ publisher: true });
    const r = await restoreReversedSource({ p_document_id: "s2", p_status: "Issued", p_reversal_of: "ev-s2", p_reason: "r" });
    expect(r.error?.message).toBe(S_PUBLISHER_HOLD);
    expect(docRow("s2").status).toBe("Superseded");
    expect(overrides()).toEqual([]);
  });

  it("an event that is not this document's split / merge (another document's split, a REV_UP, none) opens no door: refused, nothing recorded", async () => {
    seedDoc("s3", { status: "Superseded" });
    seedHold("s3");
    T("audit_logs").push(
      { id: "ev-other", org_id: ORG, action: "DOC_SPLIT", resource_id: "elsewhere", details: { mergeSiblings: "s3" } },
      { id: "ev-revup", org_id: ORG, action: "REV_UP", resource_id: "s3", details: {} },
      { id: "ev-foreign", org_id: "o2", action: "DOC_SPLIT", resource_id: "s3", details: {} },
    );
    bindGuard();
    for (const ev of ["ev-other", "ev-revup", "ev-foreign", null]) {
      const r = await restoreReversedSource({ p_document_id: "s3", p_status: "Issued", p_reversal_of: ev, p_reason: "r" });
      expect(r.error?.message, String(ev)).toBe(S_NEW_DOOR_HOLD);
    }
    expect(docRow("s3").status).toBe("Superseded");
    expect(overrides()).toEqual([]);
  });

  it("no session: refused before anything is read; an unknown document: no_match", async () => {
    state.session = null;
    expect((await restoreReversedSource({ p_document_id: "x", p_status: "Issued", p_reversal_of: null })).error).toMatchObject({ code: "42501", message: S_NO_SESSION });
    state.session = ME;
    expect((await restoreReversedSource({ p_document_id: "x", p_status: "Issued", p_reversal_of: null })).data).toBe("no_match");
  });

  it("review fix — an event a recorded reversal already undid opens no door: P-150's split reversed, P-150 superseded again by the service role (unstamped) and held; naming that split from the console is refused, nothing recorded", async () => {
    seedSplit("p150", "none");
    bindGuard();
    await reverseSplit({ splitAuditEventId: "ev-p150", reason: "wrong split", orgId: ORG, actorUserId: ME });
    expect(docRow("p150").status).toBe("Issued");
    expect(audit("DOC_SPLIT_REVERSED")).toHaveLength(1);
    expect(audit("DOC_SPLIT_REVERSED")[0]).toMatchObject({ resource_id: "p150", details: expect.objectContaining({ reversedAuditEventId: "ev-p150" }) });
    // later superseded again by the service role: no retirement stamp
    const { supabase } = await import("@/lib/supabase");
    state.session = null;
    await supabase.from("documents").update({ status: "Superseded", superseded_at: "2026-09-20T00:00:00Z" }).eq("id", "p150").select("id");
    state.session = ME;
    expect(docRow("p150")).toMatchObject({ status: "Superseded", retired_issue_status: null });
    seedHold("p150");
    const r = await restoreReversedSource({ p_document_id: "p150", p_status: "Issued", p_reversal_of: "ev-p150", p_reason: "console" });
    expect(r.error?.message).toBe(S_NEW_DOOR_HOLD);
    expect(docRow("p150").status).toBe("Superseded");
    expect(overrides()).toEqual([]);
    expect(state.flag).toBeNull();
  });

  it("review fix — the binding is to THAT event: a reversal of another split of the same document, or another org's reversal row, does not close this event's door", async () => {
    seedDoc("s5", { status: "Superseded" });
    seedHold("s5");
    T("audit_logs").push(
      { id: "ev-s5a", org_id: ORG, action: "DOC_SPLIT", resource_id: "s5", details: {} },
      { id: "ev-s5b", org_id: ORG, action: "DOC_SPLIT", resource_id: "s5", details: {} },
      { id: "rev-s5a", org_id: ORG, action: "DOC_SPLIT_REVERSED", resource_id: "s5", details: { reversedAuditEventId: "ev-s5a" } },
      { id: "rev-s5b-foreign", org_id: "o2", action: "DOC_SPLIT_REVERSED", resource_id: "s5", details: { reversedAuditEventId: "ev-s5b" } },
    );
    bindGuard();
    expect((await restoreReversedSource({ p_document_id: "s5", p_status: "Issued", p_reversal_of: "ev-s5a", p_reason: "r" })).error?.message).toBe(S_NEW_DOOR_HOLD);
    expect(overrides()).toEqual([]);
    expect(await restoreReversedSource({ p_document_id: "s5", p_status: "Issued", p_reversal_of: "ev-s5b", p_reason: "r" })).toEqual({ data: "restored_over_hold", error: null });
    expect(overrides("s5")).toHaveLength(1);
    expect(overrides("s5")[0].details).toMatchObject({ reversedAuditEventId: "ev-s5b" });
  });

  it("integrator fix — a reversal recorded with the caller's own spelling of the event's id (upper case, braces) is seen by the door: that event opens nothing", async () => {
    for (const [id, spelled] of [["s8", "EV-S8"], ["s9", "{EV-S9}"]]) {
      seedDoc(id, { status: "Superseded" });
      seedHold(id);
      T("audit_logs").push(
        { id: `ev-${id}`, org_id: ORG, action: "DOC_SPLIT", resource_id: id, details: {} },
        { id: `rev-${id}`, org_id: ORG, action: "DOC_SPLIT_REVERSED", resource_id: id, details: { reversedAuditEventId: spelled } },
      );
    }
    bindGuard();
    for (const id of ["s8", "s9"]) {
      expect((await restoreReversedSource({ p_document_id: id, p_status: "Issued", p_reversal_of: `ev-${id}`, p_reason: "r" })).error?.message, id).toBe(S_NEW_DOOR_HOLD);
      expect(docRow(id).status).toBe("Superseded");
    }
    expect(overrides()).toEqual([]);
  });

  it("the answer says whether the pass was recorded: restored_over_hold for the recorded door, restored for the bare write", async () => {
    seedDoc("s6", { status: "Superseded" });
    seedDoc("s7", { status: "Superseded" });
    seedHold("s6");
    T("audit_logs").push(
      { id: "ev-s6", org_id: ORG, action: "DOC_SPLIT", resource_id: "s6", details: {} },
      { id: "ev-s7", org_id: ORG, action: "DOC_SPLIT", resource_id: "s7", details: {} },
    );
    bindGuard();
    expect((await restoreReversedSource({ p_document_id: "s6", p_status: "Issued", p_reversal_of: "ev-s6" })).data).toBe("restored_over_hold");
    expect((await restoreReversedSource({ p_document_id: "s7", p_status: "Issued", p_reversal_of: "ev-s7" })).data).toBe("restored");
    expect(overrides().map((o) => o.resource_id)).toEqual(["s6"]);
  });
});

// ─── integrator fix: the reversal's record names the event by the database's id ─
describe("REV-22 (P18, integrator fix) — the reversal's own record names the event by the id the database holds (ev.id), not the caller's spelling", () => {
  it("reverseSplit called with a braced, upper-case id: DOC_SPLIT_REVERSED and the restore carry ev.id — so the door sees the event as reversed when P-160 is superseded again and held", async () => {
    seedSplit("p160", "none");
    seedHold("p160a");
    bindGuard();
    await reverseSplit({ splitAuditEventId: "{EV-P160}", reason: "r", orgId: ORG, actorUserId: ME, force: true });
    expect(docRow("p160").status).toBe("Issued");
    expect(state.rpcCalls.find((c) => c.fn === "restore_reversed_source")?.args.p_reversal_of).toBe("ev-p160");
    expect(overrides("p160")[0].details).toMatchObject({ reversedAuditEventId: "ev-p160" });
    expect(audit("DOC_SPLIT_REVERSED")).toHaveLength(1);
    expect((audit("DOC_SPLIT_REVERSED")[0].details as Row).reversedAuditEventId).toBe("ev-p160");
    const { supabase } = await import("@/lib/supabase");
    state.session = null;
    await supabase.from("documents").update({ status: "Superseded" }).eq("id", "p160").select("id");
    state.session = ME;
    expect((await restoreReversedSource({ p_document_id: "p160", p_status: "Issued", p_reversal_of: "ev-p160", p_reason: "again" })).error?.message).toBe(S_NEW_DOOR_HOLD);
    expect(overrides("p160")).toHaveLength(1);
  });

  it("reverseMerge called with an upper-case id: DOC_MERGE_REVERSED carries ev.id", async () => {
    seedMerge("q");
    bindGuard();
    await reverseMerge({ mergeAuditEventId: "EV-Q", reason: "r", orgId: ORG, actorUserId: ME });
    expect(audit("DOC_MERGE_REVERSED")).toHaveLength(1);
    expect((audit("DOC_MERGE_REVERSED")[0].details as Row).reversedAuditEventId).toBe("ev-q");
    expect(state.rpcCalls.filter((c) => c.fn === "restore_reversed_source").map((c) => c.args.p_reversal_of)).toEqual(["ev-q", "ev-q"]);
  });
});

// ─── review fix: a recorded pass the saga rolls back is corrected ────────
describe("REV-22 (P18, review fix) — a recorded restore that the reversal's saga then rolls back is corrected on the record (REV_HOLD_OVERRIDE_UNDONE)", () => {
  const undone = (id?: string) => audit("REV_HOLD_OVERRIDE_UNDONE").filter((r) => !id || r.resource_id === id);
  const LINEAGE_REFUSED = { code: "42501", message: "only Document Control may delete supersession rows" };

  it("the lineage delete is refused after the recorded restore: the source is put back Superseded, the carried hold released, the override stays and the correction is written after it — naming the event, the statuses and why the saga rolled back", async () => {
    seedSplit("p401", "none");
    seedHold("p401a");
    bindGuard();
    state.db.deleteErrors!.document_supersessions = LINEAGE_REFUSED;
    await expect(reverseSplit({ splitAuditEventId: "ev-p401", reason: "wrong split", orgId: ORG, actorUserId: ME, actorEmail: "dc@example.com", actorRole: "DocCtrl", force: true }))
      .rejects.toThrow(/supersession link\(s\) could not be removed[\s\S]*rolled back — no partial changes were kept/);
    expect(docRow("p401").status).toBe("Superseded");
    expect(activeHolds("p401")).toEqual([]);
    for (const s of ["p401a", "p401b"]) expect(docRow(s).status).toBe("Issued");
    expect(overrides("p401")).toHaveLength(1);
    expect(undone()).toHaveLength(1);
    expect(undone("p401")[0]).toMatchObject({ resource_type: "document", org_id: ORG, user_id: ME, user_email: "dc@example.com", user_role: "DocCtrl" });
    expect(undone("p401")[0].details).toMatchObject({
      via: "reversal_restore", corrects: "REV_HOLD_OVERRIDDEN", reversedAuditEventId: "ev-p401", restoredStatus: "Issued", putBackTo: "Superseded",
    });
    expect(String((undone("p401")[0].details as Row).rollbackReason)).toMatch(/^Reversal stopped: 2 supersession link\(s\) could not be removed \(only Document Control may delete supersession rows\)/);
    expect(T("audit_logs").indexOf(undone("p401")[0])).toBeGreaterThan(T("audit_logs").indexOf(overrides("p401")[0]));
    expect(audit("DOC_SPLIT_REVERSED")).toEqual([]);
  });

  it("the reviewer's merge: M1's restore lands and is recorded, M2's is refused — M1 is re-superseded and corrected, M2 (never recorded) is not", async () => {
    state.roles = ["Admin"];
    seedMerge("n");
    seedHold("nt", "Client Review");
    bindGuard();
    state.restore = async (args) => (args.p_document_id === "n2"
      ? { data: null, error: { code: "23514", message: "refused for n2" } }
      : restoreReversedSource(args));
    await expect(reverseMerge({ mergeAuditEventId: "ev-n", reason: "wrong merge", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/n2 could not be restored to Issued \(refused for n2\)[\s\S]*rolled back/);
    for (const s of ["n1", "n2"]) {
      expect(docRow(s).status).toBe("Superseded");
      expect(activeHolds(s)).toEqual([]);
    }
    expect(docRow("nt").status).toBe("Issued");
    expect(overrides().map((o) => o.resource_id)).toEqual(["n1"]);
    expect(undone().map((o) => o.resource_id)).toEqual(["n1"]);
    expect(undone("n1")[0].details).toMatchObject({ reversedAuditEventId: "ev-n", putBackTo: "Superseded", restoredStatus: "Issued" });
    expect(String((undone("n1")[0].details as Row).rollbackReason)).toMatch(/n2 could not be restored to Issued \(refused for n2\)/);
    expect(audit("DOC_MERGE_REVERSED")).toEqual([]);
  });

  it("nothing to correct when the restore was not recorded (no hold): the saga rolls back with no override and no correction", async () => {
    seedSplit("p402", "none");
    bindGuard();
    state.db.deleteErrors!.document_supersessions = LINEAGE_REFUSED;
    await expect(reverseSplit({ splitAuditEventId: "ev-p402", reason: "r", orgId: ORG, actorUserId: ME })).rejects.toThrow(/rolled back/);
    expect(docRow("p402").status).toBe("Superseded");
    expect(overrides()).toEqual([]);
    expect(undone()).toEqual([]);
  });

  it("the put-back itself is refused: the pass over the hold stood, so its record is true and nothing is corrected — the failed put-back is named for manual attention", async () => {
    seedSplit("p403", "none");
    seedHold("p403a");
    bindGuard();
    state.db.deleteErrors!.document_supersessions = LINEAGE_REFUSED;
    const guard = state.db.beforeUpdate!.documents;
    state.db.beforeUpdate!.documents = (next, old, table) => {
      if (old.id === "p403" && old.status === "Issued" && next.status === "Superseded") throw { code: "42501", message: "put-back refused" };
      return guard(next, old, table);
    };
    await expect(reverseSplit({ splitAuditEventId: "ev-p403", reason: "r", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/some cleanup steps failed[\s\S]*put p403 back to Superseded: p403 could not be put back to Superseded \(put-back refused\)/);
    expect(docRow("p403").status).toBe("Issued");
    expect(overrides("p403")).toHaveLength(1);
    expect(undone()).toEqual([]);
  });

  it("a correction that cannot be written is named for manual attention, never swallowed", async () => {
    seedSplit("p404", "none");
    seedHold("p404b");
    bindGuard();
    state.db.deleteErrors!.document_supersessions = LINEAGE_REFUSED;
    state.db.beforeInsert!.audit_logs = (row) => {
      if (row.action === "REV_HOLD_OVERRIDE_UNDONE") throw { code: "42501", message: "audit insert refused" };
      return row;
    };
    await expect(reverseSplit({ splitAuditEventId: "ev-p404", reason: "r", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/correct the hold-override record on p404: the record of the reversal's pass over p404's hold \(REV_HOLD_OVERRIDDEN\) could not be corrected \(audit insert refused\)/);
    expect(docRow("p404").status).toBe("Superseded");
    expect(overrides("p404")).toHaveLength(1);
    expect(undone()).toEqual([]);
  });

  it("the source of restoreStatus: the correction is registered BEFORE the put-back (so the LIFO rollback runs it after), and recorded only by restored_over_hold (an unknown answer arms its look-up — integrator fix, below)", () => {
    const reverse = readFileSync(join(process.cwd(), "lib/documentLifecycle/reverse.ts"), "utf8");
    const restore = reverse.slice(reverse.indexOf("async function restoreStatus("), reverse.indexOf("/** Delete this operation's supersession rows"));
    const corr = restore.indexOf("register({ describe: `correct the hold-override record on ${docId}`, run: correctRecordedPass(docId, snap, status, door, pass) });");
    const putBack = restore.indexOf("register({ describe: `put ${docId} back to ${snap.status}`, run: putBackIfChanged(docId, snap, actorUserId, outcome) });");
    expect(corr).toBeGreaterThan(0);
    expect(putBack).toBeGreaterThan(corr);
    expect(restore.indexOf('supabase.rpc("restore_reversed_source"')).toBeGreaterThan(putBack);
    expect(restore.match(/pass\.recorded = /g)).toHaveLength(1);
  });
});

// ─── integrator fix: a recorded restore whose answer was lost is corrected too ─
describe("REV-22 (P18, integrator fix) — a restore whose answer is lost (an error other than the function being absent) is checked against the record, and a pass it committed is corrected", () => {
  const undone = (id?: string) => audit("REV_HOLD_OVERRIDE_UNDONE").filter((r) => !id || r.resource_id === id);
  const LOST = { message: "TypeError: Failed to fetch" };

  it("the restore committed (recorded over the hold) and its answer was lost: the source is put back, the carried hold released, and the correction is written for that REV_HOLD_OVERRIDDEN row", async () => {
    seedSplit("p170", "none");
    seedHold("p170a");
    bindGuard();
    state.restore = async (args) => {
      expect(await restoreReversedSource(args)).toEqual({ data: "restored_over_hold", error: null });
      return { data: null, error: LOST };
    };
    await expect(reverseSplit({ splitAuditEventId: "ev-p170", reason: "wrong split", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/p170 could not be restored to Issued \(TypeError: Failed to fetch\)[\s\S]*rolled back — no partial changes were kept/);
    expect(docRow("p170").status).toBe("Superseded");
    expect(activeHolds("p170")).toEqual([]);
    for (const s of ["p170a", "p170b"]) expect(docRow(s).status).toBe("Issued");
    expect(overrides("p170")).toHaveLength(1);
    expect(undone()).toHaveLength(1);
    expect(undone("p170")[0]).toMatchObject({ org_id: ORG, user_id: ME });
    expect(undone("p170")[0].details).toMatchObject({
      via: "reversal_restore", corrects: "REV_HOLD_OVERRIDDEN", reversedAuditEventId: "ev-p170", restoredStatus: "Issued", putBackTo: "Superseded",
      restoreAnswerLost: true, correctsAuditLogId: overrides("p170")[0].id,
    });
    expect(String((undone("p170")[0].details as Row).rollbackReason)).toMatch(/TypeError: Failed to fetch/);
    expect(T("audit_logs").indexOf(undone("p170")[0])).toBeGreaterThan(T("audit_logs").indexOf(overrides("p170")[0]));
    expect(audit("DOC_SPLIT_REVERSED")).toEqual([]);
  });

  it("the answer was lost and nothing committed: no correction — nor for an earlier attempt's pass that is already corrected, nor for a landed reversal's pass (its record names the event in upper case — reverse.ts reads any spelling)", async () => {
    seedSplit("p171", "none");
    seedHold("p171a");
    bindGuard();
    state.rpcMode = "canned";
    state.canned = { data: null, error: LOST };
    await expect(reverseSplit({ splitAuditEventId: "ev-p171", reason: "r", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/p171 could not be restored to Issued \(TypeError: Failed to fetch\)[\s\S]*rolled back — no partial changes were kept/);
    expect(docRow("p171").status).toBe("Superseded");
    expect(undone()).toEqual([]);

    // an earlier attempt's pass, already corrected
    T("audit_logs").push(
      { id: "ovr-old", org_id: ORG, action: "REV_HOLD_OVERRIDDEN", resource_id: "p171", user_id: ME, timestamp: "2026-09-01T00:00:00Z", details: { via: "reversal_restore", reversedAuditEventId: "ev-p171" } },
      { id: "und-old", org_id: ORG, action: "REV_HOLD_OVERRIDE_UNDONE", resource_id: "p171", user_id: ME, timestamp: "2026-09-01T00:00:01Z", details: { via: "reversal_restore", corrects: "REV_HOLD_OVERRIDDEN", reversedAuditEventId: "ev-p171" } },
    );
    await expect(reverseSplit({ splitAuditEventId: "ev-p171", reason: "r", orgId: ORG, actorUserId: ME, force: true })).rejects.toThrow(/no partial changes were kept/);
    expect(undone().map((r) => r.id)).toEqual(["und-old"]);

    // a landed reversal of the event, recorded with an upper-case id, and its pass (which stood)
    seedSplit("p172", "none");
    seedHold("p172a");
    T("audit_logs").push(
      { id: "ovr-landed", org_id: ORG, action: "REV_HOLD_OVERRIDDEN", resource_id: "p172", user_id: ME, timestamp: "2026-09-02T00:00:00Z", details: { via: "reversal_restore", reversedAuditEventId: "ev-p172" } },
      { id: "rev-landed", org_id: ORG, action: "DOC_SPLIT_REVERSED", resource_id: "p172", user_id: ME, timestamp: "2026-09-02T00:00:01Z", details: { reversedAuditEventId: "EV-P172" } },
    );
    await expect(reverseSplit({ splitAuditEventId: "ev-p172", reason: "r", orgId: ORG, actorUserId: ME, force: true })).rejects.toThrow(/no partial changes were kept/);
    expect(undone("p172")).toEqual([]);
  });

  it("the record cannot be read: the reversal still rolls back, and says the look-up failed and needs manual attention — never silent", async () => {
    seedSplit("p173", "none");
    seedHold("p173a");
    bindGuard();
    state.rpcMode = "canned";
    state.canned = { data: null, error: LOST };
    state.auditLookupError = { message: "lookup refused" };
    await expect(reverseSplit({ splitAuditEventId: "ev-p173", reason: "r", orgId: ORG, actorUserId: ME, force: true }))
      .rejects.toThrow(/p173 could not be restored to Issued \(TypeError: Failed to fetch\)[\s\S]*may need manual attention:[\s\S]*correct the hold-override record on p173: p173's restore answered with an error and whether it recorded a pass over its hold \(REV_HOLD_OVERRIDDEN\) could not be checked \(lookup refused\)/);
    expect(docRow("p173").status).toBe("Superseded");
    expect(activeHolds("p173")).toEqual([]);
    expect(undone()).toEqual([]);
  });

  it("the source of restoreStatus: only an error other than the missing function marks the pass unknown, before the reversal's refusal is thrown", () => {
    const reverse = readFileSync(join(process.cwd(), "lib/documentLifecycle/reverse.ts"), "utf8");
    const restore = reverse.slice(reverse.indexOf("async function restoreStatus("), reverse.indexOf("/** Delete this operation's supersession rows"));
    expect(restore.match(/pass\.unknown = true;/g)).toHaveLength(1);
    const branch = restore.indexOf("if (!isMissingRestoreRpc(rpcErr)) {");
    expect(restore.indexOf("pass.unknown = true;")).toBeGreaterThan(branch);
    expect(restore.indexOf("pass.unknown = true;")).toBeLessThan(restore.indexOf("throw new Error", branch));
  });
});

// ─── the app's handling of the answer ────────────────────────────────────
describe("REV-22 (P18) — restoreStatus reads the restore's answer; only a missing function falls back", () => {
  it("isMissingRestoreRpc: PGRST202, 42883 and the schema-cache sentence — nothing else", () => {
    expect(isMissingRestoreRpc({ code: "PGRST202", message: "x" })).toBe(true);
    expect(isMissingRestoreRpc({ code: "42883", message: "x" })).toBe(true);
    expect(isMissingRestoreRpc({ message: "Could not find the function public.restore_reversed_source(p_document_id, p_reason, p_reversal_of, p_status) in the schema cache" })).toBe(true);
    for (const e of [{ code: "23514", message: S_NEW_DOOR_HOLD }, { code: "42501", message: S_NO_SESSION }, { message: "Failed to fetch" }, null, undefined]) {
      expect(isMissingRestoreRpc(e), JSON.stringify(e)).toBe(false);
    }
  });

  it("a refusal from the restore is the reversal's refusal: no direct write is tried, and the reversal rolls back whole", async () => {
    state.rpcMode = "canned";
    state.canned = { data: null, error: { code: "23514", message: "refused by the database" } };
    seedSplit("p301", "none");
    const writes: string[] = [];
    state.db.beforeUpdate!.documents = (next, old) => { writes.push(`${old.id}:${old.status}->${next.status}`); return next; };
    await expect(reverseSplit({ splitAuditEventId: "ev-p301", reason: "r", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/p301 could not be restored to Issued \(refused by the database\)[\s\S]*rolled back/);
    expect(writes.filter((w) => w.startsWith("p301:"))).toEqual([]); // the source was never written directly
    expect(docRow("p301").status).toBe("Superseded");
    for (const s of ["p301a", "p301b"]) expect(docRow(s).status).toBe("Issued");
  });

  it("no_match is a refusal (the write matched no row); an unrecognised answer is too, and the rollback re-reads before putting anything back", async () => {
    state.rpcMode = "canned";
    state.canned = { data: "no_match", error: null };
    seedSplit("p302", "none");
    await expect(reverseSplit({ splitAuditEventId: "ev-p302", reason: "r", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/p302 could not be restored to Issued \(the write was refused\)/);
    expect(docRow("p302").status).toBe("Superseded");
    state.canned = { data: { odd: true }, error: null };
    seedSplit("p303", "none");
    await expect(reverseSplit({ splitAuditEventId: "ev-p303", reason: "r", orgId: ORG, actorUserId: ME }))
      .rejects.toThrow(/p303 could not be restored to Issued \(the database answered \{"odd":true\}\)/);
    expect(docRow("p303").status).toBe("Superseded");
  });

  it("the source of restoreStatus: the restore first, the direct write only behind isMissingRestoreRpc, and still no pointer in either payload", () => {
    const reverse = readFileSync(join(process.cwd(), "lib/documentLifecycle/reverse.ts"), "utf8");
    const restore = reverse.slice(reverse.indexOf("async function restoreStatus("), reverse.indexOf("/** Delete this operation's supersession rows"));
    const rpcAt = restore.indexOf('supabase.rpc("restore_reversed_source", {');
    const guardAt = restore.indexOf("if (!isMissingRestoreRpc(rpcErr)) {");
    const directAt = restore.indexOf('supabase.from("documents").update({\n    status,\n    superseded_at: null,');
    expect(rpcAt).toBeGreaterThan(0);
    expect(guardAt).toBeGreaterThan(rpcAt);
    expect(directAt).toBeGreaterThan(guardAt);
    expect(restore).not.toMatch(/current_version_id/);
    // the census (REV-18's, dcRoundFStatusTransition): the function is a status writer only the reversal calls
    const walk = (d: string): string[] => readdirSync(join(process.cwd(), d), { withFileTypes: true }).flatMap((e) => {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : walk(p);
      return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
    const callers = ["lib", "components", "app"].flatMap(walk).filter((f) => readFileSync(join(process.cwd(), f), "utf8").includes("restore_reversed_source"));
    expect(callers).toEqual(["lib/documentLifecycle/reverse.ts"]);
    expect(reverse.match(/supabase\.rpc\("restore_reversed_source"/g)).toHaveLength(1);
    // both reversals pass the event they reverse
    expect(reverse).toContain("await restoreStatus(sourceDocId, priorStatus, input.actorUserId, now, register, { reversalOf: ev.id, reversalResource: ev.resource_id, reason: input.reason, actor, rollback });");
    expect(reverse).toContain("await restoreStatus(sId, restoreTo.get(sId)!, input.actorUserId, now, register, { reversalOf: ev.id, reversalResource: ev.resource_id, reason: input.reason, actor, rollback });");
  });
});
