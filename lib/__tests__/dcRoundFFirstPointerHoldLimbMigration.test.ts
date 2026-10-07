// document-control Round F wave 3 — P21 FIRST-POINTER-WRITE HOLD LIMB:
// migration 20261182 (REV-25).
//
//   enforce_document_publish_guard re-created from its NEWEST earlier body
//   (scan — 20261174 today) with EXACTLY the P21 block added, two widenings
//   of v_unforced_move (refused over an active hold, in REV-20 (b)'s
//   sentence, unless the flag a recorded force sets names the document):
//   (i)  a controller's FIRST pointer write (OLD current_version_id NULL ->
//        a revision), in any status;
//   (ii) a controller's CLEAR of the pointer of a document in an issue
//        status, whatever status the write leaves.
//   The Draft route is closed by (i). Nothing else is re-created or created.
//
//   The decision pinned here: the guard tells an existing document's first
//   pointer write from a creation's (REV-17) by the ACTIVE HOLD. TG_OP cannot
//   (trg_document_publish_guard fires BEFORE UPDATE only), nor can "created in
//   this transaction" (each creation writes its first pointer in its own
//   request); no creation carries a hold at that write (HLD-2 carries a
//   source's holds onto a new sheet only after it).
//
// Byte fidelity: lineDiff (nothing removed; every new line is an addition)
// AND an exact cut (the re-created body minus the addition IS the base, byte
// for byte). The script was run on a throwaway PostgreSQL 16 (REV-25's
// record); the behaviour is driven through the real app functions in
// dcRoundFFirstPointerHoldLimb.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261182_dc_roundF_first_pointer_hold_limb.sql";
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
/** A prosrc LIKE pattern as a RegExp over a body (% any run, _ any one character). */
const likeRe = (pat: string) => new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
const prosrcOf = (body: string) => body.slice(body.indexOf("$$") + 2);
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
/** The definition this migration re-creates from: the newest one BEFORE it (scanned). */
const defining = files.filter((f) => /CREATE OR REPLACE FUNCTION enforce_document_publish_guard\(\)/.test(stripComments(mig(f))));
const PREV = defining[defining.indexOf(FILE) - 1];
const G = { live: between(mig(PREV), GUARD_HEAD, "\n$$;"), next: between(M, GUARD_HEAD, "\n$$;") };
const STAMP_BLOCK = "  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN\n";

/** The guard's one addition, as contiguous text. */
const G_LIMB = G.next.slice(
  G.next.indexOf("  -- REV-25 (document-control Round F wave 3, P21): two more controller"),
  G.next.indexOf(STAMP_BLOCK),
);
const UNFORCED_HOLD_SQL = "'Document has an active hold; release the hold before issuing it, or publish over it with Document Control''s recorded override.'";
/** P20's limb (a), the last statement before the P21 block in the base. */
const P20_A_CODE = "  v_new_door := v_new_door\n                OR COALESCE(v_issuing\n                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id\n                            AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                            AND OLD.retired_issue_version_id IS NOT NULL\n                            AND OLD.retired_issue_version_id IS DISTINCT FROM OLD.current_version_id, false);\n";
const P20_B_CODE = "  v_unforced_move := v_unforced_move\n                     OR COALESCE(OLD.current_version_id IS NOT NULL\n                                 AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')\n                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                                 AND is_org_controller(NEW.org_id), false);\n";
const P17_MOVE = "  v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS NOT NULL\n                              AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id\n                              AND is_controlled_issue_status(OLD.status)\n                              AND is_controlled_issue_status(NEW.status)\n                              AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                              AND is_org_controller(NEW.org_id), false);\n";
const P19_LIMB_CODE = "  v_new_door := v_new_door\n                OR COALESCE(v_restoring\n                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text\n                            AND is_org_controller(NEW.org_id), false);\n";
const REV17_BLOCK = "      IF OLD.current_version_id IS NULL AND v_intake_link IS NULL\n         AND COALESCE(NEW.status, '') NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')\n         AND NOT is_org_controller(NEW.org_id)\n";

