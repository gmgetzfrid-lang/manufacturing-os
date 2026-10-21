// document-control Round G — P36 STATUS EDITOR PARITY III: migration 20261253
// (REV-36 (1); assigned by the integrator at the P34 merge, 2026-10-21,
// DEC-31; ruled under DEC-90 — fail-safe, no regression).
//
//   enforce_document_publish_guard re-created from its NEWEST earlier body
//   (scan — 20261245 today) with EXACTLY one block added, after the
//   retirement stamp and before the guard's "not advancing" return: a write
//   changing a document's status into Superseded or Void (from any other
//   status) while a hold is active is refused (check_violation) — Document
//   Control included, and into Void anyone below a controller (a write the
//   rest of the guard does not judge) — unless the transaction-local flag
//   app.publish_hold_override names the document. put_back_retired_issue
//   re-created from ITS newest body (20261192) with one additive limb: the
//   reversal's rollback putting a held source back into Superseded, and a
//   rollback putting a held document the caller superseded back into Void,
//   are recorded passes for Document Control (its flag, its own
//   REV_HOLD_OVERRIDDEN). retire_over_hold created: the split / merge source
//   flip and the reversal's park over a hold, recorded.
//
// Byte fidelity: lineDiff (nothing removed; every new line is the block / the
// limb) AND an exact cut (each body minus what was added IS its base, byte
// for byte). The runtime proof — every door before and after the paste, on
// PostgreSQL 16 — is lib/__tests__/rls/dcP36StatusEditorHoldLeg.test.ts
// (`npm run test:db`).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dir = join(root, "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261253_dc_roundG_status_editor_hold_leg.sql";
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
const PUT_BACK_HEAD = "CREATE OR REPLACE FUNCTION put_back_retired_issue(";
const RETIRE_HEAD = "CREATE OR REPLACE FUNCTION retire_over_hold(";
const definingOf = (head: string) => files.filter((f) => stripComments(mig(f)).includes(head));
const prevOf = (head: string) => { const d = definingOf(head); return d[d.indexOf(FILE) - 1]; };
const G = { prev: prevOf(GUARD_HEAD), live: between(mig(prevOf(GUARD_HEAD)), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };
const P = { prev: prevOf(PUT_BACK_HEAD), live: between(mig(prevOf(PUT_BACK_HEAD)), PUT_BACK_HEAD, "\n$$;"), next: between(M, PUT_BACK_HEAD, "\n$$;") };
const R = between(M, RETIRE_HEAD, "\n$$;");

/** The block: from its comment's first line to the "not advancing" return it precedes. */
const NOT_ADVANCING = "  IF NOT v_advancing THEN\n    RETURN NEW;\n  END IF;\n";
const BLOCK = G.next.slice(G.next.indexOf("  -- REV-36 (document-control Round G, P36 STATUS EDITOR PARITY III —\n"), G.next.indexOf(NOT_ADVANCING));
const BLOCK_CODE = [
  "  IF COALESCE(NEW.status IN ('Superseded', 'Void'), false)",
  "     AND NEW.status IS DISTINCT FROM OLD.status",
  "     AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text",
  "     AND (is_org_controller(NEW.org_id) OR NOT COALESCE(v_advancing, false))",
  "     AND EXISTS (",
  "           SELECT 1 FROM document_holds h",
  "            WHERE h.document_id = NEW.id AND h.released_at IS NULL",
  "         ) THEN",
  "    RAISE EXCEPTION",
  "      'Document has an active hold; a held document can''t be superseded or voided here — release the hold first, or replace it through a split or merge (Document Control proceeds over the hold there, recorded, and it is carried to the new document).'",
  "      USING ERRCODE = 'check_violation';",
  "  END IF;",
];

/** put_back_retired_issue's added lines, each a whole block (the limb, the flag set and cleared, the record). */
const PB_ADDED = [
  "  v_reentry boolean := false;\n",
  P.next.slice(P.next.indexOf("  -- REV-36 (document-control Round G, P36, 20261253): since this migration\n"), P.next.indexOf("  -- The put-back: the app's own write for this door, as the caller. The\n")),
  "  IF v_reentry THEN\n    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);\n  END IF;\n",
  "  IF v_reentry THEN\n    PERFORM set_config('app.publish_hold_override', '', true);\n  END IF;\n",
  P.next.slice(P.next.indexOf("  -- REV-36 (P36): the rollback's recorded re-entry, on its own record.\n"), P.next.indexOf("  RETURN CASE WHEN v_forced THEN 'restored_over_hold' ELSE 'restored' END;\n")),
];

describe("20261253 — enforce_document_publish_guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261245 — the scan, not this comment, decides), and it carries the P32 lock leg and no hold leg", () => {
    expect(definingOf(GUARD_HEAD)).toContain(FILE);
    expect(G.prev < FILE).toBe(true);
    expect(G.prev >= "20261245_dc_roundG_publish_guard_lock_leg.sql").toBe(true);
    expect(G.live).toContain("  -- HAND-13 (drafting-flow; document-control Round G, P32 PUBLISH GUARD LOCK\n");
    expect(G.live).not.toContain("a held document can''t be superseded or voided here");
    // a later re-create (another package) must keep this block byte for byte
    for (const later of definingOf(GUARD_HEAD).filter((f) => f > FILE)) expect(between(mig(later), GUARD_HEAD, "\n$$;"), later).toContain(BLOCK);
  });

  it("nothing removed, every new line is the P36 block, and the body minus it IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    for (const l of onlyInB) expect(BLOCK.split("\n"), l).toContain(l);
    expect(BLOCK.length).toBeGreaterThan(1500);
    expect(G.next.split(BLOCK).length).toBe(2);
    expect(G.next.replace(BLOCK, "")).toBe(G.live);
  });

  it("the block's code is exactly the ruled leg — after the retirement stamp, before the 'not advancing' return (so before the controller return and the publisher tier)", () => {
    expect(code(BLOCK.split("\n"))).toEqual(BLOCK_CODE);
    expect(G.next).toContain(BLOCK + NOT_ADVANCING);
    const at = (s: string) => G.next.indexOf(s);
    expect(at(BLOCK)).toBeGreaterThan(at("    NEW.retired_issue_status := NULL;\n    NEW.retired_issue_version_id := NULL;\n  END IF;\n"));
    expect(at(BLOCK)).toBeLessThan(at("  IF is_org_controller(NEW.org_id) THEN\n    RETURN NEW;\n  END IF;\n"));
    expect(at(BLOCK)).toBeLessThan(at("'You do not have authority to publish revisions in this library.'"));
    expect(at(BLOCK)).toBeLessThan(at("  IF OLD.checked_out_by IS NOT NULL\n"));
    // the service role returned at the top, as always
    expect(at("  IF v_actor IS NULL THEN\n    RETURN NEW;\n  END IF;\n")).toBeLessThan(at(BLOCK));
    // no declaration, nothing else touched: the same variables, one more refusal, no assignment
    expect(G.next.slice(0, G.next.indexOf("BEGIN\n"))).toBe(G.live.slice(0, G.live.indexOf("BEGIN\n")));
    const count = (s: string, w: RegExp) => (stripComments(s).match(w) ?? []).length;
    expect(count(G.next, /RAISE EXCEPTION/g)).toBe(count(G.live, /RAISE EXCEPTION/g) + 1);
    expect(count(G.next, /current_setting/g)).toBe(count(G.live, /current_setting/g) + 1);
    for (const v of [/v_issuing/g, /v_restoring/g, /v_new_door/g, /v_unforced_move/g, /v_unforced_issue/g, /v_can_publish/g, /v_has_hold/g, /set_config/g, /RETURN NEW/g]) {
      expect(count(G.next, v), String(v)).toBe(count(G.live, v));
    }
    expect(BLOCK).not.toMatch(/:=/);
    expect(stripComments(BLOCK)).not.toMatch(/RETURN|set_config/);
  });

  it("every ENTRY into Superseded or Void binds (from any other status — a move between retired statuses included, as the publisher tier binds it below a controller), never Archived; a controller always, below one only what the rest of the guard does not judge (the publisher tier keeps its own words)", () => {
    const c = stripComments(BLOCK);
    expect(c).toContain("NEW.status IN ('Superseded', 'Void')");
    expect(c).not.toMatch(/'Archived'/);
    expect(c).toContain("AND NEW.status IS DISTINCT FROM OLD.status");
    expect(c).toContain("(is_org_controller(NEW.org_id) OR NOT COALESCE(v_advancing, false))");
    // the hold is the document_holds row the rest of the guard reads
    expect(c).toContain("WHERE h.document_id = NEW.id AND h.released_at IS NULL");
  });
});

