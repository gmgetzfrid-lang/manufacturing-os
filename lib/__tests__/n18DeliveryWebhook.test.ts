// notifications Round G — N18 DELIVERY RECORD, drafting-flow EVID-9 dw1
// (DEC-90 ruling (1)): the provider's signed delivery / bounce report is
// written onto the email row it names; an email that works today sends
// exactly as today.
//
//   * lib/resendWebhook.ts — the Standard Webhooks (Svix) signature: a good
//     one passes; a wrong secret, a changed body, a stale or future
//     timestamp, a missing header, a v2-only list all fail; the report's
//     outcome, provider id, time and words.
//   * POST /api/webhooks/resend — no secret → 503 and nothing touched; an
//     unsigned / mis-signed body → 401 and nothing touched; an outcome →
//     record_email_delivery with exactly the report; before 20261258 → 503
//     (said); an unknown id → 409 while fresh, 200 once old.
//   * the drain keeps the provider's id beside 'sent'; before 20261258 (the
//     column missing) the 'sent' bookkeeping is today's update, so nothing is
//     ever left 'sending' to be mailed twice; a not_emailed row is never
//     claimed, recovered or reclaimed; the send itself is byte-identical.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { resetState, type MemoryState } from "./helpers/memoryDb";
import { resetDeliveryRecordLatches, DELIVERY_RECORD_REPROBE_MS } from "@/lib/deliveryRecordLatch";

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://supabase.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "service-key";
  process.env.CRON_SECRET = "cron-secret";
  return {
    state: null as unknown as MemoryState,
    rpc: vi.fn(),
    idColumnMissing: false,
    refusedUpdates: [] as Array<Record<string, unknown>>,
    /** An update that never answers (a stalled connection), by its payload. */
    hangUpdate: null as null | ((payload: Record<string, unknown>) => boolean),
  };
});

vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => h.rpc(...a) } }));
vi.mock("@supabase/supabase-js", async () => {
  const mem = await import("./helpers/memoryDb");
  h.state = mem.freshState();
  const base = mem.makeSupabase(h.state);
  const client = {
    ...base,
    auth: { getUser: async () => ({ data: { user: null } }) },
    from: (t: string) => {
      const c = base.from(t) as Record<string, (...a: unknown[]) => unknown>;
      if (t !== "email_notifications") return c;
      return new Proxy(c, {
        get(target, prop: string) {
          if (prop === "update") {
            return (payload: Record<string, unknown>) => {
              if (h.hangUpdate?.(payload)) {
                const t: Record<string, unknown> = {};
                t.eq = () => t;
                t.in = () => t;
                t.then = () => new Promise(() => undefined);
                return t;
              }
              if (h.idColumnMissing && payload && "provider_message_id" in payload) {
                h.refusedUpdates.push(payload);
                const err = { data: null, error: { code: "PGRST204", message: "Could not find the 'provider_message_id' column of 'email_notifications' in the schema cache" } };
                const t: Record<string, unknown> = {};
                t.eq = () => t;
                t.in = () => t;
                t.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => Promise.resolve(err).then(r, j);
                return t;
              }
              return target.update(payload);
            };
          }
          return target[prop];
        },
      });
    },
  };
  return { createClient: () => client };
});

import { verifyWebhookSignature, parseDeliveryReport, providerMessageIdOf, outcomeOf, RESEND_WEBHOOK_TOLERANCE_SECONDS, PROVIDER_ID_READ_TIMEOUT_MS, RESEND_WEBHOOK_MAX_BYTES } from "@/lib/resendWebhook";
import { POST as webhook, NO_ROW_RETRY_WINDOW_MS } from "@/app/api/webhooks/resend/route";
import { POST as drain } from "@/app/api/notifications/send-queued/route";

