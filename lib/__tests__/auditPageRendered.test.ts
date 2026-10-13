// @vitest-environment jsdom
//
// admin-and-org Round G — package P7, RENDERED: /admin/audit.
//   ALOG-6  — "Export CSV" pages every matching row, writes AUDIT_LOG_EXPORTED
//             BEFORE the file is handed over, and a refused record means no
//             file (said on screen);
//   ALOG-11 — the action filter offers the registry (permission changes,
//             purges, restores…), grouped; the library filter says what it hides;
//   ALOG-7  — each row says whose word its identity is;
//   EVID-12 — an attempt row shows the outcome its _NOT_APPLIED row records.

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
    { id: "n1", action: "TICKET_CLOSE_NOT_APPLIED", resource_type: "ticket", resource_id: "t1", org_id: "o1", user_id: "u1", user_email: "e@x.io", user_role: "Engineer-1", actor_kind: "server", details: { attempt: "a1" }, metadata: null, timestamp: new Date(now - 1000).toISOString() },
    { id: "a1", action: "TICKET_CLOSE", resource_type: "ticket", resource_id: "t1", org_id: "o1", user_id: "u1", user_email: "e@x.io", user_role: "Engineer-1", actor_kind: "server", details: { recordedBeforeApply: true }, metadata: null, timestamp: new Date(now - 2000).toISOString() },
    { id: "c1", action: "CAPABILITY_POLICY_CHANGED", resource_type: "org_configuration", resource_id: "o1", org_id: "o1", user_id: "u2", user_email: "adm@x.io", user_role: "Admin", details: { before: {} }, metadata: null, timestamp: new Date(now - 3000).toISOString() },
    { id: "v1", action: "VIEW", resource_type: "document", resource_id: "d1", org_id: "o1", user_id: "u3", user_email: "dr@x.io", user_role: "Drafter", actor_kind: "member", details: {}, metadata: null, timestamp: new Date(now - 4000).toISOString() },
  ];
  h.libraries = [{ id: "L1", name: "Piping", org_id: "o1" }];
  h.documents = [{ id: "d1", document_number: "P-101", title: "P&ID", name: null, library_id: "L1" }];
  h.limits = []; h.lte = []; h.logged = []; h.logResult = { ok: true, error: null }; h.downloads = 0; h.blobs = []; h.order = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => { h.downloads++; h.blobs.push(b); h.order.push("download"); return "blob:x"; };
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks(); });

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render() { await act(async () => { root!.render(React.createElement(AuditLogPage)); }); await flush(); }
const exportBtn = () => [...host!.querySelectorAll("button")].find((b) => /Export CSV/.test(b.textContent ?? ""))!;

describe("/admin/audit (rendered)", () => {
  it("regression: the rows load and render; each says whose word its identity is (ALOG-7)", async () => {
    await render();
    const text = host!.textContent ?? "";
    expect(text).toContain("Capability Policy Changed");
    expect(text).toContain("as sent by the writer"); // c1: no actor_kind (before 20261201)
    expect(text).toContain("identity resolved by the database at write time"); // v1
  });

  it("EVID-12: the attempt shows the outcome its _NOT_APPLIED row records, and the follow-up names it", async () => {
    await render();
    const text = host!.textContent ?? "";
    expect(text).toMatch(/Not applied — a later row records that this transition did not land/);
    expect(text).toMatch(/Names the attempt row a1/);
  });

  it("ALOG-11: the action filter offers the registry, grouped (a permission change and a purge are choosable)", async () => {
    await render();
    const selects = [...host!.querySelectorAll("select")];
    const actionSel = selects.find((s) => [...s.options].some((o) => o.value === "CAPABILITY_POLICY_CHANGED"))!;
    expect(actionSel).toBeTruthy();
    const values = [...actionSel.options].map((o) => o.value);
    for (const a of ["DATA_PURGE", "NODE_ACL_CHANGED", "RESTORE_BEGIN", "family:TICKET_"]) expect(values).toContain(a);
    expect([...actionSel.querySelectorAll("optgroup")].map((g) => g.label)).toContain("Members, roles & permissions");
  });

  it("ALOG-11 done-when 2: choosing a library says how many other rows it hides", async () => {
    await render();
    const libSel = [...host!.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "L1"))!;
    await act(async () => { libSel.value = "L1"; libSel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(host!.textContent).toMatch(/3 other loaded rows .* are hidden/);
  });

  it("ALOG-6: the export pages the server, records AUDIT_LOG_EXPORTED first, then hands the file over", async () => {
    await render();
    await act(async () => { exportBtn().click(); });
    await flush();
    // Keyset pages of 1000 over the snapshot "dated at or before the export's start": the page of
    // rows, then the empty page that ends the pass (P7 review: a short page may be the server's
    // max_rows cap, never the end) — both bounded by the same start.
    expect(h.limits).toContain(1000);
    expect(h.lte).toHaveLength(2);
    expect(new Set(h.lte).size).toBe(1);
    expect(Date.parse(h.lte[0])).toBeGreaterThanOrEqual(now);
    expect(h.logged).toEqual([expect.objectContaining({
      action: "AUDIT_LOG_EXPORTED", orgId: "o1", resourceType: "org", userId: "u-aud", userRole: "Auditor",
      details: expect.objectContaining({ rows: 4, complete: true }),
    })]);
    expect(h.order).toEqual(["audit", "download"]);
    expect(host!.textContent).toMatch(/Exported 4 row\(s\) — every row the filters select/);
    // P7 review: the file's shape change is told to whoever imports it.
    expect(host!.textContent).toMatch(/The file opens with 13 lines of bounds before the column header \(line 14\); skip them when importing\./);
    expect(exportBtn().getAttribute("title")).toMatch(/opens with 13 lines of bounds before the column header/);
  });

  it("P7 second review (ALOG-6): a row dated after the export began, which the screen shows, is in the file, listed first and counted", async () => {
    h.audit.push({ id: "f1", action: "VIEW", resource_type: "document", resource_id: "d1", org_id: "o1", user_id: "u9", user_email: "forger@x.io", user_role: "Admin", details: {}, metadata: null, timestamp: "2099-01-01T00:00:00.000Z" });
    await render();
    expect(host!.textContent).toContain("forger@x.io"); // on screen
    await act(async () => { exportBtn().click(); });
    await flush();
    expect(h.downloads).toBe(1);
    const csv = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsText(h.blobs[0]); });
    expect(csv).toContain('Rows dated after the export began,"1 (included, listed first');
    const body = csv.split("\n");
    const head = body.findIndex((l) => l.startsWith("Timestamp,"));
    expect(body[head + 1]).toMatch(/^2099-01-01T00:00:00\.000Z,View,VIEW,document,d1,.*forger@x\.io/);
    expect(csv).toMatch(/Complete,Yes/);
    expect(h.logged[0]).toMatchObject({ details: expect.objectContaining({ rows: 5, datedAfterStart: 1 }) });
  });

  it("ALOG-6: a refused export record means no file, and it is said", async () => {
    h.logResult = { ok: false, error: "insert refused" };
    await render();
    await act(async () => { exportBtn().click(); });
    await flush();
    expect(h.downloads).toBe(0);
    expect(host!.textContent).toMatch(/The export was not handed over: its own audit record could not be written \(insert refused\)/);
  });
});
