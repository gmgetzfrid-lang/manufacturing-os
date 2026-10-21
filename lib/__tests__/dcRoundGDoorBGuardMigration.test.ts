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
//   P37 final fix pass (the integrator's ruling (1)): intake_door_submit_version
//   re-created from ITS newest body (20261214) with one block — the door's own
//   INTAKE_DOOR_SUBMITTED record of the submission, in the door's transaction,
//   its own sub-block (a WARNING, never a refusal) — and the guard's intake
//   limb accepts that record, the route's, or the route's server dead letter.
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

/**
 * The writer census's path walk (P37 fix pass). A plpgsql body is split into
 * statements at `;` outside string literals, control prefixes are peeled
 * (IF / ELSIF / ELSE / END IF, BEGIN / EXCEPTION WHEN / END, loops), and the
 * walk carries every reachable state (conditions are not evaluated: each IF
 * arm, and the fall-through of an IF with no ELSE, is a path). A state knows
 * whether the documents row was written ('yes' only once a no-match gate —
 * `IF v_n = 0 THEN RETURN` on the UPDATE's own ROW_COUNT — has been passed)
 * and which variables hold the id of a version the function inserted (with
 * its record_id). At each `INSERT INTO audit_logs … VALUES ('REV_HOLD_OVERRIDDEN'`
 * every state must carry the documents proof or name such a version in
 * `'versionId', <var>` — what enforce_hold_override_record_rail admits.
 */
