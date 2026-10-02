// @vitest-environment jsdom
//
// notifications Round G, N3 SURFACES — the doorway and the surfaces.
//
//   * TAX-1 / TRAIL-3 / TAX-2 dw4: a sidebar badge opens the Notification
//     Center scoped to its own section; the header count is the badge's own
//     number (the same hook, the same tally), an empty scope names the
//     section, and "mark read" in a scope clears only that scope's rows.
//   * NEDGE-5: the bell is named with its count, says it opens a dialog and
//     whether it is open, announces the count in one polite live region, and
//     its drawer is a labelled dialog that takes focus and gives it back; the
//     center does the same and is inert while closed.
//   * RT-9: the bell shows "N need action" beside the total, its button says
//     "Mark notifications read", and what that leaves behind is said in place.
//   * RT-11 dw1: opened while the corner dock is raised over an upload modal,
//     the center opens ABOVE that modal (Z.dialog, a listed layer), and the
//     raised dock moves left of it.
//
// The REAL Sidebar, NotificationBell, NotificationCenter and the REAL
// attention hook render here; only the database, the session and the router
// are doubles.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fx = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  tickets: [] as Array<Record<string, unknown>>,
  role: {
    roles: ["Admin"], activeRole: "Admin", activeOrgId: "o1", uid: "u1", userEmail: "me@example.com",
    membershipState: "member", hasAnyRole: (_r: string[]) => false, setActiveOrgId: () => {},
  },
  markMany: [] as string[][],
  markAll: 0,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): Record<string, unknown> => {
    const result = { data: table === "tickets" ? fx.tickets : [], error: null, count: 0 };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "in", "order", "limit", "is", "or", "gte"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: null, error: null });
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko);
    return q;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: { from: (t: string) => chain(t), channel: () => channel, removeChannel: () => {}, auth: { signOut: async () => ({}) } },
    setPreferMicrosoft: () => {},
  };
});
vi.mock("@/components/providers/RoleContext", () => ({ useRole: () => fx.role }));
vi.mock("@/components/providers/OrgBrandingProvider", () => ({ useOrgBranding: () => ({ logoUrl: null, branding: null, canEdit: false }) }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/swSession", () => ({ clearServiceWorkerSession: async () => {} }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("@/lib/capabilityPolicy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCapabilityPolicy: async () => undefined,
}));
vi.mock("@/lib/inAppNotifications", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listMyNotifications: async () => fx.rows,
    markRead: async () => {},
    markAllRead: async () => { fx.markAll++; },
    markManyRead: async (ids: string[]) => { fx.markMany.push(ids); },
  };
});

import Sidebar from "@/components/navigation/Sidebar";
import NotificationBell, { bellLabel, bellAnnouncement } from "@/components/notifications/NotificationBell";
import { NotificationCenterProvider, useNotificationCenter, centerHeadline } from "@/components/notifications/NotificationCenter";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { CornerDock, __resetDockForTests, useDockAllowances, useDockRaise, NOTIFICATION_CENTER_RAIL_PX } from "@/components/ui/CornerDock";
import { ToastProvider, useToast } from "@/components/providers/ToastProvider";
import { Z } from "@/lib/zLayers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id, orgId: "o1", userId: "u1", kind, title: `t ${kind} ${id}`, body: null, link: `/x/${id}`,
  resourceType: "document", resourceId: `res-${id}`, actorUserId: null, actorName: null, metadata: null,
  readAt: null, createdAt: `2026-10-01T00:00:${id.replace(/\D/g, "").padStart(2, "0")}Z`, ...extra,
});
// Documents 3 (one action: red), Drafting Requests 2, Projects 1, one bell-only.
const FEED = [
  row("n1", "checkout_conflict"), row("n2", "library_doc_revised"), row("n3", "ack_requested"),
  row("n4", "ticket_comment"), row("n5", "ticket_mention"),
  row("n6", "project_member"),
  row("n7", "security_export"),
];

let host: HTMLDivElement;
let root: Root;
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const panel = () => document.querySelector("[data-center-panel]") as HTMLElement;
const headline = () => (document.querySelector("[data-center-headline]") as HTMLElement).textContent;
const listedTitles = () => [...panel().querySelectorAll("li a .truncate")].map((e) => e.textContent).filter((t) => t?.startsWith("t "));

const opener: { open: ReturnType<typeof useNotificationCenter>["open"] } = { open: () => {} };
function GrabCenter() {
  const { open } = useNotificationCenter();
  React.useEffect(() => { opener.open = open; }, [open]);
  return null;
}
/** What a badge shows, from the same hook (Sidebar's badgeOf). */
const badgeSeen: Record<string, number> = {};
function BadgeProbe() {
  const { sectionCounts } = useTicketNotifications();
  React.useEffect(() => {
    for (const [s, c] of Object.entries(sectionCounts)) badgeSeen[s] = c.total;
  }, [sectionCounts]);
  return null;
}

