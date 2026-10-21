// document-control Round G — P37 DOOR B GUARD: migration 20261254 (DCK-18's
// remainders and REV-37; assigned by the integrator at the P35 and P36
// merges, 2026-10-21, DEC-31; ruled under DEC-90 — fail-safe, no regression).
//
//   enforce_document_publish_guard re-created from its NEWEST earlier body
//   (scan — 20261253 today) with exactly two additions: five declarations,
//   and one block after the lock leg and before the controller return —
//   door (b)'s intake limb asks for the intake route's own INTAKE_SUBMISSION
//   record over another person's checkout (refused 42501 in the lock leg's
//   words otherwise), and a door-(b) write over another person's checkout
//   that finalize_reviewed_promote did not make is recorded and the holder
//   told (each write its own sub-block — a WARNING, never a refusal).
//   finalize_reviewed_promote re-created from ITS newest body (20261252) with
//   two lines: the transaction-local flag app.review_promote_records set
//   before its UPDATE and cleared after it. retire_over_hold re-created from
//   ITS newest body (20261253) with one block: a recorded reversal_park needs
//   an unreversed recorded split / merge naming the document. Created: the
//   REV_HOLD_OVERRIDDEN write rail on audit_logs.
//
// Byte fidelity: lineDiff (nothing removed) AND an exact cut (each body minus
// what was added IS its base, byte for byte). The runtime proof — every door
// before and after the paste, on PostgreSQL 16 — is
// lib/__tests__/rls/dcP37DoorBGuard.test.ts (`npm run test:db`).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_META } from "@/lib/notificationKinds";

