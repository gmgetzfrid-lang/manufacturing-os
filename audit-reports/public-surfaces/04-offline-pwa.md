# 04 · Offline, the service worker & the field device

**14 findings** — 1 CRITICAL · 1 HIGH · 12 MEDIUM.

The core document-control risk of caching: a superseded drawing served from disk.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| The RSC-payload bypass is correct and well-reasoned — the worker does not intercept `_rsc`-flagged requests at all rather than wrapping them, which both guarantees "never cached" and lets the Next router fall back to a full page load on a genuine failure | `public/sw.js:129-154, lib/__tests__/sw.test.ts:89-128` | This is the one rule in the file that is fully honoured and tested, including the header-flagged variant (`RSC: 1` / `Next-Router-State-Tree`) as well as the `?_rsc` query form. Any change to the fetch handler's branch order must keep this check ahead of everything else. |
| Cross-origin exclusion: Supabase, R2 signed URLs, Stripe and fonts are never touched by the worker | `public/sw.js:15-17, public/sw.js:125` | This is why controlled-document BYTES viewed through the internal viewer are not in Cache Storage — SecureDocViewer resolves a presigned R2 URL and streams from R2 (cross-origin). The only same-origin path that carries document bytes is `/api/share/file`. Keep this exclusion; the fix work is on the same-origin side. |
| The four QR verify routes are minimal-disclosure by design and get that part right | `app/api/verify/route.ts:1-12, app/api/verify-hold/route.ts:48-52` | UUID-validated, service-role, no file access, no URLs, no people — verify-hold explicitly strips operator notes and staff names because a photographed hold card is public. The caching defect does not require weakening any of this; it is orthogonal to the payload design. |
| Server-side stamping on the share download path, with a verify QR embedded in the footer | `app/api/share/file/route.ts:105-125` | Every copy that leaves through a share link is watermarked UNCONTROLLED and carries `${label} Rev ${rev} at time of download — scan the QR to confirm it is still current`, pointing at `/verify/<docId>?v=<versionId>`. This is the right architecture: the paper defers to the live check. It is exactly why finding 1 is critical — the stamp's promise is only as good as the verify endpoint's freshness. |
| RoleContext's membership resolution treats a failed lookup as a failure, not as an answer — three retries with backoff and a distinct `error` state | `components/providers/RoleContext.tsx:125-187, app/(protected)/layout.tsx:49-50` | This is the corrected form of the bug still present at app/page.tsx:72-85, and its comment documents why. Fix the entry page by copying this, not by inventing a new approach. |
| UpdatePill polls `/api/version` against the deployed commit SHA and reloads unconditionally on click | `components/system/UpdatePill.tsx:19-38, app/api/version/route.ts:14-20` | A working build-staleness mechanism already exists and already knows the build id — `VERCEL_GIT_COMMIT_SHA ?? VERCEL_DEPLOYMENT_ID ?? "dev"`. That same value is what the service worker's VERSION should be derived from, and its unconditional `window.location.reload()` is the pattern ServiceWorkerManager's applyUpdate should adopt. |
| The Web Push receiver in the worker is a complete, correct implementation with no transmitter — already fully documented by the notifications audit | `public/sw.js:223-256; audit-reports/notifications/07-os-notifications-and-nudges.md (OS-01, OS-11)` | Do not re-report: the notifications audit traced commit 1200498 shipping push end-to-end and commit 0bb13ed deleting every TypeScript file in the set, leaving sw.js's push/notificationclick handlers, the push_subscriptions migration, and three registry entries behind. I independently re-confirmed the transmitter side is absent (no `pushManager`, no VAPID, no `requestPermission` anywhere outside sw.js:238). It is dead code in this area's files but it is that audit's finding. |
| The manifest is genuinely install-ready with raster PNGs ahead of the SVG and a maskable purpose | `app/manifest.ts:23-32` | Desktop/Windows install and taskbar pinning need the PNGs, and the comment records why an SVG-only manifest regressed to a favicon. One caveat worth noting outside the findings: `display_override: ["window-controls-overlay", ...]` (line 18) is declared but no CSS in this repo reads `env(titlebar-area-*)` — `grep -rn "titlebar-area\|safe-area-inset\|viewport-fit" app/globals.css app/layout.tsx components/` returns nothing — so a desktop install draws app chrome under the OS window controls. |
| There is no offline write queue and no background sync anywhere | `public/sw.js (no `sync` listener), no IndexedDB store outside lib/draftHandoff.ts:22-24` | Nothing is silently queued and replayed later, which is the right default for a document-control system — a phantom deferred approval would be worse than a failed one. But it also means every write button stays enabled offline with no guard, and given the codebase-wide pattern of unchecked `{error}` returns from supabase-js, an offline acknowledgment or approval can render as success while nothing was written. Any "make the app work offline" work must decide this deliberately rather than inherit it. |


---


<a id="off-1"></a>

## OFF-1 · The QR verify verdict is cached and replayed offline — a superseded drawing can be answered "CURRENT" from a week-old cache, and the fail-safe error branch becomes unreachable

- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:207-220`, `public/sw.js:116-120`, `app/verify/[docId]/page.tsx:44-49`, `app/api/verify/route.ts:96-108`, `app/verify-hold/[holdId]/page.tsx:33-38`, `app/api/verify-hold/route.ts:53-61`, `app/api/verify-package/route.ts:67-76`, `app/api/verify-ticket/route.ts:91-102`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Mechanism confirmed for all four verify routes (verify, verify-hold, verify-ticket, verify-package are all uncached GETs behind the same catch-all). Two small overstatements worth recording: the error branch is not unconditionally unreachable — a first-ever offline scan gets sw.js's 503 `unavailableResponse()` and does show 'Can't verify this code'; and the page prints a stale `Checked {new Date(result.checkedAt).toLocaleString()}` (page.tsx:140-141), though at 10px in white/60 under a full-screen green CURRENT.

**Mechanism.** The four QR endpoints are same-origin GETs whose pathnames carry no file extension (`/api/verify`, `/api/verify-hold`, `/api/verify-package`, `/api/verify-ticket`), so every one of them falls through the worker's RSC bypass (sw.js:148-154), the navigate branch (157), and the static-asset branch (180) into the generic handler at sw.js:207-220:

    try {
      const res = await fetch(request);
      cachePut(RUNTIME_CACHE, request, res);
      return res;
    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;

The cache key is the full Request URL including `?doc=<uuid>&v=<versionId>` — i.e. keyed by the exact QR that is printed on one exact sheet of paper. `cachePut` stores any 2xx (sw.js:117: `if (!response || !response.ok || response.type === "opaque") return;`) and none of the four routes declares `dynamic`, `revalidate`, or a `Cache-Control` header. So the first successful scan writes that sheet's verdict into Cache Storage permanently, and any later scan that cannot reach the network replays it byte-for-byte as a 200.

The verdict is the entire payload. `/api/verify` computes `isCurrent` server-side (route.ts:89-94) and the page paints the whole screen from it — green `CURRENT` vs red `DO NOT USE` (page.tsx:65, 98-100). `/api/verify-hold` returns `active: !h.released_at` and the page paints red `HOLD ACTIVE` vs green `RELEASED` (verify-hold page.tsx:54, 81-88). `/api/verify-package` returns `allFresh` and paints green vs red (route.ts:73, page.tsx:60).

Worse than the stale answer: both pages carry a deliberate fail-safe on the error path — `/verify` says "If this QR came from a printed drawing, contact Document Control before using the print" (page.tsx:78-80) and `/verify-hold` says "Treat the hold as ACTIVE until Document Control confirms otherwise" (page.tsx:67-69). Those branches only run when `fetch` rejects or returns `!res.ok`. The service worker guarantees `fetch` resolves with a cached 200 whenever a cached entry exists, so on the exact device most likely to have scanned this tag before, the fail-safe is dead code.

**Failure scenario.** A contractor scans the QR on drawing 2002-D-10001 Rev C at the unit on Monday; the phone is online, gets `isCurrent: true`, paints the green CURRENT screen, and the service worker (registered from the root layout at app/layout.tsx:93, so it installs on this public page too) writes that verdict to Cache Storage keyed by `/api/verify?doc=<id>&v=<versionId>`. Tuesday an MOC issues Rev D and supersedes Rev C. Thursday the same contractor is inside the unit with no cell coverage and scans the same paper again to confirm before a tie-in. `fetch` rejects, `caches.match` hits, and the phone paints the identical full-screen green CURRENT with "This print matches the current revision." He works to the superseded drawing. The only contradicting signal is `Checked <Monday's timestamp>` rendered at 10px in `text-white/60` at the bottom of the screen (page.tsx:140-142). The amber "Offline" pill may not appear at all: it is driven by `navigator.onLine` (ServiceWorkerManager.tsx:24-28), which reports true on plant Wi-Fi that is associated but has no route out — the most common way a plant device is "offline".

**Evidence.**

```
public/sw.js:117 — `if (!response || !response.ok || response.type === "opaque") return;` is the entire cacheability test: no Cache-Control parsing, no allowlist, no path exclusion. sw.js:214-216 — `const cached = await caches.match(request); if (cached) return cached;`. `grep -n "no-store|revalidate|dynamic =" app/api/verify/route.ts app/api/verify-hold/route.ts app/api/verify-package/route.ts app/api/verify-ticket/route.ts` returns nothing. sw.js:15-17 names exactly what is excluded — "cross-origin requests (Supabase, R2 signed URLs, Stripe, fonts) and any non-GET request" — and the verify endpoints are neither.
```

**Chain reaction.** The verify pages are the app's terminal document-control control: they are what the printed watermark tells the reader to trust (`/api/share/file` stamps the footer "scan the QR to confirm it is still current", share/file/route.ts:113). Caching them inverts the guarantee — the QR now certifies the past. It also makes the /verify-hold tag worse than no tag, because a released-then-reapplied hold reads green RELEASED and instructs the worker "this tag can come down".

> **Verifier correction.** Two preconditions and two weak mitigations the finding omits. Preconditions: the SW must already be installed on that phone from a prior visit, and the exact `?doc=…&v=…` URL must already be in RUNTIME_CACHE — on a first-ever scan the in-page fetch (useEffect) can outrun registration (which waits for `load`, ServiceWorkerManager.tsx:50-51), so a cold device still gets the honest fail-safe. Mitigations: the payload's own `checkedAt` is rendered as "Checked <date/time>" (verify page.tsx:140-142, verify-hold:117-119), so a replayed verdict shows a stale timestamp, and the root-layout offline pill (ServiceWorkerManager.tsx:74-78) is on screen. Both are 10px secondary text against a full-screen green CURRENT, so they do not change the severity. Also, the evidence's grep for `dynamic`/`Cache-Control` on the four routes is beside the point: cachePut reads no headers at all, so declaring `no-store` would not have helped.

**Done when.**

- [ ] The service worker never writes a response for `/api/verify`, `/api/verify-hold`, `/api/verify-package`, or `/api/verify-ticket` into any cache, and never serves one from cache — the request either reaches the network or fails so the page's fail-safe error branch runs
- [ ] A path-based exclusion list (or an opt-in allowlist of cacheable paths) exists in sw.js rather than the current cache-everything-same-origin default, and it is asserted by a test
- [ ] All four verify routes declare `export const dynamic = "force-dynamic"` and send `Cache-Control: no-store`, so the intent is stated at the route as well as enforced in the worker
- [ ] A field device with the network removed and a prior successful scan in its cache shows the "Can't verify this code / treat the hold as ACTIVE" screen, not a coloured verdict

