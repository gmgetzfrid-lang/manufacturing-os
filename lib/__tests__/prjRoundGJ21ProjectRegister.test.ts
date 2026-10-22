// projects-joint Round G — J21 DRAFTING-REQUEST PROJECT REMAINDERS: the
// register side.
//
//   20261262 (DEC-30 one paste) — shape: a counts-only inventory before the
//   transaction, BEGIN / COMMIT, ONE final (check, ok, n) result set; the two
//   new functions SECURITY DEFINER with search_path pinned and EXECUTE
//   revoked (DRLS-16); no destructive DDL (PROJ-10: the column is kept);
//   the two audit actions it writes are filterable (lib/auditActions.ts's
//   PROJECT_ family) and classified "mirrored" on the project timeline.
//   PROJ-5 — lib/projects.ts reads a source 'intake' register row as
//   "intake" (with its link); the Documents card badges it "from intake";
//   the project timeline's entry for an adopted intake document reads as
//   such (TRANSITION_IN).
//   PROJ-1 — the project's requests card reads a deliverable published into
//   review as "in document review" while it is the pending draft, and as the
//   current revision once its review promoted it (it read "Superseded" in
//   review, and "In document review." after completion).
//   The behaviour of 20261262 is proved on PostgreSQL 16 in
//   lib/__tests__/rls/j21ProjectRegisterRecord.test.ts (npm run test:db).

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({ rows: {} as Record<string, Array<Record<string, unknown>>> }));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let range: [number, number] | null = null;
  const finish = () => {
    let rows = (st.rows[table] ?? []).filter((r) => filters.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
    if (range) rows = rows.slice(range[0], range[1] + 1);
    return { data: rows, error: null };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => unknown) => Promise.resolve(finish()).then(res);
      return (...args: unknown[]) => {
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "in") filters.push([String(args[0]), args[1]]);
        if (prop === "range") range = [Number(args[0]), Number(args[1])];
        if (prop === "maybeSingle") return Promise.resolve({ data: finish().data[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } }));

import { listProjectDocuments } from "@/lib/projects";
import { deliverableReference } from "@/lib/ticketProject";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { summarizeAudit, hiddenProjectActions, PROJECT_EVENT_VOCABULARY } from "@/lib/timeline";
import { auditActionDef } from "@/lib/auditActions";

const root = process.cwd();
const FILE = "20261262_prj_roundG_project_register_record.sql";
const SQL = readFileSync(join(root, "supabase", "migrations", FILE), "utf8");
const code = SQL.replace(/--[^\n]*/g, "");

