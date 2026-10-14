// @vitest-environment jsdom
//
// notifications Round G — N10 PUSH (GAP-205; OS-3, OS-10, TAX-12):
// components/settings/PushOptIn.tsx on the RENDERED card.
//
//   OS-3 dw1/dw3: the browser's permission dialog is reached only through
//     the person's click, and the card says what will be sent BEFORE it.
//   OS-3 dw3: "Not now" (or the dialog dismissed) is recorded and the card
//     stops inviting.
//   OS-3 dw4: a browser that blocked the site renders how to unblock it.
//   OS-10 dw2: push_enabled is a real control, saved alone.
//   OS-2 dw1 / TAX-12 dw1 / RT-7 dw2: registration.pushManager.subscribe(
//     { userVisibleOnly: true, applicationServerKey }) from
//     navigator.serviceWorker.ready, POSTed to /api/push/subscribe.
//   GAP-205 acceptance 1: the opt-in from settings lands the row.
//
// Fix pass (the review's major 3 and a minor): the card lists only what is
// pushed TODAY (PUSH_SENT_TODAY — each kind has an emit() producer) and says
// what is not sent to devices yet (PUSH_NOT_SENT_YET — no emit() producer:
// OS-14); a subscription made before the click (another person's, on a
// shared browser) is never taken back when registration fails; an endpoint
// the server holds under other keys (409 keys_mismatch) gets ONE fresh
// subscription.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";

const db = vi.hoisted(() => ({
  prefRow: null as Record<string, unknown> | null,
  prefError: null as { message: string } | null,
  subRow: null as Record<string, unknown> | null,
  upserts: [] as Array<{ table: string; row: Record<string, unknown>; opts: unknown }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => {
          if (table === "notification_preferences") return { data: db.prefError ? null : db.prefRow, error: db.prefError };
          if (table === "push_subscriptions") return { data: db.subRow, error: null };
          throw new Error(`unexpected table ${table}`);
        },
        upsert: async (row: Record<string, unknown>, opts: unknown) => {
          db.upserts.push({ table, row, opts });
          return { data: null, error: null };
        },
      });
      return q;
    },
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
  },
}));

import PushOptIn, {
  PUSH_WHAT_IS_SENT, PUSH_PRIVACY_NOTE, PUSH_DENIED_TEXT, PUSH_UNSUPPORTED_TEXT, PUSH_UNCONFIGURED_TEXT, PUSH_DECLINE_KEY,
  PUSH_SENT_TODAY, PUSH_NOT_SENT_YET, PUSH_NOT_YET_NOTE,
  urlBase64ToUint8Array,
} from "@/components/settings/PushOptIn";
import { PUSH_KEYS_MISMATCH } from "@/lib/notify/dispatch";
import { KIND_META, NOTIFICATION_KINDS } from "@/lib/notificationKinds";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A real-shaped VAPID public key (65 bytes, base64url).
const PUBLIC_KEY = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";

type Sub = { endpoint: string; options: { applicationServerKey: ArrayBuffer | null }; unsubscribe: ReturnType<typeof vi.fn>; toJSON: () => unknown };
const env = {
  permission: "default" as NotificationPermission,
  requestResult: "granted" as NotificationPermission,
  existing: null as Sub | null,
  configured: true,
  subscribeResult: 200,
  /** answers for successive subscribe POSTs (then subscribeResult) */
  subscribeQueue: [] as Array<{ status: number; body: Record<string, unknown> }>,
};
const calls = {
  requestPermission: vi.fn(),
  subscribe: vi.fn(),
  fetch: [] as Array<{ url: string; init?: RequestInit }>,
};
const makeSub = (endpoint = "https://fcm.googleapis.com/fcm/send/device-1", key: Uint8Array | null = urlBase64ToUint8Array(PUBLIC_KEY)): Sub => ({
  endpoint,
  options: { applicationServerKey: key ? key.buffer.slice(0) as ArrayBuffer : null },
  unsubscribe: vi.fn(async () => true),
  toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } }),
});

