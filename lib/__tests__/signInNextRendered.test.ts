// @vitest-environment jsdom
//
// public-surfaces PHYS-14 (identity-and-session Round G, IS-P3) — RENDERED.
// A scanned equipment label sends a no-session scan to
// `/?next=%2Fassets%2F<tag>` (lib/assetSignIn.ts, PS-VERIFY). This renders
// the real sign-in page (app/page.tsx) with Supabase and the router stubbed
// and drives every sign-in path that ends in a redirect:
//   * a session found on load (an already-signed-in visitor),
//   * email / password,
//   * Microsoft — the explicit button and the silent (prompt=none) attempt —
//     across the OAuth round trip (the page navigates away and a NEW page
//     load comes back at `/` with the provider's response).
// Each lands on a same-origin relative `next` when one was carried, and on
// exactly today's destination (/dashboard) when none was — or when the one
// carried is not a safe same-origin path (no open redirect).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Listener = (event: string, session: unknown) => void;
type FakeSession = { user: { id: string; email: string; app_metadata: Record<string, unknown> } };

const s = vi.hoisted(() => {
  const replace = vi.fn();
  const push = vi.fn();
  return {
    // a stable router, as next/navigation's is
    router: { replace, push },
    replace,
    push,
    session: null as FakeSession | null,
    listeners: [] as Listener[],
    prefersMs: false,
    signInWithPassword: vi.fn(),
    signInWithOAuth: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => s.router }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: s.session }, error: null }),
      onAuthStateChange: (cb: Listener) => {
        s.listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => { s.listeners = s.listeners.filter((l) => l !== cb); } } } };
      },
      signInWithPassword: (...a: unknown[]) => s.signInWithPassword(...a),
      signInWithOAuth: (...a: unknown[]) => s.signInWithOAuth(...a),
    },
    from: () => ({ upsert: async () => ({ error: null }) }),
  },
  setRememberSession: () => {},
  setPreferMicrosoft: () => {},
  prefersMicrosoft: () => s.prefersMs,
}));

import LoginPage from "@/app/page";
import { assetSignInHref } from "@/lib/assetSignIn";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER: FakeSession = { user: { id: "u1", email: "Pat@Plant.example", app_metadata: {} } };
const TAG_PATH = "/assets/FE-201";
const withNext = (v: string) => `/?next=${encodeURIComponent(v)}`;

let host: HTMLDivElement;
let root: Root | null = null;

const flush = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

/** Open the sign-in page at `url` (a fresh page load). */
async function open(url: string) {
  if (root) await close();
  window.history.replaceState({}, "", url);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(LoginPage)); });
  await flush();
}

/** Leave the page (the browser navigating away to Microsoft, or a reload). */
async function close() {
  const r = root;
  root = null;
  if (r) act(() => r.unmount());
  host.remove();
}

