// @vitest-environment jsdom
//
// admin-and-org Round G — package P7, ALOG-8 done-when 2 and 3 for the ACL
// drawer (components/permissions/PermissionDrawer.tsx save), RENDERED:
//   * the actor is resolved BEFORE the write: with no signed-in user the
//     change is refused and nothing is written (never saved unaudited, never
//     a NULL user_id row);
//   * a refused NODE_ACL_CHANGED row is said out loud after the save;
//   * regression: a save that records closes the drawer with no alert.
//   * P7 review: the actor comes from the LOCAL session first — a getUser()
//     failure (slow auth server, failed refresh) with a valid session still
//     saves and records; getUser is the fallback only when no session is held.
//   * intelligence DACL-5 criterion 3 (drawer half): a role rule says which
//     active members it reaches, by headline or additional role.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  user: { id: "u-1", email: "dc@x.io" } as { id: string; email: string } | null,
  sessionUser: null as { id: string; email: string } | null,
  getUserError: null as { message: string } | null,
  members: [] as Array<Record<string, unknown>>,
  membersError: null as { message: string } | null,
  getUserCalls: 0,
  auditError: null as { message: string } | null,
  writes: [] as Array<{ table: string; op: string; row: unknown }>,
  alerts: [] as Array<{ title?: string; message: string; tone?: string }>,
}));

vi.mock("@/lib/supabase", () => {
  const table = (name: string) => {
    const q: Record<string, unknown> = {
      select() { return q; },
      eq() { return q; },
      update(row: unknown) {
        h.writes.push({ table: name, op: "update", row });
        const u: Record<string, unknown> = { eq() { return u; }, select() { return Promise.resolve({ data: [{ id: "doc-1" }], error: null }); } };
        return u;
      },
      insert(row: unknown) { h.writes.push({ table: name, op: "insert", row }); return Promise.resolve({ error: name === "audit_logs" ? h.auditError : null }); },
      then(res: (v: unknown) => unknown) {
        const out = name === "org_members" ? { data: h.membersError ? null : h.members, error: h.membersError } : { data: [], error: null };
        return Promise.resolve(out).then(res);
      },
    };
    return q;
  };
  return {
    supabase: {
      from: (t: string) => table(t),
      auth: {
        getUser: async () => { h.getUserCalls++; return h.getUserError ? { data: { user: null }, error: h.getUserError } : { data: { user: h.user }, error: null }; },
        getSession: async () => ({ data: { session: h.sessionUser ? { access_token: "t", user: h.sessionUser } : null } }),
      },
    },
  };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => ({ activeOrgId: "o1", activeRole: "DocCtrl", roles: ["DocCtrl"] }) }));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: vi.fn(async (a: { title?: string; message: string; tone?: string }) => { h.alerts.push(a); }),
}));
vi.mock("@/lib/teams", () => ({ listTeams: async () => [] }));

import PermissionDrawer from "@/components/permissions/PermissionDrawer";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  h.user = { id: "u-1", email: "dc@x.io" }; h.auditError = null; h.writes = []; h.alerts = [];
  h.sessionUser = null; h.getUserError = null; h.members = []; h.membersError = null; h.getUserCalls = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

