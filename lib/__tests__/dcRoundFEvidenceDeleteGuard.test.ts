// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS: shape
// pins on 20261149, the document-delete half of DRLS-14 (DEC-79,
// awaiting the user's ratification).
//
//   · a NEW BEFORE DELETE trigger on documents refuses the delete of a
//     document carrying evidence of a person's act (a confirmed distribution
//     ack, an acknowledged / waived read-&-understood row, a signed review
//     sign-off); unanswered asks still cascade, the three document_id
//     references are not touched, and no other migration's function, policy
//     or trigger is re-created;
//   · the guard is SECURITY DEFINER, search_path pinned, executable by no
//     client role (DRLS-16's rule for a trigger function);
//   · the DEC-30 one-paste shape: inventory TEMP TABLE (counts only) before
//     BEGIN, one BEGIN / COMMIT, ONE final SELECT (check, ok, n); every
//     probe's LIKE pattern is found in the body it reads, none carries a cast;
//   · the doors: the two collections routes never delete a document (so
//     they cannot meet the refusal); the library page's single delete shows
//     the database's sentence (one checked statement, DRLS-17).
// The script was run on a throwaway PostgreSQL 16 (cases in DRLS-14's record).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dir = join(root, "supabase", "migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const FILE = "20261149_dc_roundF_document_evidence_delete_guard.sql";
const M = read(FILE);
const numbered = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const body = M.slice(M.indexOf("CREATE OR REPLACE FUNCTION enforce_document_evidence_delete_guard()"), M.indexOf("\n$$;", M.indexOf("CREATE OR REPLACE FUNCTION enforce_document_evidence_delete_guard()")));
const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

