// notifications Round G — N6 EMAIL-PIPELINE-AND-CRON: the render layer.
//
//   NEDGE-4 / DELIV-5   every email body's links are absolute, built on the
//                       public origin; the renderer refuses (throws) when
//                       there is no origin rather than mailing a bare path;
//                       emit()'s link reaches the email; ticketUrl() is built
//                       on publicOrigin() (also public-surfaces PHYS-13's
//                       last site).
//   NEDGE-10            mention markup renders as names; every email carries
//                       a footer linking the settings page; the one-click
//                       unsubscribe token is signed per member.
//   NEDGE-12 dw1        lib/recordTime.ts writes moments ISO-8601 with an
//                       offset and the zone named.
//   escapeHtml          every interpolation is escaped (report 08's "verified
//                       sound" invariant, carried forward).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    const p: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (r: (v: unknown) => void) => r({ data: [], error: null });
        return (...args: unknown[]) => {
          if (prop === "insert") { h.inserts.push({ table, ...(args[0] as Record<string, unknown>) }); return Promise.resolve({ error: null }); }
          if (prop === "maybeSingle") return Promise.resolve({ data: null, error: null });
          return new Proxy(c, p);
        };
      },
    };
    return new Proxy(c, p);
  };
  return {
    supabase: {
      from: chain,
      rpc: async (fn: string, args: Record<string, unknown>) => { h.rpc.push({ fn, args }); return { data: true, error: null }; },
      auth: { getSession: async () => ({ data: { session: null } }) },
    },
  };
});

import {
  renderNotificationEmail, wrapEmailBody, absoluteEmailLink, plainMentions, requireEmailOrigin,
  EmailOriginMissingError, hrefsOf, textToHtml,
} from "@/lib/emailRender";
import { formatRecordTime, formatRecordDate, isValidTimeZone, orgTimeZone } from "@/lib/recordTime";
import { signUnsubscribe, verifyUnsubscribe, unsubscribeUrl } from "@/lib/unsubscribeToken";
import { queueEmail, ticketUrl } from "@/lib/notifications";

