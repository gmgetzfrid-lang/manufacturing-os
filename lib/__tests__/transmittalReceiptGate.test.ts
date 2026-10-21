// DELIV-15 done-when 3 (notifications Round G, N9): a receipt recorded with
// the issuer's email OFF writes the bell row and queues NO email — through the
// real modules (lib/transmittalReceiptNotice.ts → lib/notifications.ts
// queueEmail → the request-scoped service-role client, lib/supabase.ts +
// lib/serverClientScope.ts), not a mocked gate. Only the service-role client
// is a stand-in: it answers email_gate() (20261148 / 20261191) or, before
// that paste, PGRST202 — and then queueEmail's fallback reads the issuer's
// preference row on that same client (emailAllowedByPrefs).

import { describe, it, expect, beforeEach } from "vitest";
import { tellIssuerOfReceipt } from "@/lib/transmittalReceiptNotice";

type Row = Record<string, unknown>;
const db = {
  prefs: null as Row | null,
  gate: { data: true } as { data?: boolean | null; error?: { code: string; message: string } },
  inserts: [] as Array<{ table: string; row: Row }>,
  gateCalls: [] as Row[],
  /** notifications N18: whether 20261258 is pasted (before it the status
   *  CHECK refuses a not_emailed row with 23514). */
  pasted258: false,
};

/** The service-role client: reads answer from `db`, writes are recorded. */
const admin = {
  from(table: string) {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["select", "eq", "in", "gte", "lte", "order", "limit", "is"]) b[m] = self;
    b.maybeSingle = async () => {
      if (table === "org_members") return { data: { email: "issuer@acme.com" }, error: null };
      if (table === "notification_preferences") return { data: db.prefs, error: null };
      return { data: null, error: null };
    };
    b.insert = async (row: Row) => {
      if (row.status === "not_emailed" && !db.pasted258) return { error: { code: "23514", message: 'violates check constraint "email_notifications_status_check"' } };
      db.inserts.push({ table, row });
      return { error: null };
    };
    return b;
  },
  rpc: async (fn: string, args: Row) => {
    if (fn === "email_gate") { db.gateCalls.push(args); return { data: db.gate.data ?? null, error: db.gate.error ?? null }; }
    return { data: null, error: { code: "PGRST202", message: `no ${fn}` } };
  },
  auth: { getSession: async () => ({ data: { session: null } }) },
};

const input = {
  orgId: "o1", transmittalId: "11111111-1111-1111-1111-111111111111", number: "TR-0007", subject: "IFC set",
  issuerUid: "issuer", acknowledgedByName: "Jane Doe", via: "portal" as const, at: "2026-10-07T12:00:00.000Z",
};
const bells = () => db.inserts.filter((i) => i.table === "notifications");
const emails = () => db.inserts.filter((i) => i.table === "email_notifications");

beforeEach(() => { db.prefs = null; db.gate = { data: true }; db.inserts = []; db.gateCalls = []; db.pasted258 = false; });

describe("DELIV-15 dw3 — the issuer's email preference stops the receipt email, never the bell row", () => {
  it("email_gate says no (the issuer turned email off): the bell row is written, no email row", async () => {
    db.gate = { data: false };
    const out = await tellIssuerOfReceipt(admin as never, input);
    expect(out.told).toBe(true);
    expect(bells()).toHaveLength(1);
    expect(bells()[0].row).toMatchObject({ user_id: "issuer", kind: "ack_complete", title: "Transmittal TR-0007 acknowledged" });
    expect(emails()).toEqual([]);
    // asked as the service role, about the receipt's own event — and, since
    // notifications N18 (EVID-9), once more with no resource to tell the
    // issuer's own preference from a 60-second repeat (a read; nothing sent)
    expect(db.gateCalls).toEqual([
      expect.objectContaining({ p_org: "o1", p_to_user: "issuer", p_event_type: "watcher_activity" }),
      expect.objectContaining({ p_org: "o1", p_to_user: "issuer", p_event_type: "watcher_activity", p_resource_id: null, p_subject: null, p_body: null }),
    ]);
  });

  it("N18 (EVID-9 dw2) — after 20261258: the issuer's opt-out leaves one not_emailed record (nothing sends it) beside the bell row, and still no queued email", async () => {
    db.gate = { data: false };
    db.pasted258 = true;
    const out = await tellIssuerOfReceipt(admin as never, input);
    expect(out.told).toBe(true);
    expect(bells()).toHaveLength(1);
    expect(emails().map((e) => e.row.status)).toEqual(["not_emailed"]);
    expect(emails()[0].row).toMatchObject({ to_user_id: "issuer", event_type: "watcher_activity", metadata: expect.objectContaining({ not_emailed: { byTheirChoice: true, reason: "preference" } }) });
    expect(emails().some((e) => e.row.status === "queued")).toBe(false);
  });

  it("before 20261148 is pasted (PGRST202) the same rule reads the issuer's row on the service-role client: email off → no email row", async () => {
    db.gate = { error: { code: "PGRST202", message: "Could not find the function public.email_gate" } };
    db.prefs = { user_id: "issuer", email_enabled: false, digest_frequency: "instant", email_on_watched_activity: true };
    await tellIssuerOfReceipt(admin as never, input);
    expect(bells()).toHaveLength(1);
    expect(emails()).toEqual([]);
  });

  it("the 'Activity on things I watch' toggle off stops it too (the receipt is that event)", async () => {
    db.gate = { error: { code: "PGRST202", message: "Could not find the function public.email_gate" } };
    db.prefs = { user_id: "issuer", email_enabled: true, digest_frequency: "instant", email_on_watched_activity: false };
    await tellIssuerOfReceipt(admin as never, input);
    expect(emails()).toEqual([]);
    expect(bells()).toHaveLength(1);
  });

  it("email on: one queued email row of event watcher_activity to the issuer's address", async () => {
    await tellIssuerOfReceipt(admin as never, input);
    expect(emails()).toHaveLength(1);
    expect(emails()[0].row).toMatchObject({
      org_id: "o1", to_user_id: "issuer", to_email: "issuer@acme.com", event_type: "watcher_activity",
      subject: "Transmittal TR-0007 acknowledged by Jane Doe", status: "queued",
    });
  });
});
