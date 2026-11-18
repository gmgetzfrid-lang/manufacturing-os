// @vitest-environment jsdom
//
// drafting-flow EVID-15 (projects-joint J15c) — the secure viewer's VIEW row,
// rendered (components/viewers/SecureDocViewer.tsx). The row was fired with
// only a `.catch`: logAuditAction RESOLVES `{ ok: false }` when the insert is
// refused, so a refused VIEW row passed in silence. It now runs in its own
// task — the document never waits on it — where it is awaited and its
// outcome read: a refusal is logged as refused, a throw as failed. The row
// itself is unchanged (SESS-6: the role omitted while none is known).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const v = vi.hoisted(() => ({ log: vi.fn(), role: "Engineer" as string | null }));
vi.mock("@/lib/audit", () => ({ logAuditAction: (...a: unknown[]) => v.log(...a) }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => undefined) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appAlert: vi.fn() }));
vi.mock("@/components/archive/BackupViewer", () => ({ default: () => null }));
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ userEmail: "ann@x.test", uid: "u1", activeRole: v.role }) }));
vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (x: unknown) => void) => resolve({ data: null, error: null });
      return () => chain();
    },
  });
  return { supabase: { from: () => chain(), auth: { getSession: async () => ({ data: { session: null } }) } } };
});

import SecureDocViewer from "@/components/viewers/SecureDocViewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let errSpy: ReturnType<typeof vi.spyOn>;
const fetches: string[] = [];
beforeEach(() => {
  v.log.mockReset(); v.role = "Engineer"; fetches.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => { fetches.push(String(input)); return new Response(new Blob(["%PDF-1.4"], { type: "application/pdf" })); }));
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:view";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); errSpy.mockRestore(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const open = async () => {
  await act(async () => {
    root.render(React.createElement(SecureDocViewer, {
      url: "https://files.example.test/orgs/o1/P-101.pdf", title: "P-101.pdf", docNumber: "P-101", rev: "B",
      documentId: "d1", orgId: "o1", zoomLevel: 1,
    }));
  });
  await settle();
};
const logged = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));

describe("EVID-15 — the secure viewer's VIEW row is awaited and its outcome read", () => {
  it("a refused VIEW row ({ ok: false }) is logged as refused — never a silent success", async () => {
    v.log.mockResolvedValue({ ok: false, error: "new row violates row-level security policy for table \"audit_logs\"" });
    await open();
    expect(v.log).toHaveBeenCalledTimes(1);
    expect(logged()).toContain("[audit] VIEW row REFUSED — this view is missing from the document's audit trail:");
    expect(errSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes("REFUSED"))?.[1]).toBe("new row violates row-level security policy for table \"audit_logs\"");
  });

  it("a VIEW row that throws is logged as failed", async () => {
    v.log.mockRejectedValue(new Error("fetch failed"));
    await open();
    expect(logged()).toContain("[audit] VIEW row failed — this view is missing from the document's audit trail:");
  });

  it("a VIEW row that lands logs nothing", async () => {
    v.log.mockResolvedValue({ ok: true, error: null });
    await open();
    expect(logged().filter((m: string) => m.startsWith("[audit]"))).toEqual([]);
  });

  it("the document never waits on the row: a VIEW write that never answers still lets the file load", async () => {
    v.log.mockImplementation(() => new Promise(() => undefined));
    await open();
    expect(fetches).toEqual(["https://files.example.test/orgs/o1/P-101.pdf"]);
  });

  it("the row is unchanged — the same fields, the role omitted while none is known (SESS-6)", async () => {
    v.log.mockResolvedValue({ ok: true, error: null });
    v.role = null;
    await open();
    expect(v.log).toHaveBeenCalledWith({
      action: "VIEW", resourceId: "d1", resourceType: "document", orgId: "o1",
      userId: "u1", userEmail: "ann@x.test", userRole: undefined, details: { fileName: "P-101.pdf" },
    });
  });
});
