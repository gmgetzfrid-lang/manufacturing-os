// Total-route JavaScript budget (projects-tab PERF-12) — the pure logic.
//
// A route's first-load JavaScript is everything the browser fetches before the
// route can hydrate: the framework's `rootMainFiles` (.next/build-manifest.json)
// plus every chunk its client-reference manifest lists under `entryJSFiles` —
// the root and group layouts, the error / loading / not-found boundaries and
// the page itself (.next/server/app/<route>/page_client-reference-manifest.js).
// This is the measure PERF-9's J12 pass used. Chunks loaded later through
// `next/dynamic` or `import()` are not in either list, so they do not count.
//
// The route's OWN chunks are the page entry's chunks that no other entry and
// no root main file lists; everything else is the SHELL the route shares with
// its layouts. `check.mjs` is the command-line check over a built `.next`;
// this file has no filesystem access so its arithmetic can be tested on a
// fixture (lib/__tests__/j18RouteJsBudget.test.ts).

import vm from "node:vm";

/** Evaluates one `*_client-reference-manifest.js` (it only assigns into
 *  `globalThis.__RSC_MANIFEST`) in an empty context and returns the map of
 *  manifest key → manifest. No module, require or process is reachable. */
export function parseClientReferenceManifest(source) {
  const sandbox = Object.create(null);
  sandbox.globalThis = sandbox;
  vm.runInNewContext(String(source), sandbox, { timeout: 1000 });
  const out = sandbox.__RSC_MANIFEST;
  if (!out || typeof out !== "object") throw new Error("not a client-reference manifest: nothing was assigned to __RSC_MANIFEST");
  return { ...out };
}

/** "/(protected)/projects/[id]/page" → "/projects/[id]"; route groups drop
 *  out of the URL, "/page" is the leaf. */
export function routeFromManifestKey(key) {
  const parts = String(key).split("/").filter(Boolean);
  if (parts[parts.length - 1] === "page") parts.pop();
  const url = parts.filter((p) => !(p.startsWith("(") && p.endsWith(")")));
  return "/" + url.join("/");
}

/** The `entryJSFiles` key of the page itself: "[project]/app" + manifest key. */
export function pageEntryKey(key) {
  return `[project]/app${key}`;
}

const norm = (f) => String(f).replace(/^\/?_next\//, "").replace(/^\//, "");

/** Splits one route's first-load chunks into the shell and its own.
 *  `entryJSFiles` is the manifest's map; `pageEntry` names the page's entry.
 *  A server-component page has no entry of its own (nothing of it ships to
 *  the browser): its own share is empty and the route is all shell.
 *  Returns sorted, de-duplicated file lists (paths relative to `.next`). */
export function routeChunks({ entryJSFiles, pageEntry, rootMainFiles }) {
  const entries = entryJSFiles ?? {};
  const pageFiles = Object.prototype.hasOwnProperty.call(entries, pageEntry) ? entries[pageEntry] : [];
  const root = new Set((rootMainFiles ?? []).map(norm));
  const elsewhere = new Set(root);
  for (const [k, list] of Object.entries(entries)) {
    if (k === pageEntry) continue;
    for (const f of list) elsewhere.add(norm(f));
  }
  const all = new Set(root);
  for (const list of Object.values(entries)) for (const f of list) all.add(norm(f));
  const own = [...new Set(pageFiles.map(norm))].filter((f) => !elsewhere.has(f)).sort();
  const ownSet = new Set(own);
  const shell = [...all].filter((f) => !ownSet.has(f)).sort();
  return { files: [...all].sort(), shell, own };
}

/** Sums bytes over a file list with a size lookup (`sizeOf(file) → number`). */
export function sumBytes(files, sizeOf) {
  let n = 0;
  for (const f of files) {
    const s = sizeOf(f);
    if (!Number.isFinite(s)) throw new Error(`no size for ${f}`);
    n += s;
  }
  return n;
}

/** One route's measurement. */
export function measureRoute({ key, manifest, rootMainFiles, sizeOf }) {
  const pageEntry = pageEntryKey(key);
  const { files, shell, own } = routeChunks({ entryJSFiles: manifest.entryJSFiles, pageEntry, rootMainFiles });
  return {
    route: routeFromManifestKey(key),
    key,
    chunks: files.length,
    totalBytes: sumBytes(files, sizeOf),
    shellBytes: sumBytes(shell, sizeOf),
    ownBytes: sumBytes(own, sizeOf),
  };
}

/** Whether a measured route sits under the signed-in `(protected)` layout. */
export const isProtectedRoute = (m) => String(m.key).startsWith("/(protected)/");

/** A route's budget: its named one, else the default for its side — the
 *  protected default, or `publicDefaultRouteMaxBytes` for a route outside
 *  the `(protected)` layout (a public page is a third the size of a
 *  protected one, so the protected default would let it grow unnoticed). */
export function budgetFor(m, budgets) {
  const named = budgets.routes ?? {};
  if (Object.prototype.hasOwnProperty.call(named, m.route)) return named[m.route];
  if (!isProtectedRoute(m) && Number.isFinite(budgets.publicDefaultRouteMaxBytes)) return budgets.publicDefaultRouteMaxBytes;
  return budgets.defaultRouteMaxBytes;
}

/** Checks measurements against the budgets:
 *    { routes: { "/projects/[id]": maxTotalBytes, … },
 *      defaultRouteMaxBytes, publicDefaultRouteMaxBytes, shellMaxBytes }
 *  Every measured route is held to its named budget, else its side's default
 *  (budgetFor); every route's shell share is held to `shellMaxBytes`. A named
 *  route that was not measured fails too (a renamed route must not silently
 *  drop its budget). */
export function checkBudgets(measurements, budgets) {
  const failures = [];
  const named = budgets.routes ?? {};
  const seen = new Set(measurements.map((m) => m.route));
  for (const r of Object.keys(named)) {
    if (!seen.has(r)) failures.push(`${r}: has a budget but no built manifest (renamed or removed? update the budget file)`);
  }
  for (const m of measurements) {
    const max = budgetFor(m, budgets);
    if (Number.isFinite(max) && m.totalBytes > max) {
      failures.push(`${m.route}: ${m.totalBytes} bytes of first-load JavaScript, over its budget of ${max}`);
    }
    if (Number.isFinite(budgets.shellMaxBytes) && m.shellBytes > budgets.shellMaxBytes) {
      failures.push(`${m.route}: its shell is ${m.shellBytes} bytes, over the shell budget of ${budgets.shellMaxBytes}`);
    }
  }
  return failures;
}
