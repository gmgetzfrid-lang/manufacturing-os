// lib/__tests__/notificationsLib.test.ts
//
// Freezes the notification helper logic that the whole fan-out depends on:
// @-mention parsing (drives who gets a mention notification + email) and the
// SLA date helpers. Pure functions, exercised heavily because a regression here
// silently mis-routes notifications.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractMentionUids,
  tokenizeMentions,
  isPastDue,
  isNearingDue,
  defaultSlaTargetDate,
  DEFAULT_SLA_DAYS,
  ticketUrl,
  queueEmail,
  type QueueEmailInput,
} from "@/lib/notifications";
import { categoryToEventType, type NotifCategory } from "@/lib/notify/dispatch";

// ── A small database for queueEmail (notifications Round G, N1) ────────────
// Two tables and one function, with the RLS each one really has:
//   notification_preferences — notif_prefs_own: a signed-in caller sees ONLY
//     their own row (20260605:111-115); the service role sees every row.
//   email_notifications — email_notif_select_own_or_admin: a member sees the
//     rows addressed to them (20261047:219-225); the service role sees all.
//   email_gate() — SECURITY DEFINER (20261148): it sees every row whoever
//     calls it. Its rules are written out here independently of the app's
//     helper; notificationPrefs.test.ts pins the migration's CASE to them.
//     A recall ('safety_recall') or PSM alert ('safety_alert') skips the
//     preferences entirely. Its dedupe merges a repeat only: the latest email
//     to the recipient for the same (event, resource, org) in 60 s has the
//     same subject AND the same body.
//   auth.getSession — the browser carries the actor's session; the service
//     role (the cron, the intake door) carries none.
const world = vi.hoisted(() => ({
  actor: "a0000000-0000-4000-8000-000000000001",
  ctx: "client" as "client" | "service",
  prefs: new Map<string, Record<string, unknown>>(),
  emails: [] as Array<Record<string, unknown>>,
  rpc: "deployed" as "deployed" | "missing" | "missing-42883" | "error",
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  insertError: null as null | { code: string; message: string },
  sessionThrows: false,
}));

