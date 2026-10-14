// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P9 TICKET-PAGE — the request page
// (app/(protected)/requests/[id]/page.tsx), AS RENDERED.
//
//   UI-1 / GAP-108   who the request waits on, the part they play, since when;
//                    "Your turn" when the engine offers the viewer a live action.
//   UI-4             "View Only" replaced by why: not permitted, naming the
//                    holder and Admin → Permissions.
//   UI-7 / UI-2      the status pill reads in words and opens the map.
//   AUTHZ-15         an unreadable policy offers no action (the route would
//                    503 every one), says why, and Try again re-reads.
//   EDGE-6 / ROUTE-8 the drafter picker offers a member holding Drafter
//                    beside a higher-ranked role, and never a Viewer; the empty
//                    state names the reason.
//   DCW-1 / DCW-7    the assign modal mounts LibraryPicker on the ticket's
//                    library and sends libraryId / unit with assign.
//   DF-P1 hand-off   a landed action's warning is said (toast).
//   LEAK-9           Cancel asks HOW the request ends (required) and sends it.
//   PERS-3 / LEAK-4  the unread_by clear is checked; a refusal is said.
//   PROJ-9           custom-category answers and the linked project render.
//   FRIC-3 / FRIC-8  an unknown unit says so.
//   DCW-5            a source the viewer cannot discover is labelled restricted.
//   HAND-3 dw3       the Rev chip compares version ids when captured.
//   HAND-7 dw2       SourceDriftBanner is mounted with the ticket's metadata.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Call = { m: string; a: unknown[] };
const s = vi.hoisted(() => ({
  role: { activeRole: "Requester", roles: ["Requester"], activeOrgId: "org-1", uid: "u-req", userEmail: "rita@x.io" } as Record<string, unknown>,
  ticket: {} as Record<string, unknown>,
  members: [] as Array<Record<string, unknown>>,
  requesterMember: { role: "Requester", roles: ["Requester"] } as Record<string, unknown> | null,
  sourceDoc: null as Record<string, unknown> | null,
  sourceDocError: null as null | { message: string },
  unreadHit: [{ id: "t1" }] as unknown[],
  unreadError: null as null | { message: string },
  config: null as Record<string, unknown> | null,
  policyEntries: [] as Array<Record<string, unknown>>,
  policyReads: 0,
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; calls: Array<{ m: string; a: unknown[] }> }>,
  posts: [] as Array<Record<string, unknown>>,
  postReply: { ok: true, status: "DRAFTING" } as Record<string, unknown>,
  toast: vi.fn(),
  alert: vi.fn(),
  confirm: vi.fn(),
  push: vi.fn(),
  driftProps: [] as Array<Record<string, unknown>>,
  pickerProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => {
  // Stable, as Next's are: the page's effects depend on the router and params.
  const params = { id: "t1" };
  const router = { push: (...a: unknown[]) => s.push(...a), back: () => {} };
  const search = new URLSearchParams("");
  return { useParams: () => params, useRouter: () => router, useSearchParams: () => search };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/providers/RoleContext", () => {
  // Stable per role, as the provider's value is.
  let last: { role: unknown; value: Record<string, unknown> } | null = null;
  return {
    useRole: () => {
      if (!last || last.role !== s.role) {
        last = { role: s.role, value: { ...s.role, hasAnyRole: (r: string[]) => r.some((x) => (s.role.roles as string[]).includes(x)) } };
      }
      return last.value;
    },
  };
});
vi.mock("@/components/providers/ToastProvider", () => {
  const value = { showToast: (...a: unknown[]) => s.toast(...a) };
  return { useToast: () => value };
});
vi.mock("@/components/providers/DialogProvider", () => ({
  appAlert: (...a: unknown[]) => s.alert(...a),
  appConfirm: (...a: unknown[]) => s.confirm(...a),
  appPrompt: vi.fn(async () => null),
}));
vi.mock("@/lib/storage", () => ({ uploadTicketAttachment: vi.fn(), getSignedUrlForPath: vi.fn(), ArchivedFileError: class extends Error {} }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ ok: true, error: null })) }));
vi.mock("@/lib/stamping", () => ({ downloadStampedPdf: vi.fn() }));
vi.mock("@/lib/teams", () => ({ getMyTeamIds: vi.fn(async () => []) }));
vi.mock("@/lib/documentGuards", () => ({ resolveCanControlLibrary: vi.fn(async () => false) }));
vi.mock("@/lib/ownership", () => ({ isEffectiveOwnerOfDocument: vi.fn(async () => false) }));
vi.mock("@/lib/reviewControl", () => ({ effectiveReviewControlForDocument: vi.fn(async () => ({ mode: "none" })) }));
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadCapabilityPolicyEntry: async () => { s.policyReads++; return s.policyEntries.shift() ?? { policy: undefined, version: null }; },
}));
vi.mock("@/lib/ticketRouting", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadRoutingContext: async () => ({
    ok: true,
    members: [{ uid: "s-1", name: "Sam Supervisor", email: "sam@x.io", role: "DraftingSupervisor", roles: ["DraftingSupervisor"] }],
    routing: { adminsAlsoReceiveWhenSupervisorSet: false },
  }),
}));
vi.mock("@/lib/ticketCreateClient", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadCodebookUnitList: async () => ({ units: [], failure: "none" }),
}));
vi.mock("@/components/requests/LibraryPicker", () => ({
  default: (p: { currentLibraryId: string | null; value: string | null; onChange: (v: string | null) => void }) => {
    s.pickerProps.push(p as unknown as Record<string, unknown>);
    return React.createElement("div", { "data-testid": "library-picker", "data-current": p.currentLibraryId ?? "", "data-value": p.value ?? "" },
      React.createElement("button", { type: "button", onClick: () => p.onChange("lib-9") }, "choose lib-9"));
  },
}));
vi.mock("@/components/requests/SourceDriftBanner", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  default: (p: Record<string, unknown>) => { s.driftProps.push(p); return React.createElement("div", { "data-testid": "drift-banner" }); },
}));
vi.mock("@/components/requests/EngineerPickerModal", () => ({ default: () => null }));
vi.mock("@/components/requests/MentionableTextarea", () => ({ default: () => null }));
vi.mock("@/components/archive/TicketArchiveViewer", () => ({ default: () => null }));
vi.mock("@/components/requests/CommentBody", () => ({ default: () => null }));
vi.mock("@/components/signatures/SignaturePanel", () => ({ default: () => null }));
vi.mock("@/components/documents/RevUpModal", () => ({ default: () => null }));
vi.mock("@/components/ui/UserAvatar", () => ({ default: () => null }));

