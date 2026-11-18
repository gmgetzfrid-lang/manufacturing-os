// @vitest-environment jsdom
//
// projects-tab PERF-12 (projects-joint J18) — the sidebar's logo modal is
// fetched on use, not with the app shell. The REAL Sidebar renders here; the
// modal is a stand-in (its own behaviour is pinned by aoRoundGLogoModal).
//   * someone who can edit the branding: the "Add a workspace logo" button
//     opens the modal on the first click, before it was ever fetched; closing
//     and reopening is immediate; the browser's idle moment fetches it unasked;
//   * someone who cannot: no button, and nothing is fetched on idle.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const fx = vi.hoisted(() => {
  const st = { canEdit: true, offline: false, fetches: 0, toasts: [] as Array<Record<string, unknown>> };
  // One role object for every render (as RoleContext's memoised value is):
  // a fresh one each render would re-run every effect that depends on it.
  const role = {
    roles: ["Admin"], activeRole: "Admin", activeOrgId: "o1", uid: "u1", userEmail: "me@example.com",
    membershipState: "member", hasAnyRole: () => st.canEdit, setActiveOrgId: () => {},
  };
  return Object.assign(st, { role });
});

vi.mock("@/lib/supabase", () => {
  // The workspace switcher (where the logo button lives) lists this
  // account's workspaces; every other read is empty.
  const chain = (table: string): Record<string, unknown> => {
    const data = table === "org_members" ? [{ org_id: "o1", orgs: { id: "o1", name: "Plant One" } }] : [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order", "limit", "is", "or", "gte", "in", "update"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve({ data, error: null, count: 0 }).then(ok, ko);
    return q;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: { from: (t: string) => chain(t), channel: () => channel, removeChannel: () => {}, auth: { signOut: async () => ({}) } },
    setPreferMicrosoft: () => {},
  };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => fx.role }));
vi.mock("@/components/providers/OrgBrandingProvider", () => ({
  useOrgBranding: () => ({ logoUrl: null, branding: null, canEdit: fx.canEdit }),
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/swSession", () => ({ clearServiceWorkerSession: async () => {}, signOutOfThisBrowser: async () => ({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("@/lib/capabilityPolicy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCapabilityPolicy: async () => undefined,
}));
vi.mock("@/lib/inAppNotifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listMyNotifications: async () => [],
}));
vi.mock("@/components/providers/ToastProvider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalToast: () => ({ showToast: (t: Record<string, unknown>) => { fx.toasts.push(t); } }),
}));
vi.mock("@/components/branding/LogoUploadModal", () => ({
  default: ({ onClose }: { onClose: () => void }) =>
    React.createElement("div", { "data-logo-modal": "" },
      React.createElement("button", { type: "button", "data-logo-close": "", onClick: onClose }, "Close")),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
/** The browser's idle callbacks, held until a test says the browser is idle
 *  (so a cold-shell test is never overtaken by the idle preload). */
let idleQueue = new Map<number, () => void>();
let idleIds = 0;
const browserIdle = () => act(async () => { const q = [...idleQueue.values()]; idleQueue.clear(); for (const cb of q) cb(); });
async function until(ok: () => boolean, label: string, ms = 5000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}
const logoButton = () => document.querySelector('button[title="Add a workspace logo"]') as HTMLButtonElement | null;
const modal = () => document.querySelector("[data-logo-modal]");

beforeEach(() => {
  idleQueue = new Map();
  (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback = (cb) => { idleQueue.set(++idleIds, cb); return idleIds; };
  (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback = (id) => { idleQueue.delete(id); };
  vi.resetModules();
  fx.canEdit = true; fx.offline = false; fx.fetches = 0; fx.toasts = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("PERF-12 — the sidebar's logo modal loads on use", () => {
  it("the first click opens it before it was ever fetched; close; reopen at once", async () => {
    const { default: Sidebar, logoUploadModalModule } = await import("@/components/navigation/Sidebar");
    await act(async () => { root.render(React.createElement(Sidebar)); });
    await until(() => !!logoButton(), "the workspace switcher");
    expect(logoUploadModalModule.peek()).toBeUndefined();
    expect(modal()).toBeNull();
    await act(async () => { logoButton()!.click(); });
    await until(() => !!modal(), "the logo modal");
    await act(async () => { (document.querySelector("[data-logo-close]") as HTMLButtonElement).click(); });
    expect(modal()).toBeNull();
    await act(async () => { logoButton()!.click(); });
    expect(modal()).not.toBeNull();
  });

  it("an editor's tab fetches it when the browser is first idle; a tab that cannot edit never does", async () => {
    const { default: Sidebar, logoUploadModalModule } = await import("@/components/navigation/Sidebar");
    fx.canEdit = false;
    await act(async () => { root.render(React.createElement(Sidebar)); });
    await until(() => document.body.textContent?.includes("Plant One") ?? false, "the workspace switcher");
    await browserIdle();
    expect(document.body.textContent).toContain("Plant One"); // the switcher is up, with no logo button
    expect(logoButton()).toBeNull();
    expect(logoUploadModalModule.peek()).toBeUndefined();
    fx.canEdit = true; fx.offline = false; fx.fetches = 0; fx.toasts = [];
    await act(async () => { root.render(React.createElement(Sidebar)); });
    await browserIdle();
    await until(() => logoUploadModalModule.peek() !== undefined, "the idle preload");
    expect(modal()).toBeNull(); // fetched, not opened
  });

  // Last: it re-registers the modal (vi.doMock) so its fetch can fail.
  it("a click offline closes the request and says so; the next click, back online, fetches again and opens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("@/components/branding/LogoUploadModal", async () => {
      fx.fetches++;
      if (fx.offline) throw new Error("Failed to fetch dynamically imported module");
      return { default: () => React.createElement("div", { "data-logo-modal": "" }) };
    });
    try {
      const { default: Sidebar, logoUploadModalModule } = await import("@/components/navigation/Sidebar");
      await act(async () => { root.render(React.createElement(Sidebar)); });
      await until(() => !!logoButton(), "the workspace switcher");
      fx.offline = true;
      await act(async () => { logoButton()!.click(); });
      await until(() => fx.toasts.length === 1, "the failure toast");
      expect(fx.toasts[0]).toEqual({ type: "error", title: "Couldn't load the logo upload", message: "Check your connection and try again." });
      expect(modal()).toBeNull();
      fx.offline = false;
      // the request was closed: a later fetch does not pop the modal open
      await act(async () => { await logoUploadModalModule.preload(); });
      expect(modal()).toBeNull();
      await act(async () => { logoButton()!.click(); });
      await until(() => !!modal(), "the logo modal, fetched again");
      expect(fx.fetches).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});