type WalkState = { doc: "no" | "maybe" | "yes"; last: "doc" | "other"; vnDoc: boolean; vers: string[] };
function walkHoldInserts(src: string, opts: { versionProof?: boolean } = {}) {
  const versionProof = opts.versionProof ?? true;
  const text = stripComments(src);
  const pieces: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") q = !q;
    if (c === ";" && !q) { pieces.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) pieces.push(cur);
  type Item = { k: "if" | "elsif" | "else" | "endif" | "begin" | "exception" | "end" | "loop" | "endloop" | "stmt"; t: string };
  const items: Item[] = [];
  const thenAt = (s: string) => {
    let depth = 0, inq = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "'") inq = !inq;
      if (inq) continue;
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (depth === 0 && /^THEN\b/.test(s.slice(i)) && /\W/.test(s[i - 1] ?? " ")) return i;
    }
    throw new Error(`no THEN in: ${s.slice(0, 80)}`);
  };
  for (const p of pieces) {
    let s = p.trim();
    while (s) {
      let m: RegExpMatchArray | null;
      if (/^END\s+IF$/.test(s)) { items.push({ k: "endif", t: "" }); s = ""; }
      else if (/^END\s+LOOP$/.test(s)) { items.push({ k: "endloop", t: "" }); s = ""; }
      else if (/^END$/.test(s)) { items.push({ k: "end", t: "" }); s = ""; }
      else if ((m = s.match(/^(IF|ELSIF)\b/))) { const at = thenAt(s); items.push({ k: m[1] === "IF" ? "if" : "elsif", t: s.slice(m[1].length, at).trim() }); s = s.slice(at + 4).trim(); }
      else if (/^ELSE\b/.test(s)) { items.push({ k: "else", t: "" }); s = s.slice(4).trim(); }
      else if (/^DECLARE\b/.test(s)) { s = s.slice(7).trim(); }
      else if (/^BEGIN\b/.test(s)) { items.push({ k: "begin", t: "" }); s = s.slice(5).trim(); }
      else if ((m = s.match(/^(?:EXCEPTION\s+)?WHEN\b/)) && (items.some((x) => x.k === "exception") || /^EXCEPTION/.test(s))) { const at = thenAt(s); items.push({ k: "exception", t: s.slice(0, at).trim() }); s = s.slice(at + 4).trim(); }
      else if ((m = s.match(/^(?:(?:FOR|FOREACH|WHILE)\b[\s\S]*?\s)?LOOP\b/))) { items.push({ k: "loop", t: "" }); s = s.slice(m[0].length).trim(); }
      else { items.push({ k: "stmt", t: s }); s = ""; }
    }
  }
  const key = (st: WalkState) => JSON.stringify({ ...st, vers: [...st.vers].sort() });
  const uniq = (sts: WalkState[]) => [...new Map(sts.map((st) => [key(st), st])).values()];
  let sites = 0;
  const unproven: string[] = [];
  let docAll = true, verAll = true;
  const stmt = (t: string, sts: WalkState[]): WalkState[] => {
    if (/^RETURN\b/.test(t)) return [];
    if (/^RAISE\b/.test(t) && !/^RAISE\s+(WARNING|NOTICE|INFO|LOG|DEBUG)\b/.test(t)) return [];
    return sts.map((st0) => {
      const st = { ...st0, vers: [...st0.vers] };
      if (/^UPDATE\s+documents\b/.test(t)) { st.last = "doc"; if (st.doc !== "yes") st.doc = "maybe"; return st; }
      if (/^GET\s+DIAGNOSTICS\s+v_n\s*=\s*ROW_COUNT$/.test(t)) { st.vnDoc = st.last === "doc"; return st; }
      if (/^v_n\s*:=/.test(t)) st.vnDoc = false;
      const v = /^INSERT\s+INTO\s+document_versions\b/.test(t) && /\brecord_id\b/.test(t) ? t.match(/RETURNING\s+id\s+INTO\s+(\w+)$/) : null;
      if (v) st.vers.push(v[1]);
      if (/^INSERT\s+INTO\s+audit_logs\b/.test(t) && t.includes("VALUES ('REV_HOLD_OVERRIDDEN'")) {
        const named = t.match(/'versionId',\s*(\w+)/)?.[1];
        const byDoc = st.doc === "yes";
        const byVer = versionProof && named !== undefined && st.vers.includes(named);
        if (!byDoc) docAll = false;
        if (!(named !== undefined && st.vers.includes(named))) verAll = false;
        if (!byDoc && !byVer) unproven.push(key(st));
      }
      st.last = "other";
      return st;
    });
  };
  const seq = (i: number, sts: WalkState[], stop: Item["k"][]): { i: number; sts: WalkState[] } => {
    while (i < items.length && !stop.includes(items[i].k)) {
      const it = items[i];
      if (it.k === "stmt") {
        const isSite = /^INSERT\s+INTO\s+audit_logs\b/.test(it.t) && it.t.includes("VALUES ('REV_HOLD_OVERRIDDEN'");
        if (isSite) sites++;
        sts = uniq(stmt(it.t, sts)); i++;
      } else if (it.k === "if") {
        const gate = /^v_n\s*=\s*0$/.test(it.t);
        const outs: WalkState[] = [];
        let r = seq(i + 1, sts, ["elsif", "else", "endif"]);
        outs.push(...r.sts);
        let hasElse = false;
        while (items[r.i].k !== "endif") {
          if (items[r.i].k === "else") hasElse = true;
          r = seq(r.i + 1, sts, ["elsif", "else", "endif"]);
          outs.push(...r.sts);
        }
        if (!hasElse) outs.push(...sts.map((st) => (gate && st.vnDoc ? { ...st, doc: "yes" as const } : st)));
        sts = uniq(outs); i = r.i + 1;
      } else if (it.k === "begin") {
        const r = seq(i + 1, sts, ["exception", "end"]);
        const outs = [...r.sts];
        let j = r.i;
        while (items[j].k === "exception") { const h = seq(j + 1, sts, ["exception", "end"]); outs.push(...h.sts); j = h.i; }
        sts = uniq(outs); i = j + 1;
      } else if (it.k === "loop") {
        const r = seq(i + 1, sts, ["endloop"]);
        sts = uniq([...sts, ...r.sts]); i = r.i + 1;
      } else {
        throw new Error(`unexpected ${it.k} at item ${i}`);
      }
    }
    return { i, sts };
  };
  seq(0, [{ doc: "no", last: "other", vnDoc: false, vers: [] }], []);
  return { sites, unproven, docOnEveryPath: docAll, versionOnEveryPath: verAll };
}

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
const FIN_HEAD = "CREATE OR REPLACE FUNCTION finalize_reviewed_promote(";
const RETIRE_HEAD = "CREATE OR REPLACE FUNCTION retire_over_hold(";
const RAIL_HEAD = "CREATE OR REPLACE FUNCTION public.enforce_hold_override_record_rail()";
const DOOR_HEAD = "CREATE OR REPLACE FUNCTION public.intake_door_submit_version(p_token_hash text, p_version jsonb)";
const definingOf = (head: string) => files.filter((f) => stripComments(mig(f)).includes(head));
const prevOf = (head: string) => { const d = definingOf(head); return d[d.indexOf(FILE) - 1]; };
const pair = (head: string) => ({ prev: prevOf(head), live: between(mig(prevOf(head)), head, "\n$$;"), next: between(M, head, "\n$$;") });
const G = pair(GUARD_HEAD);
const F = pair(FIN_HEAD);
const R = pair(RETIRE_HEAD);
const D = pair(DOOR_HEAD);
const RAIL = between(M, RAIL_HEAD, "\n$$;");