describe("20261262 — DEC-30 one paste, DRLS-16, no destructive DDL", () => {
  it("is the package's only migration and carries the reserved number", () => {
    const mine = readdirSync(join(root, "supabase", "migrations")).filter((f) => f.startsWith("20261262"));
    expect(mine).toEqual([FILE]);
  });
  it("a counts-only TEMP inventory before BEGIN; BEGIN … COMMIT; ONE final SELECT with the (check, ok, n) shape after COMMIT", () => {
    const temp = code.indexOf("CREATE TEMP TABLE prj_round_g_262_before");
    const begin = code.indexOf("\nBEGIN;");
    const commit = code.indexOf("\nCOMMIT;");
    expect(temp).toBeGreaterThan(0);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    const tail = code.slice(commit + "\nCOMMIT;".length);
    expect(tail.trim().startsWith('SELECT "check", ok, n FROM (')).toBe(true);
    expect((tail.match(/;\s*$/gm) ?? []).length).toBe(1); // one statement after COMMIT
    // the inventory is aggregate counts only (never a customer row)
    const inventory = code.slice(temp, begin);
    expect(inventory).not.toMatch(/SELECT\s+\*/i);
    expect((inventory.match(/COUNT\(\*\)::text/g) ?? []).length).toBe(6);
  });
  it("both new functions are SECURITY DEFINER, pin search_path = public and revoke EXECUTE from PUBLIC, anon and authenticated", () => {
    for (const fn of ["project_documents_intake_source", "project_documents_record_link_change"]) {
      const head = code.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}()`);
      expect(head, fn).toBeGreaterThan(0);
      expect(code.slice(head, head + 200)).toMatch(/RETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public\n/);
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, anon, authenticated;`);
    }
  });
  it("PROJ-10 dw2 / no destructive DDL: no DROP TABLE / DROP COLUMN; milestones.linked_ticket_id gets a COMMENT only", () => {
    expect(code).not.toMatch(/DROP\s+TABLE\s+(?!IF EXISTS prj_round_g_262_before)/i);
    expect(code).not.toMatch(/DROP\s+COLUMN/i);
    expect(code).toContain("COMMENT ON COLUMN milestones.linked_ticket_id IS\n  'UNUSED (drafting-flow PROJ-10");
  });
  it("J21 fix pass: refuses to run, changing nothing, without documents.authored_by_link_id (20261104) — the guard runs before the inventory and the transaction", () => {
    const guard = SQL.slice(0, SQL.indexOf("DROP TABLE IF EXISTS prj_round_g_262_before;"));
    expect(guard).toMatch(/DO \$\$\nBEGIN\n  IF NOT EXISTS \(SELECT 1 FROM information_schema\.columns\n\s+WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'authored_by_link_id'\) THEN\n\s+RAISE EXCEPTION 'Apply 20261104_prj_roundG_intake_links\.sql first/);
  });
  it("PROJ-5 (J21 fix pass, review major 2): 'intake' only for the door's reference — no active member behind the write, a document the door created (authored_by_link_id), in the project's own intake folder", () => {
    const head = code.indexOf("CREATE OR REPLACE FUNCTION public.project_documents_intake_source()");
    const fn = code.slice(head, code.indexOf("$$;", head));
    const insertLimb = fn.slice(fn.indexOf("IF NEW.source = 'manual'"));
    expect(insertLimb).toContain("AND NOT EXISTS (\n       SELECT 1\n         FROM org_members m\n        WHERE m.org_id = NEW.org_id AND m.uid = auth.uid() AND m.status = 'active')");
    expect(insertLimb).toContain("AND d.collection_id = p.intake_collection_id\n          AND d.authored_by_link_id IS NOT NULL) THEN\n    NEW.source := 'intake';");
    expect(fn).not.toMatch(/m\.role|roles/); // DB-7: the trigger reads no role
    // the UPDATE limb is unchanged: an intake row keeps 'intake'; 'checkout' is never changed by the trigger
    expect(fn).toContain("IF OLD.source = 'intake' AND NEW.source = 'manual' THEN\n      NEW.source := 'intake';");
  });
  it("PROJ-5: the CHECK keeps checkout and manual and adds intake; existing rows are not rewritten (no UPDATE of project_documents)", () => {
    expect(code).toContain("CHECK (source IN ('checkout', 'manual', 'intake'))");
    expect(code).not.toMatch(/UPDATE\s+project_documents/i);
  });
  it("PROJ-3 dw2: the record writes the two actions as separate INSERT INTO audit_logs statements (the ALOG-11 census reads them); both are registered (PROJECT_ family) and 'mirrored' on the project timeline", () => {
    for (const a of ["PROJECT_DOCUMENT_ATTACHED", "PROJECT_DOCUMENT_DETACHED"]) {
      expect(code).toMatch(new RegExp(`INSERT INTO audit_logs \\(action[^)]*\\)\\s*VALUES \\('${a}'`));
      expect(auditActionDef(a), a).not.toBeNull();
      expect(PROJECT_EVENT_VOCABULARY[a]).toBe("mirrored");
      expect(hiddenProjectActions()).toContain(a);
    }
    expect(auditActionDef("TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN")).not.toBeNull();
  });
});

