// @vitest-environment jsdom
//
// drafting-flow Round G, DF-P14 — roles-and-permissions GAP-13 acceptance 1 /
// drafting-flow GAP-107 acceptance 1: the workspace's own reasons for ending
// a request, under DEC-103's five categories (the integrator's ruling under
// DEC-90 (2): optional; none configured → the Cancel Request picker behaves
// exactly as today; with a list → the org's reasons grouped by category, a
// category with none offered bare).
//
//   lib/ticketOutcomeReasons.ts — parse / normalize / ids / choices / check.
//   app/(protected)/requests/[id]/page.tsx — the Cancel Request dialog, AS
//   RENDERED (the DF-P9 ticket-page harness): what it offers and what it sends.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseOutcomeReasons, withNormalizedOutcomeReasons, newOutcomeReasonId, outcomeChoiceGroups, decodeOutcomeChoice,
  checkOutcomeReason, OUTCOME_REASONS_MAX, OUTCOME_REASON_CATEGORIES,
} from "@/lib/ticketOutcomeReasons";
import { CANCEL_OUTCOMES, OUTCOME_LABEL, TICKET_OUTCOMES } from "@/lib/ticketOutcome";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Call = { m: string; a: unknown[] };
const s = vi.hoisted(() => ({
  role: { activeRole: "Requester", roles: ["Requester"], activeOrgId: "org-1", uid: "u-req", userEmail: "rita@x.io" } as Record<string, unknown>,
  ticket: {} as Record<string, unknown>,
  members: [] as Array<Record<string, unknown>>,
  /** PostgREST's max-rows for the stand-in: a page never returns more. */
  maxRows: 1000,
  /** The picker's member reads (select of its columns), in order. */
  pickerReads: [] as Array<Array<{ m: string; a: unknown[] }>>,
  /** The picker page (1-based) that fails, or 0. */
  pickerFailPage: 0,
  noSession: false,
  traveler: vi.fn(),
  requesterMember: { role: "Requester", roles: ["Requester"] } as Record<string, unknown> | null,
  requesterMemberError: null as null | { message: string },
  postStatus: 200,
  upload: vi.fn(),
  audit: vi.fn(),
  sourceDoc: null as Record<string, unknown> | null,
  sourceDocError: null as null | { message: string },
  unreadHit: [{ id: "t1" }] as unknown[],
  unreadError: null as null | { message: string },
  config: null as Record<string, unknown> | null,
  configError: null as null | { message: string },
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
// The page's one dynamic import is the redline editor: a stand-in that saves a redline on click.
vi.mock("next/dynamic", () => ({
  default: () => (p: { fileUrl?: unknown; onSave?: (b: Blob) => unknown }) =>
    typeof p.onSave === "function" && typeof p.fileUrl === "string"
      ? React.createElement("button", { type: "button", "data-testid": "redline-save", onClick: () => p.onSave!(new Blob(["%PDF-1.7"], { type: "application/pdf" })) }, "save redline")
      : null,
}));
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
vi.mock("@/lib/storage", () => ({ uploadTicketAttachment: (...a: unknown[]) => s.upload(...a), getSignedUrlForPath: vi.fn(), ArchivedFileError: class extends Error {} }));
vi.mock("@/lib/audit", () => ({ logAuditAction: (...a: unknown[]) => s.audit(...a) }));
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
      if (terminal === "maybeSingle" && has("eq", "uid")) return s.requesterMemberError ? { data: null, error: s.requesterMemberError } : { data: s.requesterMember, error: null };
      if (sel === "uid, email, role, roles, display_name") {
        // The drafter picker's keyset pages, served as PostgREST would: in uid
        // order, after `gt`, at most min(limit, max-rows) rows, the exact count
        // on request.
        s.pickerReads.push(calls);
        if (s.pickerFailPage === s.pickerReads.length) return { data: null, error: { message: "upstream request timeout" } };
        const after = calls.find((c) => c.m === "gt")?.a[1] as string | undefined;
        const limit = (calls.find((c) => c.m === "limit")?.a[0] as number | undefined) ?? Infinity;
        const sorted = [...s.members].sort((x, y) => String(x.uid).localeCompare(String(y.uid)));
        const rows = sorted.filter((m) => after === undefined || String(m.uid) > after).slice(0, Math.min(limit, s.maxRows));
        const wantsCount = (calls.find((c) => c.m === "select")?.a[1] as { count?: string } | undefined)?.count === "exact";
        return { data: rows, error: null, ...(wantsCount ? { count: s.members.length } : {}) };
      }
      return { data: s.members, error: null };
    }
    if (table === "org_configurations") return s.configError ? { data: null, error: s.configError } : { data: s.config ? { data: s.config } : null, error: null };
    if (table === "documents") return s.sourceDocError ? { data: null, error: s.sourceDocError } : { data: s.sourceDoc, error: null };
    if (table === "projects") return { data: { name: "Flare header replacement" }, error: null };
    return { data: terminal === "then" ? [] : null, error: null };
  };
  const chain = (table: string) => {
    const calls: Call[] = [];
    let patch: Record<string, unknown> | null = null;
    const api: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "not", "in", "order", "is", "limit", "range", "or", "gt", "gte", "lte", "lt", "contains"]) {
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
      auth: { getSession: async () => ({ data: { session: s.noSession ? null : { access_token: "tok" } } }) },
    },
  };
});
// UI-7 (integrator fix pass): the traveler generator, to read what the page hands it.
vi.mock("@/lib/physicalBridge", () => ({ printTicketTraveler: (...a: unknown[]) => s.traveler(...a) }));

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
  s.maxRows = 1000; s.pickerReads = []; s.pickerFailPage = 0; s.noSession = false;
  s.traveler.mockReset(); s.traveler.mockResolvedValue(undefined);
  s.requesterMember = { role: "Requester", roles: ["Requester"] };
  s.requesterMemberError = null;
  s.postStatus = 200;
  s.upload.mockReset();
  s.upload.mockImplementation(async ({ file }: { file: File }) => ({ url: `orgs/org-1/tickets/KE-DDRT-26-0007/${file.name}` }));
  s.audit.mockReset();
  s.audit.mockResolvedValue({ ok: true, error: null });
  s.sourceDoc = null; s.sourceDocError = null;
  s.unreadHit = [{ id: "t1" }]; s.unreadError = null;
  s.config = null; s.configError = null;
  s.policyEntries = []; s.policyReads = 0;
  s.updates = []; s.posts = [];
  s.postReply = { ok: true, status: "DRAFTING" };
  s.driftProps = []; s.pickerProps = [];
  for (const f of [s.toast, s.alert, s.confirm, s.push]) f.mockReset();
  s.alert.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).includes("/api/tickets/workflow-action")) {
      s.posts.push(JSON.parse(init?.body ?? "{}"));
      return new Response(JSON.stringify(s.postStatus === 200 ? s.postReply : { error: "conflict" }), { status: s.postStatus, headers: { "content-type": "application/json" } });
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


const REASONS = [
  { id: "not_drafting_work", label: "Not drafting work", category: "rejected" },
  { id: "insufficient_info", label: "Not enough information", category: "rejected" },
  { id: "vendor_did_it", label: "The vendor did it directly", category: "handled_out_of_band" },
  { id: "close_out_only", label: "Close-out only", category: "completed" },
];

describe("lib/ticketOutcomeReasons — the list", () => {
  it("parse keeps well-formed entries once, bounded; anything else reads as none configured", () => {
    expect(parseOutcomeReasons(null)).toEqual([]);
    expect(parseOutcomeReasons({})).toEqual([]);
    expect(parseOutcomeReasons({ outcomeReasons: "x" })).toEqual([]);
    expect(parseOutcomeReasons({ outcomeReasons: [
      { id: "a", label: "  Spaced  ", category: "withdrawn" },
      { id: "a", label: "Dup id", category: "withdrawn" },
      { id: "Bad Id", label: "x", category: "withdrawn" },
      { id: "b", label: "", category: "withdrawn" },
      { id: "c", label: "x", category: "abandoned" },
      { id: "d", label: "x".repeat(500), category: "duplicate" },
      7, null,
    ] })).toEqual([
      { id: "a", label: "Spaced", category: "withdrawn" },
      { id: "d", label: "x".repeat(120), category: "duplicate" },
    ]);
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `r${i}`, label: `R ${i}`, category: "withdrawn" }));
    expect(parseOutcomeReasons({ outcomeReasons: many })).toHaveLength(OUTCOME_REASONS_MAX);
  });
  it("the save: settings without the key are the SAME object (written exactly as before); a list is cleaned and new reasons get ids from their words, saved ids kept", () => {
    const plain = { requestTypes: { label: "T", enabled: true, options: [] } };
    expect(withNormalizedOutcomeReasons(plain)).toBe(plain);
    const out = withNormalizedOutcomeReasons({ ...plain, outcomeReasons: [
      { id: "", label: "Not drafting work", category: "rejected" },
      { id: "", label: "  ", category: "rejected" },
      { id: "kept_id", label: "Renamed words", category: "withdrawn" },
      { id: "", label: "Not drafting work", category: "rejected" },
    ] }) as { outcomeReasons: unknown };
    expect(out.outcomeReasons).toEqual([
      { id: "not_drafting_work", label: "Not drafting work", category: "rejected" },
      { id: "kept_id", label: "Renamed words", category: "withdrawn" },
      { id: "not_drafting_work_2", label: "Not drafting work", category: "rejected" },
    ]);
    expect(newOutcomeReasonId("!!!", [])).toBe("reason");
    expect(newOutcomeReasonId("Dup", ["dup", "dup_2"])).toBe("dup_3");
  });
  it("the editor offers reasons under the four ways a cancel can end a request (a cancel is never completed)", () => {
    expect(OUTCOME_REASON_CATEGORIES).toEqual(CANCEL_OUTCOMES);
    expect(OUTCOME_REASON_CATEGORIES).not.toContain("completed");
  });
});