vi.mock("@/lib/supabase", () => {
  type Row = Record<string, unknown>;
  const EXEMPT = new Set(["safety_recall", "safety_alert"]);
  const GATED: Record<string, string> = {
    comment_mention: "email_on_mention",
    assignment: "email_on_assignment",
    engineer_review_requested: "email_on_assignment",
    ticket_status_changed: "email_on_status_change",
    ticket_approved: "email_on_status_change",
    ticket_revision_requested: "email_on_status_change",
    ticket_closed: "email_on_status_change",
    watcher_activity: "email_on_watched_activity",
    sla_warning: "email_on_sla_warning",
  };
  const visible = (table: string): Row[] => {
    if (table === "notification_preferences") {
      const rows = [...world.prefs.values()];
      return world.ctx === "service" ? rows : rows.filter((r) => r.user_id === world.actor);
    }
    if (table === "email_notifications") {
      return world.ctx === "service" ? world.emails : world.emails.filter((r) => r.to_user_id === world.actor);
    }
    return [];
  };
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let lim = Infinity;
    let sort: { col: string; asc: boolean } | null = null;
    const run = () => {
      // insertion order breaks a created_at tie (two inserts in one millisecond)
      const rows = visible(table).map((r, i) => ({ r, i })).filter(({ r }) => filters.every((f) => f(r)));
      if (sort) {
        const { col, asc } = sort;
        rows.sort((a, b) => {
          const x = String(a.r[col]), y = String(b.r[col]);
          const c = x < y ? -1 : x > y ? 1 : a.i - b.i;
          return asc ? c : -c;
        });
      }
      return rows.map(({ r }) => r).slice(0, lim);
    };
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      gte: (c: string, v: unknown) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
      order: (c: string, o?: { ascending?: boolean }) => { sort = { col: c, asc: o?.ascending !== false }; return q; },
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(res, rej),
      insert: async (row: Row) => {
        if (world.insertError) return { data: null, error: world.insertError };
        world.emails.push({ ...row, created_at: new Date().toISOString() });
        return { data: null, error: null };
      },
    });
    return q;
  }
  async function rpc(fn: string, args: Record<string, unknown>) {
    world.rpcCalls.push({ fn, args });
    if (world.rpc === "missing") {
      return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}(p_body, p_event_type, p_org, p_resource_id, p_subject, p_to_user) in the schema cache` } };
    }
    if (world.rpc === "missing-42883") {
      return { data: null, error: { code: "42883", message: `function public.${fn}(uuid, uuid, text, text) does not exist` } };
    }
    if (world.rpc === "error") {
      return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    }
    if (fn !== "email_gate") return { data: null, error: { code: "PGRST202", message: "unknown" } };
    const p = EXEMPT.has(args.p_event_type as string) ? undefined : world.prefs.get(args.p_to_user as string);
    if (p) {
      if (p.email_enabled === false) return { data: false, error: null };
      if (p.digest_frequency === "never") return { data: false, error: null };
      const col = GATED[args.p_event_type as string];
      if (col && p[col] === false) return { data: false, error: null };
    }
    if (args.p_resource_id) {
      const since = Date.now() - 60_000;
      const last = world.emails.filter((e) => e.to_user_id === args.p_to_user && e.event_type === args.p_event_type
        && e.resource_id === args.p_resource_id && e.org_id === args.p_org && Date.parse(e.created_at as string) >= since).at(-1);
      if (last && args.p_subject != null && args.p_body != null
        && last.subject === args.p_subject && last.body_text === args.p_body) return { data: false, error: null };
    }
    return { data: true, error: null };
  }
  async function getSession() {
    if (world.sessionThrows) throw new Error("session storage unavailable");
    return { data: { session: world.ctx === "client" ? { user: { id: world.actor }, access_token: "t" } : null } };
  }
  const client = { from, rpc, auth: { getSession } };
  return { supabase: client };
});

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";

describe("extractMentionUids", () => {
  it("pulls uids out of @[Name](uuid) syntax", () => {
    expect(extractMentionUids(`hey @[Mike Leonard](${U1}) and @[Brady](${U2})`)).toEqual([U1, U2]);
  });

  it("dedupes a uid mentioned twice", () => {
    expect(extractMentionUids(`@[A](${U1}) ... @[A again](${U1})`)).toEqual([U1]);
  });

  it("returns nothing for plain text or malformed mentions", () => {
    expect(extractMentionUids("no mentions here")).toEqual([]);
    expect(extractMentionUids("")).toEqual([]);
    expect(extractMentionUids("@[Name](not-a-uuid)")).toEqual([]);
    expect(extractMentionUids("@Name plain at-sign")).toEqual([]);
  });
});

describe("tokenizeMentions", () => {
  it("splits text and mention tokens in order", () => {
    const tokens = tokenizeMentions(`Hi @[Mike](${U1}), please review`);
    expect(tokens).toEqual([
      { kind: "text", value: "Hi " },
      { kind: "mention", name: "Mike", uid: U1 },
      { kind: "text", value: ", please review" },
    ]);
  });

  it("handles a leading mention and an empty string", () => {
    expect(tokenizeMentions(`@[Mike](${U1}) hello`)).toEqual([
      { kind: "mention", name: "Mike", uid: U1 },
      { kind: "text", value: " hello" },
    ]);
    expect(tokenizeMentions("")).toEqual([]);
  });
});

describe("SLA date helpers", () => {
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const soon = new Date(Date.now() + 12 * 3_600_000).toISOString(); // 12h out

  it("isPastDue: true only for an overdue, still-open ticket", () => {
    expect(isPastDue({ targetCompletionAt: past, status: "DRAFTING" })).toBe(true);
    expect(isPastDue({ targetCompletionAt: future, status: "DRAFTING" })).toBe(false);
    expect(isPastDue({ targetCompletionAt: past, status: "CLOSED" })).toBe(false);
    expect(isPastDue({ targetCompletionAt: past, status: "CANCELED" })).toBe(false);
    expect(isPastDue({})).toBe(false);
  });

  it("isNearingDue: true within the warn window, false outside it", () => {
    expect(isNearingDue({ targetCompletionAt: soon, status: "DRAFTING" }, 1)).toBe(true);
    expect(isNearingDue({ targetCompletionAt: future, status: "DRAFTING" }, 1)).toBe(false);
    expect(isNearingDue({ targetCompletionAt: past, status: "DRAFTING" }, 1)).toBe(false); // already past, not "nearing"
    expect(isNearingDue({ targetCompletionAt: soon, status: "CLOSED" }, 1)).toBe(false);
  });

  it("defaultSlaTargetDate honors the per-type day budget", () => {
    for (const [type, days] of Object.entries(DEFAULT_SLA_DAYS)) {
      const iso = defaultSlaTargetDate(type)!;
      const deltaDays = (new Date(iso).getTime() - Date.now()) / 86_400_000;
      // Within a day of the budget (the helper also pins the time to 17:00).
      expect(deltaDays).toBeGreaterThan(days - 1.5);
      expect(deltaDays).toBeLessThan(days + 1);
    }
  });

  it("defaultSlaTargetDate falls back to 14 days for an unknown type", () => {
    const deltaDays = (new Date(defaultSlaTargetDate("SOMETHING_ELSE")!).getTime() - Date.now()) / 86_400_000;
    expect(deltaDays).toBeGreaterThan(12.5);
    expect(deltaDays).toBeLessThan(15);
  });
});

describe("ticketUrl", () => {
  it("falls back to an app-relative path with no window (server/test)", () => {
    expect(ticketUrl("abc-123")).toBe("/requests/abc-123");
  });
});

// ─── queueEmail: the preference gate that can see the recipient ──────────
// DELIV-2 / DELIV-9 (notifications Round G, N1). The first two blocks are the
// reproduction: on the pre-N1 tree queueEmail read the recipient's row and the
// dedupe window through the CALLER's RLS, so from the browser an opt-out and a
// duplicate were both invisible.

const ORG = "0a000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const C = "c0000000-0000-4000-8000-00000000000c";
const DOC1 = "d1000000-0000-4000-8000-0000000000d1";
const DOC2 = "d2000000-0000-4000-8000-0000000000d2";
const ALL_ON = {
  email_enabled: true, email_on_mention: true, email_on_assignment: true, email_on_status_change: true,
  email_on_watched_activity: true, email_on_sla_warning: true, digest_frequency: "instant",
};

const mail = (over: Partial<QueueEmailInput> = {}): QueueEmailInput => ({
  orgId: ORG, toUserId: B, toEmail: "b@example.test", subject: "Subject", bodyText: "Body",
  resourceType: "document", resourceId: DOC1, eventType: "comment_mention", ...over,
});
const setPrefs = (uid: string, over: Record<string, unknown>) => world.prefs.set(uid, { user_id: uid, ...ALL_ON, ...over });

let warn: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  world.ctx = "client";
  world.prefs.clear();
  world.emails.length = 0;
  world.rpc = "deployed";
  world.rpcCalls.length = 0;
  world.insertError = null;
  world.sessionThrows = false;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  err = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  err.mockRestore();
});

describe("DELIV-2 — an opt-out is honoured whoever queues the email", () => {
  it("email_enabled = false, queued from another member's browser: nothing is queued", async () => {
    setPrefs(B, { email_enabled: false });
    await queueEmail(mail());
    expect(world.emails).toHaveLength(0);
  });

  it("a per-event toggle off suppresses that event only; digest_frequency 'never' suppresses all", async () => {
    setPrefs(B, { email_on_mention: false });
    await queueEmail(mail({ eventType: "comment_mention" }));
    expect(world.emails).toHaveLength(0);
    await queueEmail(mail({ eventType: "assignment" }));
    expect(world.emails.map((e) => e.event_type)).toEqual(["assignment"]);

    setPrefs(C, { digest_frequency: "never" });
    await queueEmail(mail({ toUserId: C, toEmail: "c@example.test", eventType: "assignment", resourceId: DOC2 }));
    expect(world.emails.filter((e) => e.to_user_id === C)).toHaveLength(0);
  });

  it("the gate is asked through email_gate with the org, the recipient, the event and the resource", async () => {
    await queueEmail(mail());
    expect(world.rpcCalls).toEqual([
      { fn: "email_gate", args: { p_org: ORG, p_to_user: B, p_event_type: "comment_mention", p_resource_id: DOC1, p_subject: "Subject", p_body: "Body" } },
    ]);
  });
});

describe("DELIV-9 — the 60-second dedupe sees the recipient's rows", () => {
  it("the same event for the same resource twice within 60 s from the browser: one email", async () => {
    await queueEmail(mail());
    await queueEmail(mail());
    expect(world.emails).toHaveLength(1);
  });

  it("two DIFFERENT resources within 60 s are two emails", async () => {
    await queueEmail(mail({ resourceId: DOC1 }));
    await queueEmail(mail({ resourceId: DOC2 }));
    expect(world.emails.map((e) => e.resource_id)).toEqual([DOC1, DOC2]);
  });

  it("the same resource under two different events is two emails; two recipients are two emails", async () => {
    await queueEmail(mail({ eventType: "comment_mention" }));
    await queueEmail(mail({ eventType: "watcher_activity" }));
    await queueEmail(mail({ toUserId: C, toEmail: "c@example.test" }));
    expect(world.emails).toHaveLength(3);
  });

  it("an email with no resource is never deduped (the pre-N1 window never matched one either)", async () => {
    await queueEmail(mail({ resourceId: undefined, resourceType: undefined, eventType: "system" }));
    await queueEmail(mail({ resourceId: undefined, resourceType: undefined, eventType: "system" }));
    expect(world.emails).toHaveLength(2);
    expect(world.rpcCalls.every((c) => c.args.p_resource_id === null)).toBe(true);
  });
});

// emit() queues with eventType = the CATEGORY (dispatch.ts categoryToEventType),
// not the notification kind, so different messages about one document share
// (recipient, event, resource) — and some share the subject too, differing
// only in the body. The dedupe must merge only a repeat: same subject AND body.
describe("DELIV-9 — the dedupe merges a repeat, never a different message about the same resource", () => {
  const STATUS = categoryToEventType("status");   // lib/holds.ts: hold placed AND hold released
  const WATCHED = categoryToEventType("watched"); // postPublish 'advanced to Rev' AND workPackages 'went stale'
  const RECALL = categoryToEventType("recall");   // lib/staleCopies.ts: the publish-time recall
  const PLACED = "HOLD placed on DOC-100 — Engineering review";
  const RELEASED = "Hold released on DOC-100";
  // lib/staleCopies.ts:389-394 — the revision is only in the body
  const RECALL_SUBJECT = "Your copy of DOC-100 is out of date";
  const recallBody = (rev: string) =>
    `The current revision is Rev ${rev}. You downloaded an older one — re-download before doing any work from it, and destroy old prints.`;
  // lib/holds.ts:438-443 — the reason is only in the body
  const releasedBody = (reason: string) => `Dana released the "${reason}" hold. Work can resume on the current revision.`;

  const PATHS = [
    ["email_gate (after the paste), queued from a browser", () => { world.ctx = "client"; world.rpc = "deployed"; }],
    ["the pre-paste fallback, under the service role", () => { world.ctx = "service"; world.rpc = "missing"; }],
  ] as const;

  for (const [path, arrange] of PATHS) {
    describe(path, () => {
      beforeEach(() => arrange());

      it("hold A released, then hold B placed on the same document within 60 s: both emails, the last one says stop", async () => {
        await queueEmail(mail({ eventType: STATUS, subject: RELEASED }));
        await queueEmail(mail({ eventType: STATUS, subject: PLACED }));
        expect(world.emails.map((e) => e.subject)).toEqual([RELEASED, PLACED]);
      });

      it("placed, released, placed again with the same reason within 60 s: all three (a repeat a different message has followed is not a repeat)", async () => {
        await queueEmail(mail({ eventType: STATUS, subject: PLACED }));
        await queueEmail(mail({ eventType: STATUS, subject: RELEASED }));
        await queueEmail(mail({ eventType: STATUS, subject: PLACED }));
        expect(world.emails.map((e) => e.subject)).toEqual([PLACED, RELEASED, PLACED]);
      });

      it("two work packages pinning one document go stale: one email per package to their owner", async () => {
        // workPackages.ts fires one emit per package (void, unawaited): the
        // second can land after the first is queued, inside the minute.
        await queueEmail(mail({ eventType: WATCHED, subject: 'Work package "A" went stale' }));
        await queueEmail(mail({ eventType: WATCHED, subject: 'Work package "B" went stale' }));
        expect(world.emails.map((e) => e.subject)).toEqual(['Work package "A" went stale', 'Work package "B" went stale']);
      });

      it("'advanced to Rev C' and 'package went stale' to one owner about the same document: both", async () => {
        await queueEmail(mail({ eventType: WATCHED, subject: "DOC-100 advanced to Rev C" }));
        await queueEmail(mail({ eventType: WATCHED, subject: 'Work package "B" went stale' }));
        expect(world.emails).toHaveLength(2);
      });

      it("Rev B published, then Rev C 30 s later: both recalls are queued, and the holder's last recall email names Rev C", async () => {
        await queueEmail(mail({ eventType: RECALL, subject: RECALL_SUBJECT, bodyText: recallBody("B") }));
        await queueEmail(mail({ eventType: RECALL, subject: RECALL_SUBJECT, bodyText: recallBody("C") }));
        expect(world.emails.map((e) => e.body_text)).toEqual([recallBody("B"), recallBody("C")]);
        expect(world.emails.at(-1)!.body_text).toMatch(/current revision is Rev C/);
      });

      it("a recall repeated (two producers, same revision) merges; the next revision still goes out", async () => {
        await queueEmail(mail({ eventType: RECALL, subject: RECALL_SUBJECT, bodyText: recallBody("B") }));
        await queueEmail(mail({ eventType: RECALL, subject: RECALL_SUBJECT, bodyText: recallBody("B") }));
        await queueEmail(mail({ eventType: RECALL, subject: RECALL_SUBJECT, bodyText: recallBody("C") }));
        expect(world.emails.map((e) => e.body_text)).toEqual([recallBody("B"), recallBody("C")]);
      });

      it("two different holds released on one document within 60 s (the reason is only in the body): both emails", async () => {
        await queueEmail(mail({ eventType: STATUS, subject: RELEASED, bodyText: releasedBody("Engineering review") }));
        await queueEmail(mail({ eventType: STATUS, subject: RELEASED, bodyText: releasedBody("Field verification") }));
        expect(world.emails.map((e) => e.body_text)).toEqual([releasedBody("Engineering review"), releasedBody("Field verification")]);
      });

      it("the same message twice within 60 s is still one email", async () => {
        await queueEmail(mail({ eventType: STATUS, subject: PLACED }));
        await queueEmail(mail({ eventType: STATUS, subject: PLACED }));
        expect(world.emails).toHaveLength(1);
      });
    });
  }
});

describe("REGRESSION — every email queued before the switch is still queued when preferences allow it", () => {
  const CATEGORIES: NotifCategory[] = ["mention", "assignment", "status", "watched", "sla", "system", "recall", "safety"];
  const EVENTS = [...new Set([
    ...CATEGORIES.map(categoryToEventType),
    "comment_mention", "assignment", "engineer_review_requested", "ticket_status_changed", "ticket_approved",
    "ticket_revision_requested", "ticket_closed", "watcher_activity", "sla_warning", "compliance_digest",
  ])];

  for (const ctx of ["client", "service"] as const) {
    for (const row of ["no row", "all on"] as const) {
      it(`${ctx} context, ${row}: each of ${EVENTS.length} event types queues exactly the row it queued before`, async () => {
        world.ctx = ctx;
        if (row === "all on") setPrefs(B, {});
        for (const [i, eventType] of EVENTS.entries()) {
          const resourceId = `e${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`;
          await queueEmail(mail({ eventType, resourceId, metadata: { i } }));
        }
        expect(world.emails).toHaveLength(EVENTS.length);
        world.emails.forEach((e, i) => {
          const { created_at: _c, ...rest } = e;
          expect(rest).toEqual({
            org_id: ORG, to_user_id: B, to_email: "b@example.test", subject: "Subject", body_text: "Body",
            body_html: null, resource_type: "document", resource_id: `e${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`,
            event_type: EVENTS[i], metadata: { i }, status: "queued",
          });
        });
        expect(warn).not.toHaveBeenCalled();
      });
    }
  }

  // Two different messages about ONE resource within 60 s, for every event
  // type: differing only in the subject, then only in the body. Through
  // email_gate (browser and service role) and the pre-paste fallback.
  const SAME_RESOURCE_PATHS = [
    ["client context, email_gate", "client", "deployed"],
    ["service context, email_gate", "service", "deployed"],
    ["service context, pre-paste fallback", "service", "missing"],
  ] as const;
  for (const [label, ctx, rpc] of SAME_RESOURCE_PATHS) {
    for (const vary of ["subject", "body"] as const) {
      it(`${label}: on ONE resource within 60 s, each of the ${EVENTS.length} event types queues two messages differing only in the ${vary} as two emails`, async () => {
        world.ctx = ctx;
        world.rpc = rpc;
        const msg = (eventType: string, n: string): Partial<QueueEmailInput> =>
          vary === "subject" ? { subject: `${eventType}: ${n}`, bodyText: "Body" } : { subject: eventType, bodyText: `${eventType}: ${n}` };
        for (const eventType of EVENTS) {
          await queueEmail(mail({ eventType, ...msg(eventType, "first") }));
          await queueEmail(mail({ eventType, ...msg(eventType, "second") }));
        }
        expect(world.emails.map((e) => [e.event_type, e.subject, e.body_text])).toEqual(
          EVENTS.flatMap((e) => [
            [e, msg(e, "first").subject, msg(e, "first").bodyText],
            [e, msg(e, "second").subject, msg(e, "second").bodyText],
          ]),
        );
        expect(world.emails.every((e) => e.metadata === null)).toBe(true);
        if (rpc === "deployed") expect(warn).not.toHaveBeenCalled();
      });
    }
  }

  it("recall and safety mail ignores every per-category toggle", async () => {
    setPrefs(B, { email_on_mention: false, email_on_assignment: false, email_on_status_change: false, email_on_watched_activity: false, email_on_sla_warning: false });
    await queueEmail(mail({ eventType: categoryToEventType("recall"), resourceId: DOC1 }));
    await queueEmail(mail({ eventType: categoryToEventType("safety"), resourceId: DOC2 }));
    expect(world.emails.map((e) => e.event_type)).toEqual(["safety_recall", "safety_alert"]);
  });

  // The plan's "recall/safety categories are un-mutable regardless
  // (dispatch.ts:59-66)": no preference stops them, on any path. On cd8a93a
  // the browser path already mailed them (it could not see the row); this
  // keeps that true after the paste, and makes the service-role path agree.
  for (const [label, ctx, rpc] of [
    ["a browser, email_gate", "client", "deployed"],
    ["the service role, email_gate", "service", "deployed"],
    ["the service role, pre-paste fallback", "service", "missing"],
    ["a browser, pre-paste fallback", "client", "missing"],
  ] as const) {
    it(`DEC-74 §9 — ${label}: the master switch and 'never' stop every email but a recall or a PSM alert`, async () => {
      world.ctx = ctx;
      world.rpc = rpc;
      setPrefs(B, { email_enabled: false });
      setPrefs(C, { digest_frequency: "never" });
      const toC = { toUserId: C, toEmail: "c@example.test" };
      for (const c of ["recall", "safety"] as const) {
        await queueEmail(mail({ eventType: categoryToEventType(c) }));
        await queueEmail(mail({ ...toC, eventType: categoryToEventType(c) }));
      }
      expect(world.emails.map((e) => [e.to_user_id, e.event_type])).toEqual([
        [B, "safety_recall"], [C, "safety_recall"], [B, "safety_alert"], [C, "safety_alert"],
      ]);
      // no preference bears on them, so a blind read never stamps them 'unverified'
      expect(world.emails.every((e) => e.metadata === null)).toBe(true);
      if (ctx === "service" || rpc === "deployed") {
        // where the row is visible, the opt-out still stops everything else
        await queueEmail(mail({ eventType: "comment_mention", resourceId: DOC2 }));
        await queueEmail(mail({ ...toC, eventType: "assignment", resourceId: DOC2 }));
        await queueEmail(mail({ eventType: "system", resourceId: DOC2 }));
        expect(world.emails).toHaveLength(4);
      }
    });
  }
});

describe("a gate that cannot answer is never a silent all-on", () => {
  it("email_gate errors: the email is still queued (a dropped compliance email is worse), stamped pref_gate='unverified', and a warning is logged", async () => {
    world.rpc = "error";
    setPrefs(B, { email_enabled: false });
    await queueEmail(mail({ metadata: { kind: "x" } }));
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0].metadata).toEqual({ kind: "x", pref_gate: "unverified" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/email_gate.*unverified/));
  });

  it("email_gate not deployed yet (PGRST202): today's read runs, with a warning — the service role still honours the opt-out", async () => {
    world.rpc = "missing";
    world.ctx = "service";
    setPrefs(B, { email_enabled: false });
    await queueEmail(mail());
    expect(world.emails).toHaveLength(0);
    setPrefs(B, {});
    await queueEmail(mail());
    await queueEmail(mail());
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0].metadata).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/20261148/));
  });

  it("email_gate not deployed (42883) from the browser: queued as before, but stamped unverified (the read could not see the recipient's row)", async () => {
    world.rpc = "missing-42883";
    setPrefs(B, { email_enabled: false });
    await queueEmail(mail());
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0].metadata).toEqual({ pref_gate: "unverified" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/20261148/));
  });

  it("pre-paste, no row where the read could have seen one is the defaults, not 'unverified': the service role, or the recipient's own session", async () => {
    world.rpc = "missing";
    world.ctx = "service";
    await queueEmail(mail());
    world.ctx = "client";
    await queueEmail(mail({ toUserId: world.actor, toEmail: "a@example.test", resourceId: DOC2 }));
    expect(world.emails.map((e) => [e.to_user_id, e.metadata])).toEqual([[B, null], [world.actor, null]]);
  });

  it("pre-paste, no row for ANOTHER member from a browser (absent and hidden look alike), or an unreadable session: stamped 'unverified'", async () => {
    world.rpc = "missing";
    await queueEmail(mail());
    world.ctx = "service";
    world.sessionThrows = true;
    await queueEmail(mail({ resourceId: DOC2 }));
    expect(world.emails.map((e) => e.metadata)).toEqual([{ pref_gate: "unverified" }, { pref_gate: "unverified" }]);
  });

  it("a refused insert is logged as an error, never reported as queued", async () => {
    world.insertError = { code: "42501", message: "new row violates row-level security policy" };
    await expect(queueEmail(mail())).resolves.toBeUndefined();
    expect(world.emails).toHaveLength(0);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/queueEmail/), expect.objectContaining({ code: "42501" }));
  });

  it("link rides on the row for the drain to render (N6), and nothing else changes", async () => {
    await queueEmail(mail({ link: "https://app.example.test/documents/x" }));
    expect(world.emails[0].metadata).toEqual({ link: "https://app.example.test/documents/x" });
  });
});