*Cross-package note (2026-10-01, public-surfaces Round F, PS-VERIFY): done-when 3 landed via `VFY-13` — all four verify routes export `dynamic = "force-dynamic"` and answer only through `verifyJson` (`Cache-Control: no-store`, errors and 429 included), and the three verify pages fetch with `cache: "no-store"` (`lib/__tests__/verifyDoor.test.ts`). Done-when 1, 2 and 4 — the service worker — remain PKG-1 SW-OFFLINE's; OFF-1 stays OPEN.*

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE. Reproduced at `564720d` with the new suite written first (`OFF-14`): the verify-replay mechanism itself had already been closed there by document-control `XEDGE-6` (P2 EGRESS, 2026-09-23) — the v6 worker refused every same-origin `/api/` write and never consulted the cache for an `/api/` request offline, and the new per-route verify cases pass against it. What was still open: done-when 2 — v6's only exclusion was the blanket `/api/` rule behind an allow-list, so a path added to that allow-list would have re-admitted a verdict (the precedence case below fails against v6) — and the per-route evidence for done-when 1 and 4.
- `public/sw.js` (schema 7): `NEVER_CACHE_PREFIXES` (`:320`) — `/api/verify` (a prefix: `/api/verify`, `-hold`, `-package`, `-ticket`), the four scan-landing pages `/verify/`, `/verify-hold/`, `/verify-package/`, `/verify-ticket/`, `/api/share/`, `/share/`, `/api/storage/`, `/api/transmittal`, `/transmittal/`, `/api/intake/`, `/submit/`, `/d/` — is the first test in `isCacheableRequest` (`:353`), ahead of the `/api/` rule and `CACHEABLE_API_PREFIXES`. `cachePut` refuses those requests; `cachedFallback` (`:469`) returns before any `caches.match` for them, so not even a leftover is replayed; the cache-first static branch is never entered for them. Offline, a verify API fetch gets the worker's `503 offline: not cached`, and every verify page treats `!res.ok` as its error branch (`app/verify/[docId]/page.tsx:35`, `app/verify-hold/[holdId]/page.tsx:29`, `app/verify-package/[packageId]/page.tsx:37`, `app/verify-ticket/[ticketId]/page.tsx:78`).
- The scan itself — the page NAVIGATION — is answered by the worker (fix pass, after review). The first cut of this package left the verify pages cacheable on the claim that "a cached page shell is what lets an offline scan reach the page's own fail-safe screen". That claim was false: the four pages are dynamic routes (no `generateStaticParams`; none of them is in `.next/prerender-manifest.json`'s `routes`, and `dynamicRoutes` is empty), so Next 16 renders them on demand with `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, which `isCacheableResponse` refuses — no verify page is ever cached, and an offline scan landed on the generic `/offline` page (or the inline notice), with no word about the print or the hold tag. Now the navigate branch's `catch` (`:581-587`), after the abort check and before any cache or `/offline` fallback, recognises a verify page (`VERIFY_PAGES` / `verifyPageFor`, `:256-265`) and answers with `verifyFailSafeResponse` (`:271`): a `503` `no-store` HTML screen on the pages' neutral slate background carrying that page's own heading and instruction — `/verify/` "Can't verify this code" + "If this QR came from a printed drawing, contact Document Control before using the print."; `/verify-hold/` "Can't verify this tag" + "Treat the hold as ACTIVE until Document Control confirms otherwise."; `/verify-package/` and `/verify-ticket/` their own lines — plus "You're offline — this can only be checked against the live record" and a "Try again" link back to the same scan (HTML-escaped). Never a coloured verdict. The four pages are on the never-cache list too, so no leftover of a page is ever served in its place.
- Tests: `lib/__tests__/sw.test.ts` "OFF-1 / OFF-5 / OFF-6 / OFF-7 / SHR-9 — the never-cache list": for each of ten routes (the four verify routes among them) a 200 with no cache header is served and never written; offline with a leftover in the runtime cache, the shell cache and a v6 runtime cache, no cache is consulted and the answer is a 503 without the payload; "OFF-1 done-when 4 (the API half)" (scan online, lose the network, scan again → the failure, nothing stored); "the never-cache list wins even over an /api/ allow-list entry" (the worker loaded with `CACHEABLE_API_PREFIXES = ["/api/"]` still refuses `/api/verify` and `/api/share/resolve`, and stores `/api/codebook`). "OFF-1 done-when 4 — an offline QR scan lands on the page's own fail-safe screen…": for each of the four pages, an offline navigation with nothing cached for it (and `/offline` precached) is a 503 carrying the page's heading and instruction, no verdict word, not the offline page; the review's scenario — a HOLD tag scanned online with the page served `private, no-cache, no-store` as Next serves it, a leftover of the page planted in the runtime and shell caches, three days on scanned offline → "Treat the hold as ACTIVE until Document Control confirms otherwise.", no cache consulted; each page online is served and never written; the worker's heading and instruction are read back out of each page's error branch (`app/verify*/…/page.tsx`), so copy drift fails CI; "Try again" is the same scan, escaped, and an aborted scan still rethrows; `/verifications` is not a verify page. These cases fail against the first cut (`0916d17`).
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ No response for `/api/verify`, `/api/verify-hold`, `/api/verify-package` or `/api/verify-ticket` is written to any cache or served from one; offline the request fails (503) and the page's error branch runs.
2. ✓ `NEVER_CACHE_PREFIXES` in `public/sw.js`, asserted per route by test, and asserted to win over the API allow-list.
3. ✓ Landed earlier by PS-VERIFY (`VFY-13`, note above).
4. ✓ In the worker harness, for the navigation as well as the API call: an offline scan of a printed QR or a hold tag on a device running this worker gets the worker's fail-safe screen with the page's own "Can't verify this code / this tag" heading and its instruction ("…contact Document Control before using the print", "Treat the hold as ACTIVE until Document Control confirms otherwise"), never a coloured verdict and never the generic offline page; and if the page itself is somehow up, its `/api/verify*` call fails and the page's own error branch runs. (The first cut claimed this on the API case alone; in production that path never ran — see the fix-pass bullet above.) Not observed on a physical device (no browser in this environment).

**Scope / residual.** None in the worker. Outside it: a device that has never installed the worker (a first-ever scan, or a browser that refuses service workers) gets the browser's own "no connection" page — no verdict, but no instruction either; the pages cannot help there. A device still running a v5/v6 worker keeps that worker's behaviour until this one activates — it now waits for the update tap or for every tab to close (`OFF-4`) — and activate then drops every cache not named for the new VERSION (`OFF-11`).

---

<a id="off-2"></a>

## OFF-2 · A field device that has been offline shows "No workspace found — ask your admin to add you": the membership query's error is discarded and read as an answer

- **Severity:** HIGH
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `app/page.tsx:72-85`, `app/page.tsx:241-262`, `components/providers/RoleContext.tsx:125-128`, `components/providers/RoleContext.tsx:169-187`, `app/(protected)/layout.tsx:49-50`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The RoleContext locations cited are the contrast, not the bug: RoleContext.tsx:126-128 explicitly comments 'Every query THROWS on error so the retry loop below can tell "the lookup failed" apart from "this account truly has no membership"', retries 3× (169-178) and lands on `setMembershipState("error")` → `MembershipErrorScreen` at app/(protected)/layout.tsx:50. The login page never got that fix, and it is the PWA's start URL.

**Mechanism.** The installed PWA's `start_url` is `/` (app/manifest.ts:15), so launching it lands on app/page.tsx, whose shell is precached (sw.js:41 lists `"/"` in SHELL_ASSETS). If `getSession()` returns a stored session, `routeAuthedUser` runs:

    const { data: membership } = await supabase
      .from("org_members")
      .select("org_id")
      .eq("uid", uid)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (membership?.org_id) {
      router.replace("/dashboard");
    } else {
      setAuthedEmail(userEmail);
      setView("no-workspace");
    }

Only `data` is destructured. supabase-js resolves rather than throws, so an offline query yields `{ data: null, error: <network failure> }`, and `membership` is null — indistinguishable from "this account holds no active membership". The device paints the `no-workspace` screen at app/page.tsx:241-262: **"No workspace found — Your Microsoft account isn't linked to a workspace yet. Ask your organization's admin to add you using this email address."** Its two actions are "Request access or create a workspace" (a link to `/signup`, which also needs the network) and "Sign out", which destroys the only credential the device has and cannot be undone until connectivity returns.

This exact bug was diagnosed and fixed one file over: RoleContext's comment at lines 125-128 reads "Every query THROWS on error so the retry loop below can tell 'the lookup failed' apart from 'this account truly has no membership'. The old code swallowed errors and answered Viewer for both — on a flaky phone connection that dressed an Admin up as a locked-out stranger." RoleContext accordingly checks `error` on all three queries, retries 3× with backoff, and lands on `membershipState = "error"` → `MembershipErrorScreen` (RoleContext.tsx:179-186, layout.tsx:50). app/page.tsx — the PWA's actual entry point — never got the same treatment.

**Failure scenario.** A tablet has been in a locker for a week. A technician launches the installed app inside the unit with no signal. If the stored session is still readable, the app tells them their account was never admitted to a workspace and offers Sign out. If they tap it, the session is cleared and the device cannot sign in again until it reaches the network — a one-tap, irreversible lockout produced entirely by an unchecked error. If instead the expired session cannot be refreshed offline, they get the login screen and cannot authenticate at all. Either way the answer to "what does a field device show after a week offline" is: a screen that blames the user's account.

**Evidence.**

```
app/page.tsx:72-78 quoted above — the destructure is `const { data: membership } =`, with no `error`. app/page.tsx:257-259 renders the accusatory copy. components/providers/RoleContext.tsx:138 — `if (error) throw new Error(error.message);` is the corrected pattern, three times over, in the sibling file. The preceding `await supabase.from("users").upsert({...})` at app/page.tsx:63-70 is wrapped in `try/catch` that can never fire for the same reason (supabase-js resolves with `{error}`), so that write silently no-ops offline too.
```

**Chain reaction.** Belongs to the same family as the unchecked-write pattern the roles-and-permissions and drafting-flow audits recorded (supabase-js resolves with `{error}` rather than throwing); this is its offline manifestation on the one screen a field device always sees first.

> **Verifier correction.** One precondition to state: this fires only when `supabase.auth.getSession()` (app/page.tsx:131) returns a still-valid stored session while offline. An expired session cannot refresh offline, returns no session, and the flow falls through to the login form instead (:150-161) — a different, less accusatory dead end. Within the ~1h access-token window on a launched PWA, the finding is exactly right.

**Done when.**

- [ ] app/page.tsx checks `error` on the org_members query and distinguishes lookup failure from genuine non-membership, matching RoleContext.tsx:125-187
- [ ] The offline/lookup-failure case renders a retry screen that does not accuse the account and does not offer Sign out as the primary action
- [ ] Launching the installed PWA with the network disabled never shows "No workspace found"

**Resolution (2026-10-01, public-surfaces Round F).** Record-only close — resolved elsewhere by identity-and-session `ORGSEL-2` / `SESS-4` (commit `c111433`). Verified at `564720d`: `app/page.tsx` no longer queries `org_members` — `routeAuthedUser` (`:65-92`) routes to `/dashboard` unconditionally and the page's own "no-workspace" view is gone (`:242-245`); `RoleProvider` makes the one membership decision, every query throws on `error` (`components/providers/RoleContext.tsx:226`, `:236`, `:258`), three attempts with backoff, and an exhausted lookup lands on `membershipState = "error"` (`:286`), rendered by the protected layout's `MembershipErrorScreen` ("Couldn't load your workspace … a network hiccup, not a permissions change", Try again, no Sign out — `app/(protected)/layout.tsx:70`, `:220`). `"none"` (`RoleContext.tsx:344`, `NotAMemberScreen`) is reached only from a lookup that succeeded and found nothing.
- No code changed in this package.

**Done-when.**
1. ✓ The login page no longer looks up membership; the provider tells "lookup failed" from "no membership" (`ORGSEL-2`).
2. ✓ A lookup failure renders the retry screen — no accusation, no Sign out.
3. ✓ By construction: "No workspace found" no longer exists in `app/page.tsx`, and the layout's not-a-member screen needs a successful empty lookup. Not observed with an installed PWA (no browser here).

**Scope / residual.** None.

---

<a id="off-3"></a>

## OFF-3 · "Offline — showing cached data" and the offline page's "data you opened recently are still available" are both false: the worker deliberately caches none of the app's data

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/pwa/ServiceWorkerManager.tsx:74-79`, `components/pwa/ServiceWorkerManager.tsx:5-7`, `app/offline/page.tsx:14-18`, `public/sw.js:15-17`, `public/sw.js:125`, `app/(protected)/layout.tsx:1-26`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Substance holds — the pill and the offline page both assert cached data that does not exist for any Supabase-backed panel, and the pill appears regardless. One correction to the wording: 'the worker deliberately caches none of the app's data' is too absolute — public/sw.js:203-220 does cache same-origin GET API responses (that is precisely the mechanism OFF-1/OFF-5/OFF-6 rely on); it is the cross-origin data, i.e. nearly all of it, that is uncached.

**Mechanism.** The entire protected application is a client-side SPA: `app/(protected)/layout.tsx:1` is `"use client"` and every screen reads its data through the browser Supabase client (lib/supabase.ts:110), whose origin is `NEXT_PUBLIC_SUPABASE_URL`. The worker's second line of defence is `if (!isSameOrigin(request.url)) return;` (sw.js:125), with the comment at sw.js:15-17 spelling out the intent: "Deliberately NOT cached: cross-origin requests (Supabase, R2 signed URLs, Stripe, fonts)".

So the one and only source of documents, tickets, revisions and holds is, by design, never cached. There is no IndexedDB store either — `grep -rn "indexedDB"` across ts/tsx returns a single unrelated hit (lib/draftHandoff.ts:22-24, a same-tab draft handoff), and there is no background sync (`grep -n "sync" public/sw.js` returns nothing).

Against that, two surfaces promise the opposite. ServiceWorkerManager renders a pill reading **"Offline — showing cached data"** (line 77), and its docblock justifies it as telling "a plant worker … they're seeing cached data (not stale-because-broken)" (lines 6-7). app/offline/page.tsx:15-17 tells the reader "Pages and data you opened recently are still available; this screen appears for anything that wasn't cached." What is actually available offline is the HTML shell and the JS/CSS chunks — a chrome with no content.

**Failure scenario.** A technician loses signal mid-inspection. The amber pill appears and says the app is showing cached data, so he trusts what is on screen and keeps working from it. In reality every panel is empty or erroring, and the shell above them is whatever React rendered before the queries failed — and if he navigates or reloads he lands on the membership-failure screen. The pill has converted "this app has no data right now" into "this data is merely a little old", which is the worse of the two lies in a document-control context.

**Evidence.**

```
public/sw.js:15-17 and 125 — the exclusion is explicit and deliberate. components/pwa/ServiceWorkerManager.tsx:77 — the literal string `Offline — showing cached data`. app/offline/page.tsx:15-17 — `Pages and data you opened recently are still available`. app/(protected)/layout.tsx:1-4 — `"use client"` plus `import { supabase } from "@/lib/supabase"`, confirming the data path is the cross-origin client.
```

**Chain reaction.** The pill is also unreliable in the direction that matters: it is driven by `navigator.onLine` (ServiceWorkerManager.tsx:24-28), which reports online on plant Wi-Fi that is associated but has no upstream route. In exactly that scenario the verify pages serve a cached verdict (finding 1) with no offline indicator at all — the app's only staleness signal is absent precisely when a stale answer is being shown.

> **Verifier correction.** "Caches none of the app's data" is overstated and contradicts findings 1-5 in the same report: the worker does cache same-origin GET /api/* responses (sw.js:209-211), which is why verify verdicts and share PDFs come back offline. The accurate claim is that the primary content path — documents, tickets, revisions, holds, all read through the cross-origin Supabase client — is never cached, and I confirmed the same-origin /api fetches in the protected tree are overwhelmingly admin/export/storage utilities, not screen data. Severity is copy-accuracy, not integrity: the pill overpromises, it does not mislead anyone about a document's status. The specific claim about what a worker SEES on those screens is inference — nobody ran the app — so treat the user-visible half as unverified.

**Done when.**

- [ ] The pill's copy matches reality — it says connectivity is lost and data may be missing, not that cached data is being shown
- [ ] app/offline/page.tsx no longer claims recently-opened data is available
- [ ] If the claim is to be made true instead, a deliberate offline data store exists with an explicit staleness timestamp per record, and the pill reports that timestamp
- [ ] Offline state is derived from actual fetch failures, not `navigator.onLine` alone

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE; the plan's default — a copy fix, not a real offline store — taken. Reproduced at `564720d`: `components/pwa/ServiceWorkerManager.tsx:77` rendered "Offline — showing cached data" off `navigator.onLine` alone (`:24-28`), and `app/offline/page.tsx:15-17` said "Pages and data you opened recently are still available".
- `components/pwa/ServiceWorkerManager.tsx`: the pill renders `OFFLINE_PILL_TEXT` (`:27`) — "Offline — can't reach the server; data may be missing or out of date"; the docblock no longer promises cached data. Offline is `browserOffline || unreachable` (`:80`): `unreachable` follows the worker's `{ type: "NETWORK", ok }` messages (`networkSignal`, `:39`); on mount the page asks the worker what it last saw (`NETWORK_STATUS`, `:99`); while offline it probes `/api/version` every 20 s and on the `online` event to clear itself.
- `public/sw.js`: `reportNetwork` (`:516`) posts `NETWORK ok:false` to every window on a genuine (not aborted) fetch failure in any branch, and `ok:true` when a navigation or a data GET answers again — one message per change; `NETWORK_STATUS` is answered with the last observation, or not at all before there is one. The cache-first static branch reports failures only (fix pass, after review): a hashed `/_next/static` asset can resolve from the browser's HTTP cache with no route out, and reporting that as "the network answers" cleared the pill on an offline device and let it flap.
- `app/offline/page.tsx`: "Documents, drawings and their status are read live and are not kept on this device, so nothing here can be checked until you reconnect — don't rely on a screen you opened earlier as current." The worker's inline last-resort page now says "This page isn't available offline" (was "isn't cached yet").
- Tests: `sw.test.ts` "OFF-3 — the worker reports what actually happened on the network" (ok:false once per change, ok:true on recovery; a static asset that resolves while the device is offline posts no ok:true and `NETWORK_STATUS` still answers ok:false — fails against the first cut, `0916d17`; a failing static asset still reports ok:false; an aborted request reports nothing; `NETWORK_STATUS`) and "OFF-3 / OFF-4 — the page side" (the pill has no "cached" and says "missing"; the offline page has no "still available"; `networkSignal`; the manager derives offline from both sources).
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ The pill says the server can't be reached and data may be missing — not that cached data is shown.
2. ✓ The offline page no longer claims recently opened data is available.
3. — Not taken: the plan default (stated to the user 2026-09-17) is the copy fix; no offline data store exists, so nothing claims one.
4. ✓ Offline is derived from the fetch failures the worker observes, not `navigator.onLine` alone.

**Scope / residual.** The worker sees only same-origin requests: a cross-origin Supabase read failing while same-origin traffic still answers does not raise the pill (the screens' own error states cover that). The manager is mounted in the root layout, so the public pages show the honest pill too — intended.

---

<a id="off-4"></a>

## OFF-4 · "Update available — tap to refresh" is an inert button: install-time skipWaiting means the worker is already activated when the toast appears, so applyUpdate waits forever for a statechange that already fired

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `components/pwa/ServiceWorkerManager.tsx:60-70`, `components/pwa/ServiceWorkerManager.tsx:36-46`, `public/sw.js:43-50`, `public/sw.js:52-65`, `public/sw.js:68-70`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: `reg.waiting` (line 45) is also normally null under install-time skipWaiting, so the statechange path is the only one that arms the toast, and it arms it with a worker that is about to activate on its own. The only way the tap works is the sub-millisecond race where the user taps while the worker is still in 'activating'.

**Mechanism.** The worker calls `self.skipWaiting()` unconditionally inside its **install** handler (sw.js:47-48: `.then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined)).then(() => self.skipWaiting())`) and `self.clients.claim()` in activate (sw.js:63). A new worker therefore goes installing → installed → activating → activated with no waiting phase.

ServiceWorkerManager latches the toast on the `installed` transition:

    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        waitingRef.current = worker;
        setUpdateReady(true);
      }
    });

By the time the user reads the toast and taps it, that worker's state is `activated`. `applyUpdate` then does:

    const w = waitingRef.current;
    if (w) {
      w.postMessage("SKIP_WAITING");
      w.addEventListener("statechange", () => {
        if (w.state === "activated") window.location.reload();
      });
    } else {
      window.location.reload();
    }

`postMessage("SKIP_WAITING")` reaches sw.js:69, which calls `skipWaiting()` on an already-activated worker — a no-op. The `statechange` listener is registered *after* the `activated` transition has already happened, and events do not replay. The next statechange this worker will ever emit is `redundant`, at which point the page is gone. So the reload never happens. The `else` branch that would have reloaded unconditionally is unreachable precisely because `waitingRef.current` was set.

**Failure scenario.** A deploy fixes the revision-comparison logic. A plant tablet that has been on one tab all shift shows the amber "Update available — tap to refresh" pill. The user taps it. Nothing happens. They tap again. Nothing happens. The tab keeps running the old bundle, and the fix "looks like it never happened" — the exact failure the sibling UpdatePill component was written to solve (components/system/UpdatePill.tsx:3-7), except UpdatePill's button calls `window.location.reload()` directly (UpdatePill.tsx:43) and works.

**Evidence.**

```
public/sw.js:47-48 — `.then(() => self.skipWaiting())` is inside the `install` listener's `waitUntil`, not gated on a message. components/pwa/ServiceWorkerManager.tsx:63-66 — the reload is inside a `statechange` handler added after `postMessage`. The component's own docblock (ServiceWorkerManager.tsx:8-9) promises "letting them refresh on their own schedule rather than mid-task", which install-time skipWaiting + clients.claim also inverts: the new worker seizes the open tab mid-task and its activate handler deletes the previous version's caches (sw.js:56-62) out from under the still-running old bundle.
```

**Chain reaction.** Compounded by the VERSION finding below: because sw.js only changes when a human edits it, `updatefound` rarely fires for an app deploy at all, so this button is doubly dead. On a field device the only remaining path off a stale build is UpdatePill, which requires the device to reach `/api/version` — impossible offline.

> **Verifier correction.** Not HIGH, because a second and working update path exists that the finding never checked: components/system/UpdatePill.tsx polls `/api/version` every 5 minutes and on tab focus (:19-31), compares the build id, and its button calls `window.location.reload()` unconditionally (:43) — mounted in app/(protected)/layout.tsx:61. So a signed-in user on a stale bundle is not stranded; what is broken is the SW toast specifically. The docblock complaint is also half wrong: the activate handler only deletes caches whose key does not start with the current VERSION (sw.js:56-62), so on an ordinary deploy it deletes nothing out from under the running tab.

**Done when.**

- [ ] `self.skipWaiting()` is removed from the install handler so a new worker actually waits, leaving the SKIP_WAITING message handler (sw.js:68-70) meaningful
- [ ] applyUpdate reloads on `navigator.serviceWorker` `controllerchange`, and falls back to an unconditional `window.location.reload()` after a short timeout so the button can never do nothing
- [ ] Tapping the pill on a device with a new worker installed reloads the page into the new build every time

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE; plan default (remove install-time `skipWaiting`) taken. Reproduced at `564720d`: `public/sw.js:59` chained `self.skipWaiting()` inside the install handler's `waitUntil`, and `ServiceWorkerManager.tsx:60-70` waited for a `statechange` to `activated` that had already happened.
- `public/sw.js`: install only precaches the shell (`:128`) — a new worker installs and WAITS; the `SKIP_WAITING` message (kept) or every tab of the old build closing activates it; `activate` still `clients.claim()`s.
- `components/pwa/ServiceWorkerManager.tsx`: `applyServiceWorkerUpdate` (`:55`) listens for `controllerchange`, posts `SKIP_WAITING` to the waiting worker, and arms an unconditional reload after `UPDATE_RELOAD_FALLBACK_MS` (3 s); it reloads exactly once, and at once when there is no waiting worker, no service-worker API, or the post throws.
- Tests: `sw.test.ts` "install never calls skipWaiting — a new worker waits; only the SKIP_WAITING message activates it" (the install handler's source carries no `skipWaiting` either); the install case in "one failing shell asset…"; "tapping the toast tells the WAITING worker to take over and reloads on controllerchange — once"; "the button can never do nothing: no controllerchange → an unconditional reload after the timeout"; "no waiting worker, no service worker API, or a worker that refuses the message → reload at once".
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ `self.skipWaiting()` is gone from the install handler; the `SKIP_WAITING` handler is meaningful again.
2. ✓ `applyUpdate` reloads on `controllerchange`, with a 3 s unconditional fallback.
3. ✓ In the unit harness the tap always reloads — on `controllerchange` or, failing that, after 3 s. Not observed on a device.

**Scope / residual.** With no install-time takeover, a deploy reaches an open tab through the toast, `UpdatePill`, or closing every tab — the docblock's "on their own schedule". **Double prompt (found in review; fixed at integration, 2026-10-01):** because `sw.js` now changes on every Vercel deploy and waits, a signed-in user sees both `UpdatePill` ("This tab is running an old version — tap to load the update", top) and this toast ("Update available — tap to refresh", bottom-left) after a deploy; tapping `UpdatePill` reloads under the old controller, the new build's `ServiceWorkerManager` finds `reg.waiting` and shows the toast again, so the user who just updated was asked to update a second time. The integrator fixed it before the merge: `UpdatePill`'s button now calls `loadLatestBuild` (`components/pwa/ServiceWorkerManager.tsx`). That asks the registration for its waiting worker and activates it exactly as the toast does: `SKIP_WAITING`, then a reload on `controllerchange`, with the same fallback. With no registration, no waiting worker or a failed lookup it reloads plainly, as before. Tests in `lib/__tests__/sw.test.ts` cover a waiting worker activated, the four reload-at-once cases, and the pill's wiring. Both prompts can still show together after a deploy; either one now leaves the tab on the new build and the new worker, and neither comes back. On self-hosted images without a build id the toast appears only when `SW_SCHEMA` changes (`OFF-11`).

---

<a id="off-5"></a>

## OFF-5 · A revoked or expired share link still hands over the document offline, and the whole revocation check is bypassed

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:207-220`, `app/api/share/file/route.ts:42-51`, `app/api/share/resolve/route.ts:32-41`, `app/share/[token]/page.tsx:42-58`, `app/share/[token]/page.tsx:67-74`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and stronger than stated: app/api/share/file/route.ts:149 sets `"Cache-Control": "no-store"`, but the Cache Storage API ignores it — sw.js's cachePut stores the response anyway. The revocation check is not merely bypassed, it is bypassed by the exact response the server marked as never-store.