const root = process.cwd();
const dir = join(root, "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261254_dc_roundG_door_b_guard.sql";
const M = mig(FILE);
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
function lineDiff(a: string, b: string) {
  const L = a.split("\n"), R = b.split("\n");
  return { onlyInA: L.filter((l) => !R.includes(l)), onlyInB: R.filter((l) => !L.includes(l)) };
}
const code = (lines: string[]) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
const likeRe = (pat: string) => new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
const prosrcOf = (body: string) => body.slice(body.indexOf("$$") + 2, body.lastIndexOf("$$"));

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
const FIN_HEAD = "CREATE OR REPLACE FUNCTION finalize_reviewed_promote(";
const RETIRE_HEAD = "CREATE OR REPLACE FUNCTION retire_over_hold(";
const RAIL_HEAD = "CREATE OR REPLACE FUNCTION public.enforce_hold_override_record_rail()";
const definingOf = (head: string) => files.filter((f) => stripComments(mig(f)).includes(head));
const prevOf = (head: string) => { const d = definingOf(head); return d[d.indexOf(FILE) - 1]; };
const pair = (head: string) => ({ prev: prevOf(head), live: between(mig(prevOf(head)), head, "\n$$;"), next: between(M, head, "\n$$;") });
const G = pair(GUARD_HEAD);
const F = pair(FIN_HEAD);
const R = pair(RETIRE_HEAD);
const RAIL = between(M, RAIL_HEAD, "\n$$;");

// ── the guard's additions ───────────────────────────────────────────────────
const DECLARED = "  v_door_b_rev   text;\n  v_door_b_label text;\n  v_door_b_who   text;\n  v_door_b_told  boolean;\n  v_door_b_n     integer;\n";
const CONTROLLER_RETURN = "  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION.\n";
const BLOCK = G.next.slice(G.next.indexOf("  -- DCK-18 (document-control Round G, P37 DOOR B GUARD — assigned by the\n"), G.next.indexOf(CONTROLLER_RETURN));
const INTAKE = BLOCK.slice(0, BLOCK.indexOf("  -- (a) The pass is recorded and the holder told, whichever door wrote it.\n"));
const RECORD = BLOCK.slice(BLOCK.indexOf("  -- (a) The pass is recorded and the holder told, whichever door wrote it.\n"));
const LOCK_LEG_END = "      COALESCE(NULLIF(btrim(OLD.checked_out_by_name), ''), 'another user')\n      USING ERRCODE = 'insufficient_privilege';\n  END IF;\n";
const DOOR_A = [
  "     AND NOT EXISTS (",
  "           SELECT 1 FROM document_versions v",
  "            WHERE v.id = NEW.current_version_id",
  "              AND v.record_id = NEW.id",
  "              AND v.created_by = v_actor",
  "              AND v.created_at = now()",
];

// ── finalize_reviewed_promote's additions ───────────────────────────────────
const FIN_SET = "  -- DCK-18 (document-control P37, 20261254): this promote records the pass\n  -- over a checkout and tells the holder itself (below), so the publish\n  -- guard's own record of a door-(b) pass is not written for it — the\n  -- transaction-local flag names this document for the one statement, as\n  -- the hold override's does, and is cleared right after it.\n  PERFORM set_config('app.review_promote_records', p_document_id::text, true);\n";
const FIN_CLEAR = "  PERFORM set_config('app.review_promote_records', '', true);\n";

// ── retire_over_hold's addition ─────────────────────────────────────────────
const PARK = R.next.slice(R.next.indexOf("\n  -- REV-37 (document-control Round G, P37 DOOR B GUARD, 20261254 — ruled\n"), R.next.indexOf("\n  -- The write: the door's own, as the caller."));

describe("20261254 — enforce_document_publish_guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261253 — the scan, not this comment, decides): it carries the P32 lock leg and the P36 hold leg, and no P37 limb", () => {
    expect(G.prev < FILE).toBe(true);
    expect(G.prev >= "20261253_dc_roundG_status_editor_hold_leg.sql").toBe(true);
    expect(G.live).toContain("  -- HAND-13 (drafting-flow; document-control Round G, P32 PUBLISH GUARD LOCK\n");
    expect(G.live).toContain("a held document can''t be superseded or voided here");
    expect(G.live).not.toContain("INTAKE_SUBMISSION");
    expect(G.live).not.toContain("app.review_promote_records");
    // a later re-create (another package) must keep both additions byte for byte
    for (const later of definingOf(GUARD_HEAD).filter((f) => f > FILE)) {
      const body = between(mig(later), GUARD_HEAD, "\n$$;");
      expect(body, later).toContain(BLOCK);
      expect(body, later).toContain(DECLARED);
    }
  });

  it("nothing removed; every new line is a declaration or the P37 block; the body minus both IS the base, byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    const allowed = [...DECLARED.split("\n"), ...BLOCK.split("\n")];
    for (const l of onlyInB) expect(allowed, l).toContain(l);
    expect(G.next.split(BLOCK).length).toBe(2);
    expect(G.next.split(DECLARED).length).toBe(2);
    expect(G.next.replace(BLOCK, "").replace(DECLARED, "")).toBe(G.live);
  });

  it("the block sits right after the lock leg's refusal and before the controller return — so every refusal above keeps its words, the publisher tier below still decides (and a write it refuses rolls the record back)", () => {
    expect(G.next).toContain(LOCK_LEG_END + "\n" + BLOCK + CONTROLLER_RETURN);
    const at = (s: string) => G.next.indexOf(s);
    expect(at(BLOCK)).toBeGreaterThan(at("  IF OLD.checked_out_by IS NOT NULL\n     AND OLD.checked_out_by::text <> v_actor::text\n     AND NEW.current_version_id IS NOT NULL\n     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n     AND NOT EXISTS ("));
    expect(at(BLOCK)).toBeLessThan(at("'You do not have authority to publish revisions in this library.'"));
    expect(at("  IF v_actor IS NULL THEN\n    RETURN NEW;\n  END IF;\n")).toBeLessThan(at(BLOCK));
    expect(stripComments(BLOCK)).not.toMatch(/RETURN/);
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
  });

  it("(b) the intake limb: over another person's checkout, no bound roster, not publish_revision's own promote, and no INTAKE_SUBMISSION record of the route (no person named) naming this version in this workspace → refused 42501 in the lock leg's own words", () => {
    const c = code(INTAKE.split("\n"));
    expect(c.slice(0, 5)).toEqual([
      "  IF OLD.checked_out_by IS NOT NULL",
      "     AND OLD.checked_out_by::text <> v_actor::text",
      "     AND NEW.current_version_id IS NOT NULL",
      "     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id",
      "     AND COALESCE(v_primary_reqs, 0) = 0",
    ]);
    expect(c.slice(5, 5 + DOOR_A.length)).toEqual(DOOR_A);
    const sc = stripComments(INTAKE);
    expect(sc).toContain("SELECT 1 FROM audit_logs a\n            WHERE a.org_id = NEW.org_id\n              AND a.resource_type = 'document'\n              AND a.resource_id = NEW.id::text\n              AND a.action = 'INTAKE_SUBMISSION'\n              AND a.user_id IS NULL\n              AND a.details->>'versionId' = NEW.current_version_id::text) THEN");
    // the lock leg's own sentence and code, so the app's finalizeReasonMessage reads it as it reads the lock leg
    const lockSentence = between(G.live, "    RAISE EXCEPTION\n      'This document is checked out by %", "USING ERRCODE = 'insufficient_privilege';");
    expect(INTAKE).toContain(lockSentence);
    expect((sc.match(/RAISE EXCEPTION/g) ?? []).length).toBe(1);
  });

  it("(a) the record: unless finalize_reviewed_promote's flag names the document, a door-(b) write over another person's checkout (never publish_revision's own) queues the holder's notice and writes REVIEW_PROMOTED_OVER_CHECKOUT — each in its own sub-block, a WARNING, never a refusal", () => {
    const c = code(RECORD.split("\n"));
    expect(c.slice(0, 5)).toEqual([
      "  IF OLD.checked_out_by IS NOT NULL",
      "     AND OLD.checked_out_by::text <> v_actor::text",
      "     AND NEW.current_version_id IS NOT NULL",
      "     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id",
      "     AND current_setting('app.review_promote_records', true) IS DISTINCT FROM NEW.id::text",
    ]);
    expect(c.slice(5, 5 + DOOR_A.length)).toEqual(DOOR_A);
    const sc = stripComments(RECORD);
    expect(sc).not.toMatch(/RAISE EXCEPTION/);
    const subs = sc.split("    BEGIN\n").slice(1);
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatch(/^      INSERT INTO notifications[\s\S]*EXCEPTION WHEN OTHERS THEN\n      RAISE WARNING 'enforce_document_publish_guard: [^']*their notice was not written \(the write stands\)/);
    expect(subs[1]).toMatch(/^      INSERT INTO audit_logs[\s\S]*EXCEPTION WHEN OTHERS THEN\n      RAISE WARNING 'enforce_document_publish_guard: [^']*the record was not written \(the write stands\)/);
    // the flag is only read here, never set
    expect(stripComments(G.next)).not.toMatch(/set_config/);
  });

  it("(a) the same notice and record 20261252 writes: the EXISTING kind revision_published_over_checkout (no new kind — notification_kinds() untouched), an app-relative link, the actor as the signed-in member; the record's keys are 20261252's plus 'promote' 'direct_write'", () => {
    expect(Object.keys(KIND_META)).toContain("revision_published_over_checkout");
    expect(stripComments(M)).not.toMatch(/FUNCTION\s+(?:public\.)?notification_kinds/);
    const sc = stripComments(RECORD);
    expect(sc).toContain("VALUES (NEW.org_id, OLD.checked_out_by::text::uuid, 'revision_published_over_checkout',");
    expect(sc).toContain("'/documents/' || NEW.library_id::text || '?doc=' || NEW.id::text, 'document', NEW.id::text,");
    expect(sc).toContain("              v_actor, v_door_b_who,\n");
    expect(sc).toContain("jsonb_build_object('newVersionId', NEW.current_version_id, 'newRev', v_door_b_rev, 'via', 'database')");
    const p35 = between(mig("20261252_dc_roundG_door_b_record.sql"), "INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)\n      VALUES ('REVIEW_PROMOTED_OVER_CHECKOUT'", "));");
    const keys = (s: string) => [...s.matchAll(/'([A-Za-z]+)', /g)].map((m) => m[1]).filter((k) => /^[a-z][A-Za-z]+$/.test(k) && !["document", "database"].includes(k));
    const mine = between(sc, "VALUES ('REVIEW_PROMOTED_OVER_CHECKOUT'", "));");
    expect(keys(mine)).toEqual(["via", "promote", "holderUserId", "holderName", "holderNotified", "versionId", "previousVersionId", "revisionLabel"]);
    expect(keys(p35).filter((k) => k !== "promote")).toEqual(keys(mine).filter((k) => k !== "promote"));
    // the app's timeline renderer reads revisionLabel and holderName (lib/timeline.ts)
    expect(readFileSync(join(root, "lib", "timeline.ts"), "utf8")).toContain('case "REVIEW_PROMOTED_OVER_CHECKOUT":');
  });
});

