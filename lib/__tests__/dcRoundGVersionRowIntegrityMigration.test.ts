// document-control Round G — P33 VERSION ROW INTEGRITY: migration 20261247
// (document-control DCK-16, DCK-17; drafting-flow HAND-13 done-when 2's
// remainder; assigned by the integrator at the P32 merge, 2026-10-21,
// DEC-31; ruled under DEC-90 — fail-safe, no regression).
//
//   §1 document_versions_insert_integrity re-created from its NEWEST earlier
//      body (scan — 20261214 today) with EXACTLY one limb ANDed in front: a
//      signed-in session's row is not 'external', names no intake link and is
//      created by the session — or it is the contractor door's role, whose
//      own limb is kept byte for byte (the J20 forward scan).
//   §2 one column guard, enforce_document_version_row_integrity(), BEFORE
//      INSERT OR UPDATE on document_versions: the intake columns (DCK-16) and
//      the lifecycle columns (DCK-17) for a signed-in session only.
//
// Byte fidelity: lineDiff (nothing removed; every new line is the limb) AND
// an exact cut (the policy minus the limb IS the base, byte for byte). The
// runtime proof — every forgery and every legitimate writer, before and after
// the paste, on PostgreSQL 16 — is lib/__tests__/rls/dcP33VersionRowIntegrity
// .test.ts (and the P32 harness's remainder cases), `npm run test:db`.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const dir = join(root, "supabase", "migrations");
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261247_dc_roundG_version_row_integrity.sql";
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
const likeRe = (pat: string) => new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");

const POLICY_HEAD = "CREATE POLICY document_versions_insert_integrity ON document_versions";
const defining = files.filter((f) => /CREATE POLICY document_versions_insert_integrity ON document_versions/.test(stripComments(mig(f))));
const PREV = defining[defining.indexOf(FILE) - 1];
const P = { live: between(mig(PREV), POLICY_HEAD, "\n);"), next: between(M, POLICY_HEAD, "\n);") };
/** The limb ANDed in front, and the parenthesis that closes the base limbs it wraps. */
const LIMB = "  (\n    CURRENT_USER = 'intake_door'\n    OR (provenance IS DISTINCT FROM 'external' AND intake_link_id IS NULL AND created_by = auth.uid())\n  )\n  AND (\n";
const CLOSE = "\n  )\n);";

const FN_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_version_row_integrity()";
const FN = between(M, FN_HEAD, "\n$$;");
const prosrc = FN.slice(FN.indexOf("$$") + 2, FN.lastIndexOf("$$"));

describe("20261247 §1 — document_versions_insert_integrity re-created from its NEWEST earlier body (found by scanning)", () => {
  it("the base is the newest earlier definition (today 20261214 — the scan, not this comment, decides), and this file is the newest", () => {
    expect(PREV < FILE).toBe(true);
    expect(PREV >= "20261214_prj_roundG_intake_door_rls.sql").toBe(true);
    expect(defining[defining.length - 1]).toBe(FILE);
  });

  it("nothing removed, every new line is the DCK-16 limb or its closing parenthesis, and the body minus them IS the base byte for byte", () => {
    const { onlyInA, onlyInB } = lineDiff(P.live, P.next);
    expect(onlyInA).toEqual([]);
    const added = LIMB.split("\n").filter((l) => l !== "");
    for (const l of onlyInB) expect(added, l).toContain(l);
    expect(P.next.split(LIMB).length).toBe(2);
    expect(P.next.endsWith(CLOSE)).toBe(true);
    expect(P.next.replace(LIMB, "").replace(/\n  \)\n\);$/, "\n);")).toBe(P.live);
  });

  it("the limb is ANDed in FRONT of every earlier limb (a publisher's row, the author's draft or first version, the door's submission), and the door's limb is kept word for word (the J20 forward scan)", () => {
    expect(P.next).toMatch(/^CREATE POLICY document_versions_insert_integrity ON document_versions\nAS RESTRICTIVE FOR INSERT WITH CHECK \(\n {2}\(\n {4}CURRENT_USER = 'intake_door'\n/);
    expect(P.next.indexOf(LIMB)).toBeLessThan(P.next.indexOf("  user_can_publish_doc(record_id, org_id)"));
    expect(P.next.replace(/\s+/g, " ")).toContain("CURRENT_USER = 'intake_door' AND review_state = 'in_review' AND released_at IS NULL AND provenance = 'external' AND intake_link_id IS NOT NULL AND created_by IS NULL");
    expect(M).toContain("DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;\nCREATE POLICY document_versions_insert_integrity ON document_versions");
  });
});