async function mount(el: React.ReactNode) {
  await act(async () => { root.render(el as React.ReactElement); });
  await flush();
}

beforeEach(() => {
  __resetDockForTests();
  fx.rows = FEED;
  fx.tickets = [];
  fx.markMany = [];
  fx.markAll = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("TAX-1 / TRAIL-3 / TAX-2 dw4 — a section badge opens its own section, with its own number", () => {
  it("clicking the Documents badge opens the center scoped to Documents: the header count is the badge's, and only Documents' items are listed", async () => {
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(Sidebar), React.createElement(BadgeProbe)));
    const badge = document.querySelector('button[aria-label^="Documents:"]') as HTMLButtonElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("aria-label")).toBe("Documents: 3 items need attention, some need action — show them");
    await act(async () => { badge.click(); });
    await flush();
    expect(panel().getAttribute("inert")).toBeNull();
    expect(panel().getAttribute("aria-label")).toBe("Notification center — Documents");
    expect(headline()).toBe(`${badgeSeen.documents} items in Documents`);
    expect(headline()).toBe("3 items in Documents");
    // every item the badge counts — the red one included — and nothing else
    expect(listedTitles().sort()).toEqual(["t ack_requested n3", "t checkout_conflict n1", "t library_doc_revised n2"]);
    // the scope clears in one tap: the whole feed, the bell's count
    const all = [...panel().querySelectorAll("button")].find((b) => /Show every section/.test(b.textContent ?? ""))!;
    expect(all.textContent).toBe("Show every section (7)");
    await act(async () => { all.click(); });
    await flush();
    expect(headline()).toBe("7 items — everything the bell counts.");
    expect(listedTitles()).toHaveLength(7);
  });

  it("every badged row opens its own section with its own count — Projects 1, Drafting Requests 2", async () => {
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(Sidebar)));
    for (const [label, want] of [["Projects", "1 item in Projects"], ["Drafting Requests", "2 items in Drafting Requests"]] as const) {
      const badge = document.querySelector(`button[aria-label^="${label}:"]`) as HTMLButtonElement;
      await act(async () => { badge.click(); });
      await flush();
      expect(headline()).toBe(want);
      expect(badge.textContent).toBe(want.split(" ")[0]);
    }
    // the bell-only row badges no row, and opens with the bell's count
    expect(document.querySelector('button[aria-label^="Home:"]')).toBeNull();
  });

  it("an empty scope names its section; a filter in a scope says so; the Action filter shows the red one", async () => {
    fx.rows = FEED.filter((r) => r.kind !== "project_member");
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(GrabCenter)));
    await act(async () => { opener.open("all", "projects"); });
    await flush();
    expect(headline()).toBe("Nothing in Projects needs your attention.");
    expect(panel().textContent).toContain("Nothing in Projects needs your attention right now.");
    await act(async () => { opener.open("action", "documents"); });
    await flush();
    expect(headline()).toBe("1 item in Documents needs action");
    expect(listedTitles()).toEqual(["t checkout_conflict n1"]);
    // a later unscoped opener (the bell's "See all", the Deck) never inherits the scope
    await act(async () => { opener.open("all"); });
    await flush();
    expect(headline()).toBe("7 items — everything the bell counts.".replace("7", String(fx.rows.length)));
  });

  it("'mark read' in a scope clears only that scope's rows; unscoped it clears the workspace's, as before", async () => {
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(GrabCenter)));
    await act(async () => { opener.open("all", "documents"); });
    await flush();
    const scoped = panel().querySelector('button[title="Mark the notifications in Documents read"]') as HTMLButtonElement;
    expect(scoped.getAttribute("aria-label")).toBe("Mark the notifications in Documents read");
    await act(async () => { scoped.click(); });
    await flush();
    expect(fx.markMany).toHaveLength(1);
    expect([...fx.markMany[0]].sort()).toEqual(["n1", "n2", "n3"]);
    expect(fx.markAll).toBe(0);
    await act(async () => { opener.open("all"); });
    await flush();
    await act(async () => { (panel().querySelector('button[title="Mark all notifications read"]') as HTMLButtonElement).click(); });
    await flush();
    expect(fx.markAll).toBe(1);
  });

  it("the headline is the opener's number in every case (pure)", () => {
    expect(centerHeadline(3, "documents", "all")).toBe("3 items in Documents");
    expect(centerHeadline(1, "requests", "all")).toBe("1 item in Drafting Requests");
    expect(centerHeadline(11, null, "all")).toBe("11 items — everything the bell counts.");
    expect(centerHeadline(2, null, "action")).toBe("2 items need action");
    expect(centerHeadline(4, "documents", "activity")).toBe("4 activity items in Documents");
    expect(centerHeadline(0, null, "all")).toBe("You're all caught up.");
    expect(centerHeadline(0, "projects", "all")).toBe("Nothing in Projects needs your attention.");
  });

  it("the Sidebar's badge passes the section of exactly the rows that spread badgeOf(sectionCounts.<section>)", () => {
    const sb = readFileSync(resolve("components/navigation/Sidebar.tsx"), "utf8");
    // each badgeOf(sectionCounts.<s>) with the href of the leaf it sits in
    // (the nearest href before it)
    const pairs = [...sb.matchAll(/badgeOf\(sectionCounts\.(\w+)\)/g)].map((m) => {
      const before = sb.slice(0, m.index);
      const href = [...before.matchAll(/href: '([^']+)'/g)].at(-1)![1];
      return [href, m[1]];
    });
    expect(Object.fromEntries(pairs)).toEqual({ "/documents": "documents", "/projects": "projects", "/requests": "requests" });
    const map = sb.match(/BADGE_SECTION_BY_HREF: Record<string, AttentionSection> = \{([\s\S]*?)\};/)![1];
    for (const [href, section] of pairs) expect(map).toContain(`'${href}': '${section}'`);
    expect(sb).toContain("openCenter('all', BADGE_SECTION_BY_HREF[leaf.href] ?? null)");
  });
});