function installBrowser(supported = true) {
  const reg = {
    pushManager: {
      getSubscription: vi.fn(async () => env.existing),
      subscribe: vi.fn(async (opts: unknown) => { calls.subscribe(opts); env.existing = makeSub(); return env.existing; }),
    },
  };
  if (supported) {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve(reg), getRegistration: vi.fn(async () => reg) },
    });
    (window as unknown as Record<string, unknown>).PushManager = function PushManager() { /* present */ };
    (window as unknown as Record<string, unknown>).Notification = {
      get permission() { return env.permission; },
      requestPermission: vi.fn(async () => { calls.requestPermission(); env.permission = env.requestResult; return env.requestResult; }),
    };
  }
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.fetch.push({ url, init });
    if (url === "/api/push/subscribe" && (!init || !init.method || init.method === "GET")) {
      return new Response(JSON.stringify({ configured: env.configured, publicKey: env.configured ? PUBLIC_KEY : null }), { status: 200 });
    }
    if (url === "/api/push/subscribe") {
      const next = env.subscribeQueue.shift();
      if (next) return new Response(JSON.stringify(next.body), { status: next.status });
      return new Response(JSON.stringify(env.subscribeResult === 200 ? { ok: true } : { error: "Device notifications need a database update that has not been applied yet (20260804_push_subscriptions.sql). Nothing was changed." }), { status: env.subscribeResult });
    }
    if (url === "/api/push/unsubscribe") return new Response(JSON.stringify({ ok: true, removed: 1 }), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
  return reg;
}
function uninstallBrowser() {
  try { delete (navigator as unknown as Record<string, unknown>).serviceWorker; } catch { /* jsdom */ }
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
  delete (window as unknown as Record<string, unknown>).PushManager;
  delete (window as unknown as Record<string, unknown>).Notification;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  db.prefRow = null; db.prefError = null; db.subRow = null; db.upserts.length = 0;
  env.permission = "default"; env.requestResult = "granted"; env.existing = null; env.configured = true; env.subscribeResult = 200; env.subscribeQueue = [];
  calls.requestPermission.mockClear(); calls.subscribe.mockClear(); calls.fetch.length = 0;
  window.localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  uninstallBrowser();
  vi.unstubAllGlobals();
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = async (props = { uid: "u1", orgId: "o1" }) => {
  await act(async () => { root.render(React.createElement(PushOptIn, props)); });
  await flush();
};
const button = (text: RegExp) => [...host.querySelectorAll("button")].find((b) => text.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
const click = async (el: HTMLElement | undefined) => {
  expect(el, "control present").toBeTruthy();
  await act(async () => { el!.click(); });
  await flush();
};
const deviceState = () => host.querySelector("[data-push-device]")?.getAttribute("data-push-device");
const pushSwitch = () => host.querySelector('[role="switch"][aria-label="Device notifications"]') as HTMLButtonElement | null;

describe("OS-3 — the permission prompt is reached only by a deliberate click, after the card says what will be sent", () => {
  it("on load nothing asks: no requestPermission, no subscribe; the card offers 'Turn on notifications for this device'", async () => {
    installBrowser();
    await mount();
    expect(deviceState()).toBe("off");
    expect(calls.requestPermission).not.toHaveBeenCalled();
    expect(calls.subscribe).not.toHaveBeenCalled();
    expect(button(/Turn on notifications for this device/)).toBeTruthy();
  });

  it("the first click explains what will be sent — only what is pushed today, what is not sent to devices yet, and that the notification names nothing — and still asks nothing", async () => {
    installBrowser();
    await mount();
    await click(button(/Turn on notifications for this device/));
    const panel = host.querySelector("[data-push-explain]")!;
    expect(panel).toBeTruthy();
    for (const line of PUSH_WHAT_IS_SENT) expect(panel.textContent).toContain(line);
    expect(panel.textContent).toContain(PUSH_NOT_YET_NOTE);
    expect(panel.textContent).toContain(PUSH_PRIVACY_NOTE);
    expect(panel.textContent).toMatch(/Your browser will ask for permission next/);
    expect(calls.requestPermission).not.toHaveBeenCalled();
    // major 3: no line promises a request mention or assignment (never pushed — OS-14)
    expect(panel.querySelectorAll("li")).toHaveLength(PUSH_SENT_TODAY.length);
    for (const li of panel.querySelectorAll("li")) expect(li.textContent).not.toMatch(/mention|assigned/i);
    expect(PUSH_WHAT_IS_SENT).toEqual(PUSH_SENT_TODAY.map((l) => l.line));
    expect(PUSH_WHAT_IS_SENT).toHaveLength(4);
  });

  it("major 3: the card's two lists split the push-worthy set exactly — each listed kind has an emit() producer, and each 'not yet' kind has none (when OS-14 lands, this fails until the line moves)", () => {
    const pushWorthy = NOTIFICATION_KINDS.filter((k) => (KIND_META[k] as { pushWorthy?: boolean }).pushWorthy).sort();
    const today = PUSH_SENT_TODAY.map((l) => l.pushKind);
    expect([...today, ...PUSH_NOT_SENT_YET].sort()).toEqual(pushWorthy);
    expect(today.filter((k) => PUSH_NOT_SENT_YET.includes(k))).toEqual([]);
    // the emit() producers, read from source: an `emit({ … kind: "<k>" …` call
    const root = process.cwd();
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "__tests__" && !n.startsWith(".")) walk(p); }
        else if (/\.tsx?$/.test(n) && !n.endsWith(".d.ts")) files.push(p);
      }
    };
    for (const d of ["app", "components", "lib", "hooks"]) walk(join(root, d));
    const emitKinds = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bemit\(\{[\s\S]{0,600}?\bkind:\s*(?:input\.opened \? )?"(\w+)"/g)) emitKinds.add(m[1]);
    }
    for (const k of today) expect(emitKinds.has(k), `${k} has an emit() producer`).toBe(true);
    for (const k of PUSH_NOT_SENT_YET) expect(emitKinds.has(k), `${k} has no emit() producer yet (OS-14)`).toBe(false);
  });

  // Fix pass 2 (the second review's minor): an emit() is pushed only from the BROWSER (its push leg POSTs
  // /api/push/notify) or from a server caller that passes serverPush — and no server caller passes it today.
  // So "has an emit() producer" is not enough: hold_opened is also emitted by the cron's scanStaleHolds,
  // which never pushes. Each line the card promises is pinned to its producer, the function its emit()
  // sits in, and the browser modules that call it — a producer moved behind a server route fails here.
  it("fix pass 2: each kind the card says is pushed today is emitted by a producer that browser modules call (a server emit pushes nothing without serverPush)", () => {
    const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const isClient = (f: string) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(src(f));
    /** a top-level function's text: from `function <name>(` to the first line that is only "}" */
    const fnBody = (f: string, name: string) => {
      const text = src(f);
      const at = text.search(new RegExp(`\\bfunction ${name}\\(`));
      expect(at, `${f}: function ${name}`).toBeGreaterThanOrEqual(0);
      const end = text.indexOf("\n}\n", at);
      return text.slice(at, end < 0 ? undefined : end);
    };
    const emitsKind = (text: string, k: string) =>
      new RegExp(`\\bemit\\(\\{[\\s\\S]{0,600}?\\bkind:\\s*(?:input\\.opened \\? )?"${k}"`).test(text);
    const PRODUCERS: Array<{ pushKind: string; file: string; emitIn: string | null; entry: string | null; module: string | null; callers: string[] }> = [
      { pushKind: "hold_opened", file: "lib/holds.ts", emitIn: "notifyHoldChange", entry: "openHold", module: "@/lib/holds",
        callers: ["components/documents/HoldStrip.tsx", "components/documents/CheckInPanel.tsx"] },
      { pushKind: "checkout_force_released", file: "lib/checkoutEpisodes.ts", emitIn: "forceReleaseDocument", entry: "forceReleaseDocument", module: "@/lib/checkoutEpisodes",
        callers: ["components/documents/CheckoutStatusCell.tsx", "app/(protected)/documents/[libraryId]/page.tsx"] },
      { pushKind: "ack_requested", file: "lib/distributionAcks.ts", emitIn: "requestAcks", entry: "requestAcks", module: "@/lib/distributionAcks",
        callers: ["components/documents/DistributionAcks.tsx", "components/documents/DistributionRecall.tsx"] },
      // the browser module is the producer itself
      { pushKind: "review_requested", file: "components/documents/CheckInPanel.tsx", emitIn: null, entry: null, module: null, callers: [] },
    ];
    expect(PRODUCERS.map((p) => p.pushKind).sort()).toEqual(PUSH_SENT_TODAY.map((l) => l.pushKind).sort());
    for (const p of PRODUCERS) {
      if (!p.emitIn) {
        expect(isClient(p.file), `${p.file} is a browser module`).toBe(true);
        expect(emitsKind(src(p.file), p.pushKind), `${p.file} emits ${p.pushKind}`).toBe(true);
        continue;
      }
      const body = fnBody(p.file, p.emitIn);
      expect(emitsKind(body, p.pushKind), `${p.emitIn} emits ${p.pushKind}`).toBe(true);
      if (p.entry !== p.emitIn) expect(fnBody(p.file, p.entry!), `${p.entry} calls ${p.emitIn}`).toMatch(new RegExp(`\\b${p.emitIn}\\(`));
      expect(p.callers.length).toBeGreaterThan(0);
      for (const c of p.callers) {
        expect(isClient(c), `${c} is a browser module`).toBe(true);
        const text = src(c);
        expect(text, `${c} imports ${p.entry} from ${p.module}`).toMatch(new RegExp(`import \\{[^}]*\\b${p.entry}\\b[^}]*\\} from "${p.module!.replace(/[/]/g, "\\/")}"`));
        expect(text, `${c} calls ${p.entry}`).toMatch(new RegExp(`\\b${p.entry}\\(`));
      }
    }
  });

  it("acceptance 1: 'Allow notifications' → the browser's dialog → subscribe({ userVisibleOnly: true, applicationServerKey }) from serviceWorker.ready → the device POSTed → 'On for this device'", async () => {
    installBrowser();
    await mount();
    await click(button(/Turn on notifications for this device/));
    await click(button(/Allow notifications/));
    expect(calls.requestPermission).toHaveBeenCalledTimes(1);
    expect(calls.subscribe).toHaveBeenCalledTimes(1);
    const opts = calls.subscribe.mock.calls[0][0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(opts.userVisibleOnly).toBe(true);
    expect([...opts.applicationServerKey]).toEqual([...urlBase64ToUint8Array(PUBLIC_KEY)]);
    expect(opts.applicationServerKey).toHaveLength(65);
    const post = calls.fetch.find((f) => f.url === "/api/push/subscribe" && f.init?.method === "POST")!;
    expect((post.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(post.init!.body))).toEqual({
      orgId: "o1",
      subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/device-1", keys: { p256dh: "p256dh-key", auth: "auth-key" } },
    });
    expect(deviceState()).toBe("on");
    expect(host.textContent).toMatch(/On for this device/);
  });

  it("a server that refuses the device (20260804 not applied) says why, and the browser's subscription is taken back", async () => {
    installBrowser();
    env.subscribeResult = 503;
    await mount();
    await click(button(/Turn on notifications for this device/));
    await click(button(/Allow notifications/));
    expect(deviceState()).toBe("off");
    expect(host.textContent).toMatch(/20260804_push_subscriptions\.sql/);
    expect(env.existing!.unsubscribe).toHaveBeenCalled();
  });

  it("minor: a subscription that existed BEFORE the click (another person's, on a shared browser) is never taken back when registration fails", async () => {
    installBrowser();
    env.permission = "granted";
    const theirs = makeSub("https://fcm.googleapis.com/fcm/send/shared-pc");
    env.existing = theirs;
    db.subRow = null; // not this member's row → the card reads "off"
    env.subscribeResult = 500;
    await mount();
    expect(deviceState()).toBe("off");
    await click(button(/Turn on notifications for this device/));
    await click(button(/Allow notifications/));
    expect(deviceState()).toBe("off");
    expect(calls.subscribe).not.toHaveBeenCalled();
    expect(theirs.unsubscribe).not.toHaveBeenCalled();
  });

  it("minor: an endpoint the server holds under other keys (409 keys_mismatch) gets ONE fresh subscription, then registers", async () => {
    installBrowser();
    env.permission = "granted";
    const stale = makeSub("https://fcm.googleapis.com/fcm/send/stale");
    env.existing = stale;
    env.subscribeQueue = [{ status: 409, body: { error: "This browser's notification registration could not be confirmed", code: PUSH_KEYS_MISMATCH } }];
    await mount();
    await click(button(/Turn on notifications for this device/));
    await click(button(/Allow notifications/));
    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    expect(calls.subscribe).toHaveBeenCalledTimes(1);
    const posts = calls.fetch.filter((f) => f.url === "/api/push/subscribe" && f.init?.method === "POST");
    expect(posts.map((p) => JSON.parse(String(p.init!.body)).subscription.endpoint)).toEqual([
      "https://fcm.googleapis.com/fcm/send/stale", "https://fcm.googleapis.com/fcm/send/device-1",
    ]);
    expect(deviceState()).toBe("on");
  });

  it("'Not now' is recorded (this account, this workspace) and the card stops inviting — the browser was never asked", async () => {
    installBrowser();
    await mount();
    await click(button(/Turn on notifications for this device/));
    await click(button(/Not now/));
    expect(calls.requestPermission).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(`dismissed:u1:o1:${PUSH_DECLINE_KEY}`)).toBe("1");
    expect(host.textContent).toMatch(/You chose not to turn on notifications for this device\. The app will not ask again\./);
    // remount: still recorded
    act(() => root.unmount());
    root = createRoot(host);
    await mount();
    expect(host.textContent).toMatch(/You chose not to turn on notifications for this device/);
  });

  it("the browser's dialog answered Block: the decline is recorded and the card shows how to unblock, not a dead control", async () => {
    installBrowser();
    env.requestResult = "denied";
    await mount();
    await click(button(/Turn on notifications for this device/));
    await click(button(/Allow notifications/));
    expect(deviceState()).toBe("denied");
    expect(host.textContent).toContain(PUSH_DENIED_TEXT);
    expect(button(/Turn on notifications for this device/)).toBeUndefined();
    expect(window.localStorage.getItem(`dismissed:u1:o1:${PUSH_DECLINE_KEY}`)).toBe("1");
    expect(calls.subscribe).not.toHaveBeenCalled();
  });

  it("dw4: a site already blocked renders the explanatory state on load", async () => {
    installBrowser();
    env.permission = "denied";
    await mount();
    expect(deviceState()).toBe("denied");
    expect(host.textContent).toContain(PUSH_DENIED_TEXT);
    expect(button(/Turn on notifications/)).toBeUndefined();
  });

  it("a browser without push, or a server without VAPID keys, gets a sentence — no control, nothing asked", async () => {
    installBrowser(false);
    await mount();
    expect(deviceState()).toBe("unsupported");
    expect(host.textContent).toContain(PUSH_UNSUPPORTED_TEXT);
    expect(calls.fetch).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(host);
    installBrowser();
    env.configured = false;
    await mount();
    expect(deviceState()).toBe("unconfigured");
    expect(host.textContent).toContain(PUSH_UNCONFIGURED_TEXT);
    expect(button(/Turn on notifications/)).toBeUndefined();
  });
});