vi.mock("@/lib/supabase", () => {
  const resolve = (table: string, calls: Call[], patch: Record<string, unknown> | null, terminal: "then" | "single" | "maybeSingle") => {
    const has = (m: string, k?: string) => calls.some((c) => c.m === m && (k === undefined || c.a[0] === k));
    if (patch) {
      s.updates.push({ table, patch, calls });
      if (table === "tickets") return s.unreadError ? { data: null, error: s.unreadError } : { data: s.unreadHit, error: null };
      return { data: null, error: null };
    }
    if (table === "tickets") return { data: s.ticket, error: null };
    if (table === "org_members") {
      const sel = String(calls.find((c) => c.m === "select")?.a[0] ?? "");
      if (sel === "uid" ) return { data: null, error: null, count: 4 };
      if (terminal === "maybeSingle" && has("eq", "uid")) return { data: s.requesterMember, error: null };
      return { data: s.members, error: null };
    }
    if (table === "org_configurations") return { data: s.config ? { data: s.config } : null, error: null };
    if (table === "documents") return s.sourceDocError ? { data: null, error: s.sourceDocError } : { data: s.sourceDoc, error: null };
    if (table === "projects") return { data: { name: "Flare header replacement" }, error: null };
    return { data: terminal === "then" ? [] : null, error: null };
  };
  const chain = (table: string) => {
    const calls: Call[] = [];
    let patch: Record<string, unknown> | null = null;
    const api: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "not", "in", "order", "is", "limit", "range", "or", "gte", "lte", "lt", "contains"]) {
      api[m] = (...a: unknown[]) => { calls.push({ m, a }); return api; };
    }
    api.update = (p: Record<string, unknown>) => { patch = p; return api; };
    api.insert = () => api;
    api.single = async () => resolve(table, calls, patch, "single");
    api.maybeSingle = async () => resolve(table, calls, patch, "maybeSingle");
    api.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resolve(table, calls, patch, "then")).then(ok, ko);
    return api;
  };
  const channelApi: Record<string, unknown> = {};
  channelApi.on = () => channelApi;
  channelApi.subscribe = () => channelApi;
  return {
    supabase: {
      from: (t: string) => chain(t),
      channel: () => channelApi,
      removeChannel: () => {},
      rpc: async () => ({ data: null, error: null }),
      auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
    },
  };
});

