// @vitest-environment jsdom
//
// admin-and-org Round G, P8 ORG-ADMIN SURFACES — the app half, driven as
// rendered (jsdom) and through the real route handlers, against the
// in-memory PostgREST (helpers/fakeSupabase).
//
//   ALOG-3   /api/admin/libraries/delete counts what the cascade removes,
//            refuses when it cannot count or the counts moved, deletes AS
//            THE CALLER, records LIBRARY_DELETED (once — the 20261204
//            trigger's row is found, never duplicated); the confirmation
//            shows the counts and says "cascade", never "may become
//            orphaned".
//   ALOG-4   a role grant and a role removal on /admin/users each write an
//            audit row naming actor, subject and the roles before and after;
//            a role write RLS filtered out (zero rows) is a refusal; a
//            refused audit row is said. /api/admin/create-user records the
//            add and the re-add (reactivation / role grant), checked; the
//            request-numbering save is checked and audited (dw2).
//   ORG-4    the numbering save reads back the row it changed (checkedWrite):
//            zero rows is "not saved", never a green "Saved".
//   ORG-15   a failed members read or pending-requests read shows an error,
//            never an empty roster or a missing card.
//   ORG-11   the org palette is validated before it reaches the theme, and
//            a non-hex palette is refused before it is written.
//   ORG-13   a supervisor must be an active member of the team's workspace.
//   NEDGE-19 / VFY-15  the workspace time zone: an Admin saves an IANA zone
//            (org_configurations key timezone, data.timeZone — the shape
//            orgTimeZone reads), checked and audited.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextRequest } from "next/server";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  appAlert: vi.fn(async (..._a: unknown[]) => undefined),
  appConfirm: vi.fn(async (..._a: unknown[]) => true),
  role: { activeRole: "Admin", roles: ["Admin"], uid: "a1", userEmail: "admin@x.io", activeOrgId: "o1" } as Record<string, unknown>,
  caller: { id: "a1", email: "admin@x.io" } as { id: string; email: string } | null,
}));