describe("20261247 §2 — the column guard", () => {
  it("is SECURITY INVOKER (it reads no table — DRLS-16: definer rights not needed) with search_path pinned, and neither PUBLIC nor anon may execute it", () => {
    expect(FN).toMatch(/^CREATE OR REPLACE FUNCTION enforce_document_version_row_integrity\(\)\nRETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS \$\$/);
    const body = prosrc.split("\n").filter((l) => !l.trim().startsWith("--") && !/^\s*RAISE EXCEPTION/.test(l)).join("\n").replace(/IS DISTINCT FROM/g, "");
    expect(body).not.toMatch(/\bFROM\b|\bJOIN\b|\bINSERT INTO\b|\bUPDATE\s+\w+\s+SET\b/);
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_version_row_integrity() FROM PUBLIC;");
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_version_row_integrity() FROM anon;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION enforce_document_version_row_integrity() TO authenticated, service_role;");
  });

  it("fires BEFORE INSERT OR UPDATE FOR EACH ROW on document_versions, re-created idempotently", () => {
    expect(M).toContain("DROP TRIGGER IF EXISTS trg_document_version_row_integrity ON document_versions;\nCREATE TRIGGER trg_document_version_row_integrity\n  BEFORE INSERT OR UPDATE ON document_versions\n  FOR EACH ROW EXECUTE FUNCTION enforce_document_version_row_integrity();");
  });

  it("judges a signed-in session only — the service role / SQL editor (no auth.uid()) and the contractor door's identity (its role, or the bound claims) return first", () => {
    const code = prosrc.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
    expect(code.slice(0, 7)).toEqual([
      "DECLARE",
      "  v_uid uuid := auth.uid();",
      "BEGIN",
      "  IF v_uid IS NULL THEN RETURN NEW; END IF;",
      "  IF CURRENT_USER = 'intake_door'",
      "     OR COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'intake_door' THEN",
      "    RETURN NEW;",
    ]);
  });

  it("DCK-16: an INSERT that is 'external', names a link, or names another creator — and an UPDATE that changes the link or the creator or moves provenance to or from 'external' — is refused 42501", () => {
    expect(prosrc).toContain("IF COALESCE(NEW.provenance, '') = 'external' OR NEW.intake_link_id IS NOT NULL THEN");
    expect(prosrc).toContain("IF NEW.created_by IS DISTINCT FROM v_uid THEN");
    expect(prosrc).toContain("IF NEW.intake_link_id IS DISTINCT FROM OLD.intake_link_id\n     OR NEW.created_by IS DISTINCT FROM OLD.created_by\n     OR (NEW.provenance IS DISTINCT FROM OLD.provenance\n         AND (COALESCE(NEW.provenance, '') = 'external' OR COALESCE(OLD.provenance, '') = 'external')) THEN");
  });

  it("DCK-17: an UPDATE into in_review from any other state, a cleared released_at / superseded_at, a changed supersedes_version_id once set, or a move to another document / organization, is refused 42501 — forward moves (approve, reject, supersede, stamp) are not touched", () => {
    expect(prosrc).toContain("IF NEW.review_state = 'in_review' AND OLD.review_state IS DISTINCT FROM 'in_review' THEN");
    expect(prosrc).toContain("IF (OLD.released_at IS NOT NULL AND NEW.released_at IS NULL)\n     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL)\n     OR (OLD.supersedes_version_id IS NOT NULL AND NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id) THEN");
    expect(prosrc).toContain("IF NEW.record_id IS DISTINCT FROM OLD.record_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN");
    expect((prosrc.match(/USING ERRCODE = 'insufficient_privilege'/g) ?? []).length).toBe(6);
    expect(prosrc).not.toMatch(/NEW\.review_state\s*=\s*'(approved|rejected|superseded)'/);
  });

  it("nothing else is defined: one policy, one function, one trigger", () => {
    const code = stripComments(M);
    expect([...code.matchAll(/CREATE POLICY (\w+)/g)].map((m) => m[1])).toEqual(["document_versions_insert_integrity"]);
    expect([...code.matchAll(/CREATE OR REPLACE FUNCTION (\w+)/g)].map((m) => m[1])).toEqual(["enforce_document_version_row_integrity"]);
    expect([...code.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1])).toEqual(["trg_document_version_row_integrity"]);
  });
});

