// document-control Round G — P32 PUBLISH GUARD LOCK LEG: migration 20261245
// (drafting-flow HAND-13 done-when 2; assigned by the integrator at the DF-P11
// merge, 2026-10-21, DEC-31; ruled under DEC-90 — fail-safe, no regression).
//
//   enforce_document_publish_guard re-created from its NEWEST earlier body
//   (scan — 20261193 today) with EXACTLY one block added, after every earlier
//   refusal and before the controller return: a write that makes a NEW
//   revision current on a document checked out by someone other than the
//   signed-in actor is refused (42501), Document Control included, unless it
//   is (a) publish_revision's own promote — a revision this actor inserted in
//   this transaction on top of the one replaced — or (b) the reviewed promote
//   of the pending draft still in review. Nothing else is re-created.
//
// Byte fidelity: lineDiff (nothing removed; every new line is the block) AND
// an exact cut (the body minus the block IS the base, byte for byte). The
// runtime proof — each door before and after the paste, on PostgreSQL 16 — is
// lib/__tests__/rls/dcP32PublishGuardLock.test.ts (`npm run test:db`).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dir = join(root, "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261245_dc_roundG_publish_guard_lock_leg.sql";
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
const prosrcOf = (body: string) => body.slice(body.indexOf("$$") + 2);

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
const defining = files.filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/.test(stripComments(mig(f))));
const PREV = defining[defining.indexOf(FILE) - 1];
const G = { live: between(mig(PREV), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };

/** The last refusal before the block (REV-22's unforced-move hold refusal, P17). */
const UNFORCED_END = "    RAISE EXCEPTION\n      'Document has an active hold; release the hold before issuing it, or publish over it with Document Control''s recorded override.'\n      USING ERRCODE = 'check_violation';\n  END IF;\n\n";
/** The controller return's comment, which the block precedes. */
const OWN3 = "  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION.\n";
const BLOCK = G.next.slice(G.next.indexOf("  -- HAND-13 (drafting-flow; document-control Round G, P32 PUBLISH GUARD LOCK\n"), G.next.indexOf(OWN3));
const BLOCK_CODE = [
  "  IF OLD.checked_out_by IS NOT NULL",
  "     AND OLD.checked_out_by::text <> v_actor::text",
  "     AND NEW.current_version_id IS NOT NULL",
  "     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id",
  "     AND NOT EXISTS (",
  "           SELECT 1 FROM document_versions v",
  "            WHERE v.id = NEW.current_version_id",
  "              AND v.record_id = NEW.id",
  "              AND v.created_by = v_actor",
  "              AND v.created_at = now()",
  "              AND v.supersedes_version_id IS NOT DISTINCT FROM OLD.current_version_id)",
  "     AND NOT COALESCE(NEW.current_version_id = OLD.pending_version_id",
  "                      AND NEW.pending_version_id IS NULL",
  "                      AND EXISTS (SELECT 1 FROM document_versions v",
  "                                   WHERE v.id = NEW.current_version_id",
  "                                     AND v.record_id = NEW.id",
  "                                     AND v.review_state = 'in_review'), false) THEN",
  "    RAISE EXCEPTION",
  "      'This document is checked out by %, so a new revision can''t be made current here; publish it from the revision flow with an override reason (shown to them and recorded), or ask them to check it in first.',",
  "      COALESCE(NULLIF(btrim(OLD.checked_out_by_name), ''), 'another user')",
  "      USING ERRCODE = 'insufficient_privilege';",
  "  END IF;",
];

const newest = (head: string, upTo = FILE) => {
  const f = files.filter((x) => x <= upTo && stripComments(mig(x)).includes(head)).pop()!;
  return between(mig(f), head, "\n$$;");
};
const PUBLISH = newest("CREATE OR REPLACE FUNCTION publish_revision(");
const FINALIZE = newest("CREATE OR REPLACE FUNCTION finalize_reviewed_promote(");

describe("20261245 — the guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261193 — the scan, not this comment, decides), and it carries REV-28's block and no lock leg", () => {
    expect(defining).toContain(FILE);
    expect(defining[defining.length - 1]).toBe(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261193_dc_roundF_ifc_rev_up_first_issue.sql").toBe(true);
    expect(G.live).toContain("      -- REV-28 (document-control Round F wave 3, P25; DEC-77, option (a),");
    expect(stripComments(G.live)).not.toMatch(/checked_out_by/);
    for (const limb of [UNFORCED_END, OWN3]) expect(G.next, limb.slice(0, 60)).toContain(limb);
  });

  it("nothing removed, every new line is the P32 block, and the body minus it IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    for (const l of onlyInB) expect(BLOCK.split("\n"), l).toContain(l);
    expect(BLOCK.length).toBeGreaterThan(1500);
    expect(G.next.split(BLOCK).length).toBe(2);
    expect(G.next.replace(BLOCK, "")).toBe(G.live);
  });

  it("the block's code is exactly the ruled leg — after the last earlier refusal, before the controller return and the publisher tier", () => {
    expect(code(BLOCK.split("\n"))).toEqual(BLOCK_CODE);
    expect(G.next).toContain(UNFORCED_END + BLOCK + OWN3);
    const at = (s: string) => G.next.indexOf(s);
    expect(at(BLOCK)).toBeLessThan(at("  IF is_org_controller(NEW.org_id) THEN\n    RETURN NEW;\n  END IF;\n"));
    expect(at(BLOCK)).toBeLessThan(at("'You do not have authority to publish revisions in this library.'"));
    expect(at(BLOCK)).toBeGreaterThan(at("  IF NOT v_advancing THEN\n    RETURN NEW;\n  END IF;\n"));
    // the service role returned at the top, as always
    expect(at("  IF v_actor IS NULL THEN\n    RETURN NEW;\n  END IF;\n")).toBeLessThan(at(BLOCK));
    // no declaration, nothing else touched: the same variables, one more refusal
    expect(G.next.slice(0, G.next.indexOf("BEGIN\n"))).toBe(G.live.slice(0, G.live.indexOf("BEGIN\n")));
    const count = (s: string, w: RegExp) => (stripComments(s).match(w) ?? []).length;
    expect(count(G.next, /RAISE EXCEPTION/g)).toBe(count(G.live, /RAISE EXCEPTION/g) + 1);
    for (const v of [/v_issuing/g, /v_restoring/g, /v_new_door/g, /v_advancing/g, /v_unforced_move/g, /v_unforced_issue/g, /v_can_publish/g, /v_has_hold/g, /current_setting/g, /set_config/g, /RETURN NEW/g]) {
      expect(count(G.next, v), String(v)).toBe(count(G.live, v));
    }
    expect(BLOCK).not.toMatch(/:=/);
    expect(stripComments(BLOCK)).not.toMatch(/publish_hold_override|is_org_controller|RETURN/);
    // the ruled code: insufficient_privilege (42501), the holder named, a sentence the person can act on
    expect(BLOCK).toContain("USING ERRCODE = 'insufficient_privilege';");
  });

  it("door (a) is publish_revision's own promote: its newest body decides the lock (locked_by_other / a 5+ character reason from a publisher or the owner / a controller's force) BEFORE it inserts the revision as its actor, at the transaction's time, on top of the current one, and then makes it current", () => {
    const at = (s: string) => {
      const i = PUBLISH.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      return i;
    };
    const lock = at("  IF v_doc.checked_out_by IS NOT NULL\n     AND v_doc.checked_out_by::text <> p_actor::text THEN\n");
    at("    IF p_force AND v_is_controller THEN\n      v_lock_via := 'force';\n    ELSIF p_override_lock THEN\n");
    at("      IF length(btrim(COALESCE(p_override_reason, ''))) < 5 THEN\n");
    const refused = at("        'status', 'locked_by_other',\n");
    const insert = at("    INSERT INTO document_versions (\n");
    const actorNow = at("      p_actor, COALESCE(NULLIF(p_version->>'created_by_name',''), p_actor_name, p_actor::text), v_now,\n");
    const base = at("      CASE WHEN p_as_branch THEN NULL ELSE v_doc.current_version_id END,\n");
    const promote = at("      current_version_id = v_new_id,\n");
    expect(PUBLISH).toContain("  v_now TIMESTAMPTZ := NOW();\n");
    expect(lock).toBeLessThan(refused);
    expect(refused).toBeLessThan(insert);
    expect(insert).toBeLessThan(actorNow);
    expect(actorNow).toBeLessThan(base);
    expect(base).toBeLessThan(promote);
    // ...whether or not it is a revert, a first publish or an override: the
    // INSERT stamps created_at with v_now (NOW(), the transaction's start —
    // never clock_timestamp()) and supersedes_version_id with the pointer it
    // replaces (NULL on a first publish), and the revert target travels in its
    // own column — so door (a) admits an override revert and a first publish
    const insertSql = PUBLISH.slice(insert, PUBLISH.indexOf("    RETURNING id INTO v_new_id;\n", insert));
    expect(insertSql).not.toMatch(/clock_timestamp|statement_timestamp|v_is_revert|v_revert_target|v_lock_via|p_override_lock|p_force/);
    expect(insertSql.match(/v_doc\.current_version_id/g)).toHaveLength(1);
    expect(insertSql).toContain("      NULLIF(p_version->>'reverted_from_version_id','')::uuid,\n");
    expect(PUBLISH).not.toMatch(/v_now\s*:=\s*(?!NOW\(\))/);
    // the actor IS the session for a signed-in call (OWN-5) — the guard's v_actor
    expect(PUBLISH).toContain("    ELSIF p_actor IS DISTINCT FROM auth.uid() THEN\n      RAISE EXCEPTION 'publish_revision: p_actor does not match the calling session.'");
    // the documents row is locked FOR UPDATE first, so OLD.current_version_id is the base it inserted on
    expect(PUBLISH).toContain("  SELECT * INTO v_doc FROM documents WHERE id = p_doc FOR UPDATE;\n");
  });

  it("door (b) is the reviewed promote: finalize_reviewed_promote (and lib/reviewControl.ts promoteThreeStep, its fallback) writes the pending draft current and clears the pending pointer in ONE write, before relabelling it (so it is still in_review when the guard reads it)", () => {
    const promote = FINALIZE.indexOf("     SET current_version_id = p_pending_id,\n");
    expect(promote).toBeGreaterThan(0);
    expect(FINALIZE).toContain("         pending_version_id = NULL,\n");
    expect(FINALIZE.indexOf("     SET review_state = 'approved',\n")).toBeGreaterThan(promote);
    const rc = readFileSync(join(root, "lib", "reviewControl.ts"), "utf8");
    expect(rc).toMatch(/\.update\(\{ current_version_id: pendingId, rev: baseRev, revision: baseRev, status: "Issued", pending_version_id: null,/);
    expect(rc.indexOf('.update({ review_state: "approved"')).toBeGreaterThan(rc.indexOf(".update({ current_version_id: pendingId"));
    // every app door marks a submitted draft in_review (submitForReview; the intake door)
    expect(readFileSync(join(root, "lib", "revisions.ts"), "utf8")).toContain('revision_label: draftLabel, base_rev: baseRev, review_state: "in_review",');
  });

  it("DRLS-16: the guard is executable by no client role; SECURITY DEFINER with its search_path pinned; nothing dropped, nothing else created, no row moved", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    const body = stripComments(M);
    expect(body).not.toMatch(/DROP FUNCTION/);
    expect((body.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/CREATE (?:POLICY|TRIGGER)|GRANT |ALTER TABLE/);
    expect(body.replace(/'(?:[^']|'')*'/g, "''")).not.toMatch(/\bUPDATE\s+documents\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b/i);
    expect(body.replace(/'(?:[^']|'')*'/g, "''")).not.toMatch(/set_config|SET LOCAL/);
  });
});

describe("20261245 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("RAISE EXCEPTION '20261245 needs 20261193 (the REV-28 first-issue block in the publish guard) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_g_245_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_g_245_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(5);
    expect(inventory).not.toMatch(/SELECT \*|document_number|title|d\.id\s+AS|user_email|checked_out_by_name/);
    expect(inventory).toContain("   WHERE d.checked_out_by IS NOT NULL\n");
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1);
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_g_245_before;");
  });

  it("the prerequisite passes on 20261193's guard and on this one (idempotent), and refuses on 20261185's (no REV-28 block)", () => {
    const pre = M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE"));
    const pats = [...pre.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(pats).toHaveLength(1);
    const ok = (body: string) => pats.every((p) => likeRe(p).test(prosrcOf(body)));
    const guardOf = (f: string) => between(mig(f), GUARD_HEAD, "\n$$;");
    expect(ok(guardOf("20261193_dc_roundF_ifc_rev_up_first_issue.sql"))).toBe(true);
    expect(ok(G.next)).toBe(true);
    expect(ok(guardOf("20261185_dc_roundF_status_into_force_issue.sql"))).toBe(false);
  });

  it("every prosrc LIKE probe matches the body of the function it names (prosrc verbatim); the two P32 probes are FALSE on the base", () => {
    const bodies: Record<string, string> = {
      enforce_document_publish_guard: G.next,
      publish_revision: PUBLISH,
      finalize_reviewed_promote: FINALIZE,
    };
    let n = 0;
    const p32: string[] = [];
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      const isP32 = /(?:^|\n)SELECT 'HAND-13 \(P32\)/.test(seg);
      for (const sub of seg.split(/\(SELECT (?=prosrc)/)) {
        const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(sub)?.[1];
        for (const m of sub.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
          expect(fn, sub.slice(0, 80)).toBeDefined();
          const pat = m[2].replace(/''/g, "'");
          // prosrc is verbatim, so a cast in the pattern is the body's own text (only
          // pg_policies' deparsed qual forbids one); none is against a policy here
          expect(sub, pat).not.toMatch(/pg_policies/);
          const body = bodies[fn!];
          expect(body, fn).toBeDefined();
          expect(likeRe(pat).test(prosrcOf(body)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
          if (isP32) p32.push(pat);
          n += 1;
        }
      }
    }
    expect(n).toBe(13); // P32 2 + REV-28/17 2 + the earlier limbs 7 + the doors 2
    expect(p32).toHaveLength(2);
    for (const pat of p32) expect(likeRe(pat).test(prosrcOf(G.live)), pat).toBe(false);
  });

  it("the probes cover the guard's grants, its pinned search_path, its trigger (BEFORE UPDATE only) and a single definition", () => {
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])");
    expect(tail).toContain("AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 4) = 0),");
    expect(tail).toContain("-- Probes: ok = true × 7. Inventory rows: n = the aggregate count.");
    expect(tail.split(/\nUNION ALL\n/).filter((s) => /AS ok,|^SELECT '/.test(s) && !/FROM dc_round_g_245_before/.test(s))).toHaveLength(7);
  });

  it("the header states the finding, the doors, the paste order (after 20261193), that no app deploy is needed, the never-re-paste list, and that it is not a widening", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/HAND-13 enforce_document_publish_guard lost its lock branch in 20260812/);
    expect(head).toMatch(/refused with insufficient_privilege \(42501\) — Document Control\n-- {11}included — unless it is \(a\) publish_revision's own promote/);
    expect(head).toMatch(/HOW TO APPLY: AFTER 20261193 \(required/);
    expect(head).toMatch(/No app deploy is needed before or after/);
    expect(head).toMatch(/⚠ Never re-paste 20261193, 20261185, 20261182, 20261174, 20261165,\n-- 20261164, 20261159, 20261151, 20261144, 20261139, 20261105 or any earlier\n-- guard migration after this one/);
    expect(head).toMatch(/NOT a widening/);
    expect(head).toMatch(/RE-CREATED FROM THE NEWEST BODY/);
    expect(head).not.toMatch(/claude|anthropic|opus|sonnet|haiku/i);
  });

  it("the runtime proof exists: the I-17 harness suite exercises every door before and after the paste", () => {
    const p = join(root, "lib", "__tests__", "rls", "dcP32PublishGuardLock.test.ts");
    expect(existsSync(p)).toBe(true);
    const t = readFileSync(p, "utf8");
    for (const s of ["THE DEFECT, closed", "the lock HOLDER's direct pointer write", "UNLOCKED document", "AUTHORIZED-PUBLISHER OVERRIDE", "Document Control's FORCE", "a hold still never passes", "finalize_reviewed_promote by a publisher", "three-step fallback", "door (b) cannot be borrowed", "door (a) cannot be borrowed", "an OVERRIDE REVERT", "NO current revision yet", "pasted as ONE script"]) {
      expect(t, s).toContain(s);
    }
  });
});