describe("20261254 — finalize_reviewed_promote re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261252), with its P35 record and report", () => {
    expect(F.prev >= "20261252_dc_roundG_door_b_record.sql").toBe(true);
    expect(F.live).toContain("'REVIEW_PROMOTED_OVER_CHECKOUT'");
    expect(F.live).not.toContain("app.review_promote_records");
  });

  it("nothing removed; the only additions are the flag's set (with its comment) before the UPDATE and its clear after the hold flag's clear; the body minus them IS the base", () => {
    const { onlyInA } = lineDiff(F.live, F.next);
    expect(onlyInA).toEqual([]);
    expect(F.next.split(FIN_SET).length).toBe(2);
    expect(F.next.split(FIN_CLEAR).length).toBe(2);
    expect(F.next.replace(FIN_SET, "").replace(FIN_CLEAR, "")).toBe(F.live);
    expect(F.next).toContain("  IF v_hold_forced THEN\n    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);\n  END IF;\n" + FIN_SET + "  UPDATE documents\n     SET current_version_id = p_pending_id,");
    expect(F.next).toContain("  IF v_hold_forced THEN\n    PERFORM set_config('app.publish_hold_override', '', true);\n  END IF;\n" + FIN_CLEAR + "  IF v_n = 0 THEN\n    RETURN 'no_match';");
  });

  it("the same eight-argument signature (CREATE OR REPLACE — no DROP, no PostgREST schema change), SECURITY INVOKER, search_path pinned, grants restated", () => {
    expect(F.next).toContain("  p_report_over_checkout boolean DEFAULT false\n) RETURNS text\nLANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(stripComments(M)).not.toMatch(/DROP FUNCTION IF EXISTS finalize_reviewed_promote/);
    expect(M).toContain("REVOKE ALL ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean) FROM PUBLIC, anon;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean) TO authenticated, service_role;");
  });
});