describe("20261253 — put_back_retired_issue re-created from its NEWEST earlier body, with the reversal rollback's re-entry limb", () => {
  it("the base is the newest earlier definition (today 20261192)", () => {
    expect(definingOf(PUT_BACK_HEAD)).toContain(FILE);
    expect(P.prev >= "20261192_dc_roundF_null_prior_status_put_back.sql").toBe(true);
    expect(P.prev < FILE).toBe(true);
    expect(P.live).not.toContain("v_reentry");
  });

  it("nothing removed; every added line is one of the limb's blocks; the body minus them IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(P.live, P.next);
    expect(onlyInA).toEqual([]);
    const added = PB_ADDED.join("\n").split("\n");
    for (const l of onlyInB) expect(added, l).toContain(l);
    let cut = P.next;
    for (const a of PB_ADDED) {
      expect(a.length).toBeGreaterThan(20);
      expect(cut.split(a).length, a.slice(0, 60)).toBeGreaterThanOrEqual(2);
      cut = cut.replace(a, "");
    }
    expect(cut).toBe(P.live);
  });

  it("the limb opens only for Document Control asking the force on a rollback door, a hold active, for the two re-entries the guard now binds — the reversal's rollback putting a restored source back INTO Superseded, and a rollback putting back Void after the caller's own retirement — after REV-23's and REV-29's doors (which it never widens)", () => {
    const limb = stripComments(PB_ADDED[1]);
    for (const s of [
      "IF NOT v_forced",
      "AND p_via <> 'unarchive'",
      "AND COALESCE(p_force_hold, false)",
      "AND ((p_via = 'reversal_rollback'",
      "AND btrim(COALESCE(p_status, '')) = 'Superseded'",
      "AND v_status IS DISTINCT FROM 'Superseded')",
      "OR (btrim(COALESCE(p_status, '')) = 'Void'",
      "AND v_status = 'Superseded'",
      "AND v_retired_by = v_uid))",
      "AND is_org_controller(v_org)",
      "WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN",
      "v_reentry := true;",
    ]) expect(limb, s).toContain(s);
    expect(stripComments(PB_ADDED.join("\n"))).not.toMatch(/v_forced\s*:=/);
    expect(P.next.indexOf(PB_ADDED[1])).toBeGreaterThan(P.next.indexOf("  -- REV-29 (P25): the recorded door for a NULL status."));
    // its record: REV_HOLD_OVERRIDDEN, retiredOverHold, and the put-back's answer
    expect(PB_ADDED[4]).toContain("VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,");
    expect(PB_ADDED[4]).toContain("'retiredOverHold', true,");
    expect(PB_ADDED[4]).toContain("    RETURN 'restored_over_hold';\n");
    // still SECURITY INVOKER, search_path pinned; grants as before (DRLS-16)
    expect(P.next).toContain(") RETURNS text\nLANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(M).toContain("REVOKE ALL ON FUNCTION put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text) FROM PUBLIC, anon, service_role;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text) TO authenticated;");
  });
  it("P36 final fix pass: the reversal's re-entry is bound to that reversal's OWN standing restore record — else refused 42501 before any write; the Void re-entry is unchanged", () => {
    const limb = stripComments(PB_ADDED[1]);
    const ev = limb.slice(limb.indexOf("IF v_reentry\n"));
    expect(ev.length).toBeGreaterThan(200);
    for (const s of [
      "IF v_reentry\n     AND p_via = 'reversal_rollback'\n     AND btrim(COALESCE(p_status, '')) = 'Superseded'\n     AND NOT EXISTS (",
      // the record restore_reversed_source writes in the restore's own transaction (20261164 / 20261192)
      "ON e.id::text = a.details->>'reversedAuditEventId'",
      "AND e.org_id = v_org",
      "AND e.action IN ('DOC_SPLIT', 'DOC_MERGED')",
      "WHERE a.org_id = v_org",
      "AND a.resource_id = p_document_id::text",
      "AND a.action = 'REV_HOLD_OVERRIDDEN'",
      "AND a.user_id = v_uid",
      "AND a.details->>'via' = 'reversal_restore'",
      "AND (a.details->>'newStatus') IS NOT DISTINCT FROM v_status",
      // not corrected since (the reversal's REV_HOLD_OVERRIDE_UNDONE), its reversal not landed
      "AND u.action = 'REV_HOLD_OVERRIDE_UNDONE'",
      "AND u.details->>'via' = 'reversal_restore'",
      "AND u.\"timestamp\" >= a.\"timestamp\")",
      "AND r.resource_id = e.resource_id",
      "AND r.action IN ('DOC_SPLIT_REVERSED', 'DOC_MERGE_REVERSED')",
      "USING ERRCODE = 'insufficient_privilege';",
    ]) expect(ev, s).toContain(s);
    // the restore writes exactly that row: via, the event, newStatus — what the binding reads
    const restore = between(mig("20261192_dc_roundF_null_prior_status_put_back.sql"), "CREATE OR REPLACE FUNCTION restore_reversed_source(", "\n$$;");
    for (const s of ["'via', 'reversal_restore',", "'reversedAuditEventId', p_reversal_of,", "'newStatus', p_status,", "VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,"]) expect(restore, s).toContain(s);
    // the correction the reversal writes after the put-back is the one the binding reads (lib/documentLifecycle/reverse.ts correctRecordedPass)
    const rev = readFileSync(join(process.cwd(), "lib", "documentLifecycle", "reverse.ts"), "utf8");
    expect(rev).toMatch(/action: "REV_HOLD_OVERRIDE_UNDONE",[\s\S]{0,400}via: "reversal_restore",[\s\S]{0,120}reversedAuditEventId: door\.reversalOf,/);
    // the refusal precedes the flag and the write; the arm only narrows (no v_reentry := in it)
    expect(P.next.indexOf("USING ERRCODE = 'insufficient_privilege';\n  END IF;\n\n  -- The put-back:")).toBeGreaterThan(0);
    expect(ev.slice(0, ev.indexOf("USING ERRCODE"))).not.toMatch(/v_reentry\s*:=|set_config/);
    // the Void arm keeps REV-23's binding: the caller's own retirement
    expect(limb).toContain("OR (btrim(COALESCE(p_status, '')) = 'Void'\n              AND v_status = 'Superseded'\n              AND v_retired_by = v_uid))");
  });
});