describe("this device, on and off", () => {
  it("a device already on (its subscription made with this key, the row ours) loads as on; 'Turn off' unsubscribes and removes the row", async () => {
    installBrowser();
    env.permission = "granted";
    env.existing = makeSub("https://push.example/mine");
    db.subRow = { id: "s1", created_at: new Date().toISOString() };
    await mount();
    expect(deviceState()).toBe("on");
    const sub = env.existing;
    await click(button(/Turn off for this device/));
    expect(sub.unsubscribe).toHaveBeenCalled();
    const off = calls.fetch.find((f) => f.url === "/api/push/unsubscribe")!;
    expect(JSON.parse(String(off.init!.body))).toEqual({ endpoint: "https://push.example/mine" });
    expect(deviceState()).toBe("off");
  });

  it("a row from before the opt-in control (the deleted reminders stack's) does not count as on — the person turns the device on again", async () => {
    installBrowser();
    env.permission = "granted";
    env.existing = makeSub("https://push.example/reminders-era");
    db.subRow = { id: "s-legacy", created_at: "2026-08-04T09:00:00Z" };
    await mount();
    expect(deviceState()).toBe("off");
    expect(button(/Turn on notifications for this device/)).toBeTruthy();
  });

  it("a subscription made with another key (the server's key rotated) reads as off, and turning on replaces it", async () => {
    installBrowser();
    env.permission = "granted";
    const stale = makeSub("https://push.example/old", new Uint8Array(65).fill(7));
    env.existing = stale;
    db.subRow = { id: "s-old", created_at: new Date().toISOString() };
    await mount();
    expect(deviceState()).toBe("off");
    await click(button(/Turn on notifications for this device/));
    await click(button(/Allow notifications/));
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(calls.subscribe).toHaveBeenCalledTimes(1);
    expect(deviceState()).toBe("on");
  });
});

describe("OS-10 done-when 2 — push_enabled is a real control, saved alone", () => {
  it("reflects the stored value and saves ONLY push_enabled for this user (no other column)", async () => {
    installBrowser(false);
    db.prefRow = { push_enabled: false, email_enabled: false };
    await mount();
    expect(pushSwitch()!.getAttribute("aria-checked")).toBe("false");
    await click(pushSwitch()!);
    expect(db.upserts).toEqual([{ table: "notification_preferences", row: { user_id: "u1", push_enabled: true }, opts: { onConflict: "user_id" } }]);
    expect(pushSwitch()!.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toMatch(/Saved/);
  });

  it("no row reads as the column default (on); an unreadable setting disables the switch instead of guessing", async () => {
    installBrowser(false);
    await mount();
    expect(pushSwitch()!.getAttribute("aria-checked")).toBe("true");
    act(() => root.unmount());
    root = createRoot(host);
    db.prefError = { message: "permission denied" };
    await mount();
    expect(pushSwitch()!.disabled).toBe(true);
    expect(host.textContent).toMatch(/could not be read/);
    await click(pushSwitch()!);
    expect(db.upserts).toHaveLength(0);
  });
});