describe("NEDGE-5 — the center is a labelled dialog that takes focus and gives it back", () => {
  it("opening focuses the panel; Escape closes it and focus returns to the badge that opened it; closed, the panel is inert", async () => {
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(Sidebar)));
    expect(panel().hasAttribute("inert")).toBe(true);
    const badge = document.querySelector('button[aria-label^="Documents:"]') as HTMLButtonElement;
    badge.focus();
    await act(async () => { badge.click(); });
    await flush();
    expect(document.activeElement).toBe(panel());
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(panel().getAttribute("aria-modal")).toBe("true");
    expect(panel().querySelector('button[aria-label="Close the notification center"]')).toBeTruthy();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flush();
    expect(panel().hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(badge);
  });
});

describe("NEDGE-5 / RT-9 — the bell", () => {
  it("is named with its count, says it opens a dialog, hides the decorative count, and announces the count politely", async () => {
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(NotificationBell, { variant: "header" })));
    const trigger = document.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
    expect(trigger.getAttribute("aria-label")).toBe("Notifications, 7 need attention");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const count = trigger.querySelector("span")!;
    expect(count.textContent).toBe("7");
    expect(count.getAttribute("aria-hidden")).toBe("true");
    const live = document.querySelector("[data-bell-live]")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-atomic")).toBe("true");
    expect(live.textContent).toBe("7 notifications need attention, 1 needs action");
    expect(bellLabel(1)).toBe("Notifications, 1 needs attention");
    expect(bellLabel(0)).toBe("Notifications");
    expect(bellAnnouncement(0, 0)).toBe("No notifications need attention");
  });

  it("opens a labelled dialog that takes focus; Escape (as before) closes it and focus returns to the bell", async () => {
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(NotificationBell, { variant: "header" })));
    const trigger = document.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
    trigger.focus();
    await act(async () => { trigger.click(); });
    await flush();
    const dialog = document.querySelector('[role="dialog"][aria-label="Notifications"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(document.activeElement).toBe(dialog);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flush();
    expect(document.querySelector('[role="dialog"][aria-label="Notifications"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("RT-9: 'N need action' beside the total; 'Mark notifications read'; what it leaves behind is said in place", async () => {
    fx.tickets = [{
      id: "t9", org_id: "o1", ticket_id: "DR-9", title: "Valve", status: "PENDING_ASSIGNMENT", requester_id: "u1",
      unread_by: ["u1"], created_at: "2026-10-01T00:00:00Z", last_modified: "2026-10-01T00:00:00Z",
    }];
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(NotificationBell, { variant: "header" })));
    const trigger = document.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    await flush();
    const dialog = document.querySelector('[role="dialog"][aria-label="Notifications"]') as HTMLElement;
    expect(dialog.textContent).toContain("8 need attention");
    // the conflict row and the unassigned request an Admin must pick up
    expect(dialog.querySelector("[data-bell-action]")!.textContent).toContain("2 need action");
    const mark = [...dialog.querySelectorAll("button")].find((b) => /Mark notifications read/.test(b.textContent ?? ""))!;
    expect(mark).toBeTruthy();
    expect(mark.getAttribute("title")).toBe("Marks the 7 notifications read. 1 request stay until the work is done or the request is opened.");
    expect(dialog.querySelector("[data-bell-remaining]")!.textContent)
      .toBe("1 request in this list clears when the work is done or the request is opened — marking notifications read leaves it.");
    expect(dialog.textContent).not.toContain("Mark all read");
  });

  it("TAX-5: a row draws its registry icon — a review request is a GitBranch in the bell, as in the feed (it was a bare Bell)", async () => {
    fx.rows = [row("n1", "review_requested")];
    await mount(React.createElement(NotificationCenterProvider, null, React.createElement(NotificationBell, { variant: "header" }), React.createElement(GrabCenter)));
    await act(async () => { (document.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement).click(); });
    await flush();
    const bellRow = document.querySelector('[role="dialog"][aria-label="Notifications"] li svg') as SVGElement;
    expect(bellRow.getAttribute("class")).toContain("lucide-git-branch");
    await act(async () => { opener.open("all"); });
    await flush();
    const feedRow = panel().querySelector("li svg") as SVGElement;
    expect(feedRow.getAttribute("class")).toContain("lucide-git-branch");
  });

  it("the never-mounted sidebar variant is gone; TopBar's mount still compiles against the props", () => {
    const bell = readFileSync(resolve("components/notifications/NotificationBell.tsx"), "utf8");
    expect(bell).not.toMatch(/variant === "sidebar"|collapsed/);
    expect(readFileSync(resolve("components/navigation/TopBar.tsx"), "utf8")).toContain('<NotificationBell variant="header" />');
  });
});