describe("20261149 — DRLS-14: a document carrying evidence is not deleted", () => {
  it("defines ONE new function and ONE new trigger, and re-creates nothing another migration defines", () => {
    const code = stripComments(M);
    const fns = [...code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/gi)].map((m) => m[1]);
    expect(fns).toEqual(["enforce_document_evidence_delete_guard"]);
    for (const f of numbered.filter((x) => x < FILE)) {
      expect(stripComments(read(f)), f).not.toMatch(/FUNCTION\s+enforce_document_evidence_delete_guard\b/);
      expect(stripComments(read(f)), f).not.toMatch(/trg_documents_evidence_delete\b/);
    }
    expect(code).not.toMatch(/CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+TABLE/i);
    expect(code).not.toMatch(/DROP\s+CONSTRAINT|ADD\s+CONSTRAINT/i);
    const triggers = [...code.matchAll(/CREATE\s+TRIGGER\s+(\w+)/gi)].map((m) => m[1]);
    expect(triggers).toEqual(["trg_documents_evidence_delete"]);
    expect(code).toMatch(/CREATE TRIGGER trg_documents_evidence_delete\n  BEFORE DELETE ON documents\n  FOR EACH ROW\n  EXECUTE FUNCTION enforce_document_evidence_delete_guard\(\);/);
  });

  it("counts exactly a person's act in each evidence table — a pending ask or a void row is not evidence", () => {
    expect(body).toContain("FROM distribution_acks a\n   WHERE a.document_id = OLD.id\n     AND a.acknowledged_at IS NOT NULL;");
    expect(body).toContain("FROM document_acknowledgments k\n   WHERE k.document_id = OLD.id\n     AND (k.acknowledged_at IS NOT NULL OR k.signature_id IS NOT NULL\n          OR k.status IN ('acknowledged', 'waived'));");
    expect(body).toContain("FROM document_review_signoffs s\n   WHERE s.document_id = OLD.id\n     AND (s.signed_at IS NOT NULL OR s.signature_id IS NOT NULL\n          OR s.status = 'signed');");
    expect(body).not.toMatch(/'pending'|'void'/);
    // The inventory reads the same three predicates (one population).
    const inventory = M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;"));
    expect(inventory).toContain("WHERE a.acknowledged_at IS NOT NULL");
    expect(inventory).toContain("WHERE k.acknowledged_at IS NOT NULL OR k.signature_id IS NOT NULL\n      OR k.status IN ('acknowledged', 'waived')");
    expect(inventory).toContain("WHERE s.signed_at IS NOT NULL OR s.signature_id IS NOT NULL\n      OR s.status = 'signed'");
  });

  it("refuses for EVERY caller (no NULL-uid branch: the service role too, as the legal-hold delete guard), in plain words, before any cascade", () => {
    expect(body).not.toMatch(/auth\.uid\(\)/);
    expect(body).toMatch(/RAISE EXCEPTION\n\s+'% carries the record of who confirmed, acknowledged or approved it \(% distribution confirmation\(s\), % read-and-understood acknowledgment\(s\) or waiver\(s\), % review sign-off\(s\)\), so it cannot be deleted\. Archive it instead: archiving keeps the record\.'/);
    expect(body).toContain("USING ERRCODE = 'restrict_violation'");
    expect(body).toContain("RETURN OLD;");
    // the label falls back number → title → name → "This document"
    expect(body).toMatch(/COALESCE\(NULLIF\(btrim\(OLD\.document_number\), ''\),\s+NULLIF\(btrim\(OLD\.title\), ''\),\s+NULLIF\(btrim\(OLD\.name\), ''\),\s+'This document'\)/);
  });

  it("DRLS-16: SECURITY DEFINER, search_path pinned, EXECUTE revoked from every client role", () => {
    expect(body).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(M).toContain("REVOKE ALL ON FUNCTION enforce_document_evidence_delete_guard() FROM PUBLIC, anon, authenticated, service_role;");
    expect(M).not.toMatch(/GRANT\s+EXECUTE/i);
  });

  it("one paste: inventory TEMP TABLE (counts only) before BEGIN, one BEGIN/COMMIT, ONE final SELECT (check, ok, n)", () => {
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_149_before AS")).toBeGreaterThan(0);
    expect(M.indexOf("CREATE TEMP TABLE dc_round_f_149_before AS")).toBeLessThan(M.indexOf("\nBEGIN;"));
    expect((M.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((M.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    const inventory = M.slice(M.indexOf("CREATE TEMP TABLE"), M.indexOf("\nBEGIN;"));
    // counts only — never a customer row
    const selects = [...stripComments(inventory).matchAll(/SELECT '[^']*(?:''[^']*)*'(?: AS inventory)?,\s*([^\n]+)/g)].map((m) => m[1]);
    expect(selects.length).toBe(6);
    for (const s of selects) expect(s).toMatch(/^COUNT\(/);
    const code = stripComments(tail);
    expect((code.match(/^SELECT /gm) ?? []).length).toBe(1);
    expect(code).toMatch(/^SELECT 'DRLS-14: [^']+' AS check,/m);
    expect(code).toMatch(/AS ok,\n\s+NULL::text AS n/);
    expect(code).toContain("UNION ALL SELECT inventory, NULL::boolean, n FROM dc_round_f_149_before;");
  });

  it("every probe's LIKE pattern is in the body it reads (prosrc verbatim), and none carries a cast", () => {
    const patterns = [...tail.matchAll(/prosrc LIKE '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(patterns.length).toBeGreaterThanOrEqual(8);
    for (const p of patterns) {
      expect(p, p).not.toMatch(/::/);
      const needle = p.replace(/^%|%$/g, "");
      expect(body, needle).toContain(needle);
    }
    const triggerDef = [...tail.matchAll(/pg_get_triggerdef\(oid\) LIKE '((?:[^']|'')*)'/g)].map((m) => m[1]);
    expect(triggerDef).toEqual(["%BEFORE DELETE ON public.documents FOR EACH ROW EXECUTE FUNCTION enforce_document_evidence_delete_guard()%"]);
  });

  it("the header states the DEC, the ratification hold and the paste order against 20261131 / 20261139 / 20261143 / 20261144", () => {
    const head = M.slice(0, M.indexOf("DROP TABLE IF EXISTS"));
    expect(head).toMatch(/DEC-79/);
    expect(head).toMatch(/AWAITING THE USER'S RATIFICATION/);
    expect(head).toMatch(/20261131/);
    expect(head).toMatch(/20261139, 20261143, 20261144/);
    expect(head).toMatch(/Paste ONLY once the user ratifies DEC-79/);
  });

  it("the evidence tables' document_id references are CASCADE today (what the guard decides before) — 20260817 / 20260818 / 20260825", () => {
    expect(read("20260817_read_understood.sql")).toMatch(/document_id UUID NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE/);
    expect(read("20260818_review_before_publish.sql")).toMatch(/document_id UUID NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE/);
    expect(read("20260825_work_packages_acks.sql")).toMatch(/document_id UUID NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE/);
    // and no later migration moved them (the probe also checks it live)
    for (const f of numbered.filter((x) => x > "20260825_work_packages_acks.sql" && x < FILE)) {
      expect(stripComments(read(f)), f).not.toMatch(/(distribution_acks|document_acknowledgments|document_review_signoffs)_document_id_fkey/);
    }
  });
});

describe("DRLS-14 — the doors that delete a document, and the ones that never do", () => {
  const src = (p: string) => readFileSync(join(root, p), "utf8");

  it("/api/collections/delete and /api/collections/trash never delete a document — a folder's contents step up, the shell is soft-deleted", () => {
    for (const p of ["app/api/collections/delete/route.ts", "app/api/collections/trash/route.ts"]) {
      const s = src(p);
      expect(s, p).not.toMatch(/from\("documents"\)\s*\.delete\(/);
      expect(s, p).not.toMatch(/from\("documents"\)[^;]*\.delete\(\)/);
    }
    const del = src("app/api/collections/delete/route.ts");
    expect(del).toMatch(/\.from\("documents"\)\.update\(\{ collection_id: heirParent \}\)\.eq\("collection_id", collectionId\)/);
    expect(del.indexOf('.update({ collection_id: heirParent })')).toBeLessThan(del.indexOf('.update({ deleted_at: new Date().toISOString(), deleted_by: user.id })'));
    // the cron purges only the shells; a purged shell's documents (none —
    // they stepped up) would keep their row: collection_id ON DELETE SET NULL
    const cron = src("app/api/cron/maintenance/route.ts");
    expect(cron).toMatch(/\.from\("collections"\)\.delete\(\)\s*\n\s*\.not\("deleted_at", "is", null\)/);
    expect(src("supabase/schema.sql")).toMatch(/collection_id UUID REFERENCES collections\(id\) ON DELETE SET NULL,/);
  });

  it("the library page's single delete is ONE checked statement that shows the database's own sentence (DRLS-17) — the refusal reaches the person verbatim", () => {
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toContain('.from("documents")\n        .delete()\n        .eq("id", docId)\n        .select("id");');
    expect(page).toContain("if (delErr) throw new Error(`the database refused it, so nothing was changed: ${delErr.message}`);");
    expect(page).toContain('await appAlert({ title: "Delete failed", message: msg, tone: "danger" });');
  });

  it("P14 review fix — the bulk delete's false success is a DEPLOY PREREQUISITE of the paste, not a follow-up: the header, the paste order, DEC-79 and DRLS-14 all say so", () => {
    const head = M.slice(0, M.indexOf("DROP TABLE IF EXISTS"));
    expect(head).toMatch(/DEPLOY PREREQUISITE \(DRLS-14, as 20261131 waits on DRLS-15 \/ DRLS-17\):\n-- not pasteable until the app deployed carries a library-page bulk delete/);
    expect(head).toContain("CHECKS\n-- each delete (.select(\"id\") plus its error) and keeps every refused row on\n-- screen with the database's sentence");
    expect(head).not.toMatch(/none needs a code change to stay truthful/);
    const seq = src("audit-reports/document-control/99-fix-sequencing.md");
    const p14 = seq.slice(seq.indexOf("Paste order — P14 RECORDS & REVIEW REMAINDERS"), seq.indexOf("20261150_dc_roundF_work_package_repin_record.sql"));
    expect(p14).toMatch(/\*\*Deploy prerequisite \(as\s+`20261131` waits on `DRLS-15` \/ `DRLS-17`\):\*\* not pasteable until the app\s+deployed carries a library-page bulk delete/);
    const dec = src("audit-reports/DECISIONS.md");
    expect(dec.slice(dec.indexOf('<a id="dec-79"></a>'))).toMatch(/\*\*Deploy prerequisite \(P14 review fix\):\*\* `20261149` is not pasted, even once this decision is ratified, until/);
    const rec = src("audit-reports/document-control/10-rls.md");
    expect(rec).toContain("**Deploy prerequisite of `20261149` (P14 review fix — first recorded only as a follow-up).**");
  });

  it("a library delete on /documents shows the database's sentence too", () => {
    const page = src("app/(protected)/documents/page.tsx");
    expect(page).toContain('const { error } = await supabase.from("libraries").delete().eq("id", lib._id!);');
    expect(page).toContain("if (error) { await appAlert({ message: `Delete failed: ${error.message}`, tone: \"danger\" }); return; }");
  });

  it("P14 final review — a library delete on /admin/libraries shows the database's sentence too, and a delete that matched no row is a refusal (driven rendered in dcRoundFLibraryDeleteRefusal.test.ts)", () => {
    const page = src("app/(protected)/admin/libraries/page.tsx");
    expect(page).toContain('const { data: deleted, error } = await supabase.from("libraries").delete().eq("id", libraryToDelete.id!).select("id");');
    expect(page).toContain("if (error) throw new Error(error.message);");
    expect(page).toContain("if (!deleted || deleted.length === 0) {");
    expect(page).toContain("await appAlert({ message: `Delete failed: ${typeof why === \"string\" && why ? why : \"the library was not deleted.\"}`, tone: \"danger\" });");
    expect(page).not.toContain("Failed to delete library.");
  });
});