describe("lib/ticketOutcomeReasons — the picker's choices and the route's check", () => {
  it("none configured (or none under these categories): the categories themselves, in order, ungrouped — today's picker", () => {
    for (const reasons of [[], [{ id: "close_out_only", label: "Close-out only", category: "completed" as const }]]) {
      const c = outcomeChoiceGroups(CANCEL_OUTCOMES, reasons);
      expect(c.grouped).toBe(false);
      expect(c.groups.flatMap((g) => g.choices.map((x) => [x.value, x.label]))).toEqual(CANCEL_OUTCOMES.map((o) => [o, OUTCOME_LABEL[o]]));
    }
  });
  it("configured: grouped by category; a category with reasons offers them, one without is offered bare", () => {
    const c = outcomeChoiceGroups(CANCEL_OUTCOMES, parseOutcomeReasons({ outcomeReasons: REASONS }));
    expect(c.grouped).toBe(true);
    expect(c.groups.map((g) => [g.label, g.choices.map((x) => x.label)])).toEqual([
      ["Withdrawn", ["Withdrawn"]],
      ["Duplicate", ["Duplicate"]],
      ["Handled outside the app", ["The vendor did it directly"]],
      ["Rejected", ["Not drafting work", "Not enough information"]],
    ]);
    expect(decodeOutcomeChoice("reason:insufficient_info", c.groups)).toEqual({ outcome: "rejected", reasonId: "insufficient_info" });
    expect(decodeOutcomeChoice("duplicate", c.groups)).toEqual({ outcome: "duplicate", reasonId: null });
    expect(decodeOutcomeChoice("reason:close_out_only", c.groups)).toBeNull(); // not a cancel category
    expect(decodeOutcomeChoice("", c.groups)).toBeNull();
  });
  it("the check: a configured reason of the category — yes; anything else says why", () => {
    const list = parseOutcomeReasons({ outcomeReasons: REASONS });
    expect(checkOutcomeReason("not_drafting_work", "rejected", list)).toEqual({ ok: true, reason: list[0] });
    expect(checkOutcomeReason("not_drafting_work", "withdrawn", list)).toMatchObject({ ok: false });
    expect(checkOutcomeReason("nope", "rejected", list)).toMatchObject({ ok: false });
    expect(checkOutcomeReason("nope", "rejected", [])).toMatchObject({ ok: false, error: expect.stringMatching(/no reasons configured/) });
    // the CHECK's five never change
    expect(TICKET_OUTCOMES).toEqual(["completed", "withdrawn", "duplicate", "handled_out_of_band", "rejected"]);
  });
});

