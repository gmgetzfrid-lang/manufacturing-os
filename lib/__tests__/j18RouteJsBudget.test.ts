// projects-tab PERF-12 (projects-joint J18 APP SHELL BUDGET) — the total-route
// JavaScript budget's arithmetic, on a fixture shaped like a built `.next`.
//
// The check itself (scripts/perf/route-js-budget/check.mjs) runs after
// `next build` — `npm run build && npm run perf:budget`, and in CI after the
// production build. This suite pins what it counts and when it fails, with no
// build and no network: rootMainFiles + every entryJSFiles chunk of the
// route's client-reference manifest, each chunk once; the page's own chunks
// apart from the shell; a server-component page as all shell; a named route
// over its budget, any route over the default, a shell over the shell budget
// and a budgeted route that no longer exists all fail.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseClientReferenceManifest,
  routeFromManifestKey,
  pageEntryKey,
  routeChunks,
  measureRoute,
  checkBudgets,
  budgetFor,
} from "../../scripts/perf/route-js-budget/budget.mjs";

const manifestSource = (key: string, entryJSFiles: Record<string, string[]>) =>
  `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n` +
  `globalThis.__RSC_MANIFEST[${JSON.stringify(key)}] = ${JSON.stringify({ moduleLoading: { prefix: "" }, clientModules: {}, entryCSSFiles: {}, entryJSFiles })};`;

// A project page: two root main files, the root layout, the (protected)
// layout (sharing one chunk with the root), the error boundary (sharing the
// protected layout's) and the page (sharing one shell chunk, owning two).
const PROJECT_ENTRIES: Record<string, string[]> = {
  "[project]/app/layout": ["static/chunks/root-layout.js"],
  "[project]/app/error": ["static/chunks/root-layout.js", "static/chunks/error.js"],
  "[project]/app/(protected)/layout": ["static/chunks/root-layout.js", "static/chunks/shell-a.js", "static/chunks/shell-b.js"],
  "[project]/app/(protected)/error": ["static/chunks/shell-a.js"],
  "[project]/app/(protected)/projects/[id]/page": ["static/chunks/shell-a.js", "static/chunks/shell-b.js", "static/chunks/own-1.js", "static/chunks/own-2.js"],
};
const ROOT_MAIN = ["static/chunks/react.js", "static/chunks/turbopack-runtime.js"];
const SIZES: Record<string, number> = {
  "static/chunks/react.js": 1000,
  "static/chunks/turbopack-runtime.js": 100,
  "static/chunks/root-layout.js": 50,
  "static/chunks/error.js": 7,
  "static/chunks/shell-a.js": 300,
  "static/chunks/shell-b.js": 200,
  "static/chunks/own-1.js": 40,
  "static/chunks/own-2.js": 2,
  "static/chunks/other-page.js": 11,
};
const sizeOf = (f: string) => SIZES[f];