// ── RT-11 dw1: the doorway while the dock is raised ─────────────────────────

/** A modal that has started an upload: it raises the dock. */
function RaisedUpload() {
  useDockRaise(true);
  return null;
}
/** The upload indicator's registration: a raisable jobs card. */
function RaisableUploadCard() {
  useDockAllowances("jobs", 30, 1, { label: "Uploading P-1.pdf", tone: "busy" }, { raisable: true });
  return null;
}
const toastHandle: { show: ReturnType<typeof useToast>["showToast"] } = { show: () => {} };
function GrabToast() {
  const { showToast } = useToast();
  React.useEffect(() => { toastHandle.show = showToast; }, [showToast]);
  return null;
}
function Shell({ raised }: { raised: boolean }) {
  const { open, isOpen } = useNotificationCenter();
  return React.createElement(React.Fragment, null,
    React.createElement(CornerDock, { onOpenCenter: open, occupiedRightPx: isOpen ? NOTIFICATION_CENTER_RAIL_PX : 0 }),
    React.createElement(GrabToast),
    React.createElement(RaisableUploadCard),
    raised ? React.createElement(RaisedUpload) : null);
}

describe("RT-11 dw1 — raised over an upload modal, '+N more' opens the center above that modal", () => {
  it("the doorway is offered raised; the center opens at Z.dialog (above every upload modal), and the raised dock moves left of it", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 480, height: 800, top: 0, left: 800, right: 1280, bottom: 800, x: 800, y: 0, toJSON() { return {}; } } as DOMRect);
    await mount(React.createElement(ToastProvider, null, React.createElement(NotificationCenterProvider, null, React.createElement(Shell, { raised: true }))));
    await act(async () => { for (let i = 0; i < 6; i++) toastHandle.show({ type: "info", title: `Doc ${i} revised`, duration: 0 }); });
    await flush();
    const dock = document.getElementById("corner-dock")!;
    expect(Number(dock.style.zIndex)).toBe(Z.dockRaised);
    expect(dock.style.right).toBe("calc(0px - 1.5rem)");
    const doorway = [...dock.querySelectorAll("button")].find((b) => /Notifications/.test(b.textContent ?? ""))!;
    expect(doorway).toBeTruthy();
    await act(async () => { doorway.click(); });
    await flush();
    // above every upload-starting modal (300 / 400 / 510), under the raised dock
    expect(Number(panel().style.zIndex)).toBe(Z.dialog);
    expect(Number((document.querySelector("[data-center-backdrop]") as HTMLElement).style.zIndex)).toBe(Z.dialog);
    expect(Z.dialog).toBeGreaterThan(Z.assetPhotoUploader);
    expect(Z.dialog).toBeLessThan(Z.dockRaised);
    // the raised dock no longer covers the panel: it sits left of it
    expect(dock.style.right).toBe("calc(480px - 1.5rem)");
    // closed, the rail above the raise goes with it
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flush();
    expect(dock.style.right).toBe("calc(0px - 1.5rem)");
  });

  it("opened at rest, the center keeps its resting layer (240 / 241, no inline layer) — nothing moved for the ordinary case", async () => {
    await mount(React.createElement(ToastProvider, null, React.createElement(NotificationCenterProvider, null, React.createElement(Shell, { raised: false }), React.createElement(GrabCenter))));
    await act(async () => { opener.open(); });
    await flush();
    expect(panel().style.zIndex).toBe("");
    expect(panel().className).toContain("z-[241]");
    expect((document.querySelector("[data-center-backdrop]") as HTMLElement).className).toContain("z-[240]");
  });
});
