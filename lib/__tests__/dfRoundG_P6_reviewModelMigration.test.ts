// drafting-flow Round G, DF-P6 REVIEW-MODEL — the shape of its two pastes.
//
//   20261250  the declaration columns, engineering_required (the ratchet), the
//             workspace's work / code class on a ticket; ticket_update_guard
//             re-created from its NEWEST earlier body (found by scanning,
//             lineDiff-pinned here) with exactly two insertions; the INSERT
//             guard; the backfill predicate is the inventory's predicate.
//   20261251  ticket_equipment (intelligence GAP-312 / WIRE-7 criterion 1).
//
// Both are exercised at runtime on a throwaway PG16 in
// lib/__tests__/rls/dfP6ReviewModel.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
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
const finalSelects = (M: string) => {
  const after = M.slice(M.indexOf("\nCOMMIT;\n"));
  return (stripComments(after).replace(/UNION ALL\s*\nSELECT/g, "UNION ALL SELECT").match(/^SELECT /gm) ?? []).length;
};

const F250 = "20261250_df_roundG_review_model.sql";
const F251 = "20261251_df_roundG_ticket_equipment.sql";

describe("DEC-30 one-paste shape (both files)", () => {
  for (const F of [F250, F251]) {
    it(`${F}: counts-only inventory into a TEMP table before BEGIN; one BEGIN / COMMIT; one final SELECT (check, ok, n)`, () => {
      const M = mig(F);
      const s = stripComments(M);
      const begin = s.indexOf("\nBEGIN;\n");
      expect(begin).toBeGreaterThan(0);
      expect(s.match(/\nBEGIN;\n/g)).toHaveLength(1);
      expect(s.match(/\nCOMMIT;\n/g)).toHaveLength(1);
      expect(s.indexOf("CREATE TEMP TABLE df_round_g_25")).toBeLessThan(begin);
      // the inventory holds counts only — never a row's content
      const inv = s.slice(s.indexOf("CREATE TEMP TABLE"), begin);
      expect(inv).not.toMatch(/SELECT\s+t\.(title|description|like_in_kind_statement)/);
      expect(finalSelects(M)).toBe(1);
      const tail = s.slice(s.indexOf("\nCOMMIT;\n"));
      expect(tail).toMatch(/AS check,/);
      expect(tail).toMatch(/AS ok,/);
      expect(tail).toMatch(/NULL::text AS n/);
      expect(tail).toMatch(/FROM df_round_g_25[01]_before ORDER BY ord/);
    });
  }
  it("the numbers are the reserved ones and nothing else in the folder takes them", () => {
    expect(files.filter((f) => f.startsWith("20261250"))).toEqual([F250]);
    expect(files.filter((f) => f.startsWith("20261251"))).toEqual([F251]);
  });
  it("DEC-35: no facility vocabulary in either paste", () => {
    for (const F of [F250, F251]) {
      expect(stripComments(mig(F))).not.toMatch(/\bQAQC\b|QA\/QC|\bB31|\bNDE\b|radiograph|PENDING_DOC_CTRL/);
    }
  });
});

