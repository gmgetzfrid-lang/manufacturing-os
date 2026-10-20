// @vitest-environment jsdom
//
// document-control Round G — P27 fix pass: DIST-17 ruling 3 on the portal
// page (app/transmittal/[token]/page.tsx) RENDERED.
//   · a signed-in member of the issuing workspace who is NOT the recipient is
//     told why they cannot acknowledge, instead of the receipt form, and the
//     header reads "awaiting the recipient's acknowledgment";
//   · a member who IS the recipient keeps the form, is told their downloads
//     count as the recipient's, and the receipt POST carries the session;
//   · a sign-in the server could not check (503 member_check_failed) asks
//     to try again, not the generic error;
//   · REGRESSION: the outside recipient (no session) sees the page exactly
//     as before — no member notice, the form, no Authorization header.
//   · P27 review (c): the visible "did not start?" fallback link renews the
//     member's ticket like download() does — re-read on a timer once the
//     ticket is older than MEMBER_TICKET_RENEW_MS, and a click on a link
//     whose ticket is old renews it first and opens the file with the fresh
//     ticket; the recipient's fallback link is the plain link, no timer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
  snapshot: null as Record<string, unknown> | null,
  snapshotStatus: 200,
  calls: [] as Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>,
  // P27 review (c): every snapshot GET hands the member a new ticket (t1, t2, …)
  rotateTicket: false,
  gets: 0,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: s.session } }) } },
}));

import TransmittalPortal from "@/app/transmittal/[token]/page";

const TOKEN = "abcdefabcdefabcdefabcdefabcdefab";
const snapshot = (member?: Record<string, unknown>) => ({
  number: "TR-0001", subject: "Unit 3 package", purpose: "For Construction", status: "issued", notes: null,
  orgName: "Acme", fromName: "Issuer", issuedAt: "2026-10-01T00:00:00Z", acknowledgedAt: null, acknowledgedByName: null,
  recipientName: "Jane Doe", recipientCompany: "BuildCo", portalExpiresAt: null,
  items: [{ documentId: "d1", number: "P-101", title: null, rev: "B", statusAsSent: "Issued", effectiveDate: null, fileHash: null, notYetInForce: false, releasedUnmarked: false, unmarkedReason: null, fileSize: null }],
  ...(member ? { member } : {}),
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  s.session = null;
  s.snapshot = snapshot();
  s.snapshotStatus = 200;
  s.calls = [];
  s.rotateTicket = false;
  s.gets = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? "GET";
    s.calls.push({ url, method, headers, body: init?.body as string | undefined });
    if (method === "POST") {
      const member = (s.snapshot?.member ?? null) as { asRecipient?: boolean } | null;
      if (headers.Authorization && member && !member.asRecipient) {
        return new Response(JSON.stringify({ error: "member_cannot_acknowledge" }), { status: 403 });
      }
      return new Response(JSON.stringify({ ok: true, acknowledgedAt: "2026-10-20T00:00:00Z" }), { status: 200 });
    }
    if (s.snapshotStatus !== 200) return new Response(JSON.stringify({ error: "member_check_failed" }), { status: s.snapshotStatus });
    s.gets += 1;
    if (s.rotateTicket && s.snapshot?.member) {
      return new Response(JSON.stringify({ ...s.snapshot, member: { ...(s.snapshot.member as object), ticket: `t${s.gets}` } }), { status: 200 });
    }
    return new Response(JSON.stringify(s.snapshot), { status: 200 });
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const f of Array.from(document.querySelectorAll("iframe"))) f.remove();
});