**Mechanism.** Revocation on this app is enforced only at the route: `/api/share/file` checks `if (share.revoked_at) return ... 410` and the expiry check on the next line (file/route.ts:48-51); `/api/share/resolve` does the same (resolve/route.ts:38-41). A 410 is not `res.ok`, so `cachePut` correctly declines to cache it (sw.js:117) — revocation works while the network is reachable.

But the generic branch is network-**first with cache fallback**, and the fallback consults the cache before it gives up:

    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;

The cache key for both routes is the URL, which contains the token: `/api/share/resolve?token=<tok>` and `/api/share/file?token=<tok>`. Once a recipient has opened the link successfully, both entries are permanent. With the network unreachable, the page's resolve call returns the cached snapshot (state `"ok"`, share page:51-52), it renders the document number, title and rev, enables "Download stamped copy", and `fetch(data.fileUrl)` returns the cached PDF bytes as a 200 — so `res.ok` is true, `res.blob()` succeeds, and the file is written to the device (share page:67-82). The recipient sees the ordinary success path. The revoked/expired branches at share page:99-104 are never reached.

**Failure scenario.** Document Control revokes a share after discovering the drawing went to the wrong contractor, then confirms the link is dead by opening it (410, "Link revoked" — correct). The contractor, on a job site with no signal, opens the same bookmarked link on the tablet he used last week. He gets the document page and a working "Download stamped copy" button, and saves the drawing. Nothing in the download_audits table records it (see the audit-bypass finding), so the distribution record shows the revocation succeeded and no post-revocation pull.

**Evidence.**

```
public/sw.js:213-217 quoted above. app/api/share/file/route.ts:48-51 — `if (share.revoked_at) return NextResponse.json({ error: "revoked" }, { status: 410 });`. app/share/[token]/page.tsx:68-72 — the revoked message is produced only inside `if (!res.ok)`, and a cache hit is a 200.
```

