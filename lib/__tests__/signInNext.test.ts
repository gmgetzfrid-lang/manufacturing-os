// public-surfaces PHYS-14 (identity-and-session Round G, IS-P3) — the sign-in
// page honours `?next=` only as a same-origin relative path. The redirect
// decision (lib/signInNext.ts), pinned value by value: the equipment label's
// tag path is honoured end to end (assetSignInHref → URLSearchParams →
// safeNextPath), and every open-redirect shape — absolute URLs,
// protocol-relative (literal, or reached by dot-segment normalisation:
// "/..//evil.example" parses to the pathname "//evil.example"), backslash
// tricks, encoded and double-encoded forms, control characters,
// javascript: — falls back to /dashboard. The carry
// across the Microsoft round trip (sessionStorage) is honoured once, within
// its TTL, only on the provider's return (any other load discards it), and
// re-validated on read. The rendered page is driven in
// signInNextRendered.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  safeNextPath,
  signInDestination,
  stashSignInNext,
  takeStashedSignInNext,
  resolveSignInNext,
  isProviderReturn,
  SIGN_IN_DEFAULT_DESTINATION,
  SIGN_IN_NEXT_STASH_KEY,
  SIGN_IN_NEXT_STASH_TTL_MS,
} from "@/lib/signInNext";
import { assetSignInHref } from "@/lib/assetSignIn";

/** The value the sign-in page reads: `next` as URLSearchParams decodes it. */
const nextOf = (href: string) => new URL(href, "https://plant.example").searchParams.get("next");

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe("PHYS-14 — safeNextPath accepts a same-origin relative path, unchanged", () => {
  it.each([
    ["/assets/FE-201"],
    ["/assets/P%20101%2FA"],
    ["/assets/50%25"],
    ["/assets/A%231"],
    ["/dashboard"],
    ["/documents/lib-1?doc=abc"],
    ["/projects/p1#tasks"],
    // a colon past the first segment is a path character, not a scheme
    ["/assets/P%3A101"],
    ["/assets/P:101"],
    ["/projects/p1#x:y"],
    // a same-origin path whose query carries a URL is still that path
    ["/x?u=https://evil.example"],
    // dot segments and an inner "//" that stay on the origin
    ["/assets/../dashboard"],
    ["/assets//FE-201"],
  ])("%s", (p) => {
    expect(safeNextPath(p)).toBe(p);
    expect(signInDestination(p)).toBe(p);
  });

  it("a tag with a colon returns to its tag (assetSignInHref -> URLSearchParams -> safeNextPath)", () => {
    const p = safeNextPath(nextOf(assetSignInHref("P:101")));
    expect(p).toBe("/assets/P%3A101");
    expect(decodeURIComponent(p!.slice("/assets/".length))).toBe("P:101");
  });

  it("the equipment label's sign-in URL round-trips: name `next`, encoding, decoded value", () => {
    expect(nextOf(assetSignInHref("FE-201"))).toBe("/assets/FE-201");
    expect(safeNextPath(nextOf(assetSignInHref("FE-201")))).toBe("/assets/FE-201");
    // a tag that needs encoding arrives as the path the asset page decodes back to the tag
    const p = safeNextPath(nextOf(assetSignInHref("P 101/A")));
    expect(p).toBe("/assets/P%20101%2FA");
    expect(decodeURIComponent(p!.slice("/assets/".length))).toBe("P 101/A");
  });
});