vi.mock("@/lib/supabase", () => ({ get supabase() { return makeFakeSupabase(s.db); } }));
vi.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return {
      ...makeFakeSupabase(s.db),
      auth: {
        getUser: async () => ({ data: { user: s.caller }, error: s.caller ? null : { message: "no" } }),
        admin: {
          createUser: async ({ email }: { email: string }) => ({ data: { user: { id: `auth-${email}` } }, error: null }),
          listUsers: async () => ({ data: { users: [] }, error: null }),
          deleteUser: async () => ({ error: null }),
        },
      },
    };
  },
}));
vi.mock("@/lib/serverAuth", () => ({
  assertOrgHasAccess: async () => null,
  callerScopedClient: () => makeFakeSupabase(s.db),
}));
vi.mock("@/lib/adminGate", () => ({
  authorizeAdminSurface: async () => ({ userId: "a1", email: "admin@x.io", orgId: "o1", role: "Admin", roles: ["Admin"], admin: makeFakeSupabase(s.db), surface: {}, admittedRole: "Admin" }),
}));
vi.mock("@/lib/accessRequestOutcome", () => ({ clearAccessRequestNotices: vi.fn(async () => undefined), queueAccessRequestOutcome: vi.fn(async () => undefined) }));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ ...s.role, hasAnyRole: (rs: string[]) => rs.some((r) => (s.role.roles as string[]).includes(r)) }),
}));
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: (...a: unknown[]) => s.appAlert(...a),
  appConfirm: (...a: unknown[]) => s.appConfirm(...a),
}));
vi.mock("@/lib/members", () => ({ revokeMember: vi.fn(async () => ({ mode: "remove", cleared: null })) }));
vi.mock("@/lib/capabilityPolicy", () => ({ invalidateCapabilityPolicy: vi.fn() }));
vi.mock("@/components/ui/UserAvatar", () => ({ default: () => null }));
vi.mock("@/lib/notifications", () => ({ kickEmailDrain: vi.fn(async () => null) }));
vi.mock("@/lib/ticketNumber", () => ({
  formatTicketNumber: () => "DDRT-2026-0001",
  getTicketNumberConfig: async () => ({ prefix: "", recordCode: "DDRT", pad: 4 }),
  TICKET_NUMBER_DEFAULTS: { prefix: "", recordCode: "DDRT", pad: 4 },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import { POST as deleteRoute } from "@/app/api/admin/libraries/delete/route";
import { POST as createUserRoute } from "@/app/api/admin/create-user/route";
import DeleteSafetyModal from "@/app/(protected)/admin/libraries/DeleteSafetyModal";
import AdminUsersPage from "@/app/(protected)/admin/users/page";
import WorkspaceSettingsPage from "@/app/(protected)/admin/settings/page";
import { countLibraryDeleteImpact, impactChanged } from "@/lib/libraryDeleteImpact";
import { sanitizeOrgPalette, PALETTE_PRESETS } from "@/components/providers/ThemeProvider";
import { saveOrgBranding, brandingPaletteProblem } from "@/lib/orgBranding";
import { assertSupervisorIsActiveMember, setTeamSupervisor } from "@/lib/teams";
import { saveWorkspaceTimeZone, readWorkspaceTimeZone } from "@/lib/workspaceTimeZone";
import { orgTimeZone, formatRecordTime } from "@/lib/recordTime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const savedFetch = globalThis.fetch;
beforeEach(() => {
  s.db = newFakeDb();
  s.appAlert.mockClear();
  s.appConfirm.mockClear();
  s.role = { activeRole: "Admin", roles: ["Admin"], uid: "a1", userEmail: "admin@x.io", activeOrgId: "o1" };
  s.caller = { id: "a1", email: "admin@x.io" };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = savedFetch;
  vi.restoreAllMocks();
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const click = async (el: Element | undefined | null) => { expect(el).toBeTruthy(); await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await flush(); };
const button = (re: RegExp) => [...host.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim())) as HTMLButtonElement | undefined;
const audits = (action: string) => (s.db.tables.audit_logs ?? []).filter((r) => r.action === action);
const req = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});

// ── ALOG-3 ──────────────────────────────────────────────────────────────────
function seedLibrary() {
  s.db.tables.libraries = [{ id: "L1", org_id: "o1", name: "Piping Isometrics" }, { id: "L2", org_id: "o1", name: "Other" }];
  s.db.tables.collections = [{ id: "c1", library_id: "L1" }, { id: "c2", library_id: "L1" }, { id: "c3", library_id: "L2" }];
  s.db.tables.documents = [
    { id: "d1", org_id: "o1", library_id: "L1", legal_hold: false },
    { id: "d2", org_id: "o1", library_id: "L1", legal_hold: false },
    { id: "d3", org_id: "o1", library_id: "L2", legal_hold: false },
  ];
  s.db.tables.document_versions = [{ id: "v1", record_id: "d1" }, { id: "v2", record_id: "d1" }, { id: "v3", record_id: "d2" }, { id: "v4", record_id: "d3" }];
  s.db.tables.document_holds = [{ id: "h1", document_id: "d2", released_at: null }, { id: "h2", document_id: "d1", released_at: "2026-01-01" }];
  s.db.tables.tickets = [];
}
const IMPACT_L1 = { folders: 2, documents: 2, revisions: 3, openHolds: 1, legalHolds: 0, requests: 0 };

describe("ALOG-3 — a library delete counts, refuses when it must, deletes as the caller, and is recorded once", () => {
  it("the count: folders, documents, revisions, open holds, legal holds — this library only", async () => {
    seedLibrary();
    s.db.tables.documents[0].legal_hold = true;
    const r = await countLibraryDeleteImpact(makeFakeSupabase(s.db) as never, "o1", "L1");
    expect(r).toEqual({ ok: true, impact: { ...IMPACT_L1, legalHolds: 1 } });
  });

  it("a count that cannot be read is a failure, never a zero", async () => {
    seedLibrary();
    s.db.selectErrors = { document_versions: { message: "statement timeout" } };
    const r = await countLibraryDeleteImpact(makeFakeSupabase(s.db) as never, "o1", "L1");
    expect(r).toEqual({ ok: false, error: "revisions: statement timeout" });
  });

  it("preview returns the counts and deletes nothing", async () => {
    seedLibrary();
    const res = await deleteRoute(req("/api/admin/libraries/delete", { orgId: "o1", libraryId: "L1", preview: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, library: { id: "L1", name: "Piping Isometrics" }, impact: IMPACT_L1 });
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L1", "L2"]);
    expect(audits("LIBRARY_DELETED")).toEqual([]);
  });

  it("the delete writes LIBRARY_DELETED naming the library, the counts and the actor", async () => {
    seedLibrary();
    const res = await deleteRoute(req("/api/admin/libraries/delete", { orgId: "o1", libraryId: "L1", expected: IMPACT_L1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: true, recordedBy: "app" });
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L2"]);
    const rows = audits("LIBRARY_DELETED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_type: "library", resource_id: "L1", org_id: "o1", user_id: "a1", user_email: "admin@x.io", user_role: "Admin" });
    expect(rows[0].details).toEqual({ name: "Piping Isometrics", via: "app", countedBeforeDelete: true, ...IMPACT_L1 });
  });

  it("after 20261204: the trigger's row is found and no second row is written", async () => {
    seedLibrary();
    s.db.tables.audit_logs = [{ id: "x", action: "LIBRARY_DELETED", resource_id: "L1", details: { via: "database" } }];
    const res = await deleteRoute(req("/api/admin/libraries/delete", { orgId: "o1", libraryId: "L1" }));
    expect(await res.json()).toMatchObject({ ok: true, recordedBy: "database" });
    expect(audits("LIBRARY_DELETED")).toHaveLength(1);
  });

  it("counts that moved since the dialog opened refuse the delete (409) and return the new counts", async () => {
    seedLibrary();
    const res = await deleteRoute(req("/api/admin/libraries/delete", { orgId: "o1", libraryId: "L1", expected: { ...IMPACT_L1, documents: 1 } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ changed: true, impact: IMPACT_L1 });
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L1", "L2"]);
    expect(impactChanged({ documents: 2 }, IMPACT_L1)).toBe(false);
    expect(impactChanged(null, IMPACT_L1)).toBe(false);
  });

  it("a count failure refuses the delete (503) — nothing is deleted", async () => {
    seedLibrary();
    s.db.selectErrors = { collections: { message: "boom" } };
    const res = await deleteRoute(req("/api/admin/libraries/delete", { orgId: "o1", libraryId: "L1" }));
    expect(res.status).toBe(503);
    expect(s.db.tables.libraries.map((l) => l.id)).toEqual(["L1", "L2"]);
  });

  it("another workspace's library is not found (404); the guard's refusal and a zero-row delete come back as refusals; no audit row", async () => {
    seedLibrary();
    s.db.tables.libraries.push({ id: "LX", org_id: "o2", name: "Theirs" });
    expect((await deleteRoute(req("/api/admin/libraries/delete", { orgId: "o1", libraryId: "LX" }))).status).toBe(404);
    s.db.deleteErrors = { libraries: { code: "23001", message: "D-1 is under legal hold" } };
    const refused = await deleteRoute(req("/api/admin/libraries/delete", { orgId: "o1", libraryId: "L1" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("D-1 is under legal hold");
    s.db.deleteErrors = {};
    s.db.refuseWrites.add("libraries");
    const none = await deleteRoute(req("/api/admin/libraries/delete", { orgId: "o1", libraryId: "L1" }));
    expect(none.status).toBe(403);
    expect((await none.json()).error).toMatch(/^the database deleted nothing/);
    expect(audits("LIBRARY_DELETED")).toEqual([]);
  });

  it("a refused audit row is said (auditError), the library is already gone", async () => {
    seedLibrary();
    s.db.refuseWrites.add("audit_logs");
    const res = await deleteRoute(req("/api/admin/libraries/delete", { orgId: "o1", libraryId: "L1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, recordedBy: null, auditError: expect.stringMatching(/row-level security/) });
  });

  it("the confirmation shows the counts, says the delete cascades, and cannot confirm without counts", async () => {
    const render = async (props: Partial<React.ComponentProps<typeof DeleteSafetyModal>>) => {
      await act(async () => {
        root.render(React.createElement(DeleteSafetyModal, { isOpen: true, onClose: () => {}, onConfirm: async () => {}, libraryName: "Piping Isometrics", isLoading: false, ...props }));
      });
      await flush();
    };
    await render({ impact: { ...IMPACT_L1, documents: 1400, revisions: 5210, legalHolds: 2, requests: 3 } });
    const text = host.textContent ?? "";
    expect(text).not.toMatch(/may become orphaned/);
    expect(text).toMatch(/the delete cascades/);
    expect(host.querySelector('[data-testid="library-delete-impact"]')?.textContent).toMatch(/1,400 document records.*5,210 revisions of those documents.*2 folders.*1 open hold/);
    expect(text).toMatch(/2 documents are under legal hold — the database will refuse this delete/);
    expect(text).toMatch(/3 requests were raised from these documents/);
    const confirm = button(/I understand, delete this library/)!;
    const input = host.querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Piping Isometrics");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirm.disabled).toBe(false);
    await render({ impact: null, impactError: "statement timeout" });
    expect(host.textContent).toMatch(/can't be deleted until the counts can be read/);
    expect(button(/I understand, delete this library/)!.disabled).toBe(true);
  });
});

// ── ALOG-4 / ORG-15 on /admin/users ─────────────────────────────────────────
function seedMembers() {
  s.db.tables.orgs = [{ id: "o1", name: "Acme" }];
  s.db.tables.org_members = [
    { id: "m0", org_id: "o1", uid: "a1", email: "admin@x.io", display_name: "Ada", role: "Admin", roles: ["Admin"], status: "active", created_at: "2026-01-02" },
    { id: "m1", org_id: "o1", uid: "u1", email: "pat@x.io", display_name: "Pat", role: "Drafter", roles: ["Viewer", "Drafter"], status: "active", created_at: "2026-01-01" },
  ];
  s.db.tables.access_requests = [{ id: "r1", org_id: "o1", status: "pending", display_name: "New Person", email: "new@x.io", created_at: "2026-01-03" }];
}
const mountUsers = async () => { await act(async () => { root.render(React.createElement(AdminUsersPage)); }); await flush(); };

describe("ALOG-4 / ORG-15 — /admin/users", () => {
  it("regression: the roster and the pending card render as before", async () => {
    seedMembers();
    await mountUsers();
    expect(host.textContent).toMatch(/Pat/);
    expect(host.textContent).toMatch(/Pending access requests/);
    expect(host.querySelector('[data-testid="members-error"]')).toBeNull();
  });

  it("a role GRANT writes ROLE_GRANTED naming actor, subject and the roles before and after", async () => {
    seedMembers();
    await mountUsers();
    await click(button(/^Add role$/));
    await click([...host.querySelectorAll("button")].find((b) => /^Supervisor/.test((b.textContent ?? "").trim())));
    expect(s.db.tables.org_members.find((m) => m.id === "m1")?.roles).toEqual(["Viewer", "Drafter", "Supervisor"]);
    const rows = audits("ROLE_GRANTED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: "a1", user_email: "admin@x.io", user_role: "Admin", resource_id: "u1", org_id: "o1" });
    expect(rows[0].details).toMatchObject({ memberUid: "u1", added: ["Supervisor"], removed: [], before: ["Viewer", "Drafter"], after: ["Viewer", "Drafter", "Supervisor"] });
    expect(s.appAlert).not.toHaveBeenCalled();
  });

  it("a role REMOVAL writes ROLE_REMOVED with before and after", async () => {
    seedMembers();
    await mountUsers();
    await click(host.querySelector('button[title="Remove Drafter"]'));
    const rows = audits("ROLE_REMOVED");
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ removed: ["Drafter"], added: [], before: ["Viewer", "Drafter"], after: ["Viewer"] });
  });

  it("a role write RLS filtered out (zero rows) is a refusal: said, reverted, and no audit row", async () => {
    seedMembers();
    s.db.refuseWrites.add("org_members");
    await mountUsers();
    await click(host.querySelector('button[title="Remove Drafter"]'));
    expect(s.appAlert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^Couldn't update roles: the database changed nothing/), tone: "danger" }));
    expect(audits("ROLE_REMOVED")).toEqual([]);
    expect(host.querySelector('button[title="Remove Drafter"]')).not.toBeNull(); // reverted on screen
  });

  it("a refused AUDIT row is said, the roles stay saved", async () => {
    seedMembers();
    s.db.refuseWrites.add("audit_logs");
    await mountUsers();
    await click(host.querySelector('button[title="Remove Drafter"]'));
    expect(s.db.tables.org_members.find((m) => m.id === "m1")?.roles).toEqual(["Viewer"]);
    expect(s.appAlert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^The roles were saved, but the audit record could not be written/) }));
  });

  it("ORG-15: a failed members read shows an error with a retry, never an empty roster", async () => {
    seedMembers();
    s.db.selectErrors = { org_members: { message: "JWT expired" } };
    await mountUsers();
    expect(host.querySelector('[data-testid="members-error"]')?.textContent).toMatch(/Couldn't load the member list \(JWT expired\)/);
    expect(host.textContent).not.toMatch(/No team members found/);
    s.db.selectErrors = {};
    await click(button(/^Retry$/));
    expect(host.querySelector('[data-testid="members-error"]')).toBeNull();
    expect(host.textContent).toMatch(/Pat/);
  });

  it("ORG-15: a failed pending-requests read shows an error card, never a missing one", async () => {
    seedMembers();
    s.db.selectErrors = { access_requests: { message: "upstream timeout" } };
    await mountUsers();
    expect(host.querySelector('[data-testid="pending-requests-error"]')?.textContent).toMatch(/Couldn't load pending access requests \(upstream timeout\)/);
    expect(host.textContent).not.toMatch(/Pending access requests/);
  });
});

// ── ALOG-4 on /api/admin/create-user ────────────────────────────────────────
describe("ALOG-4 — adding and re-adding a member is recorded, checked", () => {
  const seedCaller = () => {
    s.db.tables.org_members = [{ id: "m0", org_id: "o1", uid: "a1", email: "admin@x.io", role: "Admin", roles: ["Admin"], status: "active" }];
    s.db.tables.users = [];
    s.db.tables.access_requests = [];
  };

  it("a new member: MEMBER_CREATED names the subject and the roles before (none) and after", async () => {
    seedCaller();
    const res = await createUserRoute(req("/api/admin/create-user", { email: "Pat@X.io", password: "pw", orgId: "o1", role: "Drafter", displayName: "Pat" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: "auth-pat@x.io" });
    const rows = audits("MEMBER_CREATED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: "a1", user_role: "Admin", resource_id: "auth-pat@x.io", org_id: "o1" });
    expect(rows[0].details).toMatchObject({ memberUid: "auth-pat@x.io", before: [], after: ["Drafter"] });
  });

  it("a refused audit row is returned (auditError), never swallowed; the membership stands", async () => {
    seedCaller();
    s.db.refuseWrites.add("audit_logs");
    const res = await createUserRoute(req("/api/admin/create-user", { email: "pat@x.io", password: "pw", orgId: "o1", role: "Drafter" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ uid: "auth-pat@x.io", auditError: expect.stringMatching(/row-level security/) });
    expect(s.db.tables.org_members.some((m) => m.uid === "auth-pat@x.io")).toBe(true);
  });

  it("re-adding a suspended member: MEMBER_REACTIVATED with the role added and the roles before and after", async () => {
    seedCaller();
    s.db.tables.users = [{ id: "u1", email: "pat@x.io" }];
    s.db.tables.org_members.push({ id: "m1", org_id: "o1", uid: "u1", email: "pat@x.io", role: "Viewer", roles: ["Viewer"], status: "suspended", display_name: "Pat" });
    const res = await createUserRoute(req("/api/admin/create-user", { email: "pat@x.io", password: "pw", orgId: "o1", role: "Drafter" }));
    expect(await res.json()).toMatchObject({ uid: "u1", merged: true, roles: ["Viewer", "Drafter"] });
    const rows = audits("MEMBER_REACTIVATED");
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ added: ["Drafter"], before: ["Viewer"], after: ["Viewer", "Drafter"], statusBefore: "suspended", statusAfter: "active", via: "add_member" });
  });

  it("re-adding an active member who already holds the role changes nothing and records nothing", async () => {
    seedCaller();
    s.db.tables.users = [{ id: "u1", email: "pat@x.io" }];
    s.db.tables.org_members.push({ id: "m1", org_id: "o1", uid: "u1", email: "pat@x.io", role: "Drafter", roles: ["Drafter"], status: "active" });
    await createUserRoute(req("/api/admin/create-user", { email: "pat@x.io", password: "pw", orgId: "o1", role: "Drafter" }));
    expect(audits("MEMBER_REACTIVATED")).toEqual([]);
    expect(audits("ROLE_GRANTED")).toEqual([]);
  });
});

// ── ORG-4 / ALOG-4 dw2 / NEDGE-19 on /admin/settings ────────────────────────
function seedSettings() {
  s.db.tables.orgs = [{ id: "o1", name: "Acme", type: "plant", subscription_status: "active", ticket_prefix: null, ticket_record_code: "DDRT", ticket_number_pad: 4 }];
  s.db.tables.org_members = [{ id: "m0", org_id: "o1", uid: "a1", status: "active" }];
  s.db.tables.libraries = [];
  s.db.tables.email_notifications = [];
}
const mountSettings = async () => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "n/a" }), { status: 500 })) as typeof fetch;
  await act(async () => { root.render(React.createElement(WorkspaceSettingsPage)); });
  await flush();
};

describe("ORG-4 / ALOG-4 dw2 — request numbering: a checked save, audited", () => {
  it("a save writes the row and TICKET_NUMBERING_CHANGED with before and after", async () => {
    seedSettings();
    await mountSettings();
    const prefix = host.querySelector('input[placeholder="e.g. KE"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(prefix, "KE");
      prefix.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(/^Save$/));
    expect(s.db.tables.orgs[0].ticket_prefix).toBe("KE");
    expect(button(/^Saved$/)).toBeTruthy();
    const rows = audits("TICKET_NUMBERING_CHANGED");
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toEqual({
      before: { ticket_prefix: null, ticket_record_code: "DDRT", ticket_number_pad: 4 },
      after: { ticket_prefix: "KE", ticket_record_code: "DDRT", ticket_number_pad: 4 },
    });
  });

  it("a write RLS filtered out is NOT saved: no green 'Saved', the refusal is said, no audit row", async () => {
    seedSettings();
    s.db.refuseWrites.add("orgs");
    await mountSettings();
    await click(button(/^Save$/));
    expect(button(/^Saved$/)).toBeUndefined();
    expect(s.appAlert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^Couldn't save numbering: the database saved nothing — only an Admin/) }));
    expect(audits("TICKET_NUMBERING_CHANGED")).toEqual([]);
  });
});

describe("NEDGE-19 / VFY-15 — the workspace time zone", () => {
  it("the settings card saves an IANA zone as org_configurations key timezone, audited; recordTime reads it", async () => {
    seedSettings();
    await mountSettings();
    const card = host.querySelector('[data-testid="workspace-timezone-card"]')!;
    expect(card.textContent).toMatch(/still sent once a day at 03:00 UTC/);
    const select = card.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "America/Chicago");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button(/Save time zone/));
    const row = (s.db.tables.org_configurations ?? []).find((r) => r.key === "timezone");
    expect(row).toMatchObject({ org_id: "o1", data: { timeZone: "America/Chicago" } });
    expect(audits("WORKSPACE_TIMEZONE_CHANGED")[0].details).toEqual({ before: null, after: "America/Chicago" });
    expect(card.textContent).toMatch(/Saved — times are now written in America\/Chicago/);
    // the reader every server-composed body uses
    const tz = await orgTimeZone(makeFakeSupabase(s.db), "o1");
    expect(tz).toBe("America/Chicago");
    expect(formatRecordTime("2026-03-20T23:15:15Z", tz)).toBe("2026-03-20T18:15:15-05:00 (America/Chicago)");
  });

  it("an unknown zone is refused before anything is written; a refused write is said; clearing an unset zone is not a refusal", async () => {
    const sb = makeFakeSupabase(s.db);
    expect(await saveWorkspaceTimeZone(sb, { orgId: "o1", timeZone: "Mars/Olympus", before: null, actorId: "a1" })).toMatchObject({ ok: false, error: expect.stringMatching(/not a time zone/) });
    expect(s.db.tables.org_configurations ?? []).toEqual([]);
    s.db.refuseWrites.add("org_configurations");
    expect(await saveWorkspaceTimeZone(sb, { orgId: "o1", timeZone: "Europe/London", before: null, actorId: "a1" })).toMatchObject({ ok: false });
    expect(await saveWorkspaceTimeZone(sb, { orgId: "o1", timeZone: null, before: null, actorId: "a1" })).toMatchObject({ ok: true, timeZone: null });
    s.db.selectErrors = { org_configurations: { message: "down" } };
    expect(await readWorkspaceTimeZone(sb, "o1")).toEqual({ ok: false, error: "down" });
  });
});

// ── ORG-11 ──────────────────────────────────────────────────────────────────
describe("ORG-11 — the org palette is validated on the way in and on the way to the theme", () => {
  it("sanitizeOrgPalette: valid passes, null stays null, a non-hex or non-string palette falls back to PALETTE_PRESETS[0]", () => {
    expect(sanitizeOrgPalette({ id: "x", name: "X", primary: "#112233", secondary: "#aabbcc" })).toEqual({ id: "x", name: "X", primary: "#112233", secondary: "#aabbcc" });
    expect(sanitizeOrgPalette(null)).toBeNull();
    expect(sanitizeOrgPalette({ primary: "red", secondary: "#aabbcc" })).toBe(PALETTE_PRESETS[0]);
    expect(sanitizeOrgPalette({ primary: 12, secondary: null })).toBe(PALETTE_PRESETS[0]);
    expect(sanitizeOrgPalette("#112233")).toBe(PALETTE_PRESETS[0]);
  });

  it("saveOrgBranding refuses a non-hex palette before writing; a valid save is checked and audited", async () => {
    expect(brandingPaletteProblem({ primary: "#12345", secondary: "#aabbcc" })).toMatch(/#RRGGBB/);
    await expect(saveOrgBranding("o1", { palette: { id: "c", name: "C", primary: "url(x)", secondary: "#aabbcc" } }, { uid: "a1" })).rejects.toThrow(/#RRGGBB/);
    expect(s.db.tables.org_configurations ?? []).toEqual([]);
    const r = await saveOrgBranding("o1", { palette: { id: "c", name: "C", primary: "#112233", secondary: "#aabbcc" } }, { uid: "a1", email: "admin@x.io" });
    expect(r).toEqual({ auditError: null });
    expect(audits("BRANDING_CHANGED")[0].details).toMatchObject({ before: null, after: { palette: { primary: "#112233" } } });
    s.db.refuseWrites.add("org_configurations");
    await expect(saveOrgBranding("o1", { palette: { id: "c", name: "C", primary: "#112233", secondary: "#aabbcc" } })).rejects.toThrow();
  });
});

// ── ORG-13 dw3 ──────────────────────────────────────────────────────────────
describe("ORG-13 done-when 3 — a supervisor is an active member of the team's workspace", () => {
  it("a suspended member, or a uid of another workspace, is refused before the write", async () => {
    s.db.tables.org_members = [
      { org_id: "o1", uid: "ok", status: "active" },
      { org_id: "o1", uid: "susp", status: "suspended" },
      { org_id: "o2", uid: "other", status: "active" },
    ];
    s.db.tables.teams = [{ id: "t1", org_id: "o1", name: "Piping", supervisor_user_id: null }];
    s.db.tables.libraries = [];
    await expect(assertSupervisorIsActiveMember("o1", "ok")).resolves.toBeUndefined();
    await expect(assertSupervisorIsActiveMember("o1", "susp")).rejects.toThrow(/not an active member of this workspace/);
    await expect(setTeamSupervisor({ teamId: "t1", orgId: "o1", supervisorUserId: "other", actorId: "a1" })).rejects.toThrow(/not an active member/);
    expect(s.db.tables.teams[0].supervisor_user_id).toBeNull();
    const ok = await setTeamSupervisor({ teamId: "t1", orgId: "o1", supervisorUserId: "ok", actorId: "a1" });
    expect(ok.affectedLibraries).toEqual([]);
    expect(s.db.tables.teams[0].supervisor_user_id).toBe("ok");
  });
});