describe("20261254 — retire_over_hold re-created from its NEWEST earlier body; the recorded park bound", () => {
  it("the base is the newest earlier definition (today 20261253); nothing removed; the one addition is the park's binding; the body minus it IS the base", () => {
    expect(R.prev >= "20261253_dc_roundG_status_editor_hold_leg.sql").toBe(true);
    const { onlyInA } = lineDiff(R.live, R.next);
    expect(onlyInA).toEqual([]);
    expect(PARK.length).toBeGreaterThan(1000);
    expect(R.next.split(PARK).length).toBe(2);
    expect(R.next.replace(PARK, "")).toBe(R.live);
  });

  it("binds only the recorded park (v_forced AND reversal_park) to an unreversed recorded split naming it among its replacements or merge naming it as its target, and refuses 42501 BEFORE the write; the split / merge source flip is not bound (the integrator's ruling, said in the comment)", () => {
    const c = code(PARK.split("\n"));
    expect(c.slice(0, 3)).toEqual(["  IF v_forced", "     AND p_via = 'reversal_park'", "     AND NOT EXISTS ("]);
    const sc = stripComments(PARK);
    expect(sc).toContain("AND ((e.action = 'DOC_SPLIT'\n                    AND jsonb_typeof(e.details->'replacementDocIds') = 'array'\n                    AND (e.details->'replacementDocIds') ? p_document_id::text)\n                   OR (e.action = 'DOC_MERGED'\n                       AND e.details->>'mergedIntoDocumentId' = p_document_id::text))");
    expect(sc).toContain("AND r.action IN ('DOC_SPLIT_REVERSED', 'DOC_MERGE_REVERSED')");
    expect(sc).toContain("translate(lower(r.details->>'reversedAuditEventId'), '{}-', '') = replace(e.id::text, '-', '')");
    expect(sc).toContain("USING ERRCODE = 'insufficient_privilege';");
    expect(PARK).toContain("the recorded Document Control\n  -- pass is enough there.");
    const at = (s: string) => R.next.indexOf(s);
    expect(at(PARK)).toBeGreaterThan(at("    v_forced := true;\n  END IF;\n"));
    expect(at(PARK)).toBeLessThan(at("PERFORM set_config('app.publish_hold_override', p_document_id::text, true);"));
    expect(at(PARK)).toBeLessThan(at("  UPDATE documents\n"));
  });

  it("reverse.ts parks exactly what the binding admits: a split's replacementDocIds, a merge's newly created mergedIntoDocumentId — the event keys the sagas write", () => {
    const rev = readFileSync(join(root, "lib", "documentLifecycle", "reverse.ts"), "utf8");
    expect(rev).toContain('const replacementIds = (ev.details?.replacementDocIds as string[] | undefined) ?? [];');
    expect(rev).toContain('const targetDocId = ev.details?.mergedIntoDocumentId as string | undefined;');
    expect(readFileSync(join(root, "lib", "documentLifecycle", "merge.ts"), "utf8")).toContain("mergedIntoDocumentId: targetDocumentId,");
  });

  it("same signature, SECURITY INVOKER, search_path pinned; authenticated only (grants restated)", () => {
    expect(R.next).toContain(") RETURNS text\nLANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(M).toContain("REVOKE ALL ON FUNCTION retire_over_hold(uuid, text, text, timestamptz, text, boolean) FROM PUBLIC, anon, service_role;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION retire_over_hold(uuid, text, text, timestamptz, text, boolean) TO authenticated;");
    expect(stripComments(M)).not.toMatch(/DROP FUNCTION IF EXISTS retire_over_hold/);
  });
});

describe("20261254 — the REV_HOLD_OVERRIDDEN write rail", () => {
  it("SECURITY DEFINER with search_path pinned; the service role passes first; a signed-in row needs the document it names (in its workspace) written by this transaction — pg_xact_status 'in progress' on the row's xmin; else 42501", () => {
    expect(RAIL).toContain("RETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public\nAS $$");
    const sc = stripComments(prosrcOf(RAIL));
    expect(sc.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;")).toBeGreaterThan(0);
    expect(sc.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;")).toBeLessThan(sc.indexOf("SELECT d.xmin"));
    expect(sc).toContain("IF NEW.resource_type = 'document'\n     AND COALESCE(NEW.resource_id, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN");
    expect(sc).toContain("WHERE d.id = NEW.resource_id::uuid AND d.org_id = NEW.org_id;");
    expect(sc).toContain("v_status := pg_xact_status(v_full::text::xid8);");
    expect(sc).toContain("IF v_status = 'in progress' THEN\n        RETURN NEW;");
    expect(sc).toContain("EXCEPTION WHEN OTHERS THEN\n        v_status := NULL;");
    expect(sc).toMatch(/RAISE EXCEPTION 'A hold-override record \(REV_HOLD_OVERRIDDEN\)[^']*''[^']*'\n    USING ERRCODE = 'insufficient_privilege';\nEND;/);
    // the epoch widening: an xmin above the current transaction by more than 2^31 is the previous epoch's
    expect(sc).toContain("v_full := (v_cur - (v_cur % 4294967296)) + v_xmin;\n        IF v_full > v_cur + 2147483648 THEN\n          v_full := v_full - 4294967296;");
  });

  it("DRLS-16: executable by no client role; bound BEFORE INSERT on audit_logs FOR EACH ROW only for REV_HOLD_OVERRIDDEN (idempotently re-created)", () => {
    for (const r of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(M).toContain(`REVOKE ALL ON FUNCTION public.enforce_hold_override_record_rail() FROM ${r};`);
    }
    expect(M).toContain("DROP TRIGGER IF EXISTS trg_audit_logs_hold_override_rail ON audit_logs;\nCREATE TRIGGER trg_audit_logs_hold_override_rail\n  BEFORE INSERT ON audit_logs\n  FOR EACH ROW\n  WHEN (NEW.action = 'REV_HOLD_OVERRIDDEN')\n  EXECUTE FUNCTION public.enforce_hold_override_record_rail();");
  });

  it("every SQL writer of REV_HOLD_OVERRIDDEN writes it right after its own UPDATE of the document it names, in the same function — the newest body of each", () => {
    const writers = new Map<string, string>();
    const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?(\w+)\s*\(/g;
    for (const f of files) {
      const s = mig(f);
      for (const m of s.matchAll(re)) {
        const body = s.slice(m.index!, s.indexOf("\n$$;", m.index!) + 4);
        if (stripComments(body).includes("VALUES ('REV_HOLD_OVERRIDDEN'")) writers.set(m[1], body);
        else if (writers.has(m[1])) writers.delete(m[1]);
      }
    }
    expect([...writers.keys()].sort()).toEqual(["finalize_reviewed_promote", "publish_revision", "put_back_retired_issue", "restore_reversed_source", "retire_over_hold"]);
    for (const [name, body] of writers) {
      const sc = stripComments(body);
      const ins = sc.indexOf("VALUES ('REV_HOLD_OVERRIDDEN'");
      expect(sc.lastIndexOf("UPDATE documents", ins), name).toBeGreaterThan(0);
    }
    // the app writes none of them itself (it reads them: reverse.ts findUncorrectedPass)
    const appWrites = (p: string) => /action:\s*"REV_HOLD_OVERRIDDEN"/.test(readFileSync(join(root, p), "utf8"));
    for (const p of ["lib/revisions.ts", "lib/documentLifecycle/common.ts", "lib/documentLifecycle/reverse.ts", "lib/reviewControl.ts"]) expect(appWrites(p), p).toBe(false);
  });
});

describe("20261254 — the one-paste shape (DEC-30)", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("header; the prerequisite refuses (changing nothing) without 20261253's hold leg, 20261252's finalize or 20261253's retire_over_hold; a counts-only TEMP inventory BEFORE the one BEGIN … COMMIT", () => {
    expect(M.startsWith("-- ─")).toBe(true);
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'");
    expect(pre).toBeGreaterThan(0);
    for (const s of ["20261254 needs 20261253 (the hold leg in the publish guard) pasted first; nothing was changed.",
      "20261254 needs 20261252 (finalize_reviewed_promote''s over-checkout record) pasted first; nothing was changed.",
      "20261254 needs 20261253 (retire_over_hold) pasted first; nothing was changed."]) expect(M).toContain(s);
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_g_254_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_g_254_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect(stripComments(M).match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(stripComments(M).match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it("the inventory is aggregate counts only — every row a COUNT, never a customer column", () => {
    const inv = between(M, "CREATE TEMP TABLE dc_round_g_254_before AS", "\nBEGIN;");
    const top = inv.slice(inv.indexOf("\nSELECT 'inventory"));
    const selects = top.split(/\bUNION ALL\b/);
    expect(selects).toHaveLength(6);
    for (const s of selects) {
      const noStrings = s.replace(/'(?:[^']|'')*'/g, "''");
      expect(noStrings, s.slice(0, 80)).toMatch(/^\s*SELECT '',?(?: AS inventory,)?\s*COUNT\((?:\*|DISTINCT d\.id)\)::text(?: AS n)?\s/);
      expect(s).toMatch(/^\s*SELECT 'inventory \(before apply\): /);
    }
  });

  it("ends with ONE statement after COMMIT: probes (ok, n NULL) and the inventory rows (ok NULL, n)", () => {
    const statements = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''").split(";").filter((s) => s.trim());
    expect(statements).toHaveLength(1);
    expect(tail).toContain("AS check,");
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM dc_round_g_254_before;");
    expect((stripComments(tail).match(/\bUNION ALL\b/g) ?? []).length).toBe(9);
  });

  it("every prosrc probe holds on the body it names (verbatim prosrc; '' in a probe is ' in the body)", () => {
    const bodies: Record<string, string> = {
      enforce_document_publish_guard: prosrcOf(G.next), finalize_reviewed_promote: prosrcOf(F.next),
      retire_over_hold: prosrcOf(R.next), enforce_hold_override_record_rail: prosrcOf(RAIL),
    };
    const probes = [...tail.matchAll(/prosrc LIKE '((?:[^']|'')*)'\s+FROM pg_proc WHERE proname = '(\w+)'/g)];
    expect(probes.length).toBe(6);
    for (const [, pat, name] of probes) expect(bodies[name], `${name}: ${pat.slice(0, 60)}`).toMatch(likeRe(pat.replace(/''/g, "'")));
  });

  it("defines exactly the guard, finalize_reviewed_promote, retire_over_hold and the rail, one trigger, no table, no policy, no new notification kind", () => {
    const sc = stripComments(M);
    expect([...sc.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?(\w+)/g)].map((m) => m[1]))
      .toEqual(["enforce_document_publish_guard", "finalize_reviewed_promote", "retire_over_hold", "enforce_hold_override_record_rail"]);
    expect([...sc.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1])).toEqual(["trg_audit_logs_hold_override_rail"]);
    expect(sc).not.toMatch(/CREATE TABLE(?! dc_round)|CREATE TEMP TABLE (?!dc_round_g_254_before)/);
    expect(sc).not.toMatch(/CREATE POLICY|ALTER TABLE/);
  });

  it("states the paste order (after 20261253, row 193) and that no deploy order is needed", () => {
    expect(M).toContain("-- HOW TO APPLY: AFTER 20261253 (required");
    expect(M).toContain("behind paste guide row 193");
    expect(M).toContain("-- DEPLOY ORDER: none — deploy the P37 app before or after this paste.");
  });
});