describe("PHYS-14 — safeNextPath refuses every open-redirect shape (→ /dashboard)", () => {
  it.each([
    // absent / not a path
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["a number", 42],
    ["no leading slash", "dashboard"],
    ["leading space", " /assets/FE-201"],
    // absolute URLs
    ["https", "https://evil.example"],
    ["http with path", "http://evil.example/assets/FE-201"],
    ["upper-case scheme", "HTTPS://evil.example"],
    ["scheme, one slash", "https:/evil.example"],
    ["scheme, no slash", "https:evil.example"],
    // protocol-relative
    ["//", "//evil.example"],
    ["///", "///evil.example"],
    ["//// with path", "////evil.example/x"],
    // protocol-relative after the URL parser removes dot segments: each
    // parses to the pathname "//evil.example", the href the router keeps
    ["/..//", "/..//evil.example"],
    ["/.//", "/.//evil.example"],
    ["/assets/..//", "/assets/..//evil.example"],
    ["/a/b/../..//", "/a/b/../..//evil.example"],
    ["/%2e%2e//", "/%2e%2e//evil.example"],
    ["/%2E// with path", "/%2E//evil.example/x"],
    ["/%2e%2E// mixed case", "/%2e%2E//evil.example"],
    ["double-encoded dot segment", "/%252e%252e//evil.example"],
    ["dot segment then encoded slash", "/..%2F%2Fevil.example"],
    ["dot segment then backslash", "/..//\\evil.example"],
    // backslash tricks
    ["/\\", "/\\evil.example"],
    ["\\/", "\\/evil.example"],
    ["\\\\", "\\\\evil.example"],
    ["backslash later", "/assets\\..\\..\\evil"],
    // encoded forms
    ["%2F%2F (no leading slash)", "%2F%2Fevil.example"],
    ["/%2F (decodes to //)", "/%2Fevil.example"],
    ["/%2f lower-case", "/%2fevil.example"],
    ["/%5C (decodes to /\\)", "/%5Cevil.example"],
    ["/%5c lower-case", "/%5cevil.example"],
    ["double-encoded slash", "/%252Fevil.example"],
    ["double-encoded backslash", "/%255Cevil.example"],
    ["triple-encoded slash", "/%25252Fevil.example"],
    ["encoded scheme", "/%68ttps://evil.example"],
    ["encoded scheme colon", "/x%3A//evil.example"],
    ["malformed escape hiding %2F", "/%2Fevil.example%E0%A4%A"],
    ["still decoding past the bound", "/%2525252525252F"],
    // control characters a browser strips (tab / CR / LF)
    ["tab", "/\t/evil.example"],
    ["newline", "/\n/evil.example"],
    ["carriage return", "/\r/evil.example"],
    ["encoded tab", "/%09/evil.example"],
    ["encoded newline", "/%0A/evil.example"],
    ["NUL", "/\u0000/evil.example"],
    ["DEL", "/\u007f/evil.example"],
    // script and data schemes
    ["javascript:", "javascript:alert(document.cookie)"],
    ["JaVaScRiPt:", "JaVaScRiPt:alert(1)"],
    ["javascript: behind a slash", "/javascript:alert(1)"],
    ["encoded javascript:", "/%6Aavascript:alert(1)"],
    ["https: behind a slash", "/https://evil.example"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["vbscript:", "vbscript:msgbox(1)"],
    // the sign-in page itself
    ["/", "/"],
    ["/ with a query", "/?next=%2Fassets%2FFE-201"],
    ["/ with a hash", "/#x"],
    ["/.", "/."],
    ["/./", "/./"],
    ["/..", "/.."],
    ["/%2e", "/%2e"],
    ["/%2E%2E", "/%2E%2E"],
    ["/%3F (decodes to /?)", "/%3Fnext=x"],
  ])("%s", (_label, v) => {
    expect(safeNextPath(v)).toBeNull();
    expect(signInDestination(v)).toBe(SIGN_IN_DEFAULT_DESTINATION);
  });

  it("the default is exactly today's destination", () => {
    expect(SIGN_IN_DEFAULT_DESTINATION).toBe("/dashboard");
    expect(signInDestination(null)).toBe("/dashboard");
  });

  it("a hostile `next` read off a real sign-in URL is refused too", () => {
    for (const v of ["//evil.example", "https://evil.example", "/\\evil.example", "/%5Cevil.example", "javascript:alert(1)"]) {
      expect(signInDestination(nextOf(`/?next=${encodeURIComponent(v)}`)), v).toBe("/dashboard");
    }
    // un-encoded in the link: URLSearchParams decodes %2F%2F → // before the check
    expect(signInDestination(nextOf("/?next=%2F%2Fevil.example"))).toBe("/dashboard");
    expect(signInDestination(nextOf("/?next=/%5Cevil.example"))).toBe("/dashboard");
    // the dot-segment form, crafted into a label or link
    expect(signInDestination(nextOf("/?next=%2F..%2F%2Fevil.example"))).toBe("/dashboard");
  });

  it("whatever is accepted, the href the router keeps after parsing it stays on the origin", () => {
    // Next's app router resolves the value against the page and keeps
    // pathname + search + hash (createHrefFromUrl) for history / location.
    const ORIGIN = "https://plant.example";
    const routerHref = (v: string) => {
      const u = new URL(v, `${ORIGIN}/`);
      return u.pathname + u.search + u.hash;
    };
    const tokens = ["", ".", "..", "%2e", "%2E%2e", "%252e", "evil.example", "assets", "%2F", "%5C", "x:y", "?q", "#h"];
    let accepted = 0;
    let refused = 0;
    const walk = (prefix: string, depth: number) => {
      if (depth === 0) return;
      for (const t of tokens) {
        const v = `${prefix}/${t}`;
        const p = safeNextPath(v);
        if (p === null) refused++;
        else {
          accepted++;
          const href = routerHref(p);
          expect(href.startsWith("//"), v).toBe(false);
          expect(href.startsWith("/\\"), v).toBe(false);
          expect(new URL(href, `${ORIGIN}/`).origin, v).toBe(ORIGIN);
          expect(new URL(href, `${ORIGIN}/`).pathname, v).not.toBe("/");
        }
        walk(v, depth - 1);
      }
    };
    walk("", 4);
    // 30,940 paths (6,333 accepted and 24,607 refused when this landed)
    expect(accepted + refused).toBe(30940);
    expect(accepted).toBeGreaterThan(6000);
    expect(refused).toBeGreaterThan(24000);
  });
});

describe("PHYS-14 — the carry across the Microsoft round trip", () => {
  const T0 = Date.parse("2026-10-02T08:00:00Z");

  it("stash then take: honoured once, then gone", () => {
    const st = memoryStore();
    stashSignInNext("/assets/FE-201", st, T0);
    expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(true);
    expect(takeStashedSignInNext(st, T0 + 5_000)).toBe("/assets/FE-201");
    expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(false);
    expect(takeStashedSignInNext(st, T0 + 6_000)).toBeNull();
  });

  it("a hostile or absent `next` is never stashed, and clears an earlier one", () => {
    const st = memoryStore();
    stashSignInNext("//evil.example", st, T0);
    expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(false);
    stashSignInNext("/assets/FE-201", st, T0);
    stashSignInNext(null, st, T0);
    expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(false);
  });

  it("expires after the TTL (removed either way), and a future stamp is refused", () => {
    const st = memoryStore();
    stashSignInNext("/assets/FE-201", st, T0);
    expect(takeStashedSignInNext(st, T0 + SIGN_IN_NEXT_STASH_TTL_MS + 1)).toBeNull();
    expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(false);
    stashSignInNext("/assets/FE-201", st, T0);
    expect(takeStashedSignInNext(st, T0 + SIGN_IN_NEXT_STASH_TTL_MS)).toBe("/assets/FE-201");
    stashSignInNext("/assets/FE-201", st, T0);
    expect(takeStashedSignInNext(st, T0 - 1)).toBeNull();
  });

  it("a tampered stash is re-validated on read", () => {
    for (const raw of [
      JSON.stringify({ path: "//evil.example", at: T0 }),
      JSON.stringify({ path: "https://evil.example", at: T0 }),
      JSON.stringify({ path: "/assets/FE-201" }),
      JSON.stringify({ path: "/assets/FE-201", at: "now" }),
      "/assets/FE-201",
      "{not json",
    ]) {
      const st = memoryStore({ [SIGN_IN_NEXT_STASH_KEY]: raw });
      expect(takeStashedSignInNext(st, T0), raw).toBeNull();
      expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(false);
    }
  });

  it("storage that throws or is missing never throws out — the default applies", () => {
    const throwing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceeded"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    expect(() => stashSignInNext("/assets/FE-201", throwing, T0)).not.toThrow();
    expect(takeStashedSignInNext(throwing, T0)).toBeNull();
    expect(() => stashSignInNext("/assets/FE-201", null, T0)).not.toThrow();
    expect(takeStashedSignInNext(null, T0)).toBeNull();
    // node has no window: the default store is null
    expect(takeStashedSignInNext()).toBeNull();
  });

  it("resolveSignInNext: the URL's `next` wins (safe or refused); else, on the provider's return, the carried one; the stash is consumed either way", () => {
    const st = memoryStore();
    stashSignInNext("/assets/FE-201", st, T0);
    expect(resolveSignInNext("?next=%2Fassets%2FP-101", st, { providerReturn: false, now: T0 })).toBe("/assets/P-101");
    expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(false);

    stashSignInNext("/assets/FE-201", st, T0);
    expect(resolveSignInNext(`?next=${encodeURIComponent("//evil.example")}`, st, { providerReturn: true, now: T0 })).toBeNull(); // never falls through to the stash
    expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(false);

    stashSignInNext("/assets/FE-201", st, T0);
    expect(resolveSignInNext("?code=abc", st, { providerReturn: true, now: T0 + 2_000 })).toBe("/assets/FE-201");
    expect(resolveSignInNext("", st, { providerReturn: true, now: T0 + 3_000 })).toBeNull();
    expect(resolveSignInNext("?error=login_required", memoryStore(), { providerReturn: true, now: T0 })).toBeNull();
  });

  it("resolveSignInNext: a load that is not the provider's return discards the carry — null, and the stash removed", () => {
    const st = memoryStore();
    stashSignInNext("/assets/P-101", st, T0);
    expect(resolveSignInNext("", st, { providerReturn: false, now: T0 + 2_000 })).toBeNull();
    expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(false);
    // the same carry, read on the provider's return, is honoured
    stashSignInNext("/assets/P-101", st, T0);
    expect(resolveSignInNext("", st, { providerReturn: true, now: T0 + 2_000 })).toBe("/assets/P-101");
    // with the default clock (Date.now), as the page calls it
    stashSignInNext("/assets/P-101", st);
    expect(resolveSignInNext("", st, { providerReturn: false })).toBeNull();
    expect(st.m.has(SIGN_IN_NEXT_STASH_KEY)).toBe(false);
  });

  it("isProviderReturn: `?code=`, `#access_token` or a non-empty `?error=` — the page's own reading", () => {
    expect(isProviderReturn("?code=abc123", "")).toBe(true);
    expect(isProviderReturn("", "#access_token=tok&refresh_token=r")).toBe(true);
    expect(isProviderReturn("?error=login_required&error_description=Login+required", "")).toBe(true);
    expect(isProviderReturn("?error=access_denied&error_code=x", "#error=access_denied")).toBe(true);
    expect(isProviderReturn("", "")).toBe(false);
    expect(isProviderReturn("?next=%2Fassets%2FP-101", "")).toBe(false);
    expect(isProviderReturn("?error=", "")).toBe(false);
    expect(isProviderReturn("", "#")).toBe(false);
    expect(isProviderReturn("", "#tasks")).toBe(false);
  });
});

describe("PHYS-14 — app/page.tsx routes every success path through the decision", () => {
  const page = readFileSync(join(process.cwd(), "app/page.tsx"), "utf8");
  it("no hard-coded /dashboard redirect is left; the three success paths use signInDestination", () => {
    expect(page).not.toMatch(/router\.(replace|push)\(\s*['"]\/dashboard['"]\s*\)/);
    // a session found on load / SIGNED_IN (routeAuthedUser), and the password sign-in
    expect(page).toContain("router.replace(signInDestination(nextRef.current));");
    expect(page).toContain("router.push(signInDestination(nextRef.current));");
    // read once per page load; carried across the Microsoft round trip, and
    // picked up only on the provider's return (`?code=`, `#access_token`, `?error=`)
    // — the address as the module loaded (before supabase-js can strip it) or as the effect reads it
    expect(page).toMatch(/let providerReturnAtLoad =\s*typeof window !== "undefined" &&\s*window\.location\.pathname === "\/" &&\s*isProviderReturn\(window\.location\.search, window\.location\.hash\);/);
    expect(page).toMatch(/if \(nextRef\.current === undefined\) \{\s*const atLoad = takeProviderReturnAtLoad\(\);\s*const providerReturn = atLoad \|\| isProviderReturn\(params, hash\);\s*nextRef\.current = resolveSignInNext\(params, undefined, \{ providerReturn \}\);\s*\}/);
    expect(page).toContain("stashSignInNext(nextRef.current);");
  });
  it("the carry is cleared on every way out: a flow that could not start, routeAuthedUser, a password success", () => {
    expect(page.match(/stashSignInNext\(null\);/g)).toHaveLength(3);
    const route = page.slice(page.indexOf("const routeAuthedUser = useCallback("), page.indexOf("router.replace(signInDestination(nextRef.current));"));
    expect(route).toContain("stashSignInNext(null);");
    expect(page).toMatch(/\} else \{\s*stashSignInNext\(null\);\s*router\.push\(signInDestination\(nextRef\.current\)\);/);
  });
  it("the Microsoft redirectTo is unchanged (the provider allow-list sees the same URL)", () => {
    expect(page).toContain("redirectTo: `${window.location.origin}/`,");
  });
});