**Chain reaction.** Combines with the no-store finding: the PDF is in the cache in the first place only because cachePut ignores the route's `Cache-Control: no-store`. Fixing cachePut to honour no-store closes this one too.

> **Verifier correction.** The title overstates the leak. `/api/share/file?token=…` is only in the cache if that recipient already ran a successful download — which is the code path that writes the PDF to their filesystem (share page:74-82). So in the scenario where the bytes come back from cache, the recipient already possesses those bytes; nothing new escapes. If they opened the link but never downloaded, the offline download fetch misses the cache and falls to `unavailableResponse()` (sw.js:217, a 503), `!res.ok` fires, and they get the download-error message (share page:68-72). What genuinely survives is narrower: while offline, a revoked/expired link renders as a live share (document number, title, rev, an enabled Download button) instead of the revocation screen. That is a UI-truth defect, not a document leak, and it only holds while the origin is unreachable.

**Done when.**

- [ ] `/api/share/file` and `/api/share/resolve` are never stored in Cache Storage and never served from it
- [ ] With the network down and a warm cache, `/share/<revoked token>` shows a failure state, never the document card and download button
- [ ] A test asserts the share routes are excluded from the worker's cache-fallback path

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE. Reproduced at `564720d`: the two share API routes were already refused by v6's blanket `/api/` rule (`XEDGE-6`) — written never, replayed never; the open half was the share PAGE: a `/share/<token>` navigation went through the navigate branch, was written whenever the response was not `no-store`, and was replayed from cache offline (the "navigation /share/tok123" cases fail against v6). In production that page half was latent rather than live: `/share/[token]` is a dynamic route, which Next serves `private, no-cache, no-store`, and v6 already refused `no-store` — the harness case fails against v6 only because its response carries no `Cache-Control`. What this package adds is a rule that does not depend on the page's headers.
- `public/sw.js`: `/api/share/` and `/share/` are on `NEVER_CACHE_PREFIXES` (`:320`). A never-cache navigation is served from the network and not stored; offline it falls through to the precached `/offline` page (or the inline notice), never its own leftover. The page's resolve call offline gets the worker's 503, which `app/share/[token]/page.tsx:52-59` renders as the `error` state.
- Tests: `sw.test.ts` — `/api/share/file?token=…` and `/api/share/resolve?token=…` among the per-route never-written / never-read cases; "navigation …/share/tok123 — never written" and "— offline, its own leftover is never served (the offline page is)"; "a never-cache path that looks like a static asset is not routed cache-first".
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ `/api/share/file` and `/api/share/resolve` are never stored and never served from Cache Storage.
2. ✓ With the network down and a warm cache, `/share/<token>` is the offline page, and the page's resolve answers 503 → the error state; never the document card or the download button. Shown in the worker harness; not observed on a device.
3. ✓ Asserted per route, write and offline read.

**Scope / residual.** None. The share routes themselves are document-control `P1 SHARE`'s.

---

<a id="off-6"></a>

## OFF-6 · Authorization-header-gated GET responses are cached with no Vary, so a cached presigned R2 URL is matched for any later request to the same path regardless of who is signed in

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `public/sw.js:116-120`, `public/sw.js:214-215`, `app/api/storage/download-url/route.ts:10-20`, `app/api/storage/download-url/route.ts:91-111`, `app/api/storage/download-url/route.ts:151-153`, `app/api/storage/resolve/route.ts:22-25`, `lib/storage.ts:126-131`, `components/viewers/SecureDocViewer.tsx:105-110`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Not refuted — the missing Vary and the shared cache key are real, and the sign-out at RoleContext.tsx:270-280 does not clear Cache Storage. But the exploit requires the app origin to be unreachable while R2 is reachable, within 60 minutes of the first user's fetch; that narrow window puts this at LOW, not MEDIUM.

**Mechanism.** `/api/storage/download-url` and `/api/storage/resolve` authenticate from an `Authorization: Bearer` header, not a cookie (download-url/route.ts:11-20; callers at lib/storage.ts:128-130 and SecureDocViewer.tsx:106-109 pass `{ headers: { authorization: `Bearer ${token}` } }`). They then run real authorization work against that identity: active-membership on the key's `orgs/<orgId>/` prefix (route.ts:35-46), an ACL discoverability check for private/hidden documents (:55-90), and an explicit `deny.download` ACL check (:91-111) — the route's own comment calls URL issuance "the enforcement point for bytes". The success body is `{ url: <presigned R2 URL> }` (:151-153).

The response carries no `Vary` header — `grep -rn '"Vary"|vary:' --include=*.ts app/ lib/` returns nothing repo-wide. Per the Cache API, `cache.put`/`caches.match` key on the request URL and, when `Vary` is absent, on nothing else. The Authorization header is therefore not part of the key. Since the pathname has no file extension the request lands in the generic branch and `cachePut(RUNTIME_CACHE, request, res)` stores it (sw.js:210), and any later same-URL request that cannot reach the network is answered by `caches.match(request)` (sw.js:214) with the previous user's signed URL — the membership check, the ACL discoverability check and the `deny.download` check are all skipped because no request was made.

**Failure scenario.** A shared plant tablet. A Doc Control user opens a restricted drawing; the worker caches `/api/storage/download-url?path=orgs/<org>/<key>&expiresIn=3600` → `{url: <presigned>}`. She signs out (which clears two localStorage prefixes and nothing else — RoleContext.tsx:270-280). A Viewer whose ACL carries an explicit `deny.download` on that document signs in, opens the same document, and the tablet's Wi-Fi drops. `getPresignedDownloadUrl` (lib/storage.ts:118) calls the same URL, the fetch rejects, and the worker returns the cached presigned URL. Because R2 presigned URLs are bearer credentials that ignore application ACLs, the denied Viewer gets the bytes for as long as the original `expiresIn=3600` window has left.

**Evidence.**

```
app/api/storage/download-url/route.ts:11-13 — `const authHeader = req.headers.get("authorization"); if (!authHeader?.startsWith("Bearer "))` — the credential is a header, and headers other than those named in `Vary` are not part of a Cache API key. Route lines 108-110 — `if (denied) return NextResponse.json({ error: "Downloading this document is denied for your account" }, { status: 403 });` is the control being bypassed. `grep -rn '"Vary"' --include=*.ts app/ lib/` and `grep -rn "vary:" --include=*.ts app/ lib/` both return nothing.
```

**Chain reaction.** The 1-hour presign TTL bounds the exploit window, but the cached JSON itself is permanent, so the same defect will return the stale (now-useless) URL forever, producing an unexplainable 403 from R2 that looks like a storage outage rather than a cache hit. The same URL-only keying also applies to `/api/transmittal?token=…&file=<docId>`, which returns a 300-second presigned URL for an as-sent revision (app/api/transmittal/route.ts:71-82).

> **Verifier correction.** The consequence does not close. `caches.match` is only reached in the `catch` of sw.js:213-217 — i.e. only when the app origin is unreachable. Under exactly that condition the presigned URL is unusable: it points at R2, which is cross-origin and therefore never cached (sw.js:125, and the docblock at 15-17), so it cannot be fetched either. It is also time-limited (`expiresIn` defaults to 3600, route.ts:139) and typically long dead by the time a second user picks up the tablet. The moment connectivity returns, the network-first branch runs the real route and all three checks execute. So the mechanism (URL-only cache key over a header-gated response) is real, but "the deny.download check is bypassed" is not reachable from what the repo shows — downgrade to a hygiene defect and SUSPECTED.

**Done when.**

- [ ] No response from an Authorization-gated route is ever written to Cache Storage — the worker skips `/api/storage/*` and `/api/transmittal` outright
- [ ] Any response the worker does cache either carries `Vary: Authorization` or is provably identity-independent
- [ ] A test asserts a request bearing an `authorization` header is not stored by cachePut

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE. Reproduced at `564720d`: the presigned-URL JSON was already refused by v6's `/api/` rule (`XEDGE-6`); what was open was the general rule — a request carrying an `Authorization` header, or a response that varies by identity, was still stored on any non-API path (both cases fail against v6).
- `public/sw.js`: `/api/storage/` and `/api/transmittal` are on `NEVER_CACHE_PREFIXES`; `isCacheableRequest` (`:353`) refuses any request that carries an `Authorization` header (the Cache API keys on the URL alone); `isCacheableResponse` (`:377`) refuses `Vary: *`, `Vary: Authorization` and `Vary: Cookie`, alongside `no-store` / `no-cache` / `private`.
- Tests: `sw.test.ts` "OFF-6: a request carrying an Authorization header is never stored", "OFF-6: a response that varies by identity (Vary: Authorization / Cookie / *) is never stored", and `/api/storage/download-url` / `/api/transmittal?token=…&file=…` among the per-route cases.
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ The worker skips `/api/storage/*` and `/api/transmittal` outright, and stores no `Authorization`-bearing request anywhere.
2. ✓ What it does still store is identity-independent by rule: a same-origin non-API GET with no `Authorization` header and no credential in its query, whose response the server marked neither `private` / `no-store` / `no-cache` nor varying by `Authorization` / `Cookie` — and the runtime cache is purged on a changed identity (`XEDGE-6`) and emptied on sign-out (`OFF-8`).
3. ✓ Asserted by test.

**Scope / residual.** None.

---

<a id="off-7"></a>

## OFF-7 · Every response served from cache silently skips the distribution and audit-trail write that the route performs — download_audits, bump_share_access and TRANSMITTAL_PORTAL_DOWNLOAD all under-record

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:214-215`, `app/api/share/file/route.ts:129-141`, `app/api/share/resolve/route.ts:59`, `app/api/transmittal/route.ts:76-83`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. True as far as it goes — nothing in sw.js reports a cache hit back to the server — but the branch is network-first, so a replay is only possible on a device that already performed an ONLINE fetch of the identical URL, which did write the audit row; the trail can under-count, never show zero. The transmittal leg is weaker still: /api/transmittal?file= returns only `{url}` from a 300-second presigned R2 link (:71-74), so a cached copy hands back a dead URL and no download actually occurs offline. Impact is a bounded undercount, not a missing record.

**Mechanism.** In a PSM/document-control system the distribution record is the deliverable, not a side effect. Three of the cached routes write it inside the request:

- `/api/share/file` inserts the `download_audits` row that is explicitly commented "The distribution record: this is the actual download" (file/route.ts:128-140), including whether the copy went out stamped or unstamped (`source: stamped ? "share_link" : "share_link_unstamped"`).
- `/api/share/resolve` bumps the share access counter — `await sb.rpc("bump_share_access", { p_share: share.id })` (resolve/route.ts:83) — the thing that makes the page's on-screen claim "Access counted on the distribution record" (share page:141) true.
- `/api/transmittal?...&file=` inserts an `audit_logs` row with `action: "TRANSMITTAL_PORTAL_DOWNLOAD"` recording documentId, docNumber and rev (transmittal/route.ts:76-83).

When `caches.match(request)` returns (sw.js:214-215) the request never leaves the device, so none of these rows are written, while the user receives the identical bytes and the identical success UI. There is no compensating client-side beacon and no background-sync queue — `grep -n "sync" public/sw.js` returns nothing.

**Failure scenario.** An incident review asks who pulled Rev C of the failed spool drawing after the hold was placed. The download_audits table shows three pulls; the actual number was six, because three field tablets served the PDF from Cache Storage. Nobody can distinguish "was never downloaded" from "was downloaded from cache", and the on-screen promise the recipient saw — "Access counted on the distribution record" (app/share/[token]/page.tsx:141) — was false for those three.

**Evidence.**

```
app/api/share/file/route.ts:129-140 — `await sb.from("download_audits").insert({...})` lives after the byte assembly and only executes on a real request. app/api/share/resolve/route.ts:83 — `try { await sb.rpc("bump_share_access", { p_share: share.id }); } catch {}`. app/api/transmittal/route.ts:76-83 — `await supabaseAdmin.from("audit_logs").insert({ action: "TRANSMITTAL_PORTAL_DOWNLOAD", ... })`. public/sw.js:214-215 returns the cached response before any of these can run.
```

**Chain reaction.** This is the reason the caching defects above are not merely privacy issues: the same cache hit that delivers a revoked document is also the reason the delivery is invisible. Whichever fix lands for the share/transmittal caching closes both.

> **Verifier correction.** Two corrections. (1) The evidence sentence `grep -n "sync" public/sw.js returns nothing` is factually wrong — it returns four hits (lines 159, 185, 208, 245, all `(async () =>`). The defensible statement is that sw.js registers no `sync` listener: `grep -n addEventListener public/sw.js` returns exactly install:43, activate:52, message:68, fetch:122, push:226, notificationclick:241. (2) The transmittal leg is inert: that route returns a presigned URL with `expiresIn: 300` (transmittal/route.ts:74) to a cross-origin host the SW never caches, so a cached replay hands over a five-minute-dead URL that cannot be redeemed offline — no real download goes unrecorded there. The substantive case is share/file: real PDF bytes delivered from cache with no download_audits row, and only while offline (network-first means every online request records normally).

**Done when.**

- [ ] No route that writes a distribution or audit row is ever served from Cache Storage
- [ ] The share landing page's "Access counted on the distribution record" line is only shown on a path that provably reached the server
- [ ] A test asserts the worker does not answer `/api/share/*` or `/api/transmittal` from cache

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE. Reproduced at `564720d`: the three audit-writing routes were already refused by v6's `/api/` rule (`XEDGE-6`), so a cache hit could not skip their record at that commit; the open half was a stated, tested exclusion for them that does not depend on the blanket rule (the allow-list precedence case fails against v6).
- `public/sw.js`: `/api/share/`, `/api/transmittal` and `/api/intake/` (and the `/share/`, `/transmittal/`, `/submit/` pages) are on `NEVER_CACHE_PREFIXES`, consulted before the API allow-list; no response from them is written, and offline none is answered from cache — the request fails and the page says so.
- Tests: `sw.test.ts` per-route never-written / never-read cases for `/api/share/file`, `/api/share/resolve`, `/api/transmittal`, `/api/intake/*`; "the never-cache list wins even over an /api/ allow-list entry".
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ No route that writes a distribution or audit row is ever served from Cache Storage.
2. ✓ The share page's distribution line (now "Each download is recorded on the distribution record…", `app/share/[token]/page.tsx:171`, P1's copy) renders only with resolve data, and resolve data can now only come from the server — every rendering of it followed a request that reached `bump_share_access`.
3. ✓ Asserted by test.

**Scope / residual.** None.

---

<a id="off-8"></a>

## OFF-8 · Nothing ever clears Cache Storage on sign-out, so a shared field tablet carries the previous user's cached API responses — and the OAuth authorization code as a cache key

- **Severity:** MEDIUM
- **Status:** RESOLVED
- **Assigned:** identity-and-session IS-P1 (done-when 3: the client-storage inventory in RoleContext) — by the integrator, 2026-10-01 (PKG-1 merge; fleet plan `audit-reports/fleet-plans/`).
- **Verification:** CONFIRMED
- **Locations:** `components/providers/RoleContext.tsx:259-281`, `public/sw.js:52-65`, `app/page.tsx:97`, `lib/eSignatures.ts:82-86`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: RUNTIME_CACHE is device-wide, survives sign-out, and caches.match(request) keys on URL, so offline any later account is served the previous account's same-origin API bytes. The OAuth half is also real — app/page.tsx:92 `redirectTo: ${window.location.origin}/` makes the code-bearing `/?code=…` a navigate request cached at sw.js:161-162 — though a single-use, already-redeemed code is the least of it; the cross-account replay is what carries the MEDIUM.

**Mechanism.** The SIGNED_OUT handler is thorough about localStorage and blind to Cache Storage:

    // Status snapshots persist in localStorage for instant paints —
    // they must not outlive the account that fetched them.
    try {
      const doomed: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && (k.startsWith("intel-status-") || k.startsWith("schema-gaps-"))) doomed.push(k);
      }
      doomed.forEach((k) => window.localStorage.removeItem(k));
    } catch { /* private mode */ }
    window.location.replace("/");