describe("PERF-12 — what a route's first-load JavaScript is", () => {
  it("parses a client-reference manifest without running anything but its assignment", () => {
    const parsed = parseClientReferenceManifest(manifestSource("/(protected)/projects/[id]/page", PROJECT_ENTRIES));
    expect(Object.keys(parsed)).toEqual(["/(protected)/projects/[id]/page"]);
    expect(parsed["/(protected)/projects/[id]/page"].entryJSFiles).toEqual(PROJECT_ENTRIES);
    // no require / process in the sandbox: a manifest that reaches for them throws
    expect(() => parseClientReferenceManifest("require('fs')")).toThrow();
    expect(() => parseClientReferenceManifest("process.exit(1)")).toThrow();
    expect(() => parseClientReferenceManifest("var x = 1;")).toThrow(/__RSC_MANIFEST/);
  });

  it("names the route by its URL: groups drop out, /page is the leaf", () => {
    expect(routeFromManifestKey("/(protected)/projects/[id]/page")).toBe("/projects/[id]");
    expect(routeFromManifestKey("/page")).toBe("/");
    expect(routeFromManifestKey("/(public)/verify/[docId]/page")).toBe("/verify/[docId]");
    expect(routeFromManifestKey("/_not-found/page")).toBe("/_not-found");
    expect(pageEntryKey("/(protected)/projects/[id]/page")).toBe("[project]/app/(protected)/projects/[id]/page");
  });

  it("counts rootMainFiles + every entry's chunks, each once; the page's own are the chunks nothing else lists", () => {
    const { files, shell, own } = routeChunks({
      entryJSFiles: PROJECT_ENTRIES,
      pageEntry: "[project]/app/(protected)/projects/[id]/page",
      rootMainFiles: ROOT_MAIN,
    });
    expect(files).toEqual([
      "static/chunks/error.js", "static/chunks/own-1.js", "static/chunks/own-2.js", "static/chunks/react.js",
      "static/chunks/root-layout.js", "static/chunks/shell-a.js", "static/chunks/shell-b.js", "static/chunks/turbopack-runtime.js",
    ]);
    expect(own).toEqual(["static/chunks/own-1.js", "static/chunks/own-2.js"]);
    expect(shell).toEqual(files.filter((f) => !own.includes(f)));
    const m = measureRoute({
      key: "/(protected)/projects/[id]/page",
      manifest: { entryJSFiles: PROJECT_ENTRIES },
      rootMainFiles: ROOT_MAIN,
      sizeOf,
    });
    // 1000 + 100 + 50 + 7 + 300 + 200 + 40 + 2 — the shared chunks once, not per entry
    expect(m).toEqual({ route: "/projects/[id]", key: "/(protected)/projects/[id]/page", chunks: 8, totalBytes: 1699, shellBytes: 1657, ownBytes: 42 });
  });

  it("a chunk the root main files also list is shell, and a '/_next/' prefix is the same file", () => {
    const { own, files } = routeChunks({
      entryJSFiles: { "[project]/app/x/page": ["/_next/static/chunks/react.js", "static/chunks/own-1.js"] },
      pageEntry: "[project]/app/x/page",
      rootMainFiles: ROOT_MAIN,
    });
    expect(own).toEqual(["static/chunks/own-1.js"]);
    expect(files).toEqual(["static/chunks/own-1.js", "static/chunks/react.js", "static/chunks/turbopack-runtime.js"]);
  });

  it("a server-component page (no entry of its own) is all shell", () => {
    const entries = { ...PROJECT_ENTRIES };
    delete entries["[project]/app/(protected)/projects/[id]/page"];
    const m = measureRoute({ key: "/(protected)/control-tower/page", manifest: { entryJSFiles: entries }, rootMainFiles: ROOT_MAIN, sizeOf });
    expect(m.ownBytes).toBe(0);
    expect(m.totalBytes).toBe(m.shellBytes);
    expect(m.totalBytes).toBe(1000 + 100 + 50 + 7 + 300 + 200);
  });

  it("a chunk with no size is an error, never a zero", () => {
    expect(() => measureRoute({
      key: "/x/page",
      manifest: { entryJSFiles: { "[project]/app/x/page": ["static/chunks/missing.js"] } },
      rootMainFiles: [],
      sizeOf,
    })).toThrow(/no size for static\/chunks\/missing\.js/);
  });
});

describe("PERF-12 — when the budget fails", () => {
  const m = (route: string, totalBytes: number, shellBytes: number) => ({ route, key: route, chunks: 1, totalBytes, shellBytes, ownBytes: totalBytes - shellBytes });
  const budgets = { routes: { "/projects/[id]": 1700 }, defaultRouteMaxBytes: 1500, shellMaxBytes: 1660 };

  it("at or under every budget: no failure", () => {
    expect(checkBudgets([m("/projects/[id]", 1700, 1657), m("/inbox", 1500, 1400)], budgets)).toEqual([]);
  });
  it("a named route one byte over its own budget fails, though it is under nothing else", () => {
    expect(checkBudgets([m("/projects/[id]", 1701, 1657)], budgets)).toEqual([
      "/projects/[id]: 1701 bytes of first-load JavaScript, over its budget of 1700",
    ]);
  });
  it("any other route is held to the default", () => {
    expect(checkBudgets([m("/projects/[id]", 1600, 1500), m("/inbox", 1501, 1400)], budgets)).toEqual([
      "/inbox: 1501 bytes of first-load JavaScript, over its budget of 1500",
    ]);
  });
  it("a shell over the shell budget fails on every route that carries it", () => {
    expect(checkBudgets([m("/projects/[id]", 1690, 1661), m("/inbox", 1661, 1661)], budgets)).toEqual([
      "/projects/[id]: its shell is 1661 bytes, over the shell budget of 1660",
      "/inbox: 1661 bytes of first-load JavaScript, over its budget of 1500",
      "/inbox: its shell is 1661 bytes, over the shell budget of 1660",
    ]);
  });
  it("an unnamed public route (outside the (protected) layout) is held to the public default, not the protected one", () => {
    const pub = (route: string, totalBytes: number) => ({ route, key: `${route}/page`, chunks: 1, totalBytes, shellBytes: 400, ownBytes: totalBytes - 400 });
    const prot = (route: string, totalBytes: number) => ({ route, key: `/(protected)${route}/page`, chunks: 1, totalBytes, shellBytes: 1400, ownBytes: totalBytes - 1400 });
    const b = { ...budgets, publicDefaultRouteMaxBytes: 800 };
    expect(budgetFor(pub("/submit/[token]", 1), b)).toBe(800);
    expect(budgetFor(prot("/inbox", 1), b)).toBe(1500);
    expect(budgetFor(pub("/projects/[id]", 1), b)).toBe(1700); // a named route keeps its own
    const named = prot("/projects/[id]", 1700);
    expect(checkBudgets([named, pub("/submit/[token]", 800), prot("/inbox", 1500)], b)).toEqual([]);
    expect(checkBudgets([named, pub("/submit/[token]", 801), prot("/inbox", 1500)], b)).toEqual([
      "/submit/[token]: 801 bytes of first-load JavaScript, over its budget of 800",
    ]);
    // with no public default, a public route falls back to the default (as before)
    expect(budgetFor(pub("/submit/[token]", 1), budgets)).toBe(1500);
  });
  it("a budgeted route with no built manifest fails (a rename must not drop its budget)", () => {
    expect(checkBudgets([m("/inbox", 10, 10)], budgets)).toEqual([
      "/projects/[id]: has a budget but no built manifest (renamed or removed? update the budget file)",
    ]);
  });
});

