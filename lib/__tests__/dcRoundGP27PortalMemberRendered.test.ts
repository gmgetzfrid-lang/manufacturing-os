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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const s = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
  snapshot: null as Record<string, unknown> | null,
  snapshotStatus: 200,
  calls: [] as Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>,
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