The stated principle — data "must not outlive the account that fetched them" — is applied to two localStorage prefixes and to nothing else. `grep -rn "caches" --include=*.ts --include=*.tsx app components lib hooks` finds no CacheStorage access anywhere in application code, and a second search for `unregister|CacheStorage|cacheName` finds none either. The only deletion in the codebase is sw.js:56-62, which deletes caches whose key does not start with the current VERSION — and VERSION never changes on deploy (see that finding), so in practice nothing is ever deleted.

Everything the previous account pulled through a same-origin GET therefore persists for the next user of that device: presigned-URL JSON, admin shed previews, structured export payloads, share PDFs, transmittal snapshots, and every navigation's HTML.

The same gap writes an OAuth artefact to disk. Microsoft sign-in uses `redirectTo: `${window.location.origin}/`` (app/page.tsx:97; lib/eSignatures.ts:86 uses the current page URL), so the PKCE return is a top-level navigation to `/?code=<authorization code>`. That is `request.mode === "navigate"`, so sw.js:158-163 fetches it and calls `cachePut(RUNTIME_CACHE, request, res)` — creating a permanent Cache Storage entry **keyed by the URL containing the authorization code**.

**Failure scenario.** A rounds tablet is shared across three shifts. Each sign-out clears two localStorage prefixes and reloads to `/`. Cache Storage keeps growing across all three accounts. Offline, any of them can be served a response another account fetched (see the Vary finding for the concrete authorization consequence). Separately, an inspection of that tablet's site data lists cache keys of the form `https://app/?code=…`, one per Microsoft sign-in ever performed on the device.

**Evidence.**

```
components/providers/RoleContext.tsx:270-281 quoted above — the loop's scope is `intel-status-`/`schema-gaps-` only, followed immediately by `window.location.replace("/")` with no cache work. public/sw.js:56-62 is the only `caches.delete` in the repo. public/sw.js:160-162 — the navigate branch calls `cachePut` for every successful navigation, including `/?code=…`.
```

**Chain reaction.** This is the retention half of every caching finding above: no fix that only stops *new* writes will remove what is already on the fleet's devices. The authorization code is single-use and short-lived so it is not directly replayable, but it is a credential fragment written to disk by a system that never removes anything.

> **Verifier correction.** Both consequences are milder than stated. Cached entries are served only from the `catch` branches (sw.js:214, 167-171), so the next user of a shared tablet sees the previous account's cached responses only while the device is offline; online, every request goes to the network and re-authorizes. The OAuth item is close to inert: the cached entry is the HTML of "/" keyed by a URL containing a spent, single-use, short-lived PKCE code, and Cache Storage is readable only by same-origin script — which on that device already has the session in localStorage (lib/supabase.ts:64-96). Worth fixing as hygiene (a `caches.keys().then(delete)` on SIGNED_OUT), not as a credential leak.

**Done when.**

- [ ] Sign-out deletes every Cache Storage cache for the origin (and, ideally, unregisters and re-registers the worker) before `window.location.replace("/")`
- [ ] No navigation whose URL carries `code=`, `access_token`, `token`, or a share/portal token is ever written to Cache Storage
- [ ] The stated principle in RoleContext.tsx:269-270 is enforced for all client-side storage, not just two localStorage prefixes

**Partial (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE, scoped by the plan to "caches cleared before redirect" (the `SIGNED_OUT` block of `components/providers/RoleContext.tsx` only; identity-and-session owns the rest of the file). Reproduced at `564720d`: the block cleared two `localStorage` prefixes and the device workspace and nothing else, and the v6 worker wrote `/?code=…` navigations to Cache Storage (`/` is prerendered and served cacheable). The `/share/<token>`, `/submit/<token>`, `/transmittal/<token>` cases also fail against v6, but only because the harness response carries no `Cache-Control`: in production those dynamic pages are served `no-store`, which v6 already refused — the list makes their exclusion independent of headers.
- `components/providers/RoleContext.tsx` (`SIGNED_OUT` block, `:440-452`): before `window.location.replace("/")`, every Cache Storage cache is deleted (`caches.keys()` → `caches.delete` each), awaited but bounded by 1.5 s so a wedged CacheStorage cannot hold the sign-out; no Cache Storage (plain HTTP) is not an error. This covers the sign-outs the four buttons do not see — a token that cannot refresh, a sign-out in another tab — which is `XEDGE-6` done-when 2's handed-off half (it asked for `clearServiceWorkerSession()` there; deleting the caches directly is the stronger form: the worker's runtime cache AND its remembered identity go).
- `public/sw.js`: `carriesCredential` (`:339`) — no URL whose query carries `code=` or any `*token*` parameter is stored or served from cache; the public token pages are on `NEVER_CACHE_PREFIXES`. Because the sign-out also empties the shell cache, `rememberSession` (`:193`) re-warms whatever shell asset is missing on the next `SESSION` announcement — last (`:209`), after its identity check and purge, so a slow or hanging shell fetch never delays a changed identity's purge (fix pass, after review).
- Tests: `sw.test.ts` "OFF-8 — whichever way the session ends, Cache Storage is emptied before the redirect" (the block deletes every cache, awaited and bounded, before the redirect; the purge expression lifted from the block empties an in-memory CacheStorage including a cache the worker does not track); the `?code=`, `?token=`, `?access_token=`, `?token_hash=` and token-page navigation cases; "a SESSION announcement re-warms only the shell assets that are missing".
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ Sign-out deletes every Cache Storage cache for the origin before `window.location.replace("/")`. The "ideally unregisters and re-registers the worker" part is not done — the worker survives with empty caches, which is enough for this finding.
2. ✓ No navigation whose URL carries `code=`, `access_token`, a `token` parameter, or a share / portal / intake token is written to Cache Storage.
3. ✗ Not done. The principle now covers Cache Storage too, but "all client-side storage" is wider than this package: `localStorage` / `sessionStorage` hold some twenty other keys (recents, settings, memory, snapshots, UI preferences, the silent-SSO flag that must SURVIVE an expiry-driven `SIGNED_OUT`) and `lib/draftHandoff.ts` keeps an IndexedDB store. Deciding which of them are account data needs a per-key inventory in the file identity-and-session owns.

**Scope / residual.** Open for done-when 3, handed to identity-and-session (it owns `RoleContext.tsx`; `IS-P1` edits it next): inventory the client-storage keys and clear the account-scoped ones on `SIGNED_OUT`. The "session evaporated" branch (`RoleContext.tsx`, the `else` after `SIGNED_IN`) still clears no cache; the next identity's `SESSION` purge bounds it (`XEDGE-6`). The Cache Storage half is closed.

**Resolution (2026-10-07, identity-and-session Round G).** Package **IS-P1** — done-when 3, the half handed to the file identity-and-session owns (commit `6dd12d2`). Reproduced on `f8d5eb5`: `components/providers/RoleContext.tsx`'s `SIGNED_OUT` block cleared two localStorage prefixes (`intel-status-`, `schema-gaps-`), the device workspace and Cache Storage (PKG-1); sessionStorage, every other account key and the IndexedDB draft hand-off were untouched, and the "session evaporated" branch cleared nothing at all.
- **The inventory** (`RoleContext.tsx` `CLIENT_STORAGE_INVENTORY` `:77`, `CLIENT_INDEXED_DB_INVENTORY` `:124`): every key the app keeps in localStorage / sessionStorage (38 rows over the 27 files that read or write them) and the one IndexedDB database, each classified under DEC-44 (IS-P1) §2 — a value an account READ from the server must not outlive that account:
  - **account** (cleared on every SIGNED_OUT): the hub snapshots `intel-status-` / `schema-gaps-` (both stores); the palette's recents `mfg-os.palette.recents` (titles and links the account opened); the graph's settled layout `orgGraph:pos…` (keyed by the ids its graph returned) and its snapshot `org-graph-…` (session); the library row cache `mfg-os:lib:…` (session); the ask thread `kl-active-thread-…` (session); dismissals `dismissed:…`; the IndexedDB database `manufacturingos` (store `draftHandoff`: marked-up drawings waiting for their request). Each says what an evaporated session does with it — "cache" (rebuilt from the server, dropped) or "held" (the ask thread, the dismissals, the hand-off: work the same account may come straight back to, kept).
  - **workspace**: `manufacturingos.activeOrgId` / `.owner` — cleared on SIGNED_OUT by `clearStoredOrgId` (IDENT-4, unchanged), kept on evaporation (owner-checked).
  - **sign-in** (kept — an expiry-driven SIGNED_OUT needs them): `manufacturingos.preferMicrosoft` (the silent-SSO flag; the explicit sign-out buttons clear it), `manufacturingos.silentSSOAttempted` (the once-per-tab guard — clearing it on an expiry could loop the silent attempt), `manufacturingos.signInNext` (the destination carried across the Microsoft round trip), `manufacturingos.rememberSession`, and supabase-js's own `sb-…` keys.
  - **uid-scoped** (kept): `manufacturingos.dashboard.<uid>` — the person's own layout mirror, never served to another identity, and the only durable copy where `users.dashboard_config` cannot be written (`lib/dashboard/config.ts` saves locally first).
  - **device** (kept): theme, density, sidebar, view modes, hints seen, snoozes, inspector folds, the rev-up's last issue type, the graph's drawing settings (DEC-88), a throttle timestamp — and `manufacturingos.customStamps`, stamp images the person uploaded: not an account read, but not keyed by uid, so the next account on the device is offered them (opened as `OFF-15`).