const KEY = Buffer.from("n18-test-signing-key-0123456789");
const SECRET = `whsec_${KEY.toString("base64")}`;
const sign = (id: string, ts: string, body: string, key = KEY) => `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
const nowTs = () => String(Math.floor(Date.now() / 1000));
const event = (type: string, data: Record<string, unknown> = { email_id: "re_abc" }, createdAt = new Date().toISOString()) =>
  JSON.stringify({ type, created_at: createdAt, data });

describe("lib/resendWebhook — the signature (Standard Webhooks / Svix)", () => {
  const body = event("email.delivered");
  it("a delivery signed with the endpoint's secret passes, with or without the whsec_ prefix; a list with one good v1 entry passes", () => {
    const ts = nowTs();
    expect(verifyWebhookSignature({ secret: SECRET, id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body), body })).toEqual({ ok: true });
    expect(verifyWebhookSignature({ secret: KEY.toString("base64"), id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body), body })).toEqual({ ok: true });
    expect(verifyWebhookSignature({ secret: SECRET, id: "msg_1", timestamp: ts, signature: `v1,AAAA ${sign("msg_1", ts, body)}`, body })).toEqual({ ok: true });
  });
  it("refused: another secret, a changed body, another id, a stale or future timestamp, a missing header, a v2-only list, no secret", () => {
    const ts = nowTs();
    const good = sign("msg_1", ts, body);
    const v = (o: Partial<Parameters<typeof verifyWebhookSignature>[0]>) => verifyWebhookSignature({ secret: SECRET, id: "msg_1", timestamp: ts, signature: good, body, ...o }).ok;
    expect(v({ signature: sign("msg_1", ts, body, Buffer.from("another key")) })).toBe(false);
    expect(v({ body: body.replace("delivered", "bounced") })).toBe(false);
    expect(v({ id: "msg_2" })).toBe(false);
    const stale = String(Number(ts) - RESEND_WEBHOOK_TOLERANCE_SECONDS - 5);
    expect(v({ timestamp: stale, signature: sign("msg_1", stale, body) })).toBe(false);
    const future = String(Number(ts) + RESEND_WEBHOOK_TOLERANCE_SECONDS + 5);
    expect(v({ timestamp: future, signature: sign("msg_1", future, body) })).toBe(false);
    expect(v({ id: null })).toBe(false);
    expect(v({ timestamp: null })).toBe(false);
    expect(v({ signature: null })).toBe(false);
    expect(v({ signature: good.replace("v1,", "v2,") })).toBe(false);
    expect(v({ timestamp: "12abc" })).toBe(false);
    expect(v({ secret: "" })).toBe(false);
    expect(v({ secret: "whsec_" })).toBe(false);
  });
});

describe("lib/resendWebhook — the report", () => {
  it("a complaint carries no detail (detailOf gives null) — which is why record_email_delivery's stronger-outcome branch keeps a bounce's reason (20261258); the two stay tied", () => {
    const p = parseDeliveryReport(JSON.parse(event("email.complained", { email_id: "re_c", complaint: { type: "abuse", message: "marked as spam" }, bounce: { message: "x" }, failed: { reason: "y" } })));
    expect(p).toMatchObject({ kind: "outcome", report: { outcome: "complained", detail: null } });
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261258_notif_roundG_delivery_record.sql"), "utf8");
    expect(sql).toContain("THEN COALESCE(left(p_detail, 500), CASE WHEN e.delivery_status IN ('bounced', 'failed') THEN e.delivery_detail END) ELSE e.delivery_detail END,");
  });

  it("the five delivery outcomes; every other event is ignored", () => {
    expect(["email.delivered", "email.delivery_delayed", "email.bounced", "email.complained", "email.failed"].map(outcomeOf))
      .toEqual(["delivered", "delayed", "bounced", "complained", "failed"]);
    for (const t of ["email.sent", "email.opened", "email.clicked", "email.scheduled", "contact.created", "toString", "__proto__"]) {
      expect(outcomeOf(t), t).toBeNull();
    }
    expect(parseDeliveryReport(JSON.parse(event("email.opened")))).toEqual({ kind: "ignored", type: "email.opened" });
  });
  it("a bounce carries its words (type / subtype: message), at most 500 characters; the time is the event's", () => {
    const at = "2026-10-21T10:10:00.000Z";
    const p = parseDeliveryReport(JSON.parse(event("email.bounced", { email_id: "re_1", bounce: { type: "Permanent", subType: "General", message: "Mailbox full" } }, at)));
    expect(p).toEqual({ kind: "outcome", report: { type: "email.bounced", outcome: "bounced", providerMessageId: "re_1", at, detail: "Permanent / General: Mailbox full" } });
    const long = parseDeliveryReport(JSON.parse(event("email.bounced", { email_id: "re_1", bounce: { message: "x".repeat(900) } })));
    expect((long as { report: { detail: string } }).report.detail.length).toBe(500);
    const delivered = parseDeliveryReport(JSON.parse(event("email.delivered", { email_id: "re_2" }, "not a date")));
    expect(delivered).toEqual({ kind: "outcome", report: { type: "email.delivered", outcome: "delivered", providerMessageId: "re_2", at: null, detail: null } });
  });
  it("not a report: no type, no data, no email id", () => {
    expect(parseDeliveryReport(null).kind).toBe("invalid");
    expect(parseDeliveryReport({ data: { email_id: "x" } }).kind).toBe("invalid");
    expect(parseDeliveryReport({ type: "email.bounced" }).kind).toBe("invalid");
    expect(parseDeliveryReport({ type: "email.bounced", data: { email_id: "" } }).kind).toBe("invalid");
  });
  it("providerMessageIdOf reads { id } and never throws (no body, not JSON, no text method)", async () => {
    expect(await providerMessageIdOf(new Response('{"id":"re_9"}'))).toBe("re_9");
    expect(await providerMessageIdOf(new Response("{}"))).toBeNull();
    expect(await providerMessageIdOf(new Response("<html>"))).toBeNull();
    expect(await providerMessageIdOf({ ok: true })).toBeNull();
    expect(await providerMessageIdOf({ text: async () => { throw new Error("stream gone"); } })).toBeNull();
  });

  it("providerMessageIdOf never hangs: a body that never arrives answers null after the bound", async () => {
    expect(PROVIDER_ID_READ_TIMEOUT_MS).toBe(2000);
    const t0 = Date.now();
    expect(await providerMessageIdOf({ text: () => new Promise<string>(() => undefined) }, 30)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    // a body that arrives inside the bound is read
    expect(await providerMessageIdOf({ text: () => new Promise<string>((r) => setTimeout(() => r('{"id":"re_late"}'), 5)) }, 500)).toBe("re_late");
  });
});

describe("POST /api/webhooks/resend", () => {
  const saved = process.env.RESEND_WEBHOOK_SECRET;
  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    h.rpc.mockReset();
    h.rpc.mockResolvedValue({ data: "recorded", error: null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.RESEND_WEBHOOK_SECRET; else process.env.RESEND_WEBHOOK_SECRET = saved;
    vi.restoreAllMocks();
  });
  const post = (body: string, headers: Record<string, string> | null = null) => {
    const ts = nowTs();
    const hd = headers ?? { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sign("msg_1", ts, body) };
    return webhook(new NextRequest("https://app.example.com/api/webhooks/resend", { method: "POST", body, headers: { "content-type": "application/json", ...hd } }));
  };

  it("no RESEND_WEBHOOK_SECRET: 503, nothing recorded — never a trusted body", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await post(event("email.bounced"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/RESEND_WEBHOOK_SECRET is not set\) — nothing was recorded/);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("unsigned, mis-signed or stale: 401, nothing recorded", async () => {
    const body = event("email.bounced");
    expect((await post(body, {})).status).toBe(401);
    const ts = nowTs();
    expect((await post(body, { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sign("msg_1", ts, body, Buffer.from("forger")) })).status).toBe(401);
    const old = String(Number(ts) - 3600);
    expect((await post(body, { "svix-id": "msg_1", "svix-timestamp": old, "svix-signature": sign("msg_1", old, body) })).status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("the webhook-* header spelling is accepted too", async () => {
    const body = event("email.delivered");
    const ts = nowTs();
    const res = await post(body, { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": sign("msg_1", ts, body) });
    expect(res.status).toBe(200);
  });

  it("a delivered / bounced report → record_email_delivery with exactly the report; 200 recorded", async () => {
    const at = new Date().toISOString();
    const res = await post(event("email.bounced", { email_id: "re_abc", bounce: { message: "Mailbox full" } }, at));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, outcome: "bounced" });
    expect(h.rpc).toHaveBeenCalledWith("record_email_delivery", { p_provider_message_id: "re_abc", p_outcome: "bounced", p_at: at, p_detail: "Mailbox full" });
  });

  it("an event that is not a delivery outcome (email.sent, email.opened) → 200 ignored, nothing written", async () => {
    for (const t of ["email.sent", "email.opened"]) {
      const res = await post(event(t));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recorded: false, ignored: t });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("not JSON → 400; not a report → 400; nothing written", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ type: "email.bounced" }))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("before 20261258 (the function is missing — PGRST202 / 42883): 503 naming the paste; the provider retries", async () => {
    for (const error of [{ code: "PGRST202", message: "Could not find the function public.record_email_delivery" }, { code: "42883", message: "function record_email_delivery(text, text, timestamptz, text) does not exist" }]) {
      h.rpc.mockResolvedValueOnce({ data: null, error });
      const res = await post(event("email.delivered"));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/paste 20261258_notif_roundG_delivery_record\.sql/);
    }
  });

  it("any other database error → 500 (the provider retries)", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "timeout" } });
    expect((await post(event("email.delivered"))).status).toBe(500);
  });

  it("an unknown message id: 409 (retry) while the event is fresh — the drain may not have kept the id yet; 200 (nothing recorded) once it is old", async () => {
    h.rpc.mockResolvedValue({ data: "no_row", error: null });
    expect((await post(event("email.delivered"))).status).toBe(409);
    const old = new Date(Date.now() - NO_ROW_RETRY_WINDOW_MS - 60_000).toISOString();
    const res = await post(event("email.delivered", { email_id: "re_old" }, old));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recorded: false });
  });

  it("a chunked body with no Content-Length is read as a stream and stopped at the bound → 413; nothing past it is buffered, nothing recorded", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    // an endless body: only a reader that stops at the bound ever returns
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += chunk.byteLength; c.enqueue(chunk); } });
    const ts = nowTs();
    const req = new NextRequest("https://app.example.com/api/webhooks/resend", {
      method: "POST", body: stream, duplex: "half",
      headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": "v1,AAAA" },
    } as NonNullable<ConstructorParameters<typeof NextRequest>[1]>);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await webhook(req);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(RESEND_WEBHOOK_MAX_BYTES + 3 * chunk.byteLength);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a signed body inside the bound, streamed with no Content-Length, is read whole (multi-byte text decoded once)", async () => {
    h.rpc.mockResolvedValueOnce({ data: "recorded", error: null });
    const body = event("email.bounced", { email_id: "re_abc", bounce: { message: "Boîte pleine — überfüllt" } });
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } });
    const ts = nowTs();
    const req = new NextRequest("https://app.example.com/api/webhooks/resend", {
      method: "POST", body: stream, duplex: "half",
      headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sign("msg_1", ts, body) },
    } as NonNullable<ConstructorParameters<typeof NextRequest>[1]>);
    expect((await webhook(req)).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("a body past the bound → 413 before anything is read into the record", async () => {
    const res = await post(JSON.stringify({ type: "email.delivered", data: { email_id: "x", pad: "y".repeat(300 * 1024) } }));
    expect(res.status).toBe(413);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("the drain keeps the provider's id beside 'sent'; nothing it sends changes", () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.RESEND_API_KEY;
  let sends: Array<Record<string, unknown>> = [];
  let answer = '{"id":"re_123"}';
  beforeEach(() => {
    resetState(h.state);
    resetDeliveryRecordLatches();
    h.hangUpdate = null;
    h.idColumnMissing = false;
    h.refusedUpdates = [];
    sends = [];
    answer = '{"id":"re_123"}';
    process.env.RESEND_API_KEY = "re_test";
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === "https://api.resend.com/emails") {
        sends.push(JSON.parse(String(init?.body)));
        return new Response(answer, { status: 200 });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
    vi.restoreAllMocks();
  });
  const run = () => drain(new Request("http://app.local/api/notifications/send-queued", { method: "POST", headers: { authorization: "Bearer cron-secret" } }));
  const seed = (rows: Array<Record<string, unknown>>) => {
    h.state.tables.email_notifications = rows.map((r) => ({ org_id: "o1", attempt_count: 0, subject: "S", body_text: "B", body_html: null, metadata: { rendered: true, external: true }, created_at: new Date().toISOString(), ...r }));
  };
  const row = (id: string) => h.state.tables.email_notifications!.find((r) => r.id === id)!;

  it("after 20261258: the row is 'sent' with sent_at, the attempt counted and the provider's id kept", async () => {
    seed([{ id: "e1", status: "queued", to_user_id: "u1", to_email: "a@x.io" }]);
    expect(await (await run()).json()).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(row("e1")).toMatchObject({ status: "sent", attempt_count: 1, provider_message_id: "re_123" });
    expect(typeof row("e1").sent_at).toBe("string");
  });

  it("BEFORE 20261258 (the column missing — PGRST204): today's 'sent' update lands without the id; the row is never left 'sending' (no second email)", async () => {
    h.idColumnMissing = true;
    seed([{ id: "e1", status: "queued", to_user_id: "u1", to_email: "a@x.io" }]);
    expect(await (await run()).json()).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(h.refusedUpdates).toHaveLength(1);
    expect(row("e1")).toMatchObject({ status: "sent", attempt_count: 1 });
    expect(row("e1").provider_message_id).toBeUndefined();
    expect(sends).toHaveLength(1);
  });

  const sevenRows = () => seed(Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, status: "queued", to_user_id: `u${i}`, to_email: `u${i}@x.io`, subject: `S${i}`, body_text: `B${i}` })));
  const sentUpdates = () => h.state.calls.filter((c) => c.table === "email_notifications" && c.method === "update" && (c.args[0] as Record<string, unknown>).status === "sent");
  const expectedSends = Array.from({ length: 7 }, (_, i) => ({ from: "notifications@manufacturing-os.app", to: `u${i}@x.io`, subject: `S${i}`, text: `B${i}` }));

  it("BEFORE 20261258, a batch across two chunks: the five sends in flight together each pay one refused update (nobody waits); every later send writes today's update directly; every email sent, byte-identical", async () => {
    h.idColumnMissing = true;
    sevenRows();
    expect(await (await run()).json()).toEqual({ processed: 7, sent: 7, failed: 0 });
    expect(h.refusedUpdates).toHaveLength(5);
    // each refused one is followed by today's update; the second chunk writes today's update once
    expect(sentUpdates().map((c) => "provider_message_id" in (c.args[0] as Record<string, unknown>))).toEqual(Array(7).fill(false));
    for (let i = 0; i < 7; i++) {
      expect(row(`e${i}`)).toMatchObject({ status: "sent", attempt_count: 1 });
      expect("provider_message_id" in row(`e${i}`)).toBe(false);
    }
    expect(sends).toEqual(expectedSends);
    // the next drain in the same process: no refused update at all
    sevenRows();
    await run();
    expect(h.refusedUpdates).toHaveLength(5);
    expect(sends).toHaveLength(14);
  });

  it("no send ever waits on another (DEC-90): a stalled provider-id update on one row holds no other row — before and after the paste", async () => {
    for (const missing of [false, true]) {
      resetState(h.state);
      resetDeliveryRecordLatches();
      h.idColumnMissing = missing;
      h.refusedUpdates = [];
      let n = 0;
      globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        void url;
        sends.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: `re_${n++}` }), { status: 200 });
      }) as typeof fetch;
      // the first send's update carrying its id never answers
      h.hangUpdate = (payload) => payload.provider_message_id === "re_0";
      seed(Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, status: "queued", to_user_id: `u${i}`, to_email: `u${i}@x.io` })));
      void run();
      await vi.waitFor(() => {
        for (let i = 1; i < 5; i++) expect(row(`e${i}`)).toMatchObject({ status: "sent", attempt_count: 1 });
      }, { timeout: 2000, interval: 10 });
      for (let i = 1; i < 5; i++) expect("provider_message_id" in row(`e${i}`)).toBe(!missing);
    }
  });

  it("the latch is not forever: past DELIVERY_RECORD_REPROBE_MS the id is tried again, and once 20261258 is pasted it is kept", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-21T09:00:00Z"));
      h.idColumnMissing = true;
      seed([{ id: "e1", status: "queued", to_user_id: "u1", to_email: "a@x.io" }]);
      await run();
      expect(h.refusedUpdates).toHaveLength(1);
      h.idColumnMissing = false; // the paste
      vi.setSystemTime(new Date(Date.parse("2026-10-21T09:00:00Z") + DELIVERY_RECORD_REPROBE_MS - 1000));
      seed([{ id: "e2", status: "queued", to_user_id: "u2", to_email: "b@x.io" }]);
      await run();
      expect("provider_message_id" in row("e2")).toBe(false);
      vi.setSystemTime(new Date(Date.parse("2026-10-21T09:00:00Z") + DELIVERY_RECORD_REPROBE_MS + 1000));
      seed([{ id: "e3", status: "queued", to_user_id: "u3", to_email: "c@x.io" }]);
      await run();
      expect(row("e3")).toMatchObject({ status: "sent", attempt_count: 1, provider_message_id: "re_123" });
      expect(h.refusedUpdates).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AFTER 20261258 (no refusal): every send keeps its id in ONE update, exactly as before the latch existed", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      void url;
      sends.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: `re_${n++}` }), { status: 200 });
    }) as typeof fetch;
    sevenRows();
    expect(await (await run()).json()).toEqual({ processed: 7, sent: 7, failed: 0 });
    expect(h.refusedUpdates).toHaveLength(0);
    expect(sentUpdates()).toHaveLength(7);
    expect(sentUpdates().every((c) => typeof (c.args[0] as Record<string, unknown>).provider_message_id === "string")).toBe(true);
    expect(new Set(Array.from({ length: 7 }, (_, i) => row(`e${i}`).provider_message_id)).size).toBe(7);
    expect(sends).toEqual(expectedSends);
  });

  it("a 2xx whose answer body stalls: the row still lands 'sent' (today's update, no id) — never left 'sending' for the reclaim to mail it twice", async () => {
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      sends.push(JSON.parse(String(init?.body)));
      void url;
      return { ok: true, status: 200, text: () => new Promise<string>(() => undefined) } as unknown as Response;
    }) as typeof fetch;
    seed([{ id: "e1", status: "queued", to_user_id: "u1", to_email: "a@x.io" }]);
    expect(await (await run()).json()).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(row("e1")).toMatchObject({ status: "sent", attempt_count: 1 });
    expect("provider_message_id" in row("e1")).toBe(false);
    expect(sends).toHaveLength(1);
  }, 15_000);

  it("a provider answer with no id (or not JSON): today's update, exactly", async () => {
    answer = "accepted";
    seed([{ id: "e1", status: "queued", to_user_id: "u1", to_email: "a@x.io" }]);
    await run();
    expect(row("e1")).toMatchObject({ status: "sent", attempt_count: 1 });
    expect("provider_message_id" in row("e1")).toBe(false);
  });

  it("REGRESSION: what goes to the provider is byte-identical to today's request (from, to, subject, text, html — no tag, no new field)", async () => {
    seed([{ id: "e1", status: "queued", to_user_id: "u1", to_email: "a@x.io", subject: "Final approval needed", body_text: "Please review", body_html: "<p>Please review</p>" }]);
    await run();
    expect(sends).toEqual([{ from: "notifications@manufacturing-os.app", to: "a@x.io", subject: "Final approval needed", text: "Please review", html: "<p>Please review</p>" }]);
  });

  it("dw2: a not_emailed row is never claimed, never sent, never re-queued — beside a queued one that is sent", async () => {
    seed([
      { id: "ne", status: "not_emailed", to_user_id: "u2", to_email: "b@x.io" },
      { id: "q", status: "queued", to_user_id: "u1", to_email: "a@x.io" },
    ]);
    expect(await (await run()).json()).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(sends.map((s) => s.to)).toEqual(["a@x.io"]);
    expect(row("ne").status).toBe("not_emailed");
    expect(row("ne").attempt_count).toBe(0);
  });

  it("by source: the drain's three status writes name only queued / failed, suppressed and sending — never not_emailed", () => {
    const route = readFileSync(join(process.cwd(), "app/api/notifications/send-queued/route.ts"), "utf8");
    expect(route).not.toContain("not_emailed");
    expect(route).toMatch(/\.eq\("status", "suppressed"\)/);
    expect(route).toMatch(/\.eq\("status", "sending"\)/);
    expect((route.match(/\.in\("status", \["queued", "failed"\]\)/g) ?? []).length).toBe(3);
  });
});