describe("20261182 — the guard re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261174 — the scan, not this comment, decides)", () => {
    expect(defining).toContain(FILE);
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261174_dc_roundF_retired_hold_limbs.sql").toBe(true);
    // the base carries P20's two limbs (the prerequisite this file checks for)
    expect(G.live).toContain(P20_B_CODE);
    expect(G.live).toContain(P20_A_CODE);
    // …and every earlier limb survives in the re-created body (a re-create, not a rewrite)
    for (const limb of [P20_B_CODE, P20_A_CODE, P19_LIMB_CODE, P17_MOVE, REV17_BLOCK, "  v_unforced_issue := COALESCE(v_issuing\n", "  v_restoring := COALESCE(v_issuing\n"]) {
      expect(G.next, limb.slice(0, 60)).toContain(limb);
    }
  });

  it("nothing removed, every new line is the P21 block, and the body minus it IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(G.live, G.next);
    expect(onlyInA).toEqual([]);
    const added = G_LIMB.split("\n");
    for (const l of onlyInB) expect(added, l).toContain(l);
    expect(G_LIMB.length).toBeGreaterThan(400);
    expect(G.next.split(G_LIMB).length).toBe(2);
    expect(G.next.replace(G_LIMB, "")).toBe(G.live);
  });

  it("the added code is exactly the two P21 limbs — (i) the first pointer write and (ii) the clear on an issued document, both as unforced moves — right after P20's limbs and before the stamp is rewritten", () => {
    expect(code(G_LIMB.split("\n"))).toEqual([
      "  v_unforced_move := v_unforced_move",
      "                     OR COALESCE(OLD.current_version_id IS NULL",
      "                                 AND NEW.current_version_id IS NOT NULL",
      "                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text",
      "                                 AND is_org_controller(NEW.org_id), false);",
      "  v_unforced_move := v_unforced_move",
      "                     OR COALESCE(OLD.current_version_id IS NOT NULL",
      "                                 AND NEW.current_version_id IS NULL",
      "                                 AND is_controlled_issue_status(OLD.status)",
      "                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text",
      "                                 AND is_org_controller(NEW.org_id), false);",
    ]);
    expect(G.next).toContain(P20_A_CODE + G_LIMB + STAMP_BLOCK);
    // both widen v_unforced_move (P17's, then P20's (b), kept byte for byte above), read only by P17's refusal, after them
    expect(G.next.indexOf(P17_MOVE)).toBeGreaterThan(0);
    expect(G.next.indexOf(P17_MOVE)).toBeLessThan(G.next.indexOf(P20_B_CODE));
    expect(G.next.indexOf(P20_B_CODE)).toBeLessThan(G.next.indexOf(G_LIMB));
    expect(G.next).toContain(`  IF v_unforced_move AND EXISTS (\n       SELECT 1 FROM document_holds h\n        WHERE h.document_id = NEW.id AND h.released_at IS NULL\n     ) THEN\n    RAISE EXCEPTION\n      ${UNFORCED_HOLD_SQL}`);
    expect(G.next.indexOf("  IF v_unforced_move AND EXISTS (")).toBeGreaterThan(G.next.indexOf(G_LIMB));
    // the refusal is reached: both writes change the pointer, so v_advancing is already true for them
    expect(G.next).toContain("  v_advancing :=\n       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)\n");
    expect(G.next.indexOf("  IF NOT v_advancing THEN\n    RETURN NEW;\n  END IF;")).toBeLessThan(G.next.indexOf("  IF v_unforced_move AND EXISTS ("));
    const count = (s: string, w: RegExp) => (stripComments(s).match(w) ?? []).length;
    expect(count(G.next, /v_unforced_move/g)).toBe(count(G.live, /v_unforced_move/g) + 4);
    expect(count(G.next, /v_new_door/g)).toBe(count(G.live, /v_new_door/g));
    // no new declaration, no new refusal sentence; REV-17's creation rule untouched
    expect(G.next.slice(0, G.next.indexOf("BEGIN\n"))).toBe(G.live.slice(0, G.live.indexOf("BEGIN\n")));
    expect(G_LIMB).not.toMatch(/RAISE/);
    expect(G.next).toContain(REV17_BLOCK);
  });

  it("(i) binds a first pointer write in ANY status; (ii) binds a clear OUT OF an issue status whatever status the write leaves; both honour the flag and bind a controller only", () => {
    const [i, ii] = code(G_LIMB.split("\n")).join("\n").split("\n  v_unforced_move := v_unforced_move");
    expect(i).toContain("OR COALESCE(OLD.current_version_id IS NULL\n                                 AND NEW.current_version_id IS NOT NULL\n");
    expect(i).not.toMatch(/status/);
    expect(ii).toContain("OR COALESCE(OLD.current_version_id IS NOT NULL\n                                 AND NEW.current_version_id IS NULL\n                                 AND is_controlled_issue_status(OLD.status)\n");
    expect(ii).not.toMatch(/NEW\.status/);
    for (const limb of [i, ii]) {
      expect(limb).toContain("AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text");
      expect(limb).toContain("AND is_org_controller(NEW.org_id), false);");
    }
  });

  it("the decision — a creation is told apart by the active hold, not by TG_OP or the transaction: the trigger fires BEFORE UPDATE only (every write it sees is an UPDATE) and the guard never reads TG_OP or xmin", () => {
    // every CREATE TRIGGER of the guard in the sequence is BEFORE UPDATE ON documents, never INSERT
    const creates = files.flatMap((f) => [...stripComments(mig(f)).matchAll(/CREATE TRIGGER trg_document_publish_guard\s+([^;]*);/g)].map((m) => ({ f, def: m[1] })));
    expect(creates.length).toBeGreaterThan(0);
    for (const { f, def } of creates) {
      expect(def, f).toMatch(/^BEFORE UPDATE ON documents\s+FOR EACH ROW\s+EXECUTE FUNCTION enforce_document_publish_guard\(\)$/);
    }
    expect(stripComments(G.next)).not.toMatch(/TG_OP|xmin|txid_current|pg_current_xact_id/);
    // the header and the block state the decision
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/DECIDED — how the guard tells an existing document's first\n-- {11}pointer write from a creation's \(REV-17\): by the active hold\./);
    expect(G_LIMB).toContain("this trigger fires BEFORE UPDATE only (TG_OP is always UPDATE here)");
  });

  it("…and no creation carries a hold at its first pointer write: every creation door inserts the row, then the version, then writes the pointer, with no hold in between; HLD-2's carry onto a new split / merge sheet runs after the sheet is created", () => {
    const fnBody = (file: string, head: string) => {
      const s = src(file);
      const a = s.indexOf(head);
      expect(a, head).toBeGreaterThanOrEqual(0);
      return s.slice(a, s.indexOf("\n}\n", a));
    };
    const doors = [
      fnBody("lib/revisions.ts", "export async function createDocumentWithFile("),
      fnBody("lib/documentLifecycle/common.ts", "export async function createNewDocWithFirstVersion("),
    ];
    for (const body of doors) {
      const ins = body.indexOf('.from("documents")\n    .insert(');
      const ver = body.indexOf('.from("document_versions")\n    .insert(');
      const ptr = body.search(/\.update\(\{ current_version_id: (?:ver\.id|versionId), updated_at: now \}\)/);
      expect(ins).toBeGreaterThan(0);
      expect(ver).toBeGreaterThan(ins);
      expect(ptr).toBeGreaterThan(ver);
      expect(body).not.toMatch(/document_holds/);
    }
    // the library page's upload (read only — another package owns the file): insert, version, pointer; no hold write anywhere on the page
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    const pIns = page.indexOf('const { data: newDoc, error: docErr } = await supabase.from("documents").insert({');
    const pVer = page.indexOf('const { data: newVersion, error: verErr } = await supabase.from("document_versions").insert({');
    const pPtr = page.indexOf('.from("documents").update({ current_version_id: newVersion.id }).eq("id", newDoc.id).select("id");');
    expect(pIns).toBeGreaterThan(0);
    expect(pVer).toBeGreaterThan(pIns);
    expect(pPtr).toBeGreaterThan(pVer);
    expect(page).not.toMatch(/from\("document_holds"\)\s*\.insert/);
    // split / merge: the carry follows the creation of every sheet
    for (const f of ["lib/documentLifecycle/split.ts", "lib/documentLifecycle/merge.ts"]) {
      const s = src(f);
      const created = s.indexOf("await createNewDocWithFirstVersion({");
      const carried = s.indexOf("await copyActiveHoldsToDoc({");
      expect(created, f).toBeGreaterThan(0);
      expect(carried, f).toBeGreaterThan(created);
    }
    // the app's hold inserts: lib/holds.ts (placing one on an existing document) and the lifecycle carry — nothing else
    const walk = (d: string): string[] => readdirSync(join(process.cwd(), d)).flatMap((n) => {
      const p = join(d, n);
      if (n === "node_modules" || n === "__tests__" || n.startsWith(".")) return [];
      return statSync(join(process.cwd(), p)).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
    const holdInserters = ["lib", "app", "components"].flatMap(walk)
      .filter((p) => /from\("document_holds"\)\s*\.insert\(/.test(src(p)));
    expect(holdInserters.sort()).toEqual(["lib/documentLifecycle/common.ts", "lib/holds.ts"]);
  });

  it("every app write of current_version_id names a revision — none clears a pointer — and the only ones are a creation's first pointer write and the review promote's pre-20261151 fallback (the census REV-24 took, re-taken)", () => {
    const walk = (d: string): string[] => readdirSync(join(process.cwd(), d)).flatMap((n) => {
      const p = join(d, n);
      if (n === "node_modules" || n === "__tests__" || n.startsWith(".")) return [];
      return statSync(join(process.cwd(), p)).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
    const writes = ["lib", "app", "components"].flatMap(walk).flatMap((p) =>
      src(p).split("\n").filter((l) => /\.(?:update|insert|upsert)\(\{[^}]*\bcurrent_version_id:/.test(l)).map((l) => `${p}: ${l.trim()}`));
    expect(writes.map((w) => w.replace(/: .*current_version_id: ([\w.]+).*/, ": $1")).sort()).toEqual([
      "app/(protected)/documents/[libraryId]/page.tsx: newVersion.id",
      "lib/documentLifecycle/common.ts: versionId",
      "lib/reviewControl.ts: pendingId",
      "lib/revisions.ts: ver.id",
    ]);
    for (const w of writes) expect(w).not.toMatch(/current_version_id: null/);
  });

  it("DRLS-16: the guard is executable by no client role; SECURITY DEFINER with its search_path pinned; nothing dropped, nothing else created", () => {
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(G.next).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    const body = stripComments(M);
    expect(body).not.toMatch(/DROP FUNCTION/);
    expect((body.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/CREATE (?:POLICY|TRIGGER)|GRANT /);
    expect(body).not.toMatch(/FUNCTION\s+(?:public\.)?(?:put_back_retired_issue|restore_reversed_source|publish_revision|finalize_reviewed_promote)\b/);
  });

  it("the flag in the whole sequence is still SET only by 20261151, 20261164 and 20261165 — this file only reads it (with those reads stripped, it never names the flag)", () => {
    const withoutFlagReads = (sql: string) => sql
      .split("current_setting('app.publish_hold_override', true)").join("")
      .split("current_setting(''app.publish_hold_override'', true)").join("");
    const setters = files.filter((f) => /publish_hold_override/.test(withoutFlagReads(stripComments(mig(f)))));
    expect(setters).toEqual([
      "20261151_dc_roundF_promote_transaction_and_hold_override.sql",
      "20261164_dc_roundF_reversal_restore.sql",
      "20261165_dc_roundF_stamped_put_back.sql",
    ]);
    expect(stripComments(M)).toContain("current_setting('app.publish_hold_override', true)");
    // the only set_config this file names is inside a probe's LIKE pattern (a string literal), never a call
    expect(stripComments(M).replace(/'(?:[^']|'')*'/g, "''")).not.toMatch(/set_config|SET LOCAL/);
    expect(stripComments(M).match(/set_config\(''app/g)).toBeNull();
  });
});

describe("20261182 — the one-paste shape", () => {
  const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

  it("prerequisite check → inventory TEMP TABLE (counts only) → one BEGIN/COMMIT → ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'");
    expect(pre).toBeGreaterThan(0);
    expect(M).toContain("RAISE EXCEPTION '20261182 needs 20261174 (the REV-24 retired-document hold limbs in the publish guard) pasted first; nothing was changed.';");
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE dc_round_f_182_before AS"));
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_182_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = stripComments(M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;")));
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(3);
    expect(inventory).not.toMatch(/SELECT \*|document_number|title|d\.id\s+AS|user_email/);
    // the population: documents under an active hold; whether each has a current revision; whether its status is an issue
    expect(inventory).toContain("  SELECT d.current_version_id IS NOT NULL AS has_current,\n         is_controlled_issue_status(d.status) AS in_issue\n    FROM documents d\n   WHERE EXISTS (SELECT 1 FROM document_holds h\n                  WHERE h.document_id = d.id AND h.released_at IS NULL)\n)");
    for (const w of ["  FROM held WHERE NOT has_current\n", "  FROM held WHERE NOT has_current AND in_issue\n", "  FROM held WHERE has_current AND in_issue;"]) {
      expect(inventory, w).toContain(w);
    }
    const c = stripComments(tail).replace(/'(?:[^']|'')*'/g, "''");
    expect((c.match(/;/g) ?? []).length).toBe(1); // one statement: the final SELECT
    expect(c).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(c).toContain("UNION ALL\nSELECT inventory, NULL::boolean, n FROM dc_round_f_182_before;");
  });

  it("the prerequisite passes on 20261174's guard (P20's limbs, with put_back_retired_issue) and on this one (idempotent), and refuses on 20261165's, 20261164's and 20261159's", () => {
    const pat = /prosrc LIKE '((?:[^']|'')*)'\)/.exec(M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE")))![1].replace(/''/g, "'");
    expect(pat).not.toMatch(/::/);
    const re = likeRe(pat);
    const guardOf = (f: string) => prosrcOf(between(mig(f), GUARD_HEAD, "\n$$;"));
    expect(re.test(guardOf("20261174_dc_roundF_retired_hold_limbs.sql"))).toBe(true);
    expect(re.test(prosrcOf(G.next))).toBe(true);
    for (const f of ["20261165_dc_roundF_stamped_put_back.sql", "20261164_dc_roundF_reversal_restore.sql", "20261159_dc_roundF_guard_owner_and_held_pointer.sql"]) {
      expect(re.test(guardOf(f)), f).toBe(false);
    }
    expect(M.slice(M.indexOf("DO $$"), M.indexOf("CREATE TEMP TABLE"))).toContain("OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'put_back_retired_issue') THEN");
  });

  it("every prosrc LIKE / NOT LIKE probe matches the body of the function it names (prosrc verbatim), and none carries a cast; the two P21 probes are FALSE on the base", () => {
    /** The newest definition of a function in the sequence up to and including this file. */
    const newest = (head: string) => {
      const f = files.filter((x) => x <= FILE && stripComments(mig(x)).includes(head)).pop()!;
      return between(mig(f), head, "\n$$;");
    };
    const bodies: Record<string, string> = {
      enforce_document_publish_guard: G.next,
      put_back_retired_issue: newest("CREATE OR REPLACE FUNCTION put_back_retired_issue("),
      publish_revision: newest("CREATE OR REPLACE FUNCTION publish_revision("),
      finalize_reviewed_promote: newest("CREATE OR REPLACE FUNCTION finalize_reviewed_promote("),
      restore_reversed_source: newest("CREATE OR REPLACE FUNCTION restore_reversed_source("),
    };
    let n = 0;
    const p21: string[] = [];
    for (const seg of tail.split(/\nUNION ALL\n/)) {
      for (const sub of seg.split(/\(SELECT (?=prosrc|pronargs|COUNT)/)) {
        const fn = /FROM pg_proc WHERE proname = '(\w+)'/.exec(sub)?.[1];
        for (const m of sub.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)) {
          expect(fn, sub.slice(0, 80)).toBeDefined();
          const pat = m[2].replace(/''/g, "'");
          expect(pat, pat).not.toMatch(/::/);
          const body = bodies[fn!];
          expect(body, fn).toBeDefined();
          expect(likeRe(pat).test(prosrcOf(body)), `${fn}: ${pat}`).toBe(m[1] ? false : true);
          if (/^%v_unforced_move := v_unforced_move%OR COALESCE\(OLD\.current_version_id IS (?:NOT NULL%AND NEW\.current_version_id IS NULL|NULL%AND NEW\.current_version_id IS NOT NULL)%/.test(pat)) p21.push(pat);
          n += 1;
        }
      }
    }
    expect(n).toBe(26);
    expect(p21).toHaveLength(2);
    for (const pat of p21) expect(likeRe(pat).test(prosrcOf(G.live)), pat).toBe(false);
  });

  it("the probes cover the guard's grants, its pinned search_path, its owner's EXECUTE on is_controlled_issue_status and its trigger — BEFORE UPDATE only (tgtype: BEFORE and UPDATE set, INSERT clear)", () => {
    expect(tail).toContain("AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE')");
    expect(tail).toContain("AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])");
    expect(tail).toContain("'is_controlled_issue_status(text)', 'EXECUTE'), false)");
    expect(tail).toContain("WHERE t.tgname = 'trg_document_publish_guard' AND NOT t.tgisinternal");
    expect(tail).toContain("AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 4) = 0),");
  });

  it("the header states the finding, the decision, the paste order (after 20261174, which follows 20261165 / 20261164 / the held 20261159), the never-re-paste list, P16's order, the deploy order, and that it is not a widening", () => {
    const head = M.slice(0, M.indexOf("DO $$"));
    expect(head).toMatch(/REV-25 {2}After 20261174/);
    expect(head).toMatch(/\(iii\) The Draft\n-- {11}route is closed by \(i\)/);
    expect(head).toMatch(/HOW TO APPLY: AFTER 20261174 \(required/);
    expect(head).toMatch(/20261174 follows 20261165, which follows 20261164 \/\n-- 20261159, the last HELD \(paste guide row 119\)/);
    expect(head).toMatch(/INTK-18/);
    expect(head).toMatch(/DEC-63's P17 Landed line/);
    expect(head).toMatch(/Never re-paste\n-- 20261174, 20261165, 20261164, 20261159, 20261151, 20261144, 20261139,\n-- 20261105 or any earlier guard migration after this one/);
    expect(head).toMatch(/P16 \(REV-21\) re-creates this guard too: whichever of P16's\n-- migration and this one is pasted second starts from the other's body/);
    expect(head).toMatch(/DEPLOY ORDER: no app deploy is needed before or after this paste/);
    expect(head).toMatch(/NOT a widening/);
  });
});
