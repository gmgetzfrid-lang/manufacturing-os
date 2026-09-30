// projects Round G — J8 PROJECT-MODEL, lib/projectExport.ts:
//
//   PERF-2  the org-wide export reads its rows in bulk — per batch of 100
//           projects one checkout read and one register read, then the
//           documents — never one serial round trip per project; it reports
//           progress, can be cancelled, and a refused read fails the export
//           instead of shipping an empty section
//   PM-10   every cell goes through lib/csvSafe: a project named =1+1 is text

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, { message: string } | undefined>,
  from: [] as string[],
}));
function chain(table: string) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  const c: Record<string, unknown> = {};
  const result = () => {
    const err = state.errors[table];
    return err ? { data: null, error: err } : { data: (state.rows[table] ?? []).filter((r) => preds.every((p) => p(r))), error: null };
  };
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
      return (...args: unknown[]) => {
        const [col, v] = args as [string, unknown];
        if (prop === "eq") preds.push((r) => r[col] === v);
        if (prop === "in") preds.push((r) => (v as unknown[]).includes(r[col]));
        if (prop === "maybeSingle") {
          const r = result();
          return Promise.resolve({ data: r.error ? null : ((r.data as unknown[])[0] ?? null), error: r.error });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => { state.from.push(t); return chain(t); } } }));

import { buildAllProjectsCsv, buildProjectCsv, ExportCancelledError, EXPORT_PROJECT_BATCH } from "@/lib/projectExport";

function seed(n: number) {
  state.rows.projects = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, org_id: "o1", name: `Project ${String(i).padStart(3, "0")}`, status: "active", visibility: "public",
  }));
  state.rows.checkout_sessions = state.rows.projects.map((p, i) => ({ id: `s${i}`, project_id: p.id, document_id: `d${i}`, user_name: "ann", mode: "edit", status: "active", started_at: "2026-09-01" }));
  state.rows.project_documents = state.rows.projects.map((p, i) => ({ id: `l${i}`, project_id: p.id, document_id: `d${i}` }));
  state.rows.documents = state.rows.projects.map((_, i) => ({ id: `d${i}`, document_number: `ISO-${i}`, title: "Line", rev: "A", status: "Issued", library_id: "lib" }));
}

beforeEach(() => { state.rows = {}; state.errors = {}; state.from = []; });

describe("PERF-2 — the round-trip count does not grow with every project", () => {
  it("3 projects and 99 projects cost the same number of reads; 150 costs one more batch, not 147 more round trips", async () => {
    seed(3);
    await buildAllProjectsCsv("o1");
    const small = state.from.length;
    state.from = []; seed(99);
    await buildAllProjectsCsv("o1");
    expect(state.from.length).toBe(small);
    state.from = []; seed(150);
    await buildAllProjectsCsv("o1");
    expect(EXPORT_PROJECT_BATCH).toBe(100);
    // 1 projects read + per batch (checkouts + register + documents) — two batches.
    expect(state.from).toEqual(["projects", "checkout_sessions", "project_documents", "documents", "checkout_sessions", "project_documents", "documents"]);
  });

  it("each project's section carries only its own rows", async () => {
    seed(2);
    const csv = await buildAllProjectsCsv("o1");
    const [, first, second] = csv.split(/^#### /m);
    expect(first).toContain("ISO-0");
    expect(first).not.toContain("ISO-1");
    expect(second).toContain("ISO-1");
  });

  it("progress is reported and a cancel stops the export before anything is built", async () => {
    seed(150);
    const seen: Array<[number, number]> = [];
    await buildAllProjectsCsv("o1", { onProgress: (p) => seen.push([p.done, p.total]) });
    expect(seen).toEqual([[0, 150], [100, 150], [150, 150]]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(buildAllProjectsCsv("o1", { signal: ctrl.signal })).rejects.toBeInstanceOf(ExportCancelledError);
  });

  it("a refused read fails the export — never an empty DOCUMENTS section in a file that gets mailed", async () => {
    seed(2);
    state.errors.checkout_sessions = { message: "permission denied for table checkout_sessions" };
    await expect(buildAllProjectsCsv("o1")).rejects.toThrow(/could not read checkouts: permission denied/);
  });

  it("the Export All button cannot start a second run and shows progress with a cancel", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/projects/page.tsx"), "utf8");
    expect(page).toMatch(/if \(!activeOrgId \|\| exportAbort\.current\) return;/);
    expect(page).toMatch(/disabled=\{!activeOrgId \|\| projects\.length === 0 \|\| exportProgress !== null\}/);
    expect(page).toMatch(/Exporting \$\{exportProgress\.done\}\/\$\{exportProgress\.total\}…/);
    expect(page).toMatch(/onClick=\{\(\) => exportAbort\.current\?\.abort\(\)\}/);
  });
});

describe("PM-10 — the exported cells are inert text", () => {
  it("a project named =1+1 and a purpose starting with =cmd are written as quoted, apostrophe-prefixed text", async () => {
    state.rows.projects = [{ id: "p1", org_id: "o1", name: "=1+1", status: "active", description: "@SUM(A1:A9)" }];
    state.rows.checkout_sessions = [{ id: "s1", project_id: "p1", document_id: "d1", user_name: "+ann", mode: "edit", purpose: "=cmd|'/C calc'!A1", status: "active", started_at: "2026-09-01" }];
    state.rows.project_documents = [];
    state.rows.documents = [{ id: "d1", document_number: "-ISO-1", title: "Line", rev: "A", status: "Issued", library_id: "lib" }];
    const built = await buildProjectCsv("p1", "o1");
    const lines = built!.csv.split("\n");
    expect(lines).toContain(`Name,"'=1+1"`);
    expect(lines).toContain(`Description,"'@SUM(A1:A9)"`);
    expect(built!.csv).toContain(`"'+ann",edit,"'=cmd|'/C calc'!A1"`);
    expect(built!.csv).toContain(`"'-ISO-1",Line,A,Issued,lib`);
    // No cell in the file begins with a formula character.
    for (const line of lines) for (const cell of line.split(",")) expect(/^[=+@\t\r-]/.test(cell), cell).toBe(false);
  });

  it("the exporter's only cell encoder is lib/csvSafe", () => {
    const src = readFileSync(join(process.cwd(), "lib/projectExport.ts"), "utf8");
    expect(src).toMatch(/import \{ csvLine \} from "@\/lib\/csvSafe";/);
    expect(src).not.toMatch(/function csvField/);
  });
});