describe("GAP-13 / GAP-107 acceptance 1 — the Cancel Request dialog (rendered)", () => {
  const openCancel = async () => {
    await mount();
    await click(byText("button", /Cancel Request/));
    return q("[data-testid=outcome-picker]") as HTMLSelectElement;
  };
  const fill = async () => setValue(host!.querySelector("textarea") as HTMLTextAreaElement, "Not ours to draw.");
  it("REGRESSION: none configured — exactly today's picker (the four categories, ungrouped) and today's request body", async () => {
    s.config = { requestTypes: { label: "Request Type", enabled: true, options: [] } };
    const picker = await openCancel();
    expect(picker.querySelectorAll("optgroup")).toHaveLength(0);
    expect(Array.from(picker.options).map((o) => [o.value, o.textContent])).toEqual([["", "Choose one…"], ...CANCEL_OUTCOMES.map((o) => [o, OUTCOME_LABEL[o]])]);
    await fill();
    await setValue(picker, "duplicate");
    await click(byText("button", /^\s*Confirm\s*$/));
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toMatchObject({ actionType: "cancel_request", outcome: "duplicate", comment: "Not ours to draw." });
    expect("outcomeReason" in s.posts[0]).toBe(false);
    expect(q("[data-testid=outcome-reasons-unreadable]")).toBeNull();
  });
  it("configured: the org's reasons grouped under their categories; a category with none is offered bare; the reason is sent with its category", async () => {
    s.config = { outcomeReasons: REASONS };
    const picker = await openCancel();
    const groups = Array.from(picker.querySelectorAll("optgroup")).map((g) => [g.label, Array.from(g.querySelectorAll("option")).map((o) => o.textContent)]);
    expect(groups).toEqual([
      ["Withdrawn", ["Withdrawn"]],
      ["Duplicate", ["Duplicate"]],
      ["Handled outside the app", ["The vendor did it directly"]],
      ["Rejected", ["Not drafting work", "Not enough information"]],
    ]);
    // a "completed" reason is never offered on a cancel
    expect(picker.textContent).not.toContain("Close-out only");
    await fill();
    const confirm = byText("button", /^\s*Confirm\s*$/) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await setValue(picker, "reason:not_drafting_work");
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(s.posts[0]).toMatchObject({ actionType: "cancel_request", outcome: "rejected", outcomeReason: "not_drafting_work" });
  });
  it("configured: a bare category under a group sends no reason", async () => {
    s.config = { outcomeReasons: REASONS };
    const picker = await openCancel();
    await fill();
    await setValue(picker, "withdrawn");
    await click(byText("button", /^\s*Confirm\s*$/));
    expect(s.posts[0]).toMatchObject({ outcome: "withdrawn" });
    expect("outcomeReason" in s.posts[0]).toBe(false);
  });
  it("the configuration cannot be read: the categories are offered (the route accepts them) and the dialog says the reasons could not be read", async () => {
    s.configError = { message: "permission denied" };
    const picker = await openCancel();
    expect(picker.querySelectorAll("optgroup")).toHaveLength(0);
    expect(Array.from(picker.options).map((o) => o.value).filter(Boolean)).toEqual([...CANCEL_OUTCOMES]);
    expect(q("[data-testid=outcome-reasons-unreadable]")?.textContent).toMatch(/could not be read/);
  });
});