describe("PROJ-5 — the 'intake' source on the project's Documents tab", () => {
  const seed = (source: string) => {
    st.rows = {
      project_documents: [{ id: "pd1", project_id: "p1", document_id: "d1", source, last_seen_at: "2026-10-22T00:00:00Z" }],
      projects: [{ id: "p1", org_id: "o1", intake_collection_id: "c-in" }],
      documents: [{ id: "d1", org_id: "o1", document_number: "P-1", rev: "A", status: "Draft", library_id: "L", collection_id: "c-filed", current_version_id: "v1" }],
    };
  };
  it("a register row the intake door made reads source 'intake' with its link; manual and checkout read as before", async () => {
    seed("intake");
    expect((await listProjectDocuments("p1")).rows).toEqual([expect.objectContaining({ linkId: "pd1", docId: "d1", source: "intake" })]);
    seed("manual");
    expect((await listProjectDocuments("p1")).rows[0]).toMatchObject({ linkId: "pd1", source: "manual" });
    seed("checkout");
    expect((await listProjectDocuments("p1")).rows[0]).toMatchObject({ linkId: "pd1", source: "checkout" });
  });
  it("the Documents card badges a linked intake row 'from intake' (sourceBadgeKey), an unlinked approved intake document 'approved intake' as before", () => {
    const card = readFileSync(join(root, "components/projects/ProjectDocumentsCard.tsx"), "utf8");
    expect(card).toContain('const badge = SOURCE_BADGE[sourceBadgeKey(r)] ?? SOURCE_BADGE.manual;');
    expect(card).toContain('intakeRef: { label: "from intake"');
    expect(card).toContain('if (!r.linkId) return "intake";\n  return r.source === "intake" ? "intakeRef" : r.source;');
    // the detach confirm's re-link sentence still keys on checkout only
    expect(card).toContain('${r.source === "checkout" ? " It will re-link automatically');
  });
  it("the project timeline's entry for an adopted intake document reads as an adoption (TRANSITION_IN), with its number", () => {
    expect(summarizeAudit({ action: "TRANSITION_IN", details: { projectId: "p1", after: { number: "P-77" } } } as never)).toBe("Adopted from the project's intake into the controlled register as P-77");
    expect(summarizeAudit({ action: "TRANSITION_IN", details: {} } as never)).toBe("Adopted from the project's intake into the controlled register");
    expect(PROJECT_EVENT_VOCABULARY.TRANSITION_IN).toBeUndefined(); // a document row, read through the register — never hidden
    expect(summarizeAudit({ action: "PROJECT_DOCUMENT_ATTACHED", details: { documentNumber: "P-1", source: "intake" } } as never)).toBe("Put on the project's document register: P-1 (by the intake link)");
    expect(summarizeAudit({ action: "PROJECT_DOCUMENT_DETACHED", details: { documentNumber: "P-1" } } as never)).toBe("Removed from the project's document register: P-1");
  });
});

describe("PROJ-1 — the project's requests card reads a deliverable published into review truthfully", () => {
  const state = { state: "published", document_id: "d1", version_id: "v2", revision_label: "2A", in_review: true };
  const doc = { id: "d1", document_number: "P-101", rev: "1", status: "Issued", library_id: "L", current_version_id: "v1", pending_version_id: "v2", archived_at: null };
  it("while it is the pending draft: in document review, not current (it read 'Superseded' before)", () => {
    const r = deliverableReference(state, doc, NOT_CURRENT_STATUSES);
    expect(r).toMatchObject({ kind: "published", canOpen: true, current: false });
    expect((r as { note: string }).note).toBe("In document review — the register stays at Rev 1 until the review completes.");
  });
  it("once its review promoted it: the current revision (it read 'In document review.' before)", () => {
    expect(deliverableReference(state, { ...doc, rev: "2", current_version_id: "v2", pending_version_id: null }, NOT_CURRENT_STATUSES))
      .toMatchObject({ current: true, note: "Current revision." });
  });
  it("neither pending nor current: not current, saying both possible reasons", () => {
    const r = deliverableReference(state, { ...doc, pending_version_id: null }, NOT_CURRENT_STATUSES);
    expect(r).toMatchObject({ current: false });
    expect((r as { note: string }).note).toMatch(/^Not current — the register is at Rev 1 \(its document review closed without publishing it, or a later revision superseded it\)\.$/);
  });
  it("REGRESSION: a deliverable published outside review reads exactly as before (current / superseded / not current / no access)", () => {
    const pub = { state: "published", document_id: "d1", version_id: "v1", revision_label: "1" };
    expect(deliverableReference(pub, { ...doc, pending_version_id: null }, NOT_CURRENT_STATUSES)).toMatchObject({ current: true, note: "Current revision." });
    expect(deliverableReference(pub, { ...doc, current_version_id: "v9", rev: "3" }, NOT_CURRENT_STATUSES)).toMatchObject({ current: false, note: "Superseded — the register is now at Rev 3." });
    expect(deliverableReference(pub, null, NOT_CURRENT_STATUSES)).toMatchObject({ canOpen: false });
  });
  it("the card reads pending_version_id with the document", () => {
    expect(readFileSync(join(root, "components/projects/ProjectRequestsCard.tsx"), "utf8"))
      .toContain('.select("id, document_number, rev, status, library_id, current_version_id, pending_version_id, archived_at")');
  });
});