- **SIGNED_OUT** (`:605`): `purgeAccountClientStores("all")` removes every account key from both stores and deletes the IndexedDB database (awaited, bounded at 1.5 s; a delete blocked by an open connection completes when it closes) — after `clearStoredOrgId`, before PKG-1's Cache Storage purge and the redirect, both kept exactly as they were. It replaces the two-prefix loop.
- **A session that evaporates** without a SIGNED_OUT (`:705`): the rebuildable caches go (`purgeAccountClientStores("cache")`) and Cache Storage is emptied the same bounded way; held work and the owner-checked workspace stay. **A different identity** signing in on the tab afterwards — or switching in another tab — ends the last identity's account data first, held keys included (`identityChangeEndsAccount`, `noteIdentity` on SIGNED_IN and on a uid-changing TOKEN_REFRESHED, `:633`, `:664`); the same identity keeps everything.
- Tests: `lib/__tests__/sessSixRoleNull.test.ts` "OFF-8 —": a census refuses any file under app/, components/, hooks/, lib/ that touches localStorage / sessionStorage / indexedDB without an inventory row, and finds every row's key in its owner files; the sign-in and account classifications; the purge per scope against real jsdom storage ("all": exactly the workspace, sign-in, uid-scoped and device keys survive; "cache": held work stays); a forbidden store never throws; the IndexedDB delete is asked for, bounded (a hung delete returns inside its budget) and not run for an evaporated session; and the provider rendered — SIGNED_OUT clears the account keys and the device workspace and keeps the silent-SSO flags; an evaporated session drops the caches and keeps held work and the workspace; a different identity's SIGNED_IN ends the held data while the same identity's keeps it. `sw.test.ts`'s OFF-8 block (PKG-1's purge, lifted verbatim) passes unchanged.

**Done-when.**
1. ✓ (PKG-1, unchanged) Sign-out deletes every Cache Storage cache before the redirect; the "ideally unregisters and re-registers the worker" part is still not done (PKG-1's note stands). The evaporated branch now empties Cache Storage too.
2. ✓ (PKG-1, unchanged).
3. ✓ The principle — what an account fetched must not outlive it — is enforced for every client store through an inventory a test keeps complete: each key holding what an account read is cleared on SIGNED_OUT (localStorage, sessionStorage and the IndexedDB database), the sign-in flow's own keys survive an expiry-driven SIGNED_OUT, and the session-evaporated branch drops the caches. Kept by the rule and said in the inventory: the uid-scoped dashboard mirror and the device keys.

**Scope / residual.** `OFF-15` (new, below): `manufacturingos.customStamps` is device-wide, not keyed by uid — the viewer's owner keys it by uid (clearing it on sign-out would destroy a person's uploaded stamps, a flow that works today). The last identity is remembered per tab and per page load: after a session evaporates, a reload and a sign-in as a DIFFERENT account in the same tab, the held keys (an open ask thread in that tab's sessionStorage, an unsubmitted hand-off) are not ended until that account's next SIGNED_OUT; the caches were already dropped by the evaporation.

---

<a id="off-9"></a>

## OFF-9 · RUNTIME_CACHE is unbounded — no size cap, no TTL, no eviction — and it stores multi-megabyte PDFs, so origin quota eviction can take the Supabase session with it

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** SUSPECTED
- **Locations:** `public/sw.js:116-120`, `public/sw.js:160-162`, `public/sw.js:209-210`, `app/api/share/file/route.ts:152-158`, `lib/supabase.ts:64-104`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanical claim is correct and repo-wide search confirms no eviction anywhere. The stated consequence is the speculative part: it needs the origin to reach hundreds of MB and the browser to run a whole-origin eviction, and the outcome is a forced re-login (lib/supabase.ts:76-77 puts the session in localStorage), not data loss or a wrong document. LOW.

**Mechanism.** Two branches write to RUNTIME_CACHE on every success — the navigate branch (sw.js:160-162) for every page the user visits, and the generic branch (sw.js:209-210) for every same-origin GET. `cachePut` applies no size test, no count limit, and no expiry, and nothing anywhere trims the cache: the only deletion in the file is the VERSION filter in activate (sw.js:56-62), which never fires because VERSION is a hand-edited literal that does not change on deploy.

The payload sizes are not small. `/api/share/file` returns whole stamped engineering PDFs (share/file/route.ts:145-151). `/api/data-export/structured` returns a structured org export. Each is stored in full, permanently.

Supabase sessions live in the same origin's localStorage (lib/supabase.ts:64-96, `hybridAuthStorage`). Browsers evict per-origin storage as a unit under quota pressure, so a Cache Storage bucket that grows without limit puts the auth session in the blast radius — on a device that may be nowhere near a network when it happens.

**Failure scenario.** A document controller uses the same browser profile for months, viewing hundreds of pages and downloading dozens of shared PDFs. Cache Storage for the origin grows into the hundreds of megabytes. The browser reclaims space for the origin. The Supabase session in localStorage goes with it, and the user is signed out with no explanation — and if this happens on a field tablet, they cannot sign back in until they find signal. Marked SUSPECTED because eviction behaviour is browser-specific and not observable from the repo; the unbounded growth itself is confirmed from the code.

**Evidence.**

```
public/sw.js:116-120 — `cachePut` has no size or count logic. public/sw.js:56-62 — the only cache deletion, gated on `!k.startsWith(VERSION)` where VERSION is the literal at sw.js:37. lib/supabase.ts:76-81 — `window.localStorage.setItem(key, value)` for the auth session, same origin as the caches.
```

**Chain reaction.** Every cacheability fix above also shrinks this: excluding the share PDF, the export payloads and the verify verdicts removes both the largest entries and the most dangerous ones.

> **Verifier correction.** None needed — the finding scopes itself correctly. Worth noting only that the session may live in sessionStorage instead when "keep me signed in" is off (lib/supabase.ts:77-81), and that browser eviction behaviour is not observable from this repo, which is why SUSPECTED is the right call.

**Done when.**

- [ ] RUNTIME_CACHE enforces a bounded entry count and/or byte budget with LRU trimming on each write
- [ ] Responses above a size threshold are never cached
- [ ] Cached entries carry a stored timestamp and are dropped past a defined age
- [ ] The worker's cache footprint is observable (a message channel or a debug page reporting entry count and total bytes)

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE; plan default budget (200 entries / 7 days) taken. Reproduced at `564720d`: `cachePut` had no size, count or age logic, and nothing trimmed `RUNTIME_CACHE` (every OFF-9 case fails against v6).
- `public/sw.js`: `MAX_RUNTIME_ENTRIES = 200`, `MAX_RUNTIME_AGE_MS = 7 days`, `MAX_RUNTIME_ENTRY_BYTES = 2 MiB` (`:91-93`). `putRuntime` (`:405`) refuses a declared `Content-Length` over the cap before reading, reads the body and refuses an actual size over it, and stores the entry with `X-Mfgos-Cached-At` (fetch time) and `X-Mfgos-Bytes`; `trimRuntime` (`:424`) drops the least recently used past 200 on every write (Cache Storage keeps last-written order) and sweeps expired entries at most hourly; `matchRuntime` (`:441`) never serves an entry past 7 days (it deletes it) and re-writes a served entry at the end of the order (true LRU, keeping its fetch time). `{ type: "CACHE_STATS" }` (answered on a MessagePort or to the asking page) reports entries, bytes, the oldest fetch time, the three limits and any shell asset that is missing (`cacheStats`, `:475`).
- Tests: `sw.test.ts` "OFF-9 — RUNTIME_CACHE is bounded…": stamping, the size cap (declared and actual), 200 entries LRU, a served entry outliving the next trim while keeping its exact original fetch time — seeded six days old, read offline, its `X-Mfgos-Cached-At` is still the six-days-ago value, and two days later the next offline read is refused (503) and the entry deleted, so a sliding TTL fails the case (tightened in the fix pass, after review; it previously asserted only that the stamp was present), the 7-day refusal (and an unstamped entry treated as expired), the hourly sweep on write, `CACHE_STATS`.
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ Bounded entry count with LRU trimming on each write.
2. ✓ Responses above 2 MiB are never cached.
3. ✓ Every entry carries its fetch time; past 7 days it is refused and deleted.
4. ✓ Observable through the `CACHE_STATS` message channel.

**Scope / residual.** The bound is per entry and per count (worst case 200 × 2 MiB); there is no running byte budget — with `/api/` and the PDFs excluded, entries are page shells and same-origin assets. `SHELL_CACHE` has no bound of its own: the cache-first static branch adds each build's content-hashed `/_next/static` chunks to it and nothing trims it. On Vercel it is per build — `VERSION` carries the build id, so activate drops the previous build's shell cache (`OFF-11`). On a self-hosted, unstamped deployment (Docker, `next start` — `SW_BUILD` stays `"unstamped"`) `VERSION` and `SHELL_CACHE` (`mfgos-v7-unstamped-shell`) are the same across every release, so on a long-lived device that cache grows with every deploy until a `SW_SCHEMA` bump or a Dockerfile build-id argument (`OFF-11` residual) rolls it — the quota exposure this finding describes, moved to the shell cache on those deployments. (The first cut's residual said "the shell cache is per build", which was true on Vercel only.)

---

<a id="off-10"></a>

## OFF-10 · The navigate branch breaks the worker's own hard rules: a bare `catch` with no abort check invents a 503 "You're offline" for a cancelled navigation, and the branch never rethrows despite the docblock claiming every branch does

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:19-30`, `public/sw.js:105-112`, `public/sw.js:157-177`, `public/sw.js:192-197`, `public/sw.js:213-218`, `app/d/[number]/route.ts:31` *(the redirect; the file was rewritten under `roles-and-permissions/EGRESS-2` but `/d/[number]` still ends in `NextResponse.redirect`, so this SW hazard is unchanged)*
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The inconsistency is real — two of three branches abort-check and the navigate branch does not. But the docblock half of the claim is a misreading: sw.js:22 says 'Every branch below ends in a real Response OR a rethrow', not that every branch rethrows, and hard rule 2 at :29-30 explicitly allows 'return a 503 that says what it is'. A navigation the browser itself cancelled is one it has already abandoned, so the 'fully-online user dropped onto the offline page' outcome is speculative; this is a code-hygiene defect, LOW.

**Mechanism.** The file states two rules. Hard rule 1 (sw.js:19-22): "Every branch below ends in a real Response or a rethrow." Hard rule 2 (sw.js:26-30): "never invent a server error … A cancelled prefetch dressed up as '504 (Offline)' reads like the platform fell over." `wasAborted` exists (sw.js:109-112) precisely to distinguish "the browser gave up on this" from "the network is down", and the static branch and the generic branch both honour it:

    } catch (err) {
      if (wasAborted(request, err)) throw err;      // sw.js:195
      return unavailableResponse();

    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (wasAborted(request, err)) throw err;      // sw.js:216
      return unavailableResponse();

The navigate branch does not:

    } catch {                                       // sw.js:164 — no error binding at all
      return (
        (await caches.match(request)) ||
        (await caches.match("/offline")) ||
        (await caches.match("/")) ||
        offlineHtmlResponse()                       // a synthesized 503
      );
    }

It cannot call `wasAborted` because it never binds the error, so a navigation the user cancelled — hitting stop, tapping a different link while a page loads, a backgrounded tab being throttled — is answered with a synthesized 503 "You're offline. This page isn't cached yet" (sw.js:81-92), which is exactly the invented server error rule 2 forbids, and it never rethrows, which is exactly the rethrow rule 1 promises.

**Failure scenario.** A technician on a slow plant link taps a document link, changes his mind, and taps a different one. The first navigation aborts. The worker answers it with a 503 offline page. Depending on timing the browser may commit that response, so a fully-online user is dropped onto "You're offline — this page isn't cached yet" and concludes the network died. The support report is "the app keeps telling me I'm offline when I'm not" — the same class of misleading report the v5 comment says the 504 removal was meant to end, left in place in the one branch a human actually sees.

**Evidence.**

```
public/sw.js:164 — `} catch {` with no binding, contrasted against sw.js:192 `} catch (err) {` and sw.js:213 `} catch (err) {`. sw.js:21-22 — "Every branch below ends in a real Response or a rethrow" is false for lines 157-177. The test suite asserts the opposite of the rule: lib/__tests__/sw.test.ts:64 asserts `expect(res!.status).toBe(503); // the synthetic offline page` for a failed navigation, with no case for an aborted one.
```

**Chain reaction.** The same branch caches redirected responses, which is a second navigation hazard: `/d/[number]` — the typeable short link printed next to title blocks — always ends in `NextResponse.redirect` (app/d/[number]/route.ts:31), so `fetch` follows it and `cachePut` stores a response with `redirected === true` under the `/d/...` key. Serving a redirected response to a navigation request is rejected by the browser, so an offline scan of a printed short link fails opaquely without even reaching the offline page. (SUSPECTED — the mechanism is in the code and the spec, the failure is not observable from the repo.)

> **Verifier correction.** Real as a code/doc inconsistency, but the harm is smaller than the write-up implies and one supporting claim is wrong. (a) Practical harm: for a genuinely aborted top-level navigation the browser discards whatever respondWith produces, and the branch tries `caches.match(request)` then `/offline` then `/` before synthesizing anything — so the invented 503 is a last resort in a case nobody is waiting on. The RSC prefetch traffic the docblock was actually written about is not routed here at all (sw.js:148-154 returns before the navigate branch). (b) The claim that "the test suite asserts the opposite of the rule" at lib/__tests__/sw.test.ts:64 is false — that case supplies `fetchImpl: async () => { throw new Error("offline") }` with an empty cache, i.e. an honest network failure, for which sw.js:29-30 explicitly sanctions "a 503 that says what it is". The valid half is that no test supplies an AbortError or an aborted signal, so wasAborted is untested.

**Done when.**

- [ ] The navigate branch binds its error and rethrows when `wasAborted(request, err)` is true, matching sw.js:195 and sw.js:216
- [ ] The docblock's rule-1 claim is true of every branch, or the claim is corrected
- [ ] Responses with `redirected === true` are not written to the cache for navigation requests
- [ ] lib/__tests__/sw.test.ts covers an aborted navigation and asserts the handler rejects rather than returning 503

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE. Reproduced at `564720d`: the navigate branch's `} catch {` bound no error, so an aborted navigation got the offline fallback, and a redirected response was stored (both cases fail against v6).
- `public/sw.js`: the navigate branch binds its error and rethrows when `wasAborted(request, err)` (`:581`), before reporting the network or touching any cache — matching the static (`:622`) and generic (`:645`) branches, where the abort check now also comes first. Hard rule 1 ("Every branch below ends in a real Response or a rethrow") is now true of every branch; the header text is unchanged. `isCacheableResponse` refuses any `redirected` response, and `/d/` is on `NEVER_CACHE_PREFIXES`.
- Tests: `sw.test.ts` "OFF-10 — a navigation the browser abandoned is rethrown…": an `AbortError` rejects (and no cache is consulted); an aborted `request.signal` rejects for both a navigation and a sub-resource; a redirected response is served and never stored; `/d/2002-D-10001` never written and its leftover never served. The genuine-network-failure case keeps its 503 assertion, now named as such.
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ The navigate branch binds the error and rethrows on `wasAborted`.
2. ✓ Rule 1 is true of every branch.
3. ✓ No redirected response is written (navigation or not).
4. ✓ `sw.test.ts` covers an aborted navigation and asserts a rejection, not a 503.

**Scope / residual.** None.

---

<a id="off-11"></a>

## OFF-11 · VERSION is a hand-edited literal with no tie to the build, so a deploy neither invalidates the runtime cache nor triggers the update toast

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:33-39`, `public/sw.js:52-65`, `package.json:6-12`, `components/pwa/ServiceWorkerManager.tsx:36-46`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Both halves of the title are literally true, but the stated consequence — 'no device shows an update prompt' — is false: components/system/UpdatePill.tsx:21-26 polls `/api/version` every 5 minutes and on tab focus and renders 'This tab is running an old version — tap to load the update' whenever the build id diverges, and it is mounted for every signed-in page at app/(protected)/layout.tsx:61. Combined with the runtime cache being network-first (stale bytes only ever served offline), this is LOW.

**Mechanism.** `const VERSION = "mfgos-v5";` (sw.js:37) is a string literal in a static file under `public/`. The activate handler drops every cache whose key does not start with VERSION (sw.js:56-62), and the file's own comment calls this "the escape hatch when caching behavior changes". Nothing in the build produces or rewrites that string: `package.json`'s only pre-step is `node scripts/copy-pdfjs-worker.mjs` (package.json:6, 8), which copies a pdf worker and touches nothing else, and `grep -rn "sw.js|VERSION|mfgos-v"` across ts/tsx/mjs/js/json outside node_modules finds the constant only at sw.js:37-39 and 59, plus the registration string at ServiceWorkerManager.tsx:33.

Two consequences follow from the file being byte-identical across deploys:

1. The browser's periodic sw.js byte-comparison finds no change, so no new worker installs, so `updatefound` (ServiceWorkerManager.tsx:46) never fires. The "Update available" toast is not merely broken on click (previous finding) — for an ordinary app deploy it never appears at all.
2. `mfgos-v5-runtime` survives every release. Everything the worker cached under build N — page HTML, verify verdicts, share PDFs, presigned-URL JSON — remains matchable under build N+5. The only thing that clears it is a human remembering to bump a literal in a file that no test and no CI step guards.

**Failure scenario.** A release ships the correct supersede logic and a corrected verify verdict. Every field device keeps answering from `mfgos-v5-runtime` whenever it is offline, and no device shows an update prompt, because sw.js has not changed since v5. The team's stated escape hatch is intact but nobody pulls it, and there is nothing that would tell them to.

**Evidence.**

```
public/sw.js:33-37 — the comment "Bumping VERSION drops every old cache on activate — the escape hatch when caching behavior changes" describes a manual procedure with no automation behind it. package.json scripts block has no sw generation step; `"prebuild": "node scripts/copy-pdfjs-worker.mjs"` and that script (scripts/copy-pdfjs-worker.mjs:30) writes only `public/pdf.worker.min.mjs`. No `next-pwa`/`workbox` dependency exists in package.json.
```

> **Verifier correction.** Both consequences need qualifying. (1) "No update path on an ordinary deploy" is wrong as stated: UpdatePill (components/system/UpdatePill.tsx:19-31, mounted at app/(protected)/layout.tsx:61) polls the real build id from /api/version (route.ts:14-17, `VERCEL_GIT_COMMIT_SHA`) and offers a working reload. The SW toast is what never appears. (2) The surviving runtime cache is read-only-on-failure: both writers are network-FIRST (sw.js:160-162 and 209-212), so a build-N entry is never served while the network is up. The cross-deploy persistence is an offline-exposure problem, which is what makes findings 1/3/5 possible, not a stale-code-while-online problem.

**Done when.**

- [ ] VERSION is derived from the deployed build id (the same `VERCEL_GIT_COMMIT_SHA` already used by app/api/version/route.ts:14-17), injected at build time so sw.js changes on every deploy
- [ ] A deploy demonstrably installs a new worker (updatefound fires) and its activate handler drops the previous build's runtime cache
- [ ] CI fails if sw.js's caching behaviour changes without VERSION changing

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE; plan default (a prebuild stamping script) taken. Reproduced at `564720d`: `const VERSION = "mfgos-v6";` was a literal nothing in the build touched; `package.json`'s `prebuild` only copied the pdf.js worker.
- `public/sw.js`: ``VERSION = `mfgos-v${SW_SCHEMA}-${SW_BUILD}` `` (`:77-79`). `SW_SCHEMA = 7` is the hand-bumped caching-behaviour generation; `SW_BUILD` is the build id. `activate` now drops every cache whose name does not start with `${VERSION}-` (the trailing dash so one build id cannot prefix another).
- `scripts/stamp-sw-version.mjs` (new), run by `prebuild` only (`package.json`): writes `SW_BUILD` from `VERCEL_GIT_COMMIT_SHA ?? VERCEL_DEPLOYMENT_ID` — the id `/api/version` serves; an empty value counts as unset — keeping only `[A-Za-z0-9_-]`, at most 64. With neither variable (`next dev` — `predev` does not run it — a local `npm run build`, the Docker image, whose Dockerfile passes no Vercel variables) the id is the deterministic `"unstamped"`, which is exactly what the committed file carries, so the file is left byte-identical: no local build dirties the tree, and running it without an id restores a stamped file. A worker without exactly one `const SW_BUILD = "…";` line fails the build. Documented in the script header and in the worker.
- CI guard: `sw.test.ts` fingerprints the worker's code (comments, whitespace and the build stamp stripped via the TypeScript transpiler) per `SW_SCHEMA`; a behaviour change without a bump fails with the fingerprint to record as a NEW entry. The guard is a speed bump, not a lock — an entry can be overwritten in place; the test's comment forbids that once a schema has merged. Schema 7's entry was re-recorded once, by this package's own fix pass, before schema 7 had merged anywhere (the verify fail-safe, the shell re-warm order and the static branch's reporting changed the code). The VERSION-shape case no longer pins `SW_SCHEMA` to 7, so a bump edits `SW_SCHEMA` and adds a fingerprint — one place.
- Tests: `sw.test.ts` "OFF-11 — VERSION follows the build…": the VERSION shape and the committed `"unstamped"` (a stamped file can never be committed); activate drops other builds' and schemas' caches and keeps its own three; the fingerprint guard (comment-only edits and the stamp do not trip it, a code edit does); `resolveBuildId` precedence, empty-as-unset, sanitizing and the 64 cap; `stampSource` exactly-one / idempotent / restoring; the script end to end on a temp copy (untouched without an id, stamped with one, non-zero exit without a stamp line); `prebuild` runs it and `predev` / `dev` do not.
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ VERSION carries the deployed build id, injected at build time, so sw.js changes on every Vercel deploy.
2. ✓ By construction and test: a new build id changes the worker's bytes (the browser's install trigger), and activate drops every cache of another build. Not observed on a live deploy (no browser here). Self-hosted images without a build id keep `"unstamped"` and roll only on a `SW_SCHEMA` bump — the documented fallback.
3. ✓ The fingerprint test fails CI when the worker's code changes without `SW_SCHEMA` changing.

**Scope / residual.** Self-hosted deployments: the Dockerfile declares no build argument for a build id, so the image is always `"unstamped"`; giving it one (an `ARG`/`ENV` `VERCEL_GIT_COMMIT_SHA` before `npm run build`) is a Dockerfile change outside this package — until then those deployments rely on `UpdatePill` plus `SW_SCHEMA` bumps, as before, and their `SHELL_CACHE` is never rolled between releases, so it grows with every deploy's hashed chunks (`OFF-9` residual).

---

<a id="off-12"></a>

## OFF-12 · cache.addAll is atomic and its failure is swallowed — one bad shell asset silently leaves the device with no offline shell and no offline page at all

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:41`, `public/sw.js:43-50`, `public/sw.js:167-171`, `app/manifest.ts:9-33`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The mechanism is right; the consequence in the title is wrong. sw.js:167-171 ends the offline navigation chain in `offlineHtmlResponse()`, a self-contained inline 503 page that needs no cache at all, so 'no offline page at all' is refuted by the very lines the finding cites; and the cache-first branch at :184-190 re-populates SHELL_CACHE with every JS/CSS/image asset on first online use, so the shell is not permanently lost either. What is actually lost is the styled /offline route and the pre-warm.

**Mechanism.** const SHELL_ASSETS = ["/", "/offline", "/icon.svg", "/manifest.webmanifest"];

    self.addEventListener("install", (event) => {
      event.waitUntil(
        caches
          .open(SHELL_CACHE)
          .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
          .then(() => self.skipWaiting()),
      );
    });

`Cache.addAll` is all-or-nothing: if any one entry fetches to a non-2xx or fails, the whole call rejects and **nothing** is written. The `.catch(() => undefined)` then converts that total failure into a successful install, and `skipWaiting()` runs regardless — so the worker activates, claims clients, and reports itself healthy with an entirely empty shell cache.

The consequences are invisible and total. `caches.match("/offline")` and `caches.match("/")` are the second and third fallbacks for every failed navigation (sw.js:167-170); with an empty shell cache, both miss and every offline navigation gets the bare inline `offlineHtmlResponse()` (sw.js:81-92) instead of the styled app offline page. And the four assets include `/manifest.webmanifest`, a Next metadata route generated from app/manifest.ts — a path that is one framework-convention change away from 404ing, at which point the app silently loses its entire offline shell with no error anywhere.

**Failure scenario.** A deploy changes the manifest route or a CDN rule briefly 404s `/icon.svg` during a rollout. Every device that installs or reinstalls the worker in that window gets an empty shell cache. Nothing logs it, no state differs, and the pill still says the app is showing cached data. Months later someone notices field devices show a bare dark "You're offline" card instead of the branded offline page and cannot reproduce it, because their own device installed the worker on a good day.

**Evidence.**

```
public/sw.js:43-50 quoted above — a single `.catch(() => undefined)` wrapping the atomic `addAll`, followed unconditionally by `skipWaiting()`. public/sw.js:167-170 — `(await caches.match("/offline")) || (await caches.match("/")) || offlineHtmlResponse()` is the chain that quietly degrades. app/manifest.ts:9 exports the Next metadata route that produces `/manifest.webmanifest`.
```

> **Verifier correction.** "No offline shell at all" is too absolute. The navigate branch writes every successful navigation into RUNTIME_CACHE (sw.js:160-162), so after the first online visit `caches.match(request)` — the FIRST fallback at sw.js:168 — still serves "/" and any page the user has opened. What an empty shell cache actually costs is the styled /offline page and the "/" fallback for never-visited URLs, which degrade to the inline offlineHtmlResponse(). The /manifest.webmanifest-404 scenario is speculation about a future framework change, not an observed defect; the durable point is that a total install failure is indistinguishable from success.

**Done when.**

- [ ] Shell assets are cached individually (`Promise.allSettled` over per-asset `cache.add`) so one failure does not discard the rest
- [ ] A failed shell precache is reported — at minimum a console warning naming the asset, ideally a signal the app can surface
- [ ] A test asserts that when one SHELL_ASSETS entry fails, the others are still cached

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE. Reproduced at `564720d`: `cache.addAll(SHELL_ASSETS).catch(() => undefined)` — one failing asset discarded the whole shell silently (fails against v6).
- `public/sw.js`: `precacheShell` (`:104`) opens the shell cache and runs `cache.add` per asset under `Promise.allSettled`; the failures are returned and named in one `console.warn`; it never rejects (a worker without a shell still serves the network and the inline notice). Install uses it (`:128`); `rememberSession` re-runs it for the missing assets only on every `SESSION` announcement — as its last step (`:209`), after the identity check and purge, because a shell fetch has no timeout and a changed identity's purge must not wait behind it (fix pass, after review) — so a failed precache (or a sign-out that emptied Cache Storage, `OFF-8`) heals on the next sign-in. `CACHE_STATS` lists `shellMissing` — the signal a page can surface.
- Tests: `sw.test.ts` "one failing shell asset does not discard the others, and is named in a console warning"; "a SESSION announcement re-warms only the shell assets that are missing"; "the same identity again still re-warms a missing shell asset"; "a changed identity's purge never waits behind the shell re-warm — even a shell fetch that never answers" (fails against the first cut, `0916d17`); `CACHE_STATS` reports the missing ones.
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ Shell assets are cached individually under `Promise.allSettled`.
2. ✓ A failed precache is a console warning naming the asset, and is readable through `CACHE_STATS`.
3. ✓ Asserted by test.

**Scope / residual.** No page surfaces `shellMissing` yet; the channel exists.

---

<a id="off-13"></a>

## OFF-13 · cachePut ignores Cache-Control entirely — every route that declares `no-store` is written to disk anyway, including the full stamped controlled PDF

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `public/sw.js:116-120`, `app/api/share/file/route.ts:152-158`, `app/api/data-export/structured/route.ts:17`, `app/api/admin/shed/route.ts:204`, `app/api/admin/ticket-shed/route.ts:256`, `app/api/version/route.ts:20`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. Survives on the facts, but two of the six cited locations are unreachable: app/api/admin/shed/route.ts:204 and app/api/admin/ticket-shed/route.ts:256 are inside POST handlers (:93 and :101), and sw.js:124 `if (request.method !== "GET") return;` means the worker never sees them. The headline harm is also mostly pre-existing — /api/share/file is served `Content-Disposition: attachment` (:148) and the page writes it to disk via an `<a download>`, so the contractor has the PDF on the tablet either way; the genuine residual is an invisible copy that outlives share revocation. LOW.

**Mechanism.** `cachePut` is the single write path for both caches and its whole gate is:

    function cachePut(cacheName, request, response) {
      if (!response || !response.ok || response.type === "opaque") return;
      const copy = response.clone();
      caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => undefined);
    }

There is no `response.headers.get("cache-control")` read anywhere in the file. Five same-origin GET routes explicitly declare `Cache-Control: no-store`, and every one of them is a plain no-extension pathname that lands in the generic branch (sw.js:207-220) and gets stored:

- `/api/share/file` (share/file/route.ts:145-151) returns the **complete stamped PDF of the controlled document** with `"Cache-Control": "no-store"`. The share page fetches it with `fetch(data.fileUrl)` (app/share/[token]/page.tsx:67), a same-origin GET — so the drawing's bytes are written to Cache Storage.
- `/api/data-export/structured` (GET, structured/route.ts:17) returns a structured org export under `no-store` (line 76).
- `/api/admin/shed` and `/api/admin/ticket-shed` GET previews (`no-store` at :204 and :256).
- `/api/version` sends `cache-control: no-store` (version/route.ts:20).

`no-store` is the strongest statement a server can make about a response, and it is the mechanism every one of these routes chose to prevent exactly this. The worker overrides all of them silently.

**Failure scenario.** An engineer shares a P&ID with an outside contractor. The contractor opens the link on a tablet and downloads the stamped copy. `/api/share/file` responds `no-store` — but the service worker has already forked a clone into `mfgos-v5-runtime`. The PDF now lives on that tablet's disk under an origin the contractor's IT department does not know is storing plant drawings, survives closing the browser, and is never removed by anything in this codebase (no `caches.delete` outside sw.js's activate handler — see the sign-out finding). For the admin export route the same mechanism persists a structured dump of org tables to whatever machine ran the export.

**Evidence.**

```
public/sw.js:116-120 quoted above — the function body is four lines and reads no headers. app/api/share/file/route.ts:145-151 — `return new NextResponse(Buffer.from(outBytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": ..., "Cache-Control": "no-store" } });`. `grep -rn '"Cache-Control"' --include=*.ts app/` returns exactly five routes, four of which are GET (`app/api/data-export/run/route.ts` is POST and therefore skipped by sw.js:124).
```

**Chain reaction.** This is the same defect as the verify-verdict replay seen from the server's side: the worker's cacheability rule is `res.ok`, so the only way to keep anything out of it is for the request to be non-GET or cross-origin. Every future route that thinks `Cache-Control: no-store` protects it is wrong by default.

> **Verifier correction.** Two of the five cited routes are wrong. app/api/admin/shed/route.ts:204 and app/api/admin/ticket-shed/route.ts:256 are inside the POST handlers (`export async function POST` at shed:93 and ticket-shed:101 — the archive-ZIP responses), and sw.js:124 `if (request.method !== "GET") return;` skips POST entirely. Their GET preview handlers (shed:66-91, ticket-shed:72-100) return a plain `NextResponse.json(...)` with NO Cache-Control at all. So the affected set is three GETs, not five: /api/share/file, /api/data-export/structured (GET at :17, no-store at :76), /api/version. `grep -rn 'Cache-Control' app lib` returns six lines across five files, and three of those (shed, ticket-shed, data-export/run) are POST-only. Severity down to MEDIUM: the one that matters is the share PDF, and the recipient deliberately saved that same file to disk via the blob download on the very request that cached it (share page:74-82).

**Done when.**

- [ ] cachePut refuses to store any response whose `Cache-Control` contains `no-store` or `private`
- [ ] A vitest case in lib/__tests__/sw.test.ts feeds the fetch handler a 200 response carrying `Cache-Control: no-store` and asserts `cacheStore.put` was not called
- [ ] `/api/share/file` responses are never present in Cache Storage after a download on a device with the worker installed

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE, completing `XEDGE-6`. Reproduced at `564720d`: the `no-store` / `private` refusal and the blanket `/api/` refusal had already landed with `XEDGE-6` (P2 EGRESS, 2026-09-23) — `/api/share/file`'s `no-store` was honoured and no `/api/` GET was stored; `no-cache` was still stored (fails against v6).
- `public/sw.js`: `isCacheableResponse` (`:377`) refuses `no-store`, `no-cache` and `private` (an offline fallback can never revalidate, so `no-cache` is a refusal too); `/api/share/` is on `NEVER_CACHE_PREFIXES` besides.
- Tests: `sw.test.ts` "never writes a Cache-Control: no-store response — navigation or sub-resource" (kept from XEDGE-6), "refuses Cache-Control: private and no-cache the same way", "a public, revalidating response (Vercel's static HTML) is still cached", and `/api/share/file?token=…` among the per-route cases.
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ `no-store` and `private` (and `no-cache`) are refused.
2. ✓ The vitest case feeds a 200 `no-store` response and asserts no `put`.
3. ✓ `/api/share/file` is never stored — refused three ways (the never-cache list, the `/api/` rule, its own `no-store`).

**Scope / residual.** None.

---

<a id="off-14"></a>

## OFF-14 · lib/__tests__/sw.test.ts calls itself a regression guard for the worker but asserts only "never resolves to undefined" — nothing tests what is cached, and one assertion locks in the wrong behaviour

- **Severity:** LOW
- **Status:** RESOLVED
- **Verification:** CONFIRMED
- **Locations:** `lib/__tests__/sw.test.ts:1-8`, `lib/__tests__/sw.test.ts:20-24`, `lib/__tests__/sw.test.ts:55-65`, `lib/__tests__/sw.test.ts:89-115`, `lib/__tests__/sw.test.ts:130-136`
- **Independently verified:** ✓ **SURVIVES, corrected** — second independent adversarial pass. Severity **MEDIUM → LOW** by this pass. The substantive gap is real — the cache-write assertions the title asks for do not exist. But 'asserts only never resolves to undefined' overstates it: :74 and :86 assert the network status and the exact cached Response identity, and :113-114 `expect(responded).toBe(false); expect(caches.match).not.toHaveBeenCalled();` is a genuine assertion about cache behaviour for RSC payloads. Test-coverage gap with no runtime consequence: LOW.

**Mechanism.** The file's header claims a broad guard — "Regression guard for the service worker (public/sw.js): every fetch branch must resolve to a real Response" — and it genuinely loads the real worker source (`readFileSync(resolve(process.cwd(), "public/sw.js"))`, line 37) into a mocked scope, which is a good harness. But the six cases cover only navigation Response-ness, RSC non-interception, and the cross-origin/non-GET skip.

The mock makes the untested area structurally invisible: `cacheStore.put` is `vi.fn(async () => undefined)` (line 21) and no test ever inspects its arguments. So there is no assertion anywhere about **what** the worker writes — not that `no-store` is refused, not that authorization-gated responses are skipped, not that a verify verdict is excluded, not that a redirected response is not stored for a navigation. Every finding in this report about *what gets cached* is in the blind spot of a suite that appears to cover the file.

One assertion is actively wrong: line 64 asserts `expect(res!.status).toBe(503); // the synthetic offline page` for a failed navigation, pinning the behaviour that violates the worker's own hard rule 2 for the aborted-navigation case, and there is no case supplying an `AbortError` or an aborted signal at all — so `wasAborted` (sw.js:109-112), the function written specifically to enforce that rule, is entirely untested.

**Failure scenario.** An engineer fixes the verify-verdict caching by adding a path exclusion, runs `npm test`, sees six green service-worker tests, and ships. A later refactor reorders the branch checks and silently reintroduces caching for `/api/verify` — all six tests still pass, because none of them ever looks at the cache. The suite's existence makes the worker look guarded and therefore safe to change.

**Evidence.**

```
lib/__tests__/sw.test.ts:20-24 — the cache mock's `put` is a bare `vi.fn` never asserted against; only `caches.match` is asserted, and only once (line 114, `expect(caches.match).not.toHaveBeenCalled()`). Lines 55-136 contain every case in the file; none constructs a response with a `Cache-Control` header, an `authorization` request header, or an abort.
```

> **Verifier correction.** Drop the "one assertion is actively wrong" limb. sw.test.ts:55-65 supplies `fetchImpl: async () => { throw new Error("offline") }` with `cacheMatch: async () => undefined` — a genuinely offline navigation with nothing cached, which is precisely the case sw.js:29-30 sanctions ("we either serve it from cache, fail it, or return a 503 that says what it is"). Asserting 503 there pins correct behaviour, not the rule violation; the aborted-navigation case the finding is thinking of is simply absent from the file. The coverage blind spot is the whole of the surviving finding.

**Done when.**

- [ ] A test asserts `cacheStore.put` is NOT called for a response carrying `Cache-Control: no-store`
- [ ] A test asserts `cacheStore.put` is NOT called, and `caches.match` NOT consulted, for `/api/verify`, `/api/verify-hold`, `/api/verify-package`, `/api/verify-ticket`, `/api/share/file`, `/api/share/resolve`, `/api/storage/download-url` and `/api/transmittal`
- [ ] A test supplies an aborted request/AbortError to the navigate branch and asserts the handler rejects rather than returning 503
- [ ] The line-64 assertion is scoped to a genuine network failure, with a separate case covering abort

**Resolution (2026-10-01, public-surfaces Round F).** PKG-1 SW-OFFLINE — written first, before the worker changed. Reproduced at `564720d`: `XEDGE-6` (P2 EGRESS) had already added `put` assertions — a `no-store` response, `private`, an `/api/` JSON, a non-API GET — so done-when 1 was met there; still missing were the per-route cases (one generic `/api/storage/download-url` offline case was the only "cache not consulted" assertion), any abort case (`wasAborted` untested), and a scoped name for the genuine-failure 503 case.
- `lib/__tests__/sw.test.ts` (115 cases; the six v5 regression cases kept, the XEDGE-6 cases kept): the harness keeps per-cache stores in Cache Storage's last-written order, resolves relative keys like the real API, captures every `waitUntil` so a case can await the worker's own cache writes, injects a clock and a console, and records what the worker posts to windows. The first cut had 96 cases, of which the v6 worker failed 44; after the fix pass (the verify-page fail-safe, the shell re-warm order, the static branch's reporting, the LRU fetch-time pin) the v6 worker fails 62 of 115 and the first v7 cut (`0916d17`) fails 17 — a handful of the v6 failures (the session and VERSION cases) only because the v6 file has no `SW_SCHEMA` line to name its caches by; the current worker passes all 115. The LRU case was also checked against a deliberately sliding-TTL mutant of `matchRuntime`, which it fails.
- Verified: `npx tsc --noEmit` 0; `npx eslint --max-warnings=0` 0 on every touched source file; full `npx vitest run` green (280 files / 5622 passed, 5 expected-fail; re-run after the fix pass). `next build` is the integrator's.

**Done-when.**
1. ✓ A 200 `Cache-Control: no-store` response is never `put` — navigation and sub-resource.
2. ✓ No `put` and no `caches.match` for `/api/verify`, `/api/verify-hold`, `/api/verify-package`, `/api/verify-ticket`, `/api/share/file`, `/api/share/resolve`, `/api/storage/download-url` and `/api/transmittal` (and `/api/intake/*`), each asserted online and offline with leftovers.
3. ✓ An `AbortError` and an aborted `request.signal` reject from the navigate branch rather than returning 503.
4. ✓ The old line-64 case is now "returns a real Response for a navigation that genuinely fails — network down, nothing cached", with the abort cases separate.

**Scope / residual.** None.

---

<a id="off-15"></a>

## OFF-15 · The viewer's custom stamp images are kept device-wide, not per account, so the next person on a shared tablet is offered the last person's uploaded stamps

- **Severity:** LOW
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/viewers/FullScreenViewer.tsx:344`, `components/viewers/FullScreenViewer.tsx:352`, `components/providers/RoleContext.tsx` (`CLIENT_STORAGE_INVENTORY`, the `manufacturingos.customStamps` row)
- **Independently verified:** — opened 2026-10-07 by identity-and-session Round G (IS-P1) while inventorying the client storage for `OFF-8` done-when 3, per DEC-31; read against the branch, not yet challenged by a second party.

**Mechanism.** The full-screen viewer persists the stamp images a person uploads (PNG / JPG data URLs, up to 12) under one localStorage key, `manufacturingos.customStamps` — read in the `useState` initialiser (`:344`) and written by `persistCustomStamps` (`:352`). The key is not scoped to the account: it carries no uid, and nothing clears it at sign-out. `OFF-8`'s inventory classes it "device" — it is not something an account READ from the server, so the sign-out purge leaves it, and clearing it there would delete a person's uploaded stamps on every sign-out, a flow that works today.

**Failure scenario.** On a shared field tablet an inspector uploads a stamp image of their initials and "VERIFIED IN FIELD" and signs out at the end of the shift. The next person signs in on the same tablet, opens a drawing and finds that stamp in their stamp menu; they can place the previous person's initials on a markup.

**Done when.**

- [ ] The stamp list is stored per account (keyed by uid, as `lib/dashboard/config.ts` and `hooks/useDismissed.ts` key theirs), so the next account on the device is never offered it and the same account keeps its stamps across sign-outs.
- [ ] Stamps already stored under the device-wide key are not shown to an account other than the one that uploaded them (moved to the first account that signs in, or dropped, deliberately and said).
- [ ] `OFF-8`'s inventory row moves from "device" to "uid-scoped", and its census still passes.

**Owner.** The full-screen viewer's owner (`components/viewers/FullScreenViewer.tsx` — public-surfaces PS-STAMP's file, merged); for the integrator to assign.

---