const ORIGIN = "https://ops.example.com";
const UUID = "3f2b8c14-9d7a-4e11-b0f3-5a6c9e2d4188";
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const ENV_KEYS = ["NEXT_PUBLIC_SITE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL", "EMAIL_UNSUBSCRIBE_SECRET"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  h.rpc = []; h.inserts = [];
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("NEDGE-4 / DELIV-5 — every link an email carries is absolute; no origin, no body", () => {
  it("an app-relative link joins the origin; an absolute http(s) link is kept; anything else is dropped", () => {
    expect(absoluteEmailLink("/requests/t1?c=9", ORIGIN)).toBe(`${ORIGIN}/requests/t1?c=9`);
    expect(absoluteEmailLink("https://elsewhere.example/x", ORIGIN)).toBe("https://elsewhere.example/x");
    for (const bad of ["//evil.example/x", "/\\evil.example", "javascript:alert(1)", "requests/t1", "", null, undefined, "/a b"]) {
      expect(absoluteEmailLink(bad as string, ORIGIN), String(bad)).toBeNull();
    }
  });

  it("REFUSES (throws) with no origin — never a body with a dead bare-path link (the XEDGE-5 lesson)", () => {
    expect(() => requireEmailOrigin()).toThrow(EmailOriginMissingError);
    expect(() => renderNotificationEmail({ subject: "s", body: "b", link: "/requests/t1" })).toThrow(EmailOriginMissingError);
    expect(() => wrapEmailBody({ text: "t" })).toThrow(EmailOriginMissingError);
    expect(() => requireEmailOrigin("not a url")).toThrow(EmailOriginMissingError);
    // configured: the public origin, trailing slash trimmed
    process.env.NEXT_PUBLIC_SITE_URL = "https://ops.example.com/";
    expect(requireEmailOrigin()).toBe(ORIGIN);
  });

  it("no href in any rendered body starts with a bare '/' (NEDGE-4 dw2 / DELIV-5 dw3)", () => {
    const r = renderNotificationEmail({ subject: "Hold placed", body: "Dana placed a hold.\n\nWork should stop.", link: "/documents/lib-1?doc=d-1", orgName: "Baytown Ops", origin: ORIGIN });
    const w = wrapEmailBody({ text: "x", html: `<p><a href="${ORIGIN}/requests/t1">Open ticket</a></p>`, origin: ORIGIN });
    for (const html of [r.bodyHtml, w.bodyHtml]) {
      const hrefs = hrefsOf(html);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) expect(href.startsWith("/"), href).toBe(false);
      for (const href of hrefs) expect(href).toMatch(/^https:\/\//);
    }
    expect(r.link).toBe(`${ORIGIN}/documents/lib-1?doc=d-1`);
    expect(r.bodyText).toContain(`Open in the app: ${ORIGIN}/documents/lib-1?doc=d-1`);
    expect(hrefsOf(r.bodyHtml)).toEqual([`${ORIGIN}/documents/lib-1?doc=d-1`, `${ORIGIN}/settings/notifications`]);
  });

  it("an event with no link renders no button, still the footer; the subject is kept (mentions as names)", () => {
    const r = renderNotificationEmail({ subject: "Ping @[Mike Leonard](" + UUID + ")", body: "Body", origin: ORIGIN });
    expect(r.link).toBeNull();
    expect(hrefsOf(r.bodyHtml)).toEqual([`${ORIGIN}/settings/notifications`]);
    expect(r.subject).toBe("Ping @Mike Leonard");
  });

  it("ticketUrl() is built on publicOrigin() (DELIV-5 dw2 / PHYS-13) — never window.location.origin", () => {
    process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
    expect(ticketUrl("abc-123")).toBe(`${ORIGIN}/requests/abc-123`);
    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "app.example.com";
    expect(ticketUrl("abc-123")).toBe("https://app.example.com/requests/abc-123");
    const lib = src("lib/notifications.ts");
    const fn = lib.slice(lib.indexOf("export function ticketUrl"), lib.indexOf("// ─── SLA"));
    expect(fn).toContain("publicOrigin()");
    expect(fn).not.toMatch(/window\.location/);
  });
});

describe("NEDGE-10 — mentions as names; a footer on every email; escaping carried forward", () => {
  it("@[Name](uuid) never leaves the system — text and HTML", () => {
    const text = `can you check this with @[Mike Leonard](${UUID}) before Friday`;
    expect(plainMentions(text)).toBe("can you check this with @Mike Leonard before Friday");
    const r = renderNotificationEmail({ subject: "s", body: text, origin: ORIGIN });
    const w = wrapEmailBody({ text, html: `<blockquote>${text}</blockquote>`, origin: ORIGIN });
    for (const out of [r.bodyText, r.bodyHtml, w.bodyText, w.bodyHtml]) {
      expect(out).not.toContain(UUID);
      expect(out).toContain("@Mike Leonard");
    }
    // a second call in the same tick still finds the first mention (fresh scan state)
    expect(plainMentions(text)).toBe(plainMentions(text));
  });

  it("the footer names the workspace and links the settings page — text and HTML", () => {
    const r = renderNotificationEmail({ subject: "s", body: "b", orgName: "Baytown Ops", origin: ORIGIN });
    expect(r.bodyText).toContain("Baytown Ops sent this notification.");
    expect(r.bodyText).toContain(`${ORIGIN}/settings/notifications`);
    expect(r.bodyHtml).toContain(`href="${ORIGIN}/settings/notifications"`);
    const anon = wrapEmailBody({ text: "t", origin: ORIGIN });
    expect(anon.bodyText).toContain("Your workspace sent this notification.");
  });

  it("every interpolation is escaped: a body, an org name or a label with markup cannot inject", () => {
    const evil = `<img src=x onerror=alert(1)> & "quoted"`;
    const r = renderNotificationEmail({ subject: "s", body: evil, orgName: evil, linkLabel: evil, link: "/x", origin: ORIGIN });
    expect(r.bodyHtml).not.toContain("<img");
    expect(r.bodyHtml).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;");
    expect(textToHtml("a\nb\n\nc")).toBe("<p>a<br>b</p>\n<p>c</p>");
  });

  it("the one-click token is the member's own: verifies for them, for nobody else, and not unsigned", () => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "s3cret";
    const t = signUnsubscribe(UUID)!;
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyUnsubscribe(UUID, t)).toBe(true);
    expect(verifyUnsubscribe("11111111-1111-4111-8111-111111111111", t)).toBe(false);
    expect(verifyUnsubscribe(UUID, t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"))).toBe(false);
    expect(verifyUnsubscribe(UUID, "")).toBe(false);
    expect(signUnsubscribe("not-a-uuid")).toBeNull();
    expect(unsubscribeUrl(ORIGIN, UUID)).toBe(`${ORIGIN}/api/notifications/unsubscribe?u=${UUID}&t=${encodeURIComponent(t)}`);
    expect(unsubscribeUrl("", UUID)).toBeNull();
    // another key, another token: the token is bound to the deployment's secret
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "other";
    expect(verifyUnsubscribe(UUID, t)).toBe(false);
  });
});

describe("NEDGE-12 dw1 — a moment in a body is ISO-8601 with its offset, the zone named", () => {
  it("UTC by default, labelled; a configured IANA zone with its offset; a bad zone falls back to UTC", () => {
    expect(formatRecordTime("2026-03-20T23:15:15Z")).toBe("2026-03-20T23:15:15+00:00 (UTC)");
    expect(formatRecordTime("2026-03-20T23:15:15Z", "America/Chicago")).toBe("2026-03-20T18:15:15-05:00 (America/Chicago)");
    expect(formatRecordTime("2026-03-20T23:15:15Z", "Asia/Kolkata")).toBe("2026-03-21T04:45:15+05:30 (Asia/Kolkata)");
    expect(formatRecordTime("2026-03-20T23:15:15Z", "Not/AZone")).toBe("2026-03-20T23:15:15+00:00 (UTC)");
    expect(formatRecordDate("2026-03-20T23:15:15Z")).toBe("2026-03-20 (UTC)");
    expect(formatRecordDate("2026-03-20T23:15:15Z", "Asia/Kolkata")).toBe("2026-03-21 (Asia/Kolkata)");
    expect(formatRecordTime("garbage")).toBe("garbage");
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("orgTimeZone reads org_configurations key 'timezone' (data.timeZone) — valid IANA only, else null; a failed read is null", async () => {
    const client = (data: unknown, error: unknown = null) => ({
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) }),
    });
    expect(await orgTimeZone(client({ data: { timeZone: "America/Chicago" } }), "o1")).toBe("America/Chicago");
    expect(await orgTimeZone(client({ data: { timeZone: "Mars/Olympus" } }), "o1")).toBeNull();
    expect(await orgTimeZone(client(null), "o1")).toBeNull();
    expect(await orgTimeZone(client(null, { message: "boom" }), "o1")).toBeNull();
  });

  it("no server-composed notification body in this package's files calls a bare toLocale*String()", () => {
    const cron = src("app/api/cron/maintenance/route.ts");
    expect(cron).not.toMatch(/toLocaleDateString\(\)|toLocaleString\(\)/);
    expect(cron).toContain("const since = formatRecordDate(row.started_at, await zoneOf(row.org_id));");
  });
});