async function renderDrawer(onClose = vi.fn(), rules: unknown[] = []) {
  await act(async () => {
    root!.render(React.createElement(PermissionDrawer, {
      isOpen: true, onClose, nodeType: "document", nodeId: "doc-1", canEdit: true,
      acl: { inherit: true, visibility: "normal", rules }, visibility: "normal",
    } as never));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderAndSave(onClose = vi.fn()) {
  await renderDrawer(onClose);
  const save = [...host!.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save");
  expect(save).toBeTruthy();
  await act(async () => { save!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return onClose;
}

describe("ALOG-8 — the ACL drawer never saves a permission change it cannot record", () => {
  it("no signed-in user: refused BEFORE the write — no ACL update, no audit row, the refusal is said", async () => {
    h.user = null;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const onClose = await renderAndSave();
      expect(h.writes).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
      expect(h.alerts.map((a) => a.message).join(" ")).toMatch(/Permissions were NOT saved — your session could not be confirmed/);
    } finally { err.mockRestore(); }
  });

  it("a refused NODE_ACL_CHANGED row is said out loud after the (committed) save", async () => {
    h.auditError = { message: "new row violates row-level security policy" };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await renderAndSave();
      expect(h.writes.map((w) => `${w.table}.${w.op}`)).toEqual(["documents.update", "audit_logs.insert"]);
      expect(h.alerts).toEqual([expect.objectContaining({
        title: "Permissions saved — NOT recorded in the audit log", tone: "danger",
        message: expect.stringMatching(/could not be written \(new row violates row-level security policy\)/),
      })]);
    } finally { err.mockRestore(); }
  });

  it("regression: a save that records writes the row with the resolved actor and closes with no alert", async () => {
    const onClose = await renderAndSave();
    const audit = h.writes.find((w) => w.table === "audit_logs")!.row as Record<string, unknown>;
    expect(audit).toMatchObject({ action: "NODE_ACL_CHANGED", resource_type: "document", resource_id: "doc-1", org_id: "o1", user_id: "u-1", user_email: "dc@x.io" });
    expect(h.alerts).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it("P7 review: a getUser() failure with a valid local session still saves and records the change (no network round trip needed)", async () => {
    h.sessionUser = { id: "u-1", email: "dc@x.io" };
    h.getUserError = { message: "fetch failed" };
    const onClose = await renderAndSave();
    expect(h.writes.map((w) => `${w.table}.${w.op}`)).toEqual(["documents.update", "audit_logs.insert"]);
    expect(h.writes[1].row).toMatchObject({ action: "NODE_ACL_CHANGED", user_id: "u-1", user_email: "dc@x.io" });
    expect(h.getUserCalls).toBe(0);
    expect(h.alerts).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it("P7 review: with no local session, getUser() is the fallback; both empty refuses before any write", async () => {
    h.sessionUser = null; h.user = { id: "u-9", email: "f@x.io" };
    await renderAndSave();
    expect(h.getUserCalls).toBe(1);
    expect(h.writes.find((w) => w.table === "audit_logs")!.row).toMatchObject({ user_id: "u-9" });
    h.writes = []; h.alerts = []; h.user = null; h.getUserError = { message: "refresh failed" };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await renderAndSave();
      expect(h.writes).toEqual([]);
      expect(h.alerts.map((a) => a.message).join(" ")).toMatch(/your session could not be confirmed/);
    } finally { err.mockRestore(); }
  });
});

describe("intelligence DACL-5 criterion 3 — the drawer says which members a role rule reaches", () => {
  const members = [
    { uid: "m1", display_name: "Sam Safety", email: "s@x.io", role: "Safety", roles: ["Safety"] },
    { uid: "m2", display_name: "Erin Eng", email: "e@x.io", role: "Engineer-2", roles: ["Engineer-2", "Safety"] },
    { uid: "m3", display_name: "Dee Draft", email: "d@x.io", role: "Drafter", roles: ["Drafter"] },
  ];

  it("a role rule names the members holding the role — as headline and as an additional role", async () => {
    h.members = members;
    await renderDrawer(vi.fn(), [{ effect: "allow", subject: { type: "role", id: "Safety" }, actions: ["read"] }]);
    const line = host!.querySelector('[data-role-reach="Safety"]')!;
    expect(line.textContent).toBe("Reaches 2 active members holding Safety — as their headline role: Sam Safety; as an additional role: Erin Eng.");
  });

  it("a role nobody holds says the rule reaches no one; a failed member read says so instead of guessing", async () => {
    h.members = members;
    await renderDrawer(vi.fn(), [{ effect: "deny", subject: { type: "role", id: "Auditor" }, actions: ["download"] }]);
    expect(host!.querySelector('[data-role-reach="Auditor"]')!.textContent).toMatch(/No active member holds Auditor today — this rule reaches no one/);
    act(() => root?.unmount()); root = createRoot(host!);
    h.membersError = { message: "permission denied" };
    await renderDrawer(vi.fn(), [{ effect: "allow", subject: { type: "role", id: "Safety" }, actions: ["read"] }]);
    expect(host!.querySelector('[data-role-reach="Safety"]')!.textContent).toMatch(/Who holds Safety could not be read \(permission denied\)/);
  });

  it("the role picker states the rule (headline or any additional role) and who holds the picked role", async () => {
    h.members = members;
    await renderDrawer();
    const subjSel = [...host!.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "role"))!;
    await act(async () => { subjSel.value = "role"; subjSel.dispatchEvent(new Event("change", { bubbles: true })); });
    const pick = host!.querySelector("[data-role-reach-pick]")!;
    expect(pick.textContent).toMatch(/A role rule reaches every active member who holds the role — as their headline role or as any additional role\./);
    const roleSel = [...host!.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "Engineer-2"))!;
    await act(async () => { roleSel.value = "Engineer-2"; roleSel.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host!.querySelector("[data-role-reach-pick]")!.textContent).toMatch(/Reaches 1 active member holding Engineer-2 — as their headline role: Erin Eng\./);
  });
});