describe("20261250 — ticket_update_guard re-created from its NEWEST earlier body with exactly two insertions", () => {
  const M = mig(F250);
  const GUARD = "CREATE OR REPLACE FUNCTION ticket_update_guard()";
  const definers = files.filter((f) => stripComments(mig(f)).includes(GUARD));
  const prev = definers[definers.indexOf(F250) - 1];
  const live = between(mig(prev), GUARD, "\n$$;");
  const next = between(M, GUARD, "\n$$;");

  it("the base is the newest earlier definition (20261221 today — the scan decides)", () => {
    expect(definers).toContain(F250);
    expect(prev < F250).toBe(true);
    expect(prev >= "20261221_df_roundG_issue_lines_server_only.sql").toBe(true);
  });
  it("lineDiff: nothing of the base is removed; the added code lines are exactly the every-caller limb and the three owned columns", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(code(onlyInB)).toEqual([
      "  IF NEW.like_in_kind_statement    IS DISTINCT FROM OLD.like_in_kind_statement",
      "     OR NEW.like_in_kind_declared_by  IS DISTINCT FROM OLD.like_in_kind_declared_by",
      "     OR NEW.like_in_kind_declared_at  IS DISTINCT FROM OLD.like_in_kind_declared_at",
      "     OR NEW.like_in_kind_signature_id IS DISTINCT FROM OLD.like_in_kind_signature_id THEN",
      "    RAISE EXCEPTION 'tickets: the like-in-kind declaration is set when the request is filed and cannot be changed';",
      "  IF OLD.engineering_required AND NOT NEW.engineering_required THEN",
      "    RAISE EXCEPTION 'tickets: engineering_required only ratchets up — it cannot be cleared';",
      "  IF NEW.review_model_filed IS DISTINCT FROM OLD.review_model_filed THEN",
      "    RAISE EXCEPTION 'tickets: review_model_filed is set when the request is filed and cannot be changed';",
      "  IF NEW.engineering_required        IS DISTINCT FROM OLD.engineering_required        THEN v_bad := array_append(v_bad, 'engineering_required'); END IF;",
      "  IF NEW.work_class                  IS DISTINCT FROM OLD.work_class                  THEN v_bad := array_append(v_bad, 'work_class'); END IF;",
      "  IF NEW.code_class                  IS DISTINCT FROM OLD.code_class                  THEN v_bad := array_append(v_bad, 'code_class'); END IF;",
    ]);
  });
  it("the every-caller limb runs AHEAD of the service-role return (the ratchet binds the service role too — DEC-90 ruling (2)); the owned columns sit with the other workflow-owned ones", () => {
    const limb = next.indexOf("IF OLD.engineering_required AND NOT NEW.engineering_required THEN");
    const decl = next.indexOf("IF NEW.like_in_kind_statement    IS DISTINCT FROM");
    const svc = next.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    expect(limb).toBeGreaterThan(0);
    expect(decl).toBeGreaterThan(0);
    expect(limb).toBeLessThan(svc);
    expect(decl).toBeLessThan(svc);
    // …after the history index stamp (which every caller also passes through)
    expect(next.indexOf("NEW.history_guarded_from := CASE WHEN jsonb_typeof(OLD.history)")).toBeLessThan(decl);
    const owned = next.indexOf("v_bad := array_append(v_bad, 'engineering_required')");
    expect(owned).toBeGreaterThan(next.indexOf("v_bad := array_append(v_bad, 'library_id')"));
    expect(owned).toBeLessThan(next.indexOf("array_append(v_bad, 'history_guarded_from')"));
  });
  it("keeps every earlier rail; DRLS-16 (definer, pinned, trigger restated, EXECUTE revoked)", () => {
    for (const must of ["app.ticket_departure", "v_bad := array_append(v_bad, 'library_id');", "array_append(v_bad, 'outcome'); END IF;", "tickets: last_modified cannot be cleared", "~* 'issued Rev [[:digit:]]'", "IF v_entry ? 'revisionRound' THEN", "array_append(v_bad, 'history_guarded_from')"]) {
      expect(next).toContain(must);
    }
    expect(next).toContain("RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(M).toContain("CREATE TRIGGER trg_ticket_update_guard\n  BEFORE UPDATE ON tickets\n  FOR EACH ROW EXECUTE FUNCTION ticket_update_guard();");
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_update_guard() FROM PUBLIC, anon, authenticated, service_role;");
  });
  it("FOLDER SCAN: the NEWEST ticket_update_guard in the sequence keeps the ratchet and the declaration limb ahead of the service-role return", () => {
    const newest = definers.at(-1)!;
    const body = between(mig(newest), GUARD, "\n$$;");
    expect(body, newest).toContain("IF OLD.engineering_required AND NOT NEW.engineering_required THEN");
    expect(body, newest).toContain("OR NEW.like_in_kind_signature_id IS DISTINCT FROM OLD.like_in_kind_signature_id THEN");
    // DF-P6 fix pass 2 (review, issue 1): whether a request was filed under
    // the review model is immutable for every caller too.
    expect(body, newest).toContain("IF NEW.review_model_filed IS DISTINCT FROM OLD.review_model_filed THEN");
    expect(body.indexOf("IF NEW.review_model_filed IS DISTINCT FROM OLD.review_model_filed THEN"), newest)
      .toBeLessThan(body.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;"));
    expect(body.indexOf("IF OLD.engineering_required AND NOT NEW.engineering_required THEN"), newest)
      .toBeLessThan(body.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;"));
    for (const c of ["engineering_required", "work_class", "code_class"]) expect(body, newest).toContain(`array_append(v_bad, '${c}')`);
  });
  it("prerequisite: refuses (nothing changed) before 20261221 is live", () => {
    const pre = M.slice(0, M.indexOf("CREATE TEMP TABLE"));
    expect(pre).toContain("prosrc LIKE '%issued Rev [[:digit:]]%'");
    expect(pre).toContain("prosrc LIKE '%history_guarded_from%'");
    expect(pre).toContain("RAISE EXCEPTION '20261250 needs 20261221");
  });
});

describe("20261250 — the columns, the backfill, the INSERT guard", () => {
  const M = mig(F250);
  const s = stripComments(M);
  it("existing rows land false (the legacy gate decides), new rows default true; the backfill raises only — never lowers", () => {
    const add = s.indexOf("ADD COLUMN IF NOT EXISTS engineering_required BOOLEAN NOT NULL DEFAULT false;");
    const def = s.indexOf("ALTER COLUMN engineering_required SET DEFAULT true;");
    expect(add).toBeGreaterThan(0);
    expect(def).toBeGreaterThan(add);
    const upd = between(s, "UPDATE tickets t SET engineering_required = true", ");\n");
    expect(upd).toContain("WHERE NOT t.engineering_required");
    expect(upd).toContain("AND t.like_in_kind_declared_at IS NULL");
    expect(s).not.toMatch(/SET engineering_required = false/);
  });
  it("DF-P6 fix pass 2 (review, issue 1): review_model_filed — every pre-paste row false, every row filed after true, written by nothing (no backfill touches it)", () => {
    const add = s.indexOf("ADD COLUMN IF NOT EXISTS review_model_filed BOOLEAN NOT NULL DEFAULT false;");
    const def = s.indexOf("ALTER COLUMN review_model_filed SET DEFAULT true;");
    expect(add).toBeGreaterThan(0);
    expect(def).toBeGreaterThan(add);
    expect(s).not.toMatch(/SET review_model_filed\s*=/);
    expect(s).not.toMatch(/UPDATE tickets[^;]*review_model_filed/);
  });
  it("the backfill predicate is the inventory's 'certain' predicate, word for word (the count the operator reads is the rows that move)", () => {
    const norm = (x: string) => x.replace(/\s+/g, " ").trim();
    const inv = between(s, "WITH legacy AS (", ") AS certain");
    const invPred = norm(inv.slice(inv.indexOf("(", inv.indexOf("t.status,")) + 1, inv.lastIndexOf(") AS certain")));
    const upd = between(s, "UPDATE tickets t SET engineering_required = true", "\n   );\n");
    const updPred = norm(upd.slice(upd.indexOf("AND (", upd.indexOf("like_in_kind_declared_at IS NULL")) + 5, upd.lastIndexOf(")")));
    expect(updPred.length).toBeGreaterThan(400);
    expect(updPred).toBe(invPred);
  });
  it("the backfill names the legacy gate's DEFAULT exempt roles exactly (lib/capabilityPolicy.ts) — a stored list or grant is left to the live gate", () => {
    expect(s).toContain("t.requester_role IN ('Admin', 'Manager', 'Supervisor', 'DocCtrl') OR t.requester_role LIKE '%Engineer%'");
    expect(s).toContain("c.data->'caps'->'ticket.engineer_gate_exempt'");
    expect(s).toContain("g.e->>'cap' = 'ticket.engineer_gate_exempt'");
  });
  it("the declaration is all-or-none; its statement is 20..2000 characters (lib/reviewModel.ts); a class is at most 120", async () => {
    const { LIKE_IN_KIND_MIN_CHARS, LIKE_IN_KIND_MAX_CHARS } = await import("@/lib/reviewModel");
    expect(s).toContain(`char_length(btrim(like_in_kind_statement)) BETWEEN ${LIKE_IN_KIND_MIN_CHARS} AND ${LIKE_IN_KIND_MAX_CHARS}`);
    expect(s).toContain("CONSTRAINT tickets_like_in_kind_all_or_none CHECK");
    expect(s).toContain("char_length(work_class) BETWEEN 1 AND 120");
  });
  it("the INSERT guard: a client insert is born engineered, undeclared, unclassified; SECURITY INVOKER, pinned, EXECUTE revoked", () => {
    const fn = between(M, "CREATE OR REPLACE FUNCTION ticket_review_model_insert_guard()", "\n$$;");
    expect(fn).toContain("RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$");
    expect(fn).not.toContain("SECURITY DEFINER");
    expect(fn).toContain("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    for (const l of ["NEW.engineering_required := true;", "NEW.review_model_filed := true;", "NEW.like_in_kind_statement := NULL;", "NEW.like_in_kind_signature_id := NULL;", "NEW.work_class := NULL;", "NEW.code_class := NULL;"]) expect(fn).toContain(l);
    expect(M).toContain("CREATE TRIGGER trg_ticket_review_model_insert_guard\n  BEFORE INSERT ON tickets\n  FOR EACH ROW EXECUTE FUNCTION ticket_review_model_insert_guard();");
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_review_model_insert_guard() FROM PUBLIC, anon, authenticated, service_role;");
  });
  it("the app's tolerance list names exactly the eight columns this paste adds (42703 / PGRST204 → today's path)", async () => {
    const { isMissingReviewModelColumn } = await import("@/lib/reviewModel");
    const added = [...s.matchAll(/ALTER TABLE tickets ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(added).toHaveLength(8);
    for (const c of added) expect(isMissingReviewModelColumn({ code: "42703", message: `column tickets.${c} does not exist` }), c).toBe(true);
  });
});

describe("20261251 — ticket_equipment", () => {
  const M = mig(F251);
  const s = stripComments(M);
  it("cascades with the org and the ticket; a deleted asset only clears the link; tag 1..80 (lib/ticketCreate.ts)", async () => {
    const { MAX_EQUIPMENT_TAG } = await import("@/lib/ticketCreate");
    expect(s).toContain("org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE");
    expect(s).toContain("ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE");
    expect(s).toContain("asset_id    UUID REFERENCES assets(id) ON DELETE SET NULL");
    expect(s).toContain(`CHECK (char_length(btrim(tag)) BETWEEN 1 AND ${MAX_EQUIPMENT_TAG})`);
  });
  it("RLS on; one SELECT policy through the ticket's read scope; no client write grant", () => {
    expect(s).toContain("ALTER TABLE ticket_equipment ENABLE ROW LEVEL SECURITY;");
    expect(s.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(s).toContain("CREATE POLICY ticket_equipment_select ON ticket_equipment FOR SELECT TO authenticated");
    expect(s).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_equipment FROM authenticated;");
    expect(s).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO authenticated/);
  });
  it("the integrity trigger is SECURITY INVOKER, pinned, EXECUTE revoked (DRLS-16)", () => {
    const fn = between(M, "CREATE OR REPLACE FUNCTION ticket_equipment_integrity()", "\n$$;");
    expect(fn).toContain("RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$");
    expect(fn).not.toContain("SECURITY DEFINER");
    expect(M).toContain("REVOKE ALL ON FUNCTION ticket_equipment_integrity() FROM PUBLIC, anon, authenticated, service_role;");
  });
});