describe("queueEmail stores and gates the RENDERED body when the dispatcher passes one (N6)", () => {
  const base = {
    orgId: "o1", toUserId: UUID, toEmail: "m@example.com", subject: "S", bodyText: "raw body",
    resourceType: "document" as const, resourceId: "d0000000-0000-4000-8000-000000000000", eventType: "watcher_activity",
  };

  it("email_gate's repeat check sees the stored (rendered) body; the row is marked rendered and carries the absolute link", async () => {
    await queueEmail({ ...base, link: `${ORIGIN}/documents/x`, rendered: { bodyText: "rendered text", bodyHtml: "<p>rendered</p>" } });
    expect(h.rpc).toEqual([{ fn: "email_gate", args: expect.objectContaining({ p_subject: "S", p_body: "rendered text" }) }]);
    const row = h.inserts.find((r) => r.table === "email_notifications")!;
    expect(row).toMatchObject({ body_text: "rendered text", body_html: "<p>rendered</p>", subject: "S" });
    expect(row.metadata).toEqual({ link: `${ORIGIN}/documents/x`, rendered: true });
  });

  it("REGRESSION: with no rendered body nothing changes — the producer's text and HTML are gated and stored as given", async () => {
    await queueEmail({ ...base, bodyHtml: "<p>own</p>" });
    expect(h.rpc[0].args).toMatchObject({ p_body: "raw body" });
    const row = h.inserts.find((r) => r.table === "email_notifications")!;
    expect(row).toMatchObject({ body_text: "raw body", body_html: "<p>own</p>", metadata: null });
  });
});