describe("20261253 — retire_over_hold: the single doors' recorded pass over a hold", () => {
  it("runs as the caller (SECURITY INVOKER, search_path pinned); authenticated only (DRLS-16); refuses no session, an unknown door and a blank reason", () => {
    expect(R).toContain(") RETURNS text\nLANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$");
    expect(M).toContain("REVOKE ALL ON FUNCTION retire_over_hold(uuid, text, text, timestamptz, text, boolean) FROM PUBLIC, anon, service_role;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION retire_over_hold(uuid, text, text, timestamptz, text, boolean) TO authenticated;");
    expect(R).toContain("  IF v_uid IS NULL THEN\n");
    expect(R).toContain("  IF p_via IS NULL OR p_via NOT IN ('split', 'merge', 'reversal_park') THEN\n");
    expect(R).toContain("  IF btrim(COALESCE(p_reason, '')) = '' THEN\n");
  });

  it("the flag is set only for Document Control's move of a held document into Superseded from any other status ASKING for the override (p_force_hold, default false — chosen, never implied), around the one write, cleared after it, and the pass recorded in the same transaction", () => {
    const at = (s: string) => { const i = R.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    // P36 review fix: the override is asked for, as put_back_retired_issue's p_force_hold — never implied.
    expect(R).toContain("  p_supersession_moc text DEFAULT NULL,\n  p_force_hold boolean DEFAULT false\n) RETURNS text");
    const cond = at("  IF COALESCE(p_force_hold, false)\n     AND v_status IS DISTINCT FROM 'Superseded'\n     AND is_org_controller(v_org)\n     AND EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN\n    v_forced := true;\n");
    const set = at("    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);\n");
    const write = at("    UPDATE documents\n       SET status = 'Superseded',\n");
    const clear = at("    PERFORM set_config('app.publish_hold_override', '', true);\n");
    const record = at("    VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,");
    expect(cond).toBeLessThan(set);
    expect(set).toBeLessThan(write);
    expect(write).toBeLessThan(clear);
    expect(clear).toBeLessThan(record);
    expect((stripComments(R).match(/v_forced := true/g) ?? []).length).toBe(1);
    expect((stripComments(R).match(/set_config/g) ?? []).length).toBe(2);
  });

  it("writes the doors' own columns: a split / merge source's (with the MOC column) and the reversal's park (without it); the actor is the session, never a parameter", () => {
    const park = R.slice(R.indexOf("  IF p_via = 'reversal_park' THEN\n"), R.indexOf("  ELSE\n", R.indexOf("  IF p_via = 'reversal_park' THEN\n")));
    expect(park).toContain("superseded_by_user = v_uid,");
    expect(park).not.toContain("supersession_moc");
    const src = R.slice(R.indexOf("  ELSE\n", R.indexOf("  IF p_via = 'reversal_park' THEN\n")), R.indexOf("  IF v_forced THEN\n    PERFORM set_config('app.publish_hold_override', '', true);"));
    for (const col of ["status = 'Superseded',", "superseded_at = v_at,", "superseded_by_user = v_uid,", "supersession_reason = p_reason,", "supersession_moc = p_supersession_moc,", "updated_at = v_at,", "updated_by = v_uid"]) expect(src, col).toContain(col);
    // the app's own write (lib/documentLifecycle/common.ts markSupersededAndLink) carries exactly these columns
    const common = readFileSync(join(root, "lib", "documentLifecycle", "common.ts"), "utf8");
    expect(common).toMatch(/status: "Superseded",\s*superseded_at: now,\s*superseded_by_user: actor\.actorUserId,\s*supersession_reason: reason\.trim\(\),\s*supersession_moc: mocReference\?\.trim\(\) \|\| null,\s*updated_at: now,\s*updated_by: actor\.actorUserId,/);
    const reverse = readFileSync(join(root, "lib", "documentLifecycle", "reverse.ts"), "utf8");
    expect(reverse).toMatch(/status: "Superseded",\s*superseded_at: now,\s*superseded_by_user: actorUserId,\s*supersession_reason: supersessionReason,\s*updated_at: now,\s*updated_by: actorUserId,/);
  });
});

describe("20261253 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("RAISE EXCEPTION '20261253 needs 20261245 (the checkout lock leg in the publish guard) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_g_253_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_g_253_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(4);
    expect(inventory).not.toMatch(/SELECT \*|document_number|title|d\.id\s+AS|user_email|checked_out_by_name|details/);
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1);
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_g_253_before;");
  });

  it("the prerequisite passes on 20261245's guard and on this one (idempotent), and refuses on 20261193's (no lock leg)", () => {
    const pre = M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE"));
    const pats = [...pre.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(pats).toHaveLength(1);
    const ok = (body: string) => pats.every((p) => likeRe(p).test(prosrcOf(body)));
    const guardOf = (f: string) => between(mig(f), GUARD_HEAD, "\n$$;");
    expect(ok(guardOf("20261245_dc_roundG_publish_guard_lock_leg.sql"))).toBe(true);
    expect(ok(G.next)).toBe(true);
    expect(ok(guardOf("20261193_dc_roundF_ifc_rev_up_first_issue.sql"))).toBe(false);
  });

  it("every prosrc LIKE probe matches the body of the function it names (prosrc verbatim); the P36 probes are FALSE on the bases", () => {
    const bodies: Record<string, string> = { enforce_document_publish_guard: G.next, put_back_retired_issue: P.next, retire_over_hold: R };
    const bases: Record<string, string> = { enforce_document_publish_guard: G.live, put_back_retired_issue: P.live };
    let n = 0;
    const p36: Array<{ fn: string; pat: string }> = [];
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      const isP36 = /(?:^|\n)SELECT 'REV-36 \(P36\)/.test(seg) || /(?:^|\n)SELECT 'put_back_retired_issue: the reversal rollback/.test(seg);
      for (const sub of seg.split(/\(SELECT (?=prosrc)/)) {
        const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(sub)?.[1];
        for (const m of sub.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
          expect(fn, sub.slice(0, 80)).toBeDefined();
          const pat = m[2].replace(/''/g, "'");
          expect(sub, pat).not.toMatch(/pg_policies/);
          const body = bodies[fn!];
          expect(body, fn).toBeDefined();
          expect(likeRe(pat).test(prosrcOf(body)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
          if (isP36 && bases[fn!]) p36.push({ fn: fn!, pat });
          n += 1;
        }
      }
    }
    expect(n).toBe(16); // the guard: P36 2 + P32 1 + the earlier limbs 9; put_back_retired_issue 3 (the limb, the earlier doors, the reversal arm's evidence); retire_over_hold 1
    expect(p36.length).toBeGreaterThanOrEqual(3);
    // the leg's and the limb's own probes are false on the bodies they replace
    for (const { fn, pat } of p36.filter((x) => /superseded or voided here|v_reentry/.test(x.pat))) expect(likeRe(pat).test(prosrcOf(bases[fn])), pat).toBe(false);
  });

  it("the probes cover the grants, the pinned search_paths, the trigger (BEFORE UPDATE only) and a single definition of each function", () => {
    expect(tail).toContain("-- Probes: ok = true × 10. Inventory rows: n = the aggregate count.");
    expect(tail.split(/\nUNION ALL\n/).filter((s) => /AS ok,|^SELECT '/.test(s) && !/FROM dc_round_g_253_before/.test(s))).toHaveLength(10);
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 4) = 0),");
    expect(tail).toContain("AND has_function_privilege('authenticated', 'retire_over_hold(uuid, text, text, timestamptz, text, boolean)', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'retire_over_hold(uuid, text, text, timestamptz, text, boolean)', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text)', 'EXECUTE')");
    expect(tail).toContain("WHERE n.nspname = 'public' AND p.proname = 'retire_over_hold')");
  });

  it("nothing else is created, dropped or moved: three functions (one created), no policy, trigger, table or row write outside the bodies; the only drop is a draft overload of retire_over_hold without p_force_hold (one definition stands)", () => {
    const body = stripComments(M);
    expect((body.match(/DROP FUNCTION/g) ?? []).length).toBe(1);
    expect(body).toContain("DROP FUNCTION IF EXISTS retire_over_hold(uuid, text, text, timestamptz, text);\nCREATE OR REPLACE FUNCTION retire_over_hold(");
    expect(body).not.toMatch(/DROP TRIGGER|DROP POLICY/);
    expect((body.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(3);
    expect(body).not.toMatch(/CREATE (?:POLICY|TRIGGER)|ALTER TABLE|CREATE TABLE (?!.*TEMP)/);
    // row writes live only inside the two function bodies (the doors' own writes and records)
    const outside = stripComments(M.replace(G.next, "").replace(P.next, "").replace(R, "")).replace(/'(?:[^']|'')*'/g, "''");
    expect(outside).not.toMatch(/\bUPDATE\s+documents\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|set_config/i);
  });

  it("the header states the finding, the doors, the paste order (after 20261245 and 20261247), the deploy order (the P36 app first, then the paste — an app before P36 is refused its forced split / merge / park), the schema-cache window, the never-re-paste list, and that it is not a widening", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/REV-36 {2}Since P34 a status editor/);
    expect(head).toMatch(/HOW TO APPLY: AFTER 20261245 \(required/);
    expect(head).toMatch(/after 20261247 \(paste guide row 191/);
    expect(head).toMatch(/20261245 \(row 187\) is HOLD behind 20261193 \(row 150\)/);
    // P36 final fix pass: after the P35 merge — 20261252 (row 192) re-creates finalize_reviewed_promote only
    expect(head).toMatch(/Independent of 20261252 \(row 192, P35: it\s+-- re-creates finalize_reviewed_promote only/);
    expect(head).toMatch(/⚠ DEPLOY FIRST: deploy the app carrying document-control P36/);
    expect(head).toMatch(/THEN paste\. The P36 app works\s+-- BEFORE and AFTER the paste/);
    expect(head).toMatch(/An app before P36 makes those flips with the bare\s+-- write, which this guard refuses for Document Control over an active hold/);
    expect(head).toMatch(/while PostgREST reloads its schema cache, the P36 app may still get\s+-- PGRST202, fall back to the bare write and be refused the same way once/);
    expect(head).toMatch(/nothing is retried automatically/);
    expect(head).not.toMatch(/no deploy order is needed/i);
    expect(head).toMatch(/PGRST202 \/ 42883/);
    expect(head).toMatch(/⚠ Never re-paste 20261245, 20261193/);
    expect(head).toMatch(/nor 20261192 or 20261165/);
    expect(head).toMatch(/NOT a widening/);
    expect(head).toMatch(/RE-CREATED FROM THE NEWEST BODY/);
    expect(head).not.toMatch(/claude|anthropic|opus|sonnet|haiku/i);
  });

  it("the runtime proof exists: the I-17 harness suite exercises every door before and after the paste", () => {
    const p = join(root, "lib", "__tests__", "rls", "dcP36StatusEditorHoldLeg.test.ts");
    expect(existsSync(p)).toBe(true);
    const t = readFileSync(p, "utf8");
    for (const s of ["THE DEFECT, closed", "Void over an active hold", "held Draft", "below a controller, a supersession over a hold", "NO active hold", "every non-retiring write", "move between retired statuses", "recorded doors cover the same moves", "service role", "THE SINGLE DOORS still work", "reversal's park", "ASKED for, never implied", "opens for nobody else", "failed REVERSAL's rollback", "other doors answer the same", "pasted as ONE script", "prerequisite refuses"]) {
      expect(t, s).toContain(s);
    }
  });
});
