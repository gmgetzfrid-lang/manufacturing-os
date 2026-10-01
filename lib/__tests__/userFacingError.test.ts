// projects Round G — J10, REL-3 / UX-10 (Done-when 2). The one translator
// from a database refusal to what a plant user reads (lib/userFacingError):
// raw driver text becomes a plain sentence by a fixed table, a rail's own
// refusal (written for users, under 42501 / 23514 / 23505 / 23503 / P0001)
// passes through as written, any other driver error is an "unexpected" line
// that names no internals, and the raw detail is always logged. Then the
// Projects / Companies libraries route through it: no raw Postgres string
// reaches a user from them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const db = vi.hoisted(() => ({ next: null as null | { data: unknown; error: unknown } }));
vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(db.next ?? { data: [], error: null });
      return () => chain();
    },
  });
  return { supabase: { from: () => chain() } };
});
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));

import { userFacingError, userFacingReadError, classifyDbError } from "@/lib/userFacingError";
import { describeWriteError } from "@/lib/checkedWrite";
import { saveCompany, listCompanies, addCompanyEvent } from "@/lib/companies";
import { saveParty, listParties, addEntry } from "@/lib/costs";
import { listChangeOrders } from "@/lib/changeOrders";

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { db.next = null; errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { errSpy.mockRestore(); });

/** Words that would leak the schema to a plant user. */
const INTERNALS = /relation|row-level|policy|constraint|column|schema|PGRST|SQLSTATE|duplicate key|permission denied for|public\.|_id\b|"[a-z_]+"/i;