describe("20261247 — the one-paste shape (DEC-30)", () => {
  const code = stripComments(M);
  it("prerequisite (20261245's lock leg, 20261214's door limb) → TEMP counts-only inventory → BEGIN … COMMIT → ONE final SELECT (check, ok, n)", () => {
    const at = (s: string) => code.indexOf(s);
    expect(at("DO $$")).toBeGreaterThanOrEqual(0);
    expect(at("CREATE TEMP TABLE dc_round_g_247_before")).toBeGreaterThan(at("DO $$"));
    expect(at("\nBEGIN;")).toBeGreaterThan(at("CREATE TEMP TABLE dc_round_g_247_before"));
    expect(code.split("\nBEGIN;").length).toBe(2);
    expect(code.split("\nCOMMIT;").length).toBe(2);
    const tail = code.slice(at("\nCOMMIT;") + "\nCOMMIT;".length).trim();
    expect(tail.startsWith("SELECT ")).toBe(true);
    // one statement: only its last line ends with a semicolon
    expect(tail.split("\n").filter((l) => /;\s*$/.test(l)).length).toBe(1);
    expect(tail.trimEnd().endsWith(";")).toBe(true);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(tail.trimEnd().endsWith("SELECT inventory, NULL::boolean, n FROM dc_round_g_247_before;")).toBe(true);
    expect((tail.match(/\nUNION ALL\n/g) ?? []).length).toBe(7);
    expect(M).toContain("RAISE EXCEPTION '20261247 needs 20261245 (the checkout lock leg in the publish guard) pasted first; nothing was changed.';");
    expect(M).toContain("RAISE EXCEPTION '20261247 needs 20261214 (the intake door limb of document_versions_insert_integrity) pasted first; nothing was changed.';");
  });

  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = between(code, "CREATE TEMP TABLE dc_round_g_247_before AS", "\nBEGIN;");
    const selects = inv.split(/\nUNION ALL\n/);
    expect(selects.length).toBe(4);
    for (const s of selects) expect(s).toMatch(/COUNT\(\*\)::text/);
    expect(inv).not.toMatch(/SELECT\s+\*|file_url|title|document_number|email/);
  });

  it("the 'expected 0' rows count the forgery SIGNATURES only (P33 review fix): an in-review member-created submission shape, and a RELEASED revision marked in review — never a trusted auto-publish (published, not in review) or a draft retired in review (superseded_at alone)", () => {
    const inv = between(code, "CREATE TEMP TABLE dc_round_g_247_before AS", "\nBEGIN;");
    expect(inv).toContain(`(v.review_state = 'in_review'
          AND (COALESCE(v.provenance, '') = 'external' OR v.intake_link_id IS NOT NULL)
          AND v.created_by IS NOT NULL AND v.created_by IS DISTINCT FROM v.intake_link_id) AS forged_submission_look`);
    expect(inv).toContain("(v.review_state = 'in_review' AND v.released_at IS NOT NULL) AS relabelled_look");
    expect(inv).not.toMatch(/superseded_at IS NOT NULL/);
    const selects = inv.split(/\nUNION ALL\n/);
    expect(selects[0]).toMatch(/informational/);
    expect(selects[0]).not.toMatch(/expected 0/);
    for (const s of selects.slice(1)) expect(s).toMatch(/expected 0/);
    expect(selects[1]).toMatch(/WHERE forged_submission_look\s*$/);
    expect(selects[2]).toMatch(/WHERE relabelled_look\s*$/);
    expect(selects[3]).toMatch(/WHERE v\.relabelled_look;\s*(BEGIN;)?\s*$/);
  });

  it("each prosrc probe holds on the function as written (pg_proc.prosrc is verbatim; '''' is one apostrophe)", () => {
    const tail = code.slice(code.indexOf("\nCOMMIT;"));
    const pats = [...tail.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(pats.length).toBe(3);
    for (const p of pats) expect(likeRe(p).test(prosrc), p.slice(0, 80)).toBe(true);
  });
});