function setInput(type: "email" | "password", value: string) {
  const input = host.querySelector(`input[type="${type}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function signInWithPassword() {
  await act(async () => { setInput("email", "pat@plant.example"); setInput("password", "pw-123456"); });
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function clickMicrosoft() {
  const btn = [...host.querySelectorAll("button")].find((b) => /Sign in with Microsoft/.test(b.textContent ?? ""))!;
  await act(async () => { btn.click(); });
  await flush();
}

/** Microsoft comes back: a NEW page load at `/` carrying the provider's
 *  response (implicit flow: the token in the hash), the session established. */
async function returnFromMicrosoft(response = "/#access_token=tok&refresh_token=r&expires_in=3600&token_type=bearer") {
  await close();
  s.session = USER;
  await open(response);
}

const landed = () => s.replace.mock.calls.map((c) => c[0]);
const pushed = () => s.push.mock.calls.map((c) => c[0]);

beforeEach(() => {
  s.replace.mockReset();
  s.push.mockReset();
  s.session = null;
  s.listeners = [];
  s.prefersMs = false;
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
  s.signInWithPassword.mockReset().mockImplementation(async () => {
    s.session = USER;
    for (const l of [...s.listeners]) l("SIGNED_IN", USER);
    return { data: { session: USER }, error: null };
  });
  // On success the browser navigates away; the promise resolves without error.
  s.signInWithOAuth.mockReset().mockResolvedValue({ data: {}, error: null });
});
afterEach(async () => {
  if (root) await close();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("PHYS-14 (rendered) — an already-signed-in visitor", () => {
  it("REGRESSION: no `next` → /dashboard, exactly as before", async () => {
    s.session = USER;
    await open("/");
    expect(landed()).toEqual(["/dashboard"]);
    expect(pushed()).toEqual([]);
  });

  it("the equipment label's sign-in URL (assetSignInHref) returns to the tag", async () => {
    s.session = USER;
    await open(assetSignInHref("FE-201"));
    expect(landed()).toEqual([TAG_PATH]);
  });

  it("a tag that needed encoding arrives as the path the asset page decodes", async () => {
    s.session = USER;
    await open(assetSignInHref("P 101/A"));
    expect(landed()).toEqual(["/assets/P%20101%2FA"]);
  });

  it.each([
    ["absolute https", "https://evil.example/assets/FE-201"],
    ["absolute http", "http://evil.example"],
    ["protocol-relative", "//evil.example/x"],
    ["triple slash", "///evil.example"],
    ["slash-backslash", "/\\evil.example"],
    ["encoded backslash", "/%5Cevil.example"],
    ["encoded double slash", "/%2F%2Fevil.example"],
    ["tab trick", "/\t/evil.example"],
    ["javascript:", "javascript:alert(document.cookie)"],
    ["no leading slash", "dashboard"],
    ["the sign-in page itself", "/"],
    ["the sign-in page with its own next", "/?next=%2Fassets%2FFE-201"],
  ])("a hostile or self-pointing `next` (%s) falls back to /dashboard", async (_label, next) => {
    s.session = USER;
    await open(withNext(next));
    expect(landed()).toEqual(["/dashboard"]);
  });
});

describe("PHYS-14 (rendered) — email / password", () => {
  it("REGRESSION: no `next` → /dashboard on both the push and the SIGNED_IN route, as before", async () => {
    await open("/");
    expect(host.querySelector("form")).not.toBeNull();
    await signInWithPassword();
    expect(s.signInWithPassword).toHaveBeenCalledWith({ email: "pat@plant.example", password: "pw-123456" });
    expect(pushed()).toEqual(["/dashboard"]);
    expect(landed()).toEqual(["/dashboard"]);
  });

  it("a scan's `next` → back to the tag", async () => {
    await open(assetSignInHref("FE-201"));
    await signInWithPassword();
    expect(pushed()).toEqual([TAG_PATH]);
    expect(landed()).toEqual([TAG_PATH]);
  });

  it.each([
    ["protocol-relative", "//evil.example"],
    ["absolute", "https://evil.example"],
    ["slash-backslash", "/\\evil.example"],
  ])("a hostile `next` (%s) → /dashboard", async (_label, next) => {
    await open(withNext(next));
    await signInWithPassword();
    expect(pushed()).toEqual(["/dashboard"]);
    expect(landed()).toEqual(["/dashboard"]);
  });

  it("a failed sign-in navigates nowhere", async () => {
    s.signInWithPassword.mockReset().mockResolvedValue({ data: {}, error: { message: "Invalid login credentials" } });
    await open(assetSignInHref("FE-201"));
    await signInWithPassword();
    expect(pushed()).toEqual([]);
    expect(landed()).toEqual([]);
    expect(host.textContent).toContain("Invalid email or password.");
  });
});

describe("PHYS-14 (rendered) — Microsoft: `next` survives the OAuth round trip", () => {
  it("the button: redirectTo is unchanged, and the return lands on the tag", async () => {
    await open(assetSignInHref("FE-201"));
    await clickMicrosoft();
    expect(s.signInWithOAuth).toHaveBeenCalledTimes(1);
    const arg = s.signInWithOAuth.mock.calls[0][0] as { provider: string; options: { redirectTo: string; queryParams?: unknown } };
    expect(arg.provider).toBe("azure");
    // the provider allow-list sees exactly the URL it saw before
    expect(arg.options.redirectTo).toBe(`${window.location.origin}/`);
    expect(arg.options.queryParams).toBeUndefined();
    await returnFromMicrosoft();
    expect(landed()).toEqual([TAG_PATH]);
  });

  it("a PKCE-shaped return (?code=) lands on the tag too", async () => {
    await open(assetSignInHref("FE-201"));
    await clickMicrosoft();
    await returnFromMicrosoft("/?code=abc123");
    expect(landed()).toEqual([TAG_PATH]);
  });

  it("the return is honoured once: a later visit with no `next` goes to /dashboard", async () => {
    await open(assetSignInHref("FE-201"));
    await clickMicrosoft();
    await returnFromMicrosoft();
    expect(landed()).toEqual([TAG_PATH]);
    s.replace.mockReset();
    await close();
    await open("/");
    expect(landed()).toEqual(["/dashboard"]);
  });

  it("REGRESSION: no `next` → the return lands on /dashboard", async () => {
    await open("/");
    await clickMicrosoft();
    expect((s.signInWithOAuth.mock.calls[0][0] as { options: { redirectTo: string } }).options.redirectTo).toBe(`${window.location.origin}/`);
    await returnFromMicrosoft();
    expect(landed()).toEqual(["/dashboard"]);
  });

  it("a hostile `next` is never carried: the return lands on /dashboard", async () => {
    await open(withNext("//evil.example"));
    await clickMicrosoft();
    await returnFromMicrosoft();
    expect(landed()).toEqual(["/dashboard"]);
  });

  it("an earlier, abandoned round trip's `next` expires (10 minutes)", async () => {
    const t0 = Date.parse("2026-10-02T08:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await open(assetSignInHref("FE-201"));
    await clickMicrosoft();
    now.mockReturnValue(t0 + 11 * 60 * 1000);
    await returnFromMicrosoft();
    expect(landed()).toEqual(["/dashboard"]);
  });

  it("a Microsoft sign-in that could not start carries nothing forward", async () => {
    s.signInWithOAuth.mockReset().mockResolvedValue({ data: {}, error: { message: "provider down" } });
    await open(assetSignInHref("FE-201"));
    await clickMicrosoft();
    expect(host.textContent).toContain("Couldn't start Microsoft sign-in.");
    await close();
    s.session = USER;
    await open("/");
    expect(landed()).toEqual(["/dashboard"]);
  });

  it("the silent (prompt=none) attempt carries `next` and the return lands on the tag", async () => {
    s.prefersMs = true;
    await open(assetSignInHref("FE-201"));
    expect(s.signInWithOAuth).toHaveBeenCalledTimes(1);
    const arg = s.signInWithOAuth.mock.calls[0][0] as { options: { redirectTo: string; queryParams?: unknown } };
    expect(arg.options.queryParams).toEqual({ prompt: "none" });
    expect(arg.options.redirectTo).toBe(`${window.location.origin}/`);
    await returnFromMicrosoft();
    expect(landed()).toEqual([TAG_PATH]);
  });

  it("a silent attempt that needs interaction keeps `next` for the form (and in the address)", async () => {
    s.prefersMs = true;
    await open(assetSignInHref("FE-201"));
    expect(s.signInWithOAuth).toHaveBeenCalledTimes(1);
    await close();
    // Microsoft answers login_required: no session, back on the form
    await open("/?error=login_required&error_description=Login+required");
    expect(host.querySelector("form")).not.toBeNull();
    expect(host.textContent).not.toContain("Access Denied");
    expect(`${window.location.pathname}${window.location.search}`).toBe(withNext(TAG_PATH));
    await signInWithPassword();
    expect(pushed()).toEqual([TAG_PATH]);
    expect(landed()).toEqual([TAG_PATH]);
  });

  it("REGRESSION: a silent attempt with no `next` that needs interaction cleans the address to / as before", async () => {
    s.prefersMs = true;
    await open("/");
    await close();
    await open("/?error=login_required&error_description=Login+required");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/");
    await signInWithPassword();
    expect(pushed()).toEqual(["/dashboard"]);
  });
});
