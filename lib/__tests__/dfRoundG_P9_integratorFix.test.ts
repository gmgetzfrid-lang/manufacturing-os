// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P9 TICKET-PAGE — the integrator's fix pass
// (DEC-90 rulings, 2026-10-14; fail-safe: never show a definite answer the
// app could not compute).
//
//   EDGE-6 / ROUTE-8  lib/ticketPickerMembers.ts loadPickerMembers — the
//                     drafter picker's member read in keyset pages: every
//                     active member, whatever PostgREST's max-rows is; a
//                     failed page fails the read; a server that ignores the
//                     keyset cannot loop it or duplicate anyone.
//   UI-7              two remaining sites fixed with the shared label list,
//                     AS RENDERED: a document's impact panel
//                     (components/documents/ImpactPanel.tsx) and the
//                     archived-ticket viewer (components/archive/
//                     TicketArchiveViewer.tsx).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  impact: null as Record<string, unknown> | null,
  archived: {} as Record<string, unknown>,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/impact", () => ({ getDocumentImpact: async () => s.impact }));
vi.mock("@/lib/revisionImpact", () => ({ findConnectedDocuments: async () => [] }));
vi.mock("jszip", () => ({
  default: {
    loadAsync: async () => ({
      files: { "tickets/t-9.json": { dir: false } },
      file: (path: string) => (path === "tickets/t-9.json" ? { async: async () => JSON.stringify(s.archived) } : null),
    }),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: () => { throw new Error("the paged reader is given its client"); } } }));

import { loadPickerMembers, PICKER_MEMBER_PAGE, PICKER_MEMBER_COLUMNS } from "@/lib/ticketPickerMembers";
import ImpactPanel from "@/components/documents/ImpactPanel";
import TicketArchiveViewer from "@/components/archive/TicketArchiveViewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── EDGE-6 / ROUTE-8: the paged member read ──────────────────────────────────

type Call = { m: string; a: unknown[] };
/** A PostgREST stand-in for org_members: uid order, `gt`, at most
 *  min(limit, maxRows) rows, the exact count on request. */
function fakeClient(members: Array<Record<string, unknown>>, opts: { maxRows?: number; failPage?: number; ignoreKeyset?: boolean; noCount?: boolean } = {}) {
  const reads: Call[][] = [];
  const client = {
    from: (table: string) => {
      expect(table).toBe("org_members");
      const calls: Call[] = [];
      const api: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gt", "order", "limit"]) api[m] = (...a: unknown[]) => { calls.push({ m, a }); return api; };
      api.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
        reads.push(calls);
        if (opts.failPage === reads.length) return Promise.resolve({ data: null, error: { message: "upstream request timeout" } }).then(ok, ko);
        const after = opts.ignoreKeyset ? undefined : (calls.find((c) => c.m === "gt")?.a[1] as string | undefined);
        const limit = (calls.find((c) => c.m === "limit")?.a[0] as number | undefined) ?? Infinity;
        const sorted = [...members].sort((x, y) => String(x.uid).localeCompare(String(y.uid)));
        const rows = sorted.filter((m) => after === undefined || String(m.uid) > after).slice(0, Math.min(limit, opts.maxRows ?? 1000));
        const wantsCount = (calls.find((c) => c.m === "select")?.a[1] as { count?: string } | undefined)?.count === "exact";
        return Promise.resolve({ data: rows, error: null, ...(wantsCount && !opts.noCount ? { count: members.length } : {}) }).then(ok, ko);
      };
      return api;
    },
  };
  return { client: client as unknown as Parameters<typeof loadPickerMembers>[1], reads };
}
const members = (n: number) => Array.from({ length: n }, (_, i) => ({ uid: `u-${String(i).padStart(5, "0")}`, email: `m${i}@x.io`, role: "Viewer", roles: ["Viewer"], display_name: `M${i}` }));

