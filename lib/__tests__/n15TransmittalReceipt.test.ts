// notifications Round G — N15: the transmittal acknowledgment receipt.
//
//   NEDGE-12 done-when 1 (the transmittal limb): the issuer's receipt email
//   prints the time through lib/recordTime.ts formatRecordTime in the org's
//   zone — never the server's unlabelled toLocaleString().
//   NEDGE-10 done-when 1 (the transmittal limb, verified): the receipt —
//   queued by lib/transmittalReceiptNotice.ts through queueEmail on the
//   service role — is gated by email_gate / emailAllowedByPrefs on the
//   issuer's master switch, so the one-click link it carries tells the truth.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({ emails: [] as Array<Record<string, unknown>>, bound: [] as unknown[] }));
vi.mock("@/lib/inAppNotifications", () => ({ notifyWithReason: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/notifications", () => ({ queueEmail: vi.fn(async (i: Record<string, unknown>) => { state.emails.push(i); }) }));
vi.mock("@/lib/serverClientScope", () => ({
  runWithServerClient: vi.fn(async (c: unknown, fn: () => Promise<unknown>) => { state.bound.push(c); return fn(); }),
}));

import { receiptEmailText, tellIssuerOfReceipt, RECEIPT_EMAIL_EVENT } from "@/lib/transmittalReceiptNotice";
import { emailAllowedByPrefs, isPreferenceExempt } from "@/lib/notificationPrefs";

const AT = "2026-03-20T23:15:15.000Z";
const input = { orgId: "o1", transmittalId: "t1", number: "TR-0412", subject: null, issuerUid: "issuer", acknowledgedByName: "Jane", via: "portal" as const, at: AT };
/** the service-role stand-in: org_members answers the issuer's address; org_configurations the zone */
const admin = (timeZone: string | null) => ({
  from: (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b; b.eq = () => b;
    b.maybeSingle = async () => table === "org_configurations"
      ? { data: timeZone ? { data: { timeZone } } : null, error: null }
      : { data: { email: "issuer@acme.com" }, error: null };
    return b;
  },
});
beforeEach(() => { state.emails = []; state.bound = []; });

describe("NEDGE-12 dw1 — the receipt's time is zone-labelled ISO-8601", () => {
  it("reproduced: the old body printed new Date(at).toLocaleString() — unlabelled; now the record time, UTC when no zone is set", () => {
    const { bodyText } = receiptEmailText(input);
    expect(bodyText).toContain("on 2026-03-20T23:15:15+00:00 (UTC).");
    expect(bodyText).not.toContain(new Date(AT).toLocaleString());
  });
  it("in the org's configured zone (the 6:15 pm Central case reads 18:15, the same calendar day)", () => {
    expect(receiptEmailText(input, "America/Chicago").bodyText).toContain("on 2026-03-20T18:15:15-05:00 (America/Chicago).");
  });
  it("tellIssuerOfReceipt reads the org's zone (org_configurations key timezone) for the email it queues", async () => {
    await tellIssuerOfReceipt(admin("America/Chicago") as never, input);
    expect(state.emails).toHaveLength(1);
    expect(String(state.emails[0].bodyText)).toContain("2026-03-20T18:15:15-05:00 (America/Chicago)");
  });
  it("no bare toLocale*String() is left in the receipt module", () => {
    const src = readFileSync(join(process.cwd(), "lib/transmittalReceiptNotice.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/toLocale(Date|Time)?String\(/);
  });
});

describe("NEDGE-10 dw1 (transmittal limb) — the receipt reads the issuer's master switch", () => {
  it("it is queued through queueEmail, on the service role, as the issuer's watcher_activity mail", async () => {
    const a = admin(null);
    await tellIssuerOfReceipt(a as never, input);
    expect(state.bound).toEqual([a]);
    expect(state.emails[0]).toMatchObject({ toUserId: "issuer", toEmail: "issuer@acme.com", eventType: RECEIPT_EMAIL_EVENT });
    expect(RECEIPT_EMAIL_EVENT).toBe("watcher_activity");
  });
  it("watcher_activity is NOT preference-exempt: the master switch off (or 'never') stops it; on, it goes", () => {
    expect(isPreferenceExempt("watcher_activity")).toBe(false);
    expect(emailAllowedByPrefs({ email_enabled: false }, "watcher_activity")).toBe(false);
    expect(emailAllowedByPrefs({ email_enabled: true, digest_frequency: "never" }, "watcher_activity")).toBe(false);
    expect(emailAllowedByPrefs(null, "watcher_activity")).toBe(true);
  });
  it("the NEWEST email_gate() stops a non-exempt event on the master switch — and watcher_activity is not on its exempt list", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    let newest = "";
    for (const f of files) {
      const s = readFileSync(join(dir, f), "utf8");
      const i = s.search(/CREATE OR REPLACE FUNCTION (public\.)?email_gate\(/);
      if (i >= 0) newest = s.slice(i, s.indexOf("$$;", s.indexOf("AS $$", i) + 5));
    }
    expect(newest).toMatch(/IF COALESCE\(p_event_type, ''\) NOT IN \('safety_recall', 'safety_alert', 'transmittal_unstamped', 'transmittal_refused'\) THEN/);
    expect(newest).toMatch(/v_prefs\.email_enabled IS FALSE/);
  });
  it("the drain's one-click header and the unsubscribe page agree: the receipt is mail the switch stops", () => {
    const drain = readFileSync(join(process.cwd(), "app/api/notifications/send-queued/route.ts"), "utf8");
    const noOpt = drain.slice(drain.indexOf("const NO_OPT_OUT_EVENT_TYPES"), drain.indexOf("]);", drain.indexOf("const NO_OPT_OUT_EVENT_TYPES")));
    expect(noOpt).not.toContain("watcher_activity");
    const page = readFileSync(join(process.cwd(), "app/api/notifications/unsubscribe/route.ts"), "utf8");
    expect(page).not.toContain("a recipient's acknowledgment");
    expect(page).toContain("when a PDF could not be stamped or was refused");
  });
});
