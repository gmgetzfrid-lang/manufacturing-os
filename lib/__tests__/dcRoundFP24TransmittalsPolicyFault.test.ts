// @vitest-environment jsdom
//
// document-control Round F wave 3 — P24: drafting-flow AUTHZ-15, the
// transmittals surface, RENDERED. During a policy-read fault with no last
// good entry (`loadCapabilityPolicyEntry` → `unreadable`), the register drew
// its transmit-authority controls (Receipt, Revoke, Void, Issue) from the
// shipped defaults with nothing on screen (`.catch(() => setPolicy({}))`).
// DEC-90 A26 — authority decisions fail closed; and the integrator's rule
// for this package, verbatim: "an affordance drawn from a cache during a
// database fault must fail closed". So an `unreadable` answer AND a `stale`
// one (the cached last good copy, served because the refresh failed) hold
// the controls back and the page says why (P24 review fix: `stale` was drawn
// as healthy). REGRESSION: a healthy read draws exactly what it drew before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  entry: null as unknown,
  entryCalls: 0,
  rows: [] as Array<Record<string, unknown>>,
  role: { activeOrgId: "org-a", uid: "u-dc", userEmail: "dc@a", activeRole: "DocCtrl", roles: ["DocCtrl"] },
}));

vi.mock("@/lib/supabase", () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null, count: 0 });
        return () => new Proxy(c, h);
      },
    };
    return new Proxy(c, h);
  };
  return { supabase: { from: () => chain(), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  loadCapabilityPolicyEntry: vi.fn(async () => {
    s.entryCalls++;
    if (s.entry instanceof Error) throw s.entry;
    return s.entry;
  }),
}));
vi.mock("@/lib/transmittals", async (orig) => {
  const real = await orig<typeof import("@/lib/transmittals")>();
  return { ...real, listTransmittals: vi.fn(async () => s.rows.map((r) => real.rowToTransmittal(r))) };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => s.role }));
vi.mock("@/components/providers/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/providers/DialogProvider", () => ({ appConfirm: vi.fn(async () => false), appPrompt: vi.fn(async () => null) }));
vi.mock("@/components/navigation/ViewTabs", () => ({ default: () => null, DOCUMENT_VIEWS: [] }));
vi.mock("@/components/documents/DocThumb", () => ({ default: () => null }));
vi.mock("@/components/documents/DocHoverPreview", () => ({ default: () => null }));

import TransmittalsPage from "@/app/(protected)/transmittals/page";

const ISSUED = {
  id: "t-issued", org_id: "org-a", seq: 7, number: "TR-0007", status: "issued", recipient_name: "Acme",
  items: [{ documentId: "d1", number: "P-101", versionId: "v1" }], created_by: "u-other",
  issued_at: "2026-10-01T00:00:00Z", portal_token: "tok", portal_expires_at: "2099-01-01T00:00:00Z",
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  s.entryCalls = 0;
  s.rows = [ISSUED];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => { root.render(React.createElement(TransmittalsPage)); });
  // let the policy read and the register read settle
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}
const fault = () => host.querySelector('[data-testid="transmittal-policy-fault"]');
const button = (title: RegExp) => Array.from(host.querySelectorAll("button")).find((b) => title.test(b.getAttribute("title") ?? "") || title.test(b.textContent ?? ""));

describe("AUTHZ-15 (transmittals) — an unreadable policy holds the transmit-authority controls back and says why", () => {
  it("unreadable, no last good entry: no Receipt / Revoke / Void, and the page says permissions could not be read", async () => {
    s.entry = { policy: {}, version: null, unreadable: "connection refused" };
    await render();
    expect(host.textContent).toContain("TR-0007");
    expect(fault()).not.toBeNull();
    expect(fault()!.getAttribute("role")).toBe("alert");
    expect(fault()!.textContent).toContain("Permissions could not be read");
    expect(fault()!.textContent).toContain("issuing, voiding, revoking a portal link and recording a receipt are not offered until they can be");
    // a DocCtrl would hold transmittal.issue under the SHIPPED DEFAULTS — the controls are still not drawn
    expect(button(/Record recipient receipt/)).toBeUndefined();
    expect(button(/Revoke the portal link/)).toBeUndefined();
    expect(button(/Void — issued in error/)).toBeUndefined();
  });
  it("a read that throws is the same fault — never the defaults; Try again re-reads and, once readable, draws the controls", async () => {
    s.entry = new Error("network down");
    await render();
    expect(fault()).not.toBeNull();
    expect(button(/Void — issued in error/)).toBeUndefined();
    const calls = s.entryCalls;
    s.entry = { policy: {}, version: null };
    await act(async () => { button(/Try again/)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    expect(s.entryCalls).toBe(calls + 1);
    expect(fault()).toBeNull();
    expect(button(/Void — issued in error/)).toBeDefined();
  });
  it("REGRESSION: a healthy read draws the DocCtrl's Receipt / Revoke / Void, with no fault notice", async () => {
    s.entry = { policy: {}, version: null };
    await render();
    expect(fault()).toBeNull();
    expect(button(/Record recipient receipt/)).toBeDefined();
    expect(button(/Revoke the portal link/)).toBeDefined();
    expect(button(/Void — issued in error/)).toBeDefined();
  });
  it("a stale answer (the cached copy, served because the refresh failed) is a fault too — drawn from neither the cache nor the defaults, with the notice", async () => {
    // P24 review fix: was a REGRESSION pin that drew the cached copy silently.
    s.entry = { policy: {}, version: "v1", stale: true, staleError: "timeout" };
    await render();
    expect(fault()).not.toBeNull();
    expect(fault()!.textContent).toContain("Permissions could not be read");
    expect(button(/Record recipient receipt/)).toBeUndefined();
    expect(button(/Revoke the portal link/)).toBeUndefined();
    expect(button(/Void — issued in error/)).toBeUndefined();
    // Try again: once the read is good again, the controls come back
    s.entry = { policy: {}, version: "v2" };
    await act(async () => { button(/Try again/)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    expect(fault()).toBeNull();
    expect(button(/Void — issued in error/)).toBeDefined();
  });
  it("REGRESSION: a healthy read of a narrowed policy still hides the controls, with no notice", async () => {
    s.entry = { policy: { caps: { "transmittal.issue": ["Admin"] } }, version: "v1" };
    await render();
    expect(fault()).toBeNull();
    expect(button(/Void — issued in error/)).toBeUndefined();
  });
  it("REGRESSION: a principal without transmit authority sees no controls and no fault notice on a healthy read", async () => {
    s.role = { ...s.role, uid: "u-eng", activeRole: "Engineer", roles: ["Engineer"] };
    try {
      s.entry = { policy: {}, version: null };
      await render();
      expect(fault()).toBeNull();
      expect(button(/Void — issued in error/)).toBeUndefined();
    } finally {
      s.role = { ...s.role, uid: "u-dc", activeRole: "DocCtrl", roles: ["DocCtrl"] };
    }
  });
});