describe("REL-3 — raw driver text becomes a plain sentence", () => {
  const cases: Array<[string, { message: string; code?: string }, RegExp]> = [
    ["RLS on insert", { message: 'new row violates row-level security policy for table "cost_entries"', code: "42501" }, /^You don't have permission to do this — nothing was changed\.$/],
    ["grant missing", { message: "permission denied for table project_parties", code: "42501" }, /^You don't have permission/],
    ["missing table", { message: 'relation "public.cost_accounts" does not exist', code: "42P01" }, /latest database migration/],
    ["missing column", { message: 'column "company_id" of relation "project_parties" does not exist', code: "42703" }, /latest database migration/],
    ["schema cache column", { message: "Could not find the 'pages_read' column of 'cost_documents' in the schema cache", code: "PGRST204" }, /latest database migration/],
    ["schema cache table", { message: "Could not find the table 'public.turnover_review_events' in the schema cache", code: "PGRST205" }, /latest database migration/],
    ["duplicate", { message: 'duplicate key value violates unique constraint "change_orders_project_co_number_key"', code: "23505" }, /^That already exists — nothing was changed\.$/],
    ["foreign key", { message: 'insert or update on table "cost_entries" violates foreign key constraint "cost_entries_cost_account_id_fkey"', code: "23503" }, /refers to has been removed/],
    ["not null", { message: 'null value in column "planned_at" of relation "milestones" violates not-null constraint', code: "23502" }, /required value is missing/],
    ["check", { message: 'new row for relation "cost_documents" violates check constraint "cost_documents_status_check"', code: "23514" }, /isn't allowed here/],
    ["bad input", { message: 'invalid input syntax for type uuid: "abc"', code: "22P02" }, /expected format/],
    ["lock", { message: "canceling statement due to lock timeout", code: "55P03" }, /changing this right now/],
    ["deadlock", { message: "deadlock detected", code: "40P01" }, /same moment/],
    ["timeout", { message: "canceling statement due to statement timeout", code: "57014" }, /took too long/],
    ["single row", { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }, /wasn't found/],
    ["jwt", { message: "JWT expired", code: "PGRST303" }, /session has expired/],
    ["network", { message: "Failed to fetch" }, /Couldn't reach the server/],
    ["unknown driver error", { message: "could not open file \"base/16384/2619\": No such file or directory", code: "58P01" }, /^Something went wrong on the server/],
  ];
  for (const [name, err, expected] of cases) {
    it(`${name} → a sentence that names no internals, and the raw detail is logged`, () => {
      const out = userFacingError(err, { context: "test" });
      expect(out).toMatch(expected);
      expect(out).not.toMatch(INTERNALS);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errSpy.mock.calls[0])).toContain(JSON.stringify(err.message).slice(1, 20));
    });
  }

  it("an Error carrying a code (a lib's re-throw) is classified by its code and text", () => {
    const e = Object.assign(new Error('relation "public.change_orders" does not exist'), { code: "42P01" });
    expect(classifyDbError(e)).toBe("migration");
    expect(userFacingError(e)).toMatch(/migration/);
  });

  it("a failed read is worded as a read — no 'nothing was changed'", () => {
    expect(userFacingReadError({ message: "permission denied for table companies", code: "42501" })).toBe("You don't have permission to see this.");
    expect(userFacingReadError({ message: 'relation "companies" does not exist', code: "42P01" })).toBe("This needs the latest database migration applied.");
  });
});

describe("REL-3 — a refusal written for users passes through untouched (never re-worded, never logged)", () => {
  const rails: Array<[string, { message: string; code?: string }]> = [
    ["a rail under 42501", { message: "Only a controller, the owner or a quality sign-off holder can sign this checklist off.", code: "42501" }],
    ["a rail under 23514", { message: "A closed project's cost records are read-only — reopen the project first.", code: "23514" }],
    ["a rail under 23505", { message: "This revision label is already used on this document.", code: "23505" }],
    ["a rail under 23503", { message: "That budget line belongs to another project.", code: "23503" }],
    ["plain RAISE (P0001)", { message: "The intake link has expired — ask the project team for a fresh one.", code: "P0001" }],
    ["a lib's own sentence", { message: "“Apex Industrial” is already in the registry." }],
  ];
  for (const [name, err] of rails) {
    it(name, () => {
      expect(classifyDbError(err)).toBe("passthrough");
      expect(userFacingError(err)).toBe(err.message);
      expect(errSpy).not.toHaveBeenCalled();
    });
  }
  it("describeWriteError keeps its own sentences and now maps the rest (a 23505 used to reach the screen raw)", () => {
    expect(describeWriteError({ message: "x", code: "42501" })).toBe("You don't have permission to do this — nothing was changed.");
    expect(describeWriteError({ message: "canceling statement due to lock timeout", code: "55P03" })).toMatch(/checklist right now/);
    expect(describeWriteError({ message: 'duplicate key value violates unique constraint "turnover_items_key"', code: "23505" })).toBe("That already exists — nothing was changed.");
    expect(describeWriteError({ message: "The checklist is complete — reopen it before changing an item.", code: "P0001" })).toBe("The checklist is complete — reopen it before changing an item.");
  });
});

describe("REL-3 — the Projects and Companies libraries route through it", () => {
  const RLS = { message: 'new row violates row-level security policy for table "companies"', code: "42501" };

  it("companies: a denied write and a denied read read as sentences; the 23505 precedent is kept", async () => {
    db.next = { data: null, error: RLS };
    await expect(saveCompany({ orgId: "o1", name: "Apex", kind: "contractor", actorId: "u1" })).rejects.toThrow("You don't have permission to do this — nothing was changed.");
    db.next = { data: null, error: { message: "permission denied for table companies", code: "42501" } };
    await expect(listCompanies("o1")).rejects.toThrow("You don't have permission to see this.");
    db.next = { data: null, error: { message: 'duplicate key value violates unique constraint "companies_org_name_key"', code: "23505" } };
    await expect(saveCompany({ orgId: "o1", name: "Apex", kind: "contractor", actorId: "u1" })).rejects.toThrow("\"Apex\" is already in the registry.");
    db.next = { data: null, error: { message: 'relation "public.company_events" does not exist', code: "42P01" } };
    await expect(addCompanyEvent({ orgId: "o1", companyId: "c1", kind: "near_miss", eventDate: "2026-10-01", description: "Crane swing", actorId: "u1" })).rejects.toThrow(/latest database migration/);
  });

  it("costs: the party, list and entry paths never hand back driver text", async () => {
    db.next = { data: null, error: RLS };
    const r = await saveParty({ orgId: "o1", projectId: "p1", patch: { name: "Apex" }, actor: { uid: "u1", email: null } });
    expect(r).toEqual({ ok: false, error: "You don't have permission to do this — nothing was changed." });
    db.next = { data: null, error: { message: 'relation "public.project_parties" does not exist', code: "42P01" } };
    await expect(listParties("o1", "p1")).rejects.toThrow("Couldn't load the contractors: This needs the latest database migration applied.");
    db.next = { data: null, error: { message: 'insert or update on table "cost_entries" violates foreign key constraint "x"', code: "23503" } };
    const e = await addEntry({ orgId: "o1", projectId: "p1", costAccountId: "a1", entryType: "actual", amount: 10, entryDate: "2026-10-01", actor: { uid: "u1", email: null } });
    expect(e.ok).toBe(false);
    expect(e.error).not.toMatch(INTERNALS);
  });

  it("change orders: the list read keeps its code (callers tell a missing table from a refusal) and loses the driver text", async () => {
    db.next = { data: null, error: { message: 'relation "public.change_orders" does not exist', code: "42P01" } };
    const err = await listChangeOrders("p1").catch((x: unknown) => x as Error & { code?: string });
    expect((err as { code?: string }).code).toBe("42P01");
    expect((err as Error).message).toBe("This needs the latest database migration applied.");
  });

  it("source census: in the Projects / Companies libraries every database error message reaches the user only through the translator", () => {
    const offenders: string[] = [];
    // The cited libraries, then the rest of the Projects area's data layer
    // (the schedule engine, project lifecycle, activity feed, transition-in,
    // intake links, the export and the report) — UX-10 done-when 2.
    for (const f of ["lib/companies.ts", "lib/costs.ts", "lib/costDocs.ts", "lib/changeOrders.ts", "lib/checklists.ts", "lib/turnover.ts",
      "lib/milestones.ts", "lib/projects.ts", "lib/timeline.ts", "lib/transitionIn.ts", "lib/intakeLinks.ts", "lib/projectExport.ts", "lib/projectReport.ts"]) {
      const lines = readFileSync(join(process.cwd(), f), "utf8").split("\n");
      lines.forEach((line, i) => {
        // any `<name>.message` / `<name>?.message` — a caught Error re-thrown
        // from an already-translated lib call ((e as Error).message) is fine
        if (!/\b[A-Za-z_][\w.]*\??\.message\b/.test(line.replace(/\(e as Error\)\??\.message/g, ""))) return;
        // logic that reads the driver text (never shown): schema step-down,
        // missing-RPC / missing-table probes, classification, a structured
        // {message, code} handed to a translating caller, a rail's own
        // sentence under 23514, an Error already translated upstream.
        if (/console\.(warn|error|log)|\.test\(|isMissing|missingColumn|looksLikeUnknownColumn|refusedColumn|=== |\/does not exist|const msg = (err\.message|\(error\.message|`\$\{(error|e)\.message)|\{ message: error\.message, code|releaseFailure\.message|code === "23514" && error\.message/.test(line)) return;
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