describe("EDGE-6 / ROUTE-8 (integrator fix pass) — the drafter picker's member read is paged", () => {
  it("2,500 active members at the default max-rows: three keyset pages, every member once, in uid order", async () => {
    const all = members(2500);
    const { client, reads } = fakeClient(all);
    const res = await loadPickerMembers("org-1", client);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(2500);
    expect(new Set(res.rows.map((r) => r.uid)).size).toBe(2500);
    expect(res.rows.map((r) => r.uid)).toEqual(all.map((m) => m.uid));
    expect(reads.length).toBe(3);
    expect(reads[0]).toEqual([
      { m: "select", a: [PICKER_MEMBER_COLUMNS, { count: "exact" }] },
      { m: "eq", a: ["org_id", "org-1"] },
      { m: "eq", a: ["status", "active"] },
      { m: "order", a: ["uid", { ascending: true }] },
      { m: "limit", a: [PICKER_MEMBER_PAGE] },
    ]);
    expect(reads[1]).toEqual(expect.arrayContaining([{ m: "gt", a: ["uid", "u-00999"] }]));
    expect(reads[2]).toEqual(expect.arrayContaining([{ m: "gt", a: ["uid", "u-01999"] }]));
  });
  it("a max-rows far below the page size: the keyset carries on from the last row returned — no one is skipped", async () => {
    const { client, reads } = fakeClient(members(23), { maxRows: 5 });
    const res = await loadPickerMembers("org-1", client);
    expect(res.ok && res.rows.length).toBe(23);
    expect(reads.length).toBe(5); // 5+5+5+5+3 = the count
  });
  it("no count back: it reads on until a page adds nobody", async () => {
    const { client, reads } = fakeClient(members(12), { maxRows: 5, noCount: true });
    const res = await loadPickerMembers("org-1", client);
    expect(res.ok && res.rows.length).toBe(12);
    expect(reads.length).toBe(4); // 5, 5, 2, then an empty page
  });
  it("a server that ignores the keyset cannot loop the read or duplicate a member", async () => {
    const { client, reads } = fakeClient(members(3), { ignoreKeyset: true, noCount: true });
    const res = await loadPickerMembers("org-1", client);
    expect(res.ok && res.rows.length).toBe(3);
    expect(reads.length).toBe(2);
  });
  it("a page that fails fails the whole read, with the reason — never a partial list", async () => {
    const { client } = fakeClient(members(1500), { failPage: 2 });
    expect(await loadPickerMembers("org-1", client)).toEqual({ ok: false, error: "upstream request timeout" });
  });
  it("REGRESSION: a normal workspace is one read, the rows as the database returned them", async () => {
    const few = members(4);
    const { client, reads } = fakeClient(few);
    const res = await loadPickerMembers("org-1", client);
    expect(res).toEqual({ ok: true, rows: few });
    expect(reads.length).toBe(1);
  });
  it("an empty workspace is an empty list, not an error", async () => {
    const { client } = fakeClient([]);
    expect(await loadPickerMembers("org-1", client)).toEqual({ ok: true, rows: [] });
  });
});

// ── UI-7: the remaining sites fixed here, as rendered ────────────────────────

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("UI-7 (integrator fix pass) — a document's impact panel names its open requests' statuses in words", () => {
  it("'Ready to issue (IFC)' and 'Issued — awaiting acknowledgement', never PENDING IFC / FINAL DRAFT", async () => {
    s.impact = {
      assets: [], siblingDocs: [], projects: [], workPackages: [], activeHoldCount: 0, openBranchCount: 0, pendingDistributionAcks: 0,
      openTickets: [
        { id: "t1", ticketId: "KE-0001", title: "Re-route the header", status: "PENDING_IFC" },
        { id: "t2", ticketId: "KE-0002", title: "Add a vent", status: "FINAL_DRAFT" },
      ],
    };
    await act(async () => { root!.render(React.createElement(ImpactPanel, { documentId: "doc-1", orgId: "org-1" })); });
    await flush();
    await act(async () => { (host!.querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    const statuses = Array.from(host!.querySelectorAll("[data-testid=impact-ticket-status]")).map((e) => e.textContent);
    expect(statuses).toEqual(["Ready to issue (IFC)", "Issued — awaiting acknowledgement"]);
    expect(host!.textContent).not.toMatch(/PENDING IFC|FINAL DRAFT|PENDING_IFC|FINAL_DRAFT/);
  });
});

describe("UI-7 (integrator fix pass) — the archived-ticket viewer states the status in words", () => {
  const openArchive = async () => {
    await act(async () => { root!.render(React.createElement(TicketArchiveViewer, { ticketRowId: "t-9", ticketLabel: "KE-0009", archiveId: "arc-1", onClose: () => {} })); });
    await flush();
    const input = host!.querySelector("input[type=file]") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["zip"], "arc-1.zip", { type: "application/zip" })] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
  };
  it("a canceled request reads 'Canceled', never CANCELED", async () => {
    s.archived = { ticket_id: "KE-0009", title: "Old request", status: "CANCELED", requester_name: "Rita" };
    await openArchive();
    expect(host!.querySelector("[data-testid=archived-status]")?.textContent).toBe("Canceled");
    expect(host!.textContent).not.toMatch(/CANCELED/);
    expect(host!.textContent).toMatch(/· Rita/);
  });
  it("REGRESSION: a snapshot with no status shows none (no invented 'Unknown status')", async () => {
    s.archived = { ticket_id: "KE-0009", title: "Old request" };
    await openArchive();
    expect(host!.querySelector("[data-testid=archived-status]")?.textContent).toBe("");
  });
});
