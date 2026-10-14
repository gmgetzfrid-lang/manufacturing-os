// notifications Round G, N9 — the transmittal notices.
//
//   PROD-12 dw1: both doors that record a receipt (the recipient's portal and
//     the register's receipt route) tell the issuer through ONE helper
//     (lib/transmittalReceiptNotice.ts tellIssuerOfReceipt): the same
//     ack_complete bell row and the same receipt email — except that nobody
//     is told of their own act.
//   PROD-12 dw2: issuing a transmittal tells the documents' owners and the
//     libraries' followers (lib/transmittals.ts notifyTransmittalIssued —
//     transmittal_issued, one notice per library).
//   DELIV-15 dw1: the receipt email is the 'watcher_activity' event, gated by
//     the issuer's preferences (queueEmail → email_gate, as the service role);
//     the unmarked / refused-PDF notice is the exempt one (DEC-90 A10).
//   NEDGE-11 dw3: the rendered email's links are absolute https:// links on
//     the configured public origin — never a relative "/transmittal/…".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  bell: [] as Array<Record<string, unknown>>,
  bellResult: { ok: true } as { ok: boolean; error?: string },
  emails: [] as Array<Record<string, unknown>>,
  boundClients: [] as unknown[],
  emits: [] as Array<Record<string, unknown>>,
  docs: [] as Array<Record<string, unknown>>,
  docsError: null as null | { message: string },
  owners: {} as Record<string, string | null>,
}));

vi.mock("@/lib/inAppNotifications", () => ({
  notifyWithReason: vi.fn(async (input: Record<string, unknown>) => { state.bell.push(input); return state.bellResult; }),
}));
vi.mock("@/lib/notifications", () => ({
  queueEmail: vi.fn(async (input: Record<string, unknown>) => { state.emails.push(input); }),
}));
vi.mock("@/lib/serverClientScope", () => ({
  runWithServerClient: vi.fn(async (client: unknown, fn: () => Promise<unknown>) => { state.boundClients.push(client); return fn(); }),
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (p: Record<string, unknown>) => { state.emits.push(p); }) }));
vi.mock("@/lib/ownership", () => ({
  effectiveOwnerForDocument: vi.fn(async (d: { ownerUserId?: string | null; libraryId: string }) => ({ userId: d.ownerUserId ?? state.owners[d.libraryId] ?? null })),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.in = () => Promise.resolve({ data: state.docsError ? null : state.docs, error: state.docsError });
      return b;
    },
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
}));

import { tellIssuerOfReceipt, receiptEmailText, RECEIPT_EMAIL_EVENT } from "@/lib/transmittalReceiptNotice";
import { notifyTransmittalIssued, renderTransmittalEmail, transmittalPortalUrl, type Transmittal } from "@/lib/transmittals";
import { isPreferenceExempt } from "@/lib/notificationPrefs";

/** A service-role client stand-in: org_members answers the issuer's address. */
const admin = (email: string | null = "issuer@acme.com", error: { message: string } | null = null) => ({
  from: () => {
    const b: Record<string, unknown> = {};
    b.select = () => b; b.eq = () => b;
    b.maybeSingle = async () => ({ data: email ? { email } : null, error });
    return b;
  },
});

beforeEach(() => {
  state.bell = []; state.bellResult = { ok: true }; state.emails = []; state.boundClients = []; state.emits = [];
  state.docs = []; state.docsError = null; state.owners = {};
});

const AT = "2026-10-07T12:00:00.000Z";
const portal = { orgId: "o1", transmittalId: "t1", number: "TR-0007", subject: "IFC set", issuerUid: "issuer", acknowledgedByName: "Jane Doe", via: "portal" as const, note: "All received", at: AT };

