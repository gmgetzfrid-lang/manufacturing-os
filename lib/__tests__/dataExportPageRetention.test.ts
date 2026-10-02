// @vitest-environment jsdom
//
// admin-and-org Round G, package P3 (fix pass 7) — BKP-6 Done-when 3, the
// page half: the data-export page's run list (app/(protected)/admin/
// data-export/page.tsx, "Export History") shows a retention purge's counts
// from the run row's own columns (retention_deleted / retention_failed,
// migration 20261172), and, for a run closed before that paste, from its
// trace's retention step, as it did before. Rendered: the page is mounted
// with the runs API answering, and the run rows' text is read. Fix pass 8:
// after the paste the row's counts lead, and what only the trace holds — how
// many objects the purge scanned, and why it stopped — follows them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ORG = "77777777-7777-4777-8777-777777777777";

vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: ORG, activeRole: "Admin", hasAnyRole: (roles: string[]) => roles.includes("Admin") }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
}));
vi.mock("@/lib/clientBackup", () => ({
  startGlobalBackup: vi.fn(async () => undefined),
  subscribeBackup: () => () => undefined,
  cancelBackup: vi.fn(),
  backupIsRunning: () => false,
}));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => true) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import DataExportPage from "@/app/(protected)/admin/data-export/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  destination_id: "dest-1", destination_name: "Nightly bucket", destination_type: "s3", trigger_type: "scheduled",
  status: "succeeded", table_count: 3, total_rows: 30, file_count: 2, total_bytes: 2048, destination_path: "b/backups/x.zip",
  started_at: "2026-10-01T05:00:00.000Z", completed_at: "2026-10-01T05:00:10.000Z", duration_ms: 10_000,
};
const RUNS = [
  // after the paste: a clean purge's count on the row (its trace kept as before, and not what is read)
  { ...base, id: "run-clean", retention_deleted: 3, retention_failed: 0,
    diagnostics: [{ step: "s3:retention:done", detail: "scanned 9, deleted 3 app archive(s)" }] },
  // after the paste: a purge that could not delete everything
  { ...base, id: "run-failed", retention_deleted: 2, retention_failed: 1,
    error_message: "Backup delivered and verified, but the retention purge did not finish: deleted 2 archive(s) older than 30 day(s), 1 could not be deleted — storage refused k: AccessDenied.",
    diagnostics: [{ step: "s3:retention:err", detail: "scanned 4, deleted 2 app archive(s), 1 could not be deleted" }] },
  // after the paste: a purge refused outright — 0 and 0, still a failure (its trace says so)
  { ...base, id: "run-refused", retention_deleted: 0, retention_failed: 0,
    error_message: "Backup delivered and verified, but the retention purge did not finish: deleted 0 archive(s) older than 7 day(s) — Retention purge refused.",
    diagnostics: [{ step: "s3:retention:err", detail: "Retention purge refused" }] },
  // after the paste: a purge whose delete call threw part-way — its counts, what it scanned, and why it stopped
  { ...base, id: "run-stopped", retention_deleted: 5, retention_failed: 2,
    error_message: "Backup delivered and verified, but the retention purge did not finish: deleted 5 archive(s) older than 30 day(s), 2 could not be deleted — the delete call failed: SlowDown.",
    diagnostics: [{ step: "s3:retention:err", detail: "scanned 12, deleted 5 app archive(s), 2 could not be deleted — the delete call failed: SlowDown" }] },
  // closed before the paste: no columns — read from its trace, as before
  { ...base, id: "run-legacy", retention_deleted: null, retention_failed: null,
    diagnostics: [{ step: "s3:retention:done", detail: "scanned 5, deleted 4 app archive(s)" }] },
  // no purge ran (a webhook): no retention line
  { ...base, id: "run-webhook", destination_type: "webhook", destination_name: "Hook", destination_path: "https://hooks.example.com/in",
    retention_deleted: null, retention_failed: null, diagnostics: [{ step: "webhook:done" }] },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith("/api/data-export/runs")) return new Response(JSON.stringify({ runs: RUNS }), { status: 200 });
    if (u.startsWith("/api/data-export/destinations")) return new Response(JSON.stringify({ destinations: [] }), { status: 200 });
    return new Response("not found", { status: 404 });
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Each run row's text, by the order the runs API answered. */
async function renderedRunRows(): Promise<string[]> {
  await act(async () => { root.render(React.createElement(DataExportPage)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const history = [...container.querySelectorAll("h2")].find((h) => h.textContent?.includes("Export History"));
  expect(history, "the Export History section").toBeTruthy();
  const section = history!.closest("div.mb-6")!;
  const rows = [...section.querySelectorAll("div.divide-y > div")];
  return rows.map((r) => r.textContent ?? "");
}

describe("A&O P3 fix pass 7 — BKP-6 Done-when 3: the run list shows a purge's counts from the run row", () => {
  it("a clean purge: its count from the row's columns (the trace's wording, \"app archive(s)\", is not what is shown), then what it scanned (fix pass 8)", async () => {
    const rows = await renderedRunRows();
    expect(rows).toHaveLength(RUNS.length);
    const line = [...container.querySelectorAll("div")].find((d) => d.textContent === "Retention: deleted 3 archive(s) (scanned 9)");
    expect(line, "the clean purge's retention line").toBeTruthy();
    expect(line!.className).not.toContain("text-amber-700");
    expect(rows[0]).not.toContain("could not be deleted");
    expect(rows[0]).not.toContain("app archive(s)");
  });

  it("a failure surfaced: the failed count on the retention line (amber), beside the run's error", async () => {
    await renderedRunRows();
    const line = [...container.querySelectorAll("div")].find((d) => d.textContent === "Retention: deleted 2 archive(s), 1 could not be deleted (scanned 4)");
    expect(line, "the failed purge's retention line").toBeTruthy();
    expect(line!.className).toContain("text-amber-700");
    const rows = [...container.querySelectorAll("div.divide-y > div")].map((r) => r.textContent ?? "");
    expect(rows[1]).toContain("retention purge did not finish");
  });

  it("a purge refused outright (0 and 0 on the row) is still shown as a failure, with why (fix pass 8)", async () => {
    await renderedRunRows();
    const line = [...container.querySelectorAll("div")].find((d) => d.textContent === "Retention: deleted 0 archive(s) — Retention purge refused");
    expect(line).toBeTruthy();
    expect(line!.className).toContain("text-amber-700");
  });

  it("fix pass 8: a purge that stopped part-way — the row's counts first, then what it scanned and why it stopped", async () => {
    await renderedRunRows();
    const line = [...container.querySelectorAll("div")].find((d) => d.textContent === "Retention: deleted 5 archive(s), 2 could not be deleted (scanned 12) — the delete call failed: SlowDown");
    expect(line, "the stopped purge's retention line").toBeTruthy();
    expect(line!.className).toContain("text-amber-700");
  });

  it("a run closed before the paste: read from its trace, as before; a run with no purge has no retention line", async () => {
    const rows = await renderedRunRows();
    expect(rows[4]).toContain("Retention: scanned 5, deleted 4 app archive(s)");
    const clean = [...container.querySelectorAll("div")].find((d) => d.textContent === "Retention: scanned 5, deleted 4 app archive(s)");
    expect(clean!.className).not.toContain("text-amber-700");
    expect(rows[5]).not.toContain("Retention:");
  });
});