import TicketDetailView from "@/app/(protected)/requests/[id]/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseTicket = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "org-1", ticket_id: "KE-DDRT-26-0007", title: "Re-route the flare header", description: "Move the header 2 m east.",
  unit: "U-100", request_type: "ISO", status: "DRAFTING", requester_id: "u-req", requester_name: "Rita Requester", requester_email: "rita@x.io",
  requester_role: "Requester", assigned_drafter_id: "d-1", assigned_drafter_name: "Hector", attachments: [], comments: [],
  history: [{ action: "Created", user: "rita@x.io", role: "Requester", date: "2026-10-01T00:00:00.000Z" }, { action: "Assign Drafter", user: "sam@x.io", role: "DraftingSupervisor", date: new Date(Date.now() - 3 * 86_400_000).toISOString() }],
  unread_by: [], watchers: [], created_at: "2026-10-01T00:00:00.000Z", last_modified: "2026-10-10T00:00:00.000Z", library_id: "lib-1", metadata: {},
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  s.role = { activeRole: "Requester", roles: ["Requester"], activeOrgId: "org-1", uid: "u-req", userEmail: "rita@x.io" };
  s.ticket = baseTicket();
  s.members = [];
  s.requesterMember = { role: "Requester", roles: ["Requester"] };
  s.sourceDoc = null; s.sourceDocError = null;
  s.unreadHit = [{ id: "t1" }]; s.unreadError = null;
  s.config = null;
  s.policyEntries = []; s.policyReads = 0;
  s.updates = []; s.posts = [];
  s.postReply = { ok: true, status: "DRAFTING" };
  s.driftProps = []; s.pickerProps = [];
  for (const f of [s.toast, s.alert, s.confirm, s.push]) f.mockReset();
  s.alert.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).includes("/api/tickets/workflow-action")) {
      s.posts.push(JSON.parse(init?.body ?? "{}"));
      return new Response(JSON.stringify(s.postReply), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = async () => { await act(async () => { root!.render(React.createElement(TicketDetailView)); }); await flush(); };
const q = (sel: string) => host!.querySelector(sel) as HTMLElement | null;
const byText = (sel: string, text: RegExp) => (Array.from(host!.querySelectorAll(sel)).find((e) => text.test(e.textContent ?? "")) ?? null) as HTMLElement | null;
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
async function setValue(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await flush();
}

describe("UI-1 / UI-7 — where the request is, on whom, since when, in words", () => {
  it("the requester while the drafter works: the status in words, waiting on the drafter by name, for how long", async () => {
    await mount();
    expect(q("[data-testid=status-pill]")?.textContent).toMatch(/^Drafting/);
    expect(q("[data-testid=status-pill]")?.getAttribute("aria-label")).toMatch(/Status: Drafting/);
    const waiting = q("[data-testid=waiting-on]")!.textContent!;
    expect(waiting).toMatch(/Waiting on Hector/);
    expect(waiting).toMatch(/\(the drafter\)/);
    expect(waiting).toMatch(/drafting in progress/);
    expect(waiting).toMatch(/for 3 days/);
  });
  it("UI-2: the status pill opens the workflow map", async () => {
    await mount();
    await click(q("[data-testid=status-pill]"));
    expect(host!.textContent).toMatch(/Awaiting drafter/); // the map's stage labels, from the same list
  });
  it("the queue owner at the assignment step: 'Your turn'", async () => {
    s.role = { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1", userEmail: "sam@x.io" };
    s.ticket = baseTicket({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, assigned_drafter_name: null });
    await mount();
    expect(q("[data-testid=waiting-on]")?.textContent).toMatch(/Your turn: needs a drafter assigned\./);
  });
});

describe("UI-4 — no action, explained", () => {
  it("a Viewer: not permitted, naming the queue by its members and pointing at Admin → Permissions", async () => {
    s.role = { activeRole: "Viewer", roles: ["Viewer"], activeOrgId: "org-1", uid: "v-1", userEmail: "vic@x.io" };
    s.ticket = baseTicket({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, assigned_drafter_name: null });
    await mount();
    const why = q("[data-testid=no-actions-why]")?.textContent ?? "";
    expect(why).toMatch(/Your roles don't act on this request/);
    expect(why).toMatch(/Sam Supervisor/);
    expect(why).toMatch(/Admin → Permissions/);
    expect(host!.textContent).not.toMatch(/View Only — No Actions Available/);
    expect(q("[data-testid=waiting-on]")?.textContent).toMatch(/Waiting on Sam Supervisor \(assignment queue\)/);
  });
});

describe("AUTHZ-15 — an unreadable policy offers nothing, says why, and retries", () => {
  it("held back with the reason; Try again re-reads and the actions return", async () => {
    s.role = { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1", userEmail: "sam@x.io" };
    s.ticket = baseTicket({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, assigned_drafter_name: null });
    s.policyEntries = [{ policy: {}, version: null, unreadable: "permission denied for org_configurations" }];
    await mount();
    expect(q("[data-testid=ticket-policy-fault]")?.textContent).toMatch(/Permissions could not be read — permission denied/);
    expect(byText("button", /Assign Drafter/)).toBeNull();
    expect(q("[data-testid=no-actions-why]")).toBeNull();
    const reads = s.policyReads;
    await click(byText("[data-testid=ticket-policy-fault] button", /Try again/));
    expect(s.policyReads).toBe(reads + 1);
    expect(q("[data-testid=ticket-policy-fault]")).toBeNull();
    expect(byText("button", /Assign Drafter/)).toBeTruthy();
  });
  it("REGRESSION: a stale (last-good) policy draws the actions as is", async () => {
    s.role = { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1", userEmail: "sam@x.io" };
    s.ticket = baseTicket({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, assigned_drafter_name: null });
    s.policyEntries = [{ policy: {}, version: "v1", stale: true, staleError: "timeout" }];
    await mount();
    expect(q("[data-testid=ticket-policy-fault]")).toBeNull();
    expect(byText("button", /Assign Drafter/)).toBeTruthy();
  });
});

describe("EDGE-6 / ROUTE-8 / DCW-1 / DCW-7 — the assign modal", () => {
  beforeEach(() => {
    s.role = { activeRole: "DraftingSupervisor", roles: ["DraftingSupervisor"], activeOrgId: "org-1", uid: "s-1", userEmail: "sam@x.io" };
    s.ticket = baseTicket({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, assigned_drafter_name: null });
  });
  it("offers a member holding Drafter beside a higher-ranked role, never a Viewer; triage starts on the ticket's library and sends the pick", async () => {
    s.members = [
      { uid: "e-2", email: "pat@x.io", role: "Engineer-2", roles: ["Engineer-2", "Drafter"], display_name: "Pat Engineer" },
      { uid: "v-1", email: "vic@x.io", role: "Viewer", roles: ["Viewer"], display_name: "Vic Viewer" },
    ];
    s.postReply = { ok: true, status: "DRAFTING", warning: "The library could not be recorded on the request yet (the database is behind) — it was assigned without it." };
    await mount();
    await click(byText("button", /Assign Drafter/));
    expect(q("[data-testid=triage-fields]")).toBeTruthy();
    expect(q("[data-testid=library-picker]")?.getAttribute("data-current")).toBe("lib-1");
    expect(q("[data-testid=library-picker]")?.getAttribute("data-value")).toBe("lib-1");
    expect(byText("button", /Pat Engineer/)).toBeTruthy();
    expect(byText("button", /Vic Viewer/)).toBeNull();
    await click(byText("[data-testid=library-picker] button", /choose lib-9/));
    await click(byText("button", /Pat Engineer/));
    expect(s.posts.length).toBe(1);
    expect(s.posts[0]).toMatchObject({ actionType: "assign", assignment: { id: "e-2", name: "Pat Engineer" }, libraryId: "lib-9" });
    expect(s.posts[0].unit).toBeUndefined(); // no unit change chosen → none sent
    // DF-P1's hand-off: the landed action's warning is said
    expect(s.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning", title: "Done, with a warning", message: expect.stringMatching(/library could not be recorded/) }));
  });
  it("nobody can be assigned → the empty state names the reason and the fix", async () => {
    s.members = [{ uid: "v-1", email: "vic@x.io", role: "Viewer", roles: ["Viewer"] }];
    await mount();
    await click(byText("button", /Assign Drafter/));
    expect(q("[data-testid=no-drafters]")?.textContent).toMatch(/nobody in this workspace holds the Drafter role/);
  });
  it("a hold the close could not release is said with its own title (holdsNotReleased)", async () => {
    s.members = [{ uid: "d-2", email: "dee@x.io", role: "Drafter", roles: ["Drafter"], display_name: "Dee" }];
    s.postReply = { ok: true, status: "DRAFTING", warning: "A hold could not be released.", holdsNotReleased: ["h-1"] };
    await mount();
    await click(byText("button", /Assign Drafter/));
    await click(byText("button", /Dee/));
    expect(s.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning", title: "Done — but a hold is still active" }));
  });
});

describe("LEAK-9 — Cancel asks how the request ends", () => {
  it("the outcome is required, and sent beside the reason", async () => {
    await mount();
    await click(byText("button", /Cancel Request/));
    const picker = q("[data-testid=outcome-picker]") as HTMLSelectElement;
    expect(picker).toBeTruthy();
    const options = Array.from(picker.options).map((o) => o.value).filter(Boolean);
    expect(options.length).toBeGreaterThan(1);
    const textarea = host!.querySelector("textarea") as HTMLTextAreaElement;
    await setValue(textarea, "Handled by the vendor directly.");
    const confirm = byText("button", /^\s*Confirm\s*$/) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // no outcome yet
    await setValue(picker, options.includes("handled_out_of_band") ? "handled_out_of_band" : options[0]);
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(s.posts.length).toBe(1);
    expect(s.posts[0]).toMatchObject({ actionType: "cancel_request", comment: "Handled by the vendor directly." });
    expect(typeof s.posts[0].outcome).toBe("string");
  });
});

describe("PERS-3 / LEAK-4 — clearing my unread marker is checked", () => {
  it("removes only my uid and says so when the write matched nothing", async () => {
    s.ticket = baseTicket({ unread_by: ["u-req", "d-1"] });
    s.unreadHit = [];
    await mount();
    const upd = s.updates.find((u) => u.table === "tickets");
    expect(upd?.patch).toEqual({ unread_by: ["d-1"] });
    expect(upd?.calls).toEqual(expect.arrayContaining([{ m: "select", a: ["id"] }]));
    expect(s.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning", title: "Not marked as read" }));
  });
  it("REGRESSION: a write that lands says nothing", async () => {
    s.ticket = baseTicket({ unread_by: ["u-req"] });
    await mount();
    expect(s.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Not marked as read" }));
  });
});

describe("PROJ-9 / FRIC-3 — what the form collected, the project, the unit", () => {
  it("custom-category answers with their labels, the linked project by name, and an unknown unit in words", async () => {
    s.config = { customCategories: [{ id: "wo", label: "Work order", enabled: true, fields: [{ key: "wo_number", label: "Work Order #", type: "text" }] }] };
    s.ticket = baseTicket({ unit: null, metadata: { unit_unknown: true, custom_categories: { wo: { wo_number: "WO-4471" } }, intake_collision: { projectId: "p-9" } } });
    await mount();
    const cat = q("[data-testid=custom-category]")!.textContent!;
    expect(cat).toMatch(/Work order/);
    expect(cat).toMatch(/Work Order #/);
    expect(cat).toMatch(/WO-4471/);
    const link = q("[data-testid=project-link] a")!;
    expect(link.getAttribute("href")).toBe("/projects/p-9");
    expect(link.textContent).toBe("Flare header replacement");
    expect(q("[data-testid=ticket-unit]")?.textContent).toBe("Unit unknown — triage assigns");
  });
});

describe("DCW-5 / HAND-3 / HAND-7 — the source card", () => {
  const src = { id: "doc-1", document_number: "P-101", title: "Overhead P&ID", rev: "B", version_id: "ver-1" };
  it("a source the viewer cannot discover: labelled restricted, its recorded number and title kept", async () => {
    s.ticket = baseTicket({ metadata: { source_document: src } });
    s.sourceDoc = null;
    await mount();
    expect(q("[data-testid=source-restricted]")?.textContent).toMatch(/Restricted document/);
    expect(host!.textContent).toMatch(/P-101/);
    expect(host!.textContent).toMatch(/Overhead P&ID/);
  });
  it("a failed read is not 'restricted'", async () => {
    s.ticket = baseTicket({ metadata: { source_document: src } });
    s.sourceDocError = { message: "timeout" };
    await mount();
    expect(q("[data-testid=source-restricted]")).toBeNull();
  });
  it("the Rev chip compares version ids: a re-issued sheet under the same label has moved", async () => {
    s.ticket = baseTicket({ metadata: { source_document: src } });
    s.sourceDoc = { id: "doc-1", library_id: null, collection_id: null, rev: "B", document_number: "P-101", title: "Overhead P&ID", current_version_id: "ver-2" };
    await mount();
    expect(host!.textContent).toMatch(/Rev advanced — register now at Rev B/);
    expect(host!.textContent).not.toMatch(/Current \(Rev B\)/);
  });
  it("REGRESSION: the same version reads current; the drift banner is mounted with the ticket's metadata", async () => {
    s.ticket = baseTicket({ metadata: { source_document: src } });
    s.sourceDoc = { id: "doc-1", library_id: null, collection_id: null, rev: "B", document_number: "P-101", title: "Overhead P&ID", current_version_id: "ver-1" };
    await mount();
    expect(host!.textContent).toMatch(/Current \(Rev B\)/);
    expect(q("[data-testid=drift-banner]")).toBeTruthy();
    expect(s.driftProps.at(-1)).toMatchObject({ orgId: "org-1", metadata: { source_document: src } });
  });
});