describe("PROD-12 dw1 — the issuer is told of a receipt, from either door", () => {
  it("the portal: the ack_complete bell row and the receipt email — the email the portal sent before N9, word for word but the time (NEDGE-12, N15: ISO-8601 with its zone)", async () => {
    const out = await tellIssuerOfReceipt(admin() as never, portal);
    expect(out).toEqual({ told: true, emailQueued: true });
    expect(state.bell).toEqual([expect.objectContaining({
      orgId: "o1", userId: "issuer", kind: "ack_complete", title: "Transmittal TR-0007 acknowledged",
      body: "Jane Doe confirmed receipt through the portal.", link: "/transmittals",
      resourceType: "transmittal", resourceId: "t1", actorName: "Jane Doe",
    })]);
    expect(state.bell[0]).not.toHaveProperty("actorUserId"); // a portal recipient is no member
    expect(state.emails).toEqual([{
      orgId: "o1", toUserId: "issuer", toEmail: "issuer@acme.com",
      subject: "Transmittal TR-0007 acknowledged by Jane Doe",
      bodyText: `Jane Doe confirmed receipt of transmittal TR-0007 (IFC set) through the recipient portal on 2026-10-07T12:00:00+00:00 (UTC).\n\nTheir note: All received`,
      resourceId: "t1", eventType: "watcher_activity",
    }]);
  });

  it("the register: the same bell row and email, naming who recorded the receipt", async () => {
    const out = await tellIssuerOfReceipt(admin() as never, {
      ...portal, via: "manual", recordedByUid: "dc1", recordedByLabel: "dora@acme.com", note: null,
    });
    expect(out).toEqual({ told: true, emailQueued: true });
    expect(state.bell[0]).toMatchObject({
      kind: "ack_complete", userId: "issuer", actorUserId: "dc1", actorName: "dora@acme.com",
      body: "dora@acme.com recorded Jane Doe's receipt on the register.",
    });
    expect(state.emails[0]).toMatchObject({
      subject: "Transmittal TR-0007 acknowledged by Jane Doe",
      bodyText: `dora@acme.com recorded Jane Doe's receipt of transmittal TR-0007 (IFC set) on 2026-10-07T12:00:00+00:00 (UTC).`,
      eventType: "watcher_activity",
    });
  });

  it("nobody is told of their own act; no issuer, nothing to tell", async () => {
    expect(await tellIssuerOfReceipt(admin() as never, { ...portal, via: "manual", recordedByUid: "issuer" }))
      .toEqual({ told: false, emailQueued: false, skipped: "recorded_by_issuer" });
    expect(await tellIssuerOfReceipt(admin() as never, { ...portal, issuerUid: null }))
      .toEqual({ told: false, emailQueued: false, skipped: "no_issuer" });
    expect(state.bell).toEqual([]);
    expect(state.emails).toEqual([]);
  });

  it("best-effort: a refused bell row is logged and the email still goes; an issuer with no address gets the bell only", async () => {
    state.bellResult = { ok: false, error: "refused" };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await tellIssuerOfReceipt(admin() as never, portal)).toEqual({ told: false, emailQueued: true });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("bell notice was refused"), "refused");
    err.mockRestore();
    state.bellResult = { ok: true }; state.emails = [];
    expect(await tellIssuerOfReceipt(admin(null) as never, portal)).toEqual({ told: true, emailQueued: false });
    expect(state.emails).toEqual([]);
  });

  it("both routes call the one helper (source pins)", () => {
    const portalRoute = readFileSync(join(process.cwd(), "app/api/transmittal/route.ts"), "utf8");
    const receiptRoute = readFileSync(join(process.cwd(), "app/api/transmittal/receipt/route.ts"), "utf8");
    expect(portalRoute).toMatch(/tellIssuerOfReceipt\(supabaseAdmin, \{[\s\S]*?via: "portal"/);
    expect(receiptRoute).toMatch(/tellIssuerOfReceipt\(supabaseAdmin, \{[\s\S]*?via: "manual"[\s\S]*?recordedByUid: user\.id/);
    // the receipt sentence lives in one place now
    expect(portalRoute).not.toContain("through the recipient portal on");
  });
});

describe("DELIV-15 dw1 — the receipt email honours the issuer's preferences; the unmarked-PDF notice does not need to", () => {
  it("the receipt email is the watcher_activity event, queued as the service role (email_gate reads the issuer's row)", async () => {
    const client = admin();
    await tellIssuerOfReceipt(client as never, portal);
    expect(RECEIPT_EMAIL_EVENT).toBe("watcher_activity");
    expect(state.emails[0]).toMatchObject({ eventType: "watcher_activity" });
    expect(state.boundClients).toEqual([client]);
    expect(isPreferenceExempt("watcher_activity")).toBe(false);
    expect(isPreferenceExempt("transmittal_unstamped")).toBe(true);
    expect(isPreferenceExempt("transmittal_refused")).toBe(true);
  });

  it("receiptEmailText keeps the subject both doors share", () => {
    expect(receiptEmailText(portal).subject).toBe(receiptEmailText({ ...portal, via: "manual" }).subject);
  });
});

describe("PROD-12 dw2 — issuing tells the documents' owners and the libraries' followers", () => {
  const t: Transmittal = {
    id: "t1", orgId: "o1", seq: 7, number: "TR-0007", subject: "IFC set", recipientName: "Jane Doe", recipientCompany: "BuildCo",
    recipientEmail: "jane@buildco.com", purpose: "For Construction", status: "issued",
    items: [
      { documentId: "d1", number: "P-1", title: "P&ID", rev: "C" },
      { documentId: "d2", number: "P-2", title: null, rev: null },
      { documentId: "d3", number: "E-9", title: null, rev: "A" },
    ],
  } as Transmittal;
  const actor = { orgId: "o1", actorUserId: "me", actorName: "me@acme.com" };

  it("one transmittal_issued notice per library: its documents' effective owners named, its followers on", async () => {
    state.docs = [
      { id: "d1", library_id: "libA", collection_id: null, owner_user_id: "own1", owner_name: null },
      { id: "d2", library_id: "libA", collection_id: null, owner_user_id: null, owner_name: null },
      { id: "d3", library_id: "libB", collection_id: null, owner_user_id: null, owner_name: null },
    ];
    state.owners = { libA: "libA-owner", libB: "libB-owner" };
    expect(await notifyTransmittalIssued(t, actor as never)).toBe(2);
    expect(state.emits).toHaveLength(2);
    const a = state.emits.find((e) => (e.resource as { id: string }).id === "libA")!;
    expect(a).toMatchObject({
      orgId: "o1", kind: "transmittal_issued", category: "watched", link: "/transmittals",
      title: "Transmittal TR-0007 issued: 2 documents to Jane Doe, BuildCo",
      resource: { type: "library", id: "libA" }, actorUserId: "me", metadata: { transmittalId: "t1" },
    });
    expect((a.audience as { involved: string[]; followers: boolean }).followers).toBe(true);
    expect(new Set((a.audience as { involved: string[] }).involved)).toEqual(new Set(["own1", "libA-owner"]));
    const b = state.emits.find((e) => (e.resource as { id: string }).id === "libB")!;
    expect(b.title).toBe("Transmittal TR-0007 issued: E-9 Rev A to Jane Doe, BuildCo");
  });

  it("never throws and never blocks the issue: an unreadable document list sends nothing (logged)", async () => {
    state.docsError = { message: "timeout" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await notifyTransmittalIssued(t, actor as never)).toBe(0);
    expect(state.emits).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("issueTransmittal starts it without awaiting it (source pin)", () => {
    const src = readFileSync(join(process.cwd(), "lib/transmittals.ts"), "utf8");
    expect(src).toMatch(/void notifyTransmittalIssued\(t, actor\);\s*const email = await sendTransmittalEmail\(t, actor\);/);
  });
});

describe("NEDGE-11 dw3 — the emailed links are absolute https:// links on the configured origin", () => {
  const saved = {
    site: process.env.NEXT_PUBLIC_SITE_URL, vercelEnv: process.env.VERCEL_ENV,
    vercelProd: process.env.VERCEL_PROJECT_PRODUCTION_URL, vercelProdPublic: process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL,
  };
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  afterEach(() => {
    restore("NEXT_PUBLIC_SITE_URL", saved.site);
    restore("VERCEL_ENV", saved.vercelEnv);
    restore("VERCEL_PROJECT_PRODUCTION_URL", saved.vercelProd);
    restore("NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL", saved.vercelProdPublic);
  });
  const t = {
    id: "t1", orgId: "o1", seq: 7, number: "TR-0007", subject: "IFC set", recipientName: "Jane", recipientCompany: null,
    recipientEmail: "jane@x.com", purpose: null, status: "issued", items: [{ documentId: "d1", number: "P-1", title: "P&ID", rev: "C" }],
  } as unknown as Transmittal;

  it("the portal link and every href in the rendered HTML are absolute https:// links", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://app.example.com";
    const url = transmittalPortalUrl("tok123");
    expect(url).toBe("https://app.example.com/transmittal/tok123");
    const { html, text } = renderTransmittalEmail(t, url!);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs).toContain("https://app.example.com/transmittal/tok123");
    for (const h of hrefs) expect(h, h).toMatch(/^https:\/\//);
    expect(html).not.toMatch(/href="\//);
    expect(text).toContain("https://app.example.com/transmittal/tok123");
  });

  it("with no configured origin no link is built at all — never a relative one (the send route refuses)", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "";
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL;
    expect(transmittalPortalUrl("tok123")).toBeNull();
    const route = readFileSync(join(process.cwd(), "app/api/transmittal/send-email/route.ts"), "utf8");
    expect(route).toMatch(/const portalUrl = transmittalPortalUrl\(t\.portalToken\);\s*if \(!portalUrl\) \{/);
  });
});
