// @vitest-environment jsdom
//
// admin-and-org Round G, package P13 — ALOG-11's hand-off on /admin/audit,
// RENDERED: a DATA_EXPORT row that names its file record (details.fileRecord
// .recordId, DEC-87 §3) carries the "Files — who took which drawing" control
// (components/audit/ExportFilesPanel); a DATA_EXPORT row recorded before the
// ledger (no file record) and every other row do not. Regression: the rows
// render as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  audit: [] as Array<Record<string, unknown>>,
  libraries: [] as Array<Record<string, unknown>>,
  documents: [] as Array<Record<string, unknown>>,
  limits: [] as number[],
  lte: [] as string[],
  logged: [] as Array<Record<string, unknown>>,
  logResult: { ok: true, error: null } as { ok: boolean; error: string | null },
  downloads: 0,
  blobs: [] as Blob[],
  order: [] as string[],
}));

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const orderBy: string[] = [];
    let lim: number | null = null;
    const data = () => {
      const src = table === "audit_logs" ? h.audit : table === "libraries" ? h.libraries : table === "documents" ? h.documents : [];
      const out = src.filter((r) => filters.every((f) => f(r)));
      // DESC on each ordered column, as the export asks (P7 review: the export now
      // pages until an EMPTY page, so the stand-in honours the keyset it sends)
      return orderBy.length ? [...out].sort((x, y) => {
        for (const k of orderBy) { const a = String(x[k] ?? ""), c = String(y[k] ?? ""); if (a !== c) return a < c ? 1 : -1; }
        return 0;
      }) : out;
    };
    const b: Record<string, unknown> = {
      select: () => b,
      order: (k: string) => { orderBy.push(k); return b; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return b; },
      gte: () => b, like: () => b, ilike: () => b,
      or: (f: string) => {
        const m = /^timestamp\.lt\."([^"]+)",and\(timestamp\.eq\."([^"]+)",id\.lt\."([^"]+)"\)$/.exec(f);
        if (m) filters.push((r) => r.timestamp != null && (String(r.timestamp) < m[1] || (String(r.timestamp) === m[2] && String(r.id) < m[3])));
        return b;
      },
      lt: (k: string, v: string) => { filters.push((r) => String(r[k]) < v); return b; },
      gt: (k: string, v: string) => { filters.push((r) => r[k] != null && String(r[k]) > v); return b; },
      lte: (k: string, v: string) => { if (table === "audit_logs") h.lte.push(v); filters.push((r) => r[k] != null && String(r[k]) <= v); return b; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return b; },
      limit: (n: number) => { lim = n; if (table === "audit_logs") h.limits.push(n); return b; },
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: lim === null ? data() : data().slice(0, lim), error: null }).then(res),
    };
    return b;
  };
  return { supabase: { from } };
});
vi.mock("@/lib/audit", () => ({
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { h.logged.push(e); h.order.push("audit"); return h.logResult; }),
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", uid: "u-aud", userEmail: "auditor@x.io", activeRole: "Auditor", roles: ["Auditor"] }),
}));
vi.mock("@/components/ui/IsoGuidance", () => ({ default: () => null }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement("a", { href }, children) }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, ACTIVITY_VIEWS: [] }));

import AuditLogPage from "@/app/(protected)/admin/audit/page";


let root: Root | null = null;
let host: HTMLDivElement | null = null;
const now = Date.now();
beforeEach(() => {
  h.audit = [
    { id: "x1", action: "DATA_EXPORT", resource_type: "org", resource_id: "o1", org_id: "o1", user_id: "u-ann", user_email: "ann@x.io", user_role: "Admin", actor_kind: "member", details: { fileRecord: { recordId: "rec-1", mode: "baseline", sha256: "abc" } }, metadata: null, timestamp: new Date(now - 1000).toISOString() },
    { id: "x2", action: "DATA_EXPORT", resource_type: "org", resource_id: "o1", org_id: "o1", user_id: "u-ann", user_email: "ann@x.io", user_role: "Admin", details: { tableCount: 3 }, metadata: null, timestamp: new Date(now - 2000).toISOString() },
    { id: "v1", action: "VIEW", resource_type: "document", resource_id: "d1", org_id: "o1", user_id: "u3", user_email: "dr@x.io", user_role: "Drafter", actor_kind: "member", details: { fileRecord: { recordId: "not-an-export" } }, metadata: null, timestamp: new Date(now - 3000).toISOString() },
  ];
  h.libraries = []; h.documents = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("ALOG-11 hand-off (P13) — /admin/audit's Files control", () => {
  it("only a DATA_EXPORT row naming its file record carries it", async () => {
    await act(async () => { root!.render(React.createElement(AuditLogPage)); });
    await flush();
    const panels = host!.querySelectorAll('[data-testid="export-files-panel"]');
    expect(panels).toHaveLength(1);
    expect(panels[0].textContent).toContain("Files — who took which drawing");
    // regression: all three rows render
    expect(host!.textContent).toContain("ann@x.io");
    expect(host!.textContent).toContain("dr@x.io");
  });
});