async function render() {
  const params = Promise.resolve({ token: TOKEN });
  await act(async () => { root.render(React.createElement(TransmittalPortal, { params })); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
const ackButton = () => Array.from(host.querySelectorAll("button")).find((b) => /Acknowledge$/.test((b.textContent ?? "").trim())) as HTMLButtonElement | undefined;

describe("DIST-17 ruling 3 — the portal page for a signed-in member", () => {
  it("REGRESSION — the outside recipient (no session): no member notice, the receipt form, no Authorization header on the snapshot or the receipt", async () => {
    await render();
    expect(host.textContent).toContain("Awaiting your acknowledgment");
    expect(host.querySelector('[data-testid="portal-member-notice"]')).toBeNull();
    expect(host.querySelector('[data-testid="portal-member-no-ack"]')).toBeNull();
    const input = host.querySelector('input[placeholder^="e.g. Dave Miller"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Jane Doe");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { ackButton()!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    const post = s.calls.find((c) => c.method === "POST")!;
    expect(post.headers).not.toHaveProperty("Authorization");
    expect(s.calls.filter((c) => c.method === "GET").every((c) => !("Authorization" in c.headers))).toBe(true);
    expect(host.textContent).toContain("Receipt recorded");
  });

  it("a member who is NOT the recipient: told downloads are recorded in their name and why they cannot acknowledge — no receipt form; the header awaits the recipient", async () => {
    s.session = { access_token: "member-jwt" };
    s.snapshot = snapshot({ email: "viewer@plant.example", ticket: "t", asRecipient: false });
    await render();
    expect(s.calls[0].headers).toEqual({ Authorization: "Bearer member-jwt" });
    const notice = host.querySelector('[data-testid="portal-member-notice"]')!;
    expect(notice.textContent).toContain("recorded in your name, not as the recipient");
    expect(notice.textContent).toContain("cannot acknowledge receipt");
    expect(host.querySelector('[data-testid="portal-member-no-ack"]')?.textContent).toMatch(/cannot acknowledge receipt on their behalf/);
    expect(ackButton()).toBeUndefined();
    expect(host.textContent).toContain("Awaiting the recipient’s acknowledgment");
  });

  it("a member who IS the recipient: told their downloads count as the recipient's, keeps the receipt form, and the receipt POST carries the session", async () => {
    s.session = { access_token: "member-jwt" };
    s.snapshot = snapshot({ email: "jane@buildco.com", ticket: "t", asRecipient: true });
    await render();
    expect(host.querySelector('[data-testid="portal-member-notice"]')?.textContent).toContain("this transmittal's recipient. Downloads from this page are recorded in your name and count as the recipient's.");
    expect(host.querySelector('[data-testid="portal-member-no-ack"]')).toBeNull();
    const input = host.querySelector('input[placeholder^="e.g. Dave Miller"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Jane Doe");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { ackButton()!.click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    const post = s.calls.find((c) => c.method === "POST")!;
    expect(post.headers).toMatchObject({ "content-type": "application/json", Authorization: "Bearer member-jwt" });
  });

  it("a sign-in the server could not check (503 member_check_failed) asks to try again — not the generic error", async () => {
    s.session = { access_token: "member-jwt" };
    s.snapshotStatus = 503;
    await render();
    expect(host.textContent).toContain("We could not check your sign-in for this page just now");
    expect(host.textContent).toContain("Try again in a moment.");
    expect(host.textContent).not.toContain("Something went wrong");
  });
});

describe("P27 review (c) — the visible fallback link renews the member's ticket like download() does", () => {
  const RENEW_MS = 15 * 60 * 1000; // MEMBER_TICKET_RENEW_MS
  const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
  const downloadButton = () => Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "Download") as HTMLButtonElement;
  const fallback = () => host.querySelector('[data-testid="portal-fallback-link"]') as HTMLAnchorElement | null;
  const ticketOf = (href: string | null | undefined) => new URL(href ?? "", "https://app").searchParams.get("member");
  const snapshotGets = () => s.calls.filter((c) => c.method === "GET");
  // Click the link and report whether the page took it over (the document
  // listener stops jsdom's own navigation either way).
  const clickLink = (a: HTMLAnchorElement) => {
    let prevented = false;
    const stop = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
    document.addEventListener("click", stop);
    act(() => { a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    document.removeEventListener("click", stop);
    return prevented;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-20T09:00:00Z"));
  });

  it("a member: the link carries the ticket download() used; once it is older than the renewal age a click renews it first and opens the file with the FRESH ticket", async () => {
    s.session = { access_token: "member-jwt" };
    s.snapshot = snapshot({ email: "viewer@plant.example", ticket: "t0", asRecipient: false });
    s.rotateTicket = true;
    await render();
    expect(snapshotGets()).toHaveLength(1);
    await act(async () => { downloadButton().click(); });
    await flush();
    const frame = document.querySelector('iframe[title="download"]') as HTMLIFrameElement;
    expect(ticketOf(frame.getAttribute("src"))).toBe("t1");
    expect(ticketOf(fallback()!.getAttribute("href"))).toBe("t1");

    // fresh: the link opens as rendered — nothing renewed, nothing opened by the page
    type FakeWindow = { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };
    const open = vi.fn((): FakeWindow => ({ opener: {}, location: { href: "" }, close: vi.fn() }));
    vi.stubGlobal("open", open);
    expect(clickLink(fallback()!)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(snapshotGets()).toHaveLength(1);

    // older than the renewal age (the clock moved, no timer ran): the click renews, then opens with the fresh ticket
    vi.setSystemTime(Date.now() + RENEW_MS + 1000);
    const win: FakeWindow = { opener: {}, location: { href: "" }, close: vi.fn() };
    open.mockReturnValue(win);
    expect(clickLink(fallback()!)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    await flush();
    const recheck = snapshotGets()[1];
    expect(recheck.url).toContain("&recheck=1");
    expect(recheck.headers).toEqual({ Authorization: "Bearer member-jwt" });
    expect(win.opener).toBeNull();
    expect(ticketOf(win.location.href)).toBe("t2");
    expect(win.location.href).toContain("file=d1");
    expect(win.close).not.toHaveBeenCalled();
    expect(ticketOf(fallback()!.getAttribute("href"))).toBe("t2"); // the link itself now carries it too
  });

  it("a member: while the fallback link is on screen the snapshot is re-read on a timer once the ticket is older than the renewal age, so the link never carries an old ticket — and not before", async () => {
    s.session = { access_token: "member-jwt" };
    s.snapshot = snapshot({ email: "viewer@plant.example", ticket: "t0", asRecipient: true });
    s.rotateTicket = true;
    await render();
    await act(async () => { downloadButton().click(); });
    await flush();
    expect(ticketOf(fallback()!.getAttribute("href"))).toBe("t1");
    // the download's own re-reads (TRX-15, at 8 s and 45 s) hand out the last
    // ticket; count from after them
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    await flush();
    const settled = snapshotGets().length;
    expect(settled).toBe(3);
    const ticketAfterDownloadRereads = ticketOf(fallback()!.getAttribute("href"));
    expect(ticketAfterDownloadRereads).toBe("t3");
    // still inside the renewal age of that ticket (14 min 15 s old): no further re-read
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000); });
    await flush();
    expect(snapshotGets()).toHaveLength(settled);
    expect(ticketOf(fallback()!.getAttribute("href"))).toBe(ticketAfterDownloadRereads);
    // past it: renewed quietly (a recheck, not an open) and the link carries the new ticket
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60 * 1000); });
    await flush();
    expect(snapshotGets()).toHaveLength(settled + 1);
    expect(snapshotGets().length).toBeGreaterThan(settled);
    expect(snapshotGets().slice(settled).every((c) => c.url.includes("&recheck=1"))).toBe(true);
    expect(ticketOf(fallback()!.getAttribute("href"))).toBe(`t${s.gets}`);
    expect(ticketOf(fallback()!.getAttribute("href"))).not.toBe(ticketAfterDownloadRereads);
  });

  it("REGRESSION — the recipient (no session): the fallback link is the plain link (no member ticket), a click is the browser's own, and no renewal timer runs", async () => {
    await render();
    await act(async () => { downloadButton().click(); });
    await flush();
    const href = fallback()!.getAttribute("href")!;
    expect(href).toBe(`/api/transmittal?token=${TOKEN}&file=d1&nav=1`);
    const open = vi.fn();
    vi.stubGlobal("open", open);
    vi.setSystemTime(Date.now() + RENEW_MS + 1000);
    expect(clickLink(fallback()!)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    // only the download's own two re-reads (TRX-15), as before — none on a renewal timer
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * RENEW_MS); });
    await flush();
    const gets = snapshotGets();
    expect(gets).toHaveLength(3);
    expect(gets.every((c) => !("Authorization" in c.headers))).toBe(true);
  });
});
