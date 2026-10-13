// @vitest-environment jsdom
//
// admin-and-org Round G — package P7, ALOG-8 done-when 2 and 3 for the ACL
// drawer (components/permissions/PermissionDrawer.tsx save), RENDERED:
//   * the actor is resolved BEFORE the write: with no signed-in user the
//     change is refused and nothing is written (never saved unaudited, never
//     a NULL user_id row);
//   * a refused NODE_ACL_CHANGED row is said out loud after the save;
//   * regression: a save that records closes the drawer with no alert.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  user: { id: "u-1", email: "dc@x.io" } as { id: string; email: string } | null,
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
      then(res: (v: unknown) => unknown) { return Promise.resolve({ data: [], error: null }).then(res); },
    };
    return q;
  };
  return {
    supabase: {
      from: (t: string) => table(t),
      auth: {
        getUser: async () => ({ data: { user: h.user }, error: null }),
        getSession: async () => ({ data: { session: { access_token: "t" } } }),
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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

async function renderAndSave(onClose = vi.fn()) {
  await act(async () => {
    root!.render(React.createElement(PermissionDrawer, {
      isOpen: true, onClose, nodeType: "document", nodeId: "doc-1", canEdit: true,
      acl: { inherit: true, visibility: "normal", rules: [] }, visibility: "normal",
    } as never));
  });
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
});