// ── the guard's additions ───────────────────────────────────────────────────
const DECLARED = "  v_door_b_rev   text;\n  v_door_b_label text;\n  v_door_b_who   text;\n  v_door_b_told  boolean;\n  v_door_b_n     integer;\n  v_door_b_proof boolean;\n";
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
// ── intake_door_submit_version's addition (P37 final fix pass) ──────────────
const DOOR_REC = D.next.slice(D.next.indexOf("  -- DCK-18 (b) (document-control Round G, P37 final fix pass, 20261254 — the\n"), D.next.indexOf("  RETURN v_id;\n"));

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

  it("(b) the intake limb: over another person's checkout, no bound roster, not publish_revision's own promote, and no proof naming this version in this workspace — the door's own INTAKE_DOOR_SUBMITTED or the route's INTAKE_SUBMISSION record (no person named), or the route's record as a SERVER dead letter (drained, or still in the outbox where 20261219 made it) → refused 42501 in the lock leg's own words", () => {
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
    expect(sc).toContain("SELECT 1 FROM audit_logs a\n            WHERE a.org_id = NEW.org_id\n              AND a.resource_type = 'document'\n              AND a.resource_id = NEW.id::text\n              AND a.action IN ('INTAKE_SUBMISSION', 'INTAKE_DOOR_SUBMITTED')\n              AND a.user_id IS NULL\n              AND a.details->>'versionId' = NEW.current_version_id::text)\n");
    // the drained dead letter (lib/auditOutboxDrain.ts drainedAuditRow): a machine row typed org, the lost row as sent,
    // from the SERVER (no reporter) — a browser's dead letter names its member reporter and vouches for nothing
    expect(sc).toContain("              AND a.action = 'AUDIT_DEAD_LETTER'\n              AND a.user_id IS NULL\n              AND a.details->>'lostAction' = 'INTAKE_SUBMISSION'\n              AND a.details->>'source' = 'server'\n              AND jsonb_typeof(COALESCE(a.details->'reportedBy', 'null'::jsonb)) = 'null'\n");
    expect(sc).toContain("AND a.details->'lost'->'details'->>'versionId' = NEW.current_version_id::text) THEN");
    // the outbox row not drained yet: read only where the table exists, an unreadable outbox vouches for nothing
    expect(sc).toContain("    v_door_b_proof := false;\n    IF to_regclass('public.audit_dead_letters') IS NOT NULL THEN\n      BEGIN\n        SELECT EXISTS (\n                 SELECT 1 FROM audit_dead_letters o\n                  WHERE o.org_id = NEW.org_id\n                    AND o.action = 'INTAKE_SUBMISSION'\n                    AND o.source = 'server'\n                    AND o.reported_by IS NULL\n");
    expect(sc).toContain("      EXCEPTION WHEN OTHERS THEN\n        v_door_b_proof := false;\n      END;\n    END IF;\n    IF NOT COALESCE(v_door_b_proof, false) THEN\n    RAISE EXCEPTION");
    // the shapes the limb reads are the shapes the app writes
    const drain = readFileSync(join(root, "lib", "auditOutboxDrain.ts"), "utf8");
    for (const k of ['lostAction: o.action,', 'lost: { ...(entry.row ?? {}), asSent: true },', 'reportedBy: o.reported_by,', 'source: o.source,', 'user_id: null,', 'resource_type: "org",', 'resource_id: o.org_id,']) expect(drain).toContain(k);
    const outbox = readFileSync(join(root, "lib", "auditOutbox.ts"), "utf8");
    expect(outbox).toContain('entry: { row, reporter: null },');
    expect(outbox).toContain('source: "server",\n      reported_by: null,');
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
    // The DC-P37 merge (the integrator, the independent review's minor): a merge of several sources is reversed once — a
    // later DOC_MERGE_REVERSED of this target listing the source also counts as that source's reversal.
    expect(sc).toContain("OR (r.action = 'DOC_MERGE_REVERSED' AND e.action = 'DOC_MERGED'");
    expect(sc).toContain("AND (r.details->'reversedSourceDocIds') ? e.resource_id::text");
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

describe("20261254 — intake_door_submit_version re-created from its NEWEST earlier body; the door records its own submission (P37 final fix pass)", () => {
  it("the base is the newest earlier definition (today 20261214 — the scan decides), with its role switch and bound-identity fallback, and no door record", () => {
    expect(D.prev >= "20261214_prj_roundG_intake_door_rls.sql").toBe(true);
    expect(D.live).toContain("IF v_rls THEN PERFORM set_config('role', 'intake_door', true); END IF;");
    expect(D.live).not.toContain("INTAKE_DOOR_SUBMITTED");
    for (const later of definingOf(DOOR_HEAD).filter((f) => f > FILE)) expect(between(mig(later), DOOR_HEAD, "\n$$;"), later).toContain(DOOR_REC);
  });

  it("nothing removed; the one addition is the record's block between the unbind and the RETURN; the body minus it IS the base, byte for byte", () => {
    const { onlyInA } = lineDiff(D.live, D.next);
    expect(onlyInA).toEqual([]);
    expect(DOOR_REC.length).toBeGreaterThan(500);
    expect(D.next.split(DOOR_REC).length).toBe(2);
    expect(D.next.replace(DOOR_REC, "")).toBe(D.live);
    expect(D.next).toContain("  END LOOP;\n  PERFORM intake_door_unbind(v_prev);\n" + DOOR_REC + "  RETURN v_id;\nEND;");
  });

  it("the record: after the role switch and the bound identity are undone (as the caller — the service role), no person named, naming the version it inserted, the link, the project and which path inserted it; its own sub-block — a WARNING, the submission stands", () => {
    const sc = stripComments(DOOR_REC);
    expect(sc).toMatch(/^\s*BEGIN\n    INSERT INTO audit_logs \(action, resource_id, resource_type, org_id, user_id, user_email, details\)\n    VALUES \('INTAKE_DOOR_SUBMITTED', v_v\.record_id::text, 'document', v_org, NULL, NULL,/);
    for (const k of ["'versionId', v_id,", "'linkId', v_link,", "'projectId', v_proj,", "'insertedAs', CASE WHEN v_rls THEN 'intake_door' ELSE 'bound_identity' END,", "'via', 'intake_door_submit_version'"]) expect(sc).toContain(k);
    expect(sc).toContain("  EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING 'intake_door_submit_version: the submission % was filed, but the door''s own record of it was not written (the submission stands): %', v_id, SQLERRM;\n  END;\n");
    expect(sc).not.toMatch(/RAISE EXCEPTION|RETURN|set_config/);
  });

  it("the same signature (CREATE OR REPLACE — no DROP, no PostgREST schema change), SECURITY INVOKER, search_path pinned; the service role only (grants restated, DRLS-16)", () => {
    expect(D.next).toContain(DOOR_HEAD + "\nRETURNS uuid\nLANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = public\nAS $$");
    expect(stripComments(M)).not.toMatch(/DROP FUNCTION IF EXISTS (?:public\.)?intake_door_submit_version/);
    expect(M).toContain("REVOKE ALL ON FUNCTION public.intake_door_submit_version(text, jsonb) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.intake_door_submit_version(text, jsonb) TO service_role;");
  });

  it("the intake route still calls it as before (same arguments) and still writes its own record after — kept in the EVID-6 outbox when the write fails (keep: true)", () => {
    const route = readFileSync(join(root, "app", "api", "intake", "upload", "route.ts"), "utf8");
    expect(route).toContain('supabaseAdmin.rpc("intake_door_submit_version", { p_token_hash: tokenHash, p_version: versionRow })');
    expect(route).toContain('action: published ? "INTAKE_AUTO_SUPERSEDE" : "INTAKE_SUBMISSION",');
    expect(route).toMatch(/appSession: session,\n    },\n[^\n]*\n  \}, \{ keep: true \}\);/);
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

  it("P37 fix pass — the version proof: the version the row names (details.versionId), OF THAT DOCUMENT in THAT workspace, inserted by this transaction, also admits it (publish_revision's forced branch over a hold writes no documents row); only after the documents row is found; each xmin judged by the same in-progress test", () => {
    const sc = stripComments(prosrcOf(RAIL));
    expect(sc).toContain("v_xmins  bigint[] := ARRAY[]::bigint[];");
    const doc = sc.indexOf("WHERE d.id = NEW.resource_id::uuid AND d.org_id = NEW.org_id;");
    const ver = sc.indexOf("SELECT v.xmin::text::bigint INTO v_xmin\n          FROM document_versions v\n         WHERE v.id = (NEW.details->>'versionId')::uuid\n           AND v.record_id = NEW.resource_id::uuid AND v.org_id = NEW.org_id;");
    expect(doc).toBeGreaterThan(0);
    expect(ver).toBeGreaterThan(doc);
    // the version is looked up only once the named document exists in the row's workspace, and only for a uuid-shaped versionId
    expect(sc.slice(doc, ver)).toContain("IF v_xmin IS NOT NULL THEN\n      v_xmins := v_xmins || v_xmin;");
    expect(sc.slice(doc, ver)).toContain("IF COALESCE(NEW.details->>'versionId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN\n        v_xmin := NULL;");
    // both xmins go through ONE judgement (the loop), which is the only RETURN NEW after the service-role pass
    const loop = sc.indexOf("FOREACH v_xmin IN ARRAY v_xmins LOOP\n      v_status := NULL;");
    expect(loop).toBeGreaterThan(ver);
    expect(sc.indexOf("END LOOP;")).toBeGreaterThan(sc.indexOf("v_status := pg_xact_status(v_full::text::xid8);"));
    expect(sc.match(/RETURN NEW;/g)).toHaveLength(2);
  });

  it("DRLS-16: executable by no client role; bound BEFORE INSERT on audit_logs FOR EACH ROW only for REV_HOLD_OVERRIDDEN (idempotently re-created)", () => {
    for (const r of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(M).toContain(`REVOKE ALL ON FUNCTION public.enforce_hold_override_record_rail() FROM ${r};`);
    }
    expect(M).toContain("DROP TRIGGER IF EXISTS trg_audit_logs_hold_override_rail ON audit_logs;\nCREATE TRIGGER trg_audit_logs_hold_override_rail\n  BEFORE INSERT ON audit_logs\n  FOR EACH ROW\n  WHEN (NEW.action = 'REV_HOLD_OVERRIDDEN')\n  EXECUTE FUNCTION public.enforce_hold_override_record_rail();");
  });

  it("every SQL writer of REV_HOLD_OVERRIDDEN reaches EVERY one of its inserts, on EVERY code path, only after a write the rail admits — its own landed UPDATE of the document, or its own INSERT of the version the row names — the newest body of each (a path-by-path walk, not a text search)", () => {
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
    const proofs = new Map<string, ReturnType<typeof walkHoldInserts>>();
    for (const [name, body] of writers) {
      const r = walkHoldInserts(prosrcOf(body));
      proofs.set(name, r);
      expect(r.sites, name).toBeGreaterThan(0);
      // every state reaching every insert carries a proof the rail admits
      expect(r.unproven, name).toEqual([]);
    }
    // the four UPDATE writers stand on their landed UPDATE (a no-match returns first) on every path
    for (const name of ["finalize_reviewed_promote", "put_back_retired_issue", "restore_reversed_source", "retire_over_hold"]) {
      expect(proofs.get(name)!.docOnEveryPath, name).toBe(true);
    }
    // publish_revision does NOT (its branch arm writes no documents row — the defect the reviewer reproduced):
    // it stands on the version it inserts on both arms, of the document the row names
    const pub = proofs.get("publish_revision")!;
    expect(pub.docOnEveryPath).toBe(false);
    expect(pub.versionOnEveryPath).toBe(true);
    const pubBody = stripComments(writers.get("publish_revision")!);
    expect(pubBody).toContain("INSERT INTO document_versions (\n      org_id, record_id, revision_label,");
    expect(pubBody).toContain(") VALUES (\n      v_doc.org_id, p_doc, btrim(v_label),");
    expect(pubBody).toContain("VALUES ('REV_HOLD_OVERRIDDEN', p_doc::text, 'document', v_doc.org_id, p_actor,");
    expect(pubBody).toContain("'versionId', v_new_id,");
    // and the walk is not vacuous: without the version proof the census fails publish_revision
    expect(walkHoldInserts(prosrcOf(writers.get("publish_revision")!), { versionProof: false }).unproven.length).toBeGreaterThan(0);
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
      "20261254 needs 20261253 (retire_over_hold) pasted first; nothing was changed.",
      "20261254 needs 20261214 (intake_door_submit_version''s role switch) pasted first; nothing was changed."]) expect(M).toContain(s);
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_g_254_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_g_254_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect(stripComments(M).match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(stripComments(M).match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it("the inventory is aggregate counts only — every row a COUNT, never a customer column", () => {
    const inv = between(M, "CREATE TEMP TABLE dc_round_g_254_before AS", "\nBEGIN;");
    const top = inv.slice(inv.indexOf("\nSELECT 'inventory"));
    const selects = top.split(/\bUNION ALL\b/);
    expect(selects).toHaveLength(7);
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
    expect((stripComments(tail).match(/\bUNION ALL\b/g) ?? []).length).toBe(11);
  });

  it("every prosrc probe holds on the body it names (verbatim prosrc; '' in a probe is ' in the body)", () => {
    const bodies: Record<string, string> = {
      enforce_document_publish_guard: prosrcOf(G.next), finalize_reviewed_promote: prosrcOf(F.next),
      retire_over_hold: prosrcOf(R.next), enforce_hold_override_record_rail: prosrcOf(RAIL),
      intake_door_submit_version: prosrcOf(D.next),
    };
    const probes = [...tail.matchAll(/prosrc LIKE '((?:[^']|'')*)'\s+FROM pg_proc WHERE proname = '(\w+)'/g)];
    expect(probes.length).toBe(7);
    for (const [, pat, name] of probes) expect(bodies[name], `${name}: ${pat.slice(0, 60)}`).toMatch(likeRe(pat.replace(/''/g, "'")));
  });

  it("defines exactly the guard, finalize_reviewed_promote, retire_over_hold, intake_door_submit_version and the rail (and the inventory's session-local outbox reader), one trigger, no table, no policy, no new notification kind", () => {
    const sc = stripComments(M);
    expect([...sc.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.|pg_temp\.)?(\w+)/g)].map((m) => m[1]))
      .toEqual(["dc_round_g_254_outbox_names", "enforce_document_publish_guard", "finalize_reviewed_promote", "retire_over_hold", "intake_door_submit_version", "enforce_hold_override_record_rail"]);
    // the outbox reader is session-local (pg_temp), created before the inventory and read by it only
    expect(sc).toContain("CREATE OR REPLACE FUNCTION pg_temp.dc_round_g_254_outbox_names(p_org uuid, p_doc text, p_version text)");
    expect(sc.indexOf("pg_temp.dc_round_g_254_outbox_names(p_org")).toBeLessThan(sc.indexOf("CREATE TEMP TABLE dc_round_g_254_before AS"));
    expect(sc.slice(sc.indexOf("\nBEGIN;"))).not.toContain("dc_round_g_254_outbox_names");
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