// ── The app census: no legitimate signed-in writer touches what §2 refuses ──
const SRC_DIRS = ["app", "lib", "components", "hooks"];
function walk(d: string, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(d); } catch { return out; }
  for (const n of names) {
    const p = join(d, n);
    if (n === "node_modules" || n === "__tests__") continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
/** Every `.from("document_versions")` followed (within 6 lines) by an insert / update / upsert, with its payload's text. */
function versionWrites(): Array<{ file: string; line: number; op: string; text: string }> {
  const out: Array<{ file: string; line: number; op: string; text: string }> = [];
  for (const f of SRC_DIRS.flatMap((d) => walk(join(root, d)))) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      if (!/from\(\s*["']document_versions["']\s*\)/.test(l)) return;
      const win = lines.slice(i, i + 25).join("\n");
      const m = /\.(insert|update|upsert)\(/.exec(lines.slice(i, i + 6).join("\n"));
      if (m) out.push({ file: relative(root, f), line: i + 1, op: m[1], text: win.slice(win.indexOf(`.${m[1]}(`)) });
    });
  }
  return out;
}

describe("20261247 — the writers it must not break (census of the app's document_versions writes)", () => {
  const writes = versionWrites();
  const SERVICE_ROLE = new Set(["app/api/intake/upload/route.ts"]);
  /** The payload object passed to the write (up to its closing brace). */
  const payload = (t: string) => {
    const a = t.indexOf("{");
    let depth = 0;
    for (let i = a; i < t.length; i++) {
      if (t[i] === "{") depth++;
      else if (t[i] === "}" && --depth === 0) return t.slice(a, i + 1);
    }
    return t.slice(a);
  };

  it("the census finds the writers it names (the app's inserts and updates of document_versions)", () => {
    const files = new Set(writes.map((w) => w.file));
    for (const f of ["lib/revisions.ts", "lib/reviewControl.ts", "components/projects/IntakePanel.tsx", "app/api/intake/upload/route.ts", "lib/documentLifecycle/common.ts"]) {
      expect(files.has(f), f).toBe(true);
    }
  });

  it("only the intake route (service role) writes provenance 'external' or an intake link, moves a row back into review, or clears released_at / superseded_at", () => {
    for (const w of writes) {
      if (SERVICE_ROLE.has(w.file)) continue;
      const p = payload(w.text);
      expect(p, `${w.file}:${w.line}`).not.toMatch(/provenance:\s*["']external["']/);
      expect(p, `${w.file}:${w.line}`).not.toMatch(/\bintake_link_id\s*:/);
      if (w.op === "update") {
        expect(p, `${w.file}:${w.line}`).not.toMatch(/review_state:\s*["']in_review["']/);
        expect(p, `${w.file}:${w.line}`).not.toMatch(/(released_at|superseded_at|supersedes_version_id):\s*null\b/);
        expect(p, `${w.file}:${w.line}`).not.toMatch(/\bcreated_by\s*:/);
      }
    }
  });

  it("the one signed-in update that writes supersedes_version_id is promoteThreeStep's relabel — with the draft's own recorded base (finalizeReviewedRevision refuses a draft whose base moved, REV-5), so it never changes a value already set", () => {
    const sup = writes.filter((w) => w.op === "update" && !SERVICE_ROLE.has(w.file) && /supersedes_version_id\s*:/.test(payload(w.text)));
    expect(sup.map((w) => w.file)).toEqual(["lib/reviewControl.ts"]);
    const rc = readFileSync(join(root, "lib", "reviewControl.ts"), "utf8");
    expect(rc).toContain("if (draftBase !== previousVersionId && !(draftBase === null && intakeApproval)) return { published: false, reason: \"stale_base\" };");
    expect(rc).toContain(".update({ review_state: \"approved\", revision_label: baseRev, released_at: nowIso, supersedes_version_id: previousVersionId, updated_at: nowIso })");
  });

  it("every signed-in INSERT names its creator as the acting session (the creation flows, submit for review, the bulk import)", () => {
    for (const w of writes.filter((x) => x.op === "insert" && !SERVICE_ROLE.has(x.file))) {
      expect(payload(w.text), `${w.file}:${w.line}`).toMatch(/created_by:\s*(uid|actorUserId|input\.actorUserId|actor\.actorUserId)\b/);
    }
  });
});