describe("PERF-12 — the command over a built .next (a fixture, no build)", () => {
  const script = resolve(process.cwd(), "scripts/perf/route-js-budget/check.mjs");
  const makeBuild = (ownBytes: number) => {
    const dir = mkdtempSync(join(tmpdir(), "j18-next-"));
    const app = join(dir, "server", "app", "(protected)", "projects", "[id]");
    mkdirSync(app, { recursive: true });
    mkdirSync(join(dir, "static", "chunks"), { recursive: true });
    writeFileSync(join(dir, "build-manifest.json"), JSON.stringify({ rootMainFiles: ROOT_MAIN, polyfillFiles: ["static/chunks/polyfill.js"] }));
    writeFileSync(join(app, "page_client-reference-manifest.js"), manifestSource("/(protected)/projects/[id]/page", PROJECT_ENTRIES));
    for (const [f, n] of Object.entries(SIZES)) writeFileSync(join(dir, f), "x".repeat(f.endsWith("own-1.js") ? ownBytes : n));
    // the polyfill is nomodule — modern browsers never fetch it, so it does not count
    writeFileSync(join(dir, "static/chunks/polyfill.js"), "x".repeat(5000));
    return dir;
  };
  const run = (dir: string, budgets: object) => {
    const b = join(dir, "budgets.json");
    writeFileSync(b, JSON.stringify(budgets));
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, "--next-dir", dir, "--budgets", b, "--json"], { encoding: "utf8" }) };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  };

  it("reads the manifests, sums the chunk files on disk and exits 0 within budget, 1 over it", () => {
    const dir = makeBuild(40);
    try {
      const ok = run(dir, { routes: { "/projects/[id]": 1699 }, defaultRouteMaxBytes: 1, shellMaxBytes: 1657 });
      expect(ok.code).toBe(0);
      const parsed = JSON.parse(ok.out);
      expect(parsed.measurements).toEqual([{ route: "/projects/[id]", key: "/(protected)/projects/[id]/page", chunks: 8, totalBytes: 1699, shellBytes: 1657, ownBytes: 42 }]);
      expect(parsed.failures).toEqual([]);
      // the page grows by one byte: over
      writeFileSync(join(dir, "static/chunks/own-1.js"), "x".repeat(41));
      const over = run(dir, { routes: { "/projects/[id]": 1699 }, defaultRouteMaxBytes: 1, shellMaxBytes: 1657 });
      expect(over.code).toBe(1);
      expect(JSON.parse(over.out).failures).toEqual(["/projects/[id]: 1700 bytes of first-load JavaScript, over its budget of 1699"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with no build to read it exits 2 and says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "j18-empty-"));
    try {
      const r = run(dir, { routes: {} });
      expect(r.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the committed budgets name /projects/[id], a default and a shell ceiling, and package.json runs the check", () => {
    const b = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/perf/route-js-budget/budgets.json"), "utf8"));
    expect(Number.isFinite(b.routes["/projects/[id]"])).toBe(true);
    expect(Number.isFinite(b.defaultRouteMaxBytes)).toBe(true);
    expect(Number.isFinite(b.shellMaxBytes)).toBe(true);
    expect(b.publicDefaultRouteMaxBytes).toBeLessThan(b.defaultRouteMaxBytes);
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts["perf:budget"]).toBe("node scripts/perf/route-js-budget/check.mjs");
    const ci = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(ci.indexOf("run: npm run perf:budget")).toBeGreaterThan(ci.indexOf("run: npm run build"));
  });
});
