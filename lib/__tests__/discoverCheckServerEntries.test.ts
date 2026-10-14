// notifications Round G, N15 RECIPIENT VISIBILITY AND NAMES — fix pass 4
// (NEDGE-6; the integrator's ruling under DEC-90).
//
// On the server the discover filter runs only when the server entry LOADED
// lib/documentDiscoverers (it registers the service-role check into
// lib/notify/recipients.ts when it is imported). With no check registered the
// filter keeps everyone and logs — today's path, the behaviour before N15, kept
// on purpose (no regression). So that no server entry can skip the check
// silently, this census walks every server entry (a route handler under app/,
// or a "use server" module), follows the named calls it makes through app/ and
// lib/ to any function that emits a DOCUMENT-scoped follower notice (an emit()
// with `followers: true` on a `type: "document"` resource, or the checkout
// thread's notifyCheckoutActivity, whose whole audience is followers), and
// fails for any entry that reaches one without `import "@/lib/documentDiscoverers";`.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

const ROOT = join(__dirname, "..", "..");
const LOADS_CHECK = 'import "@/lib/documentDiscoverers";';

type Sources = Map<string, string>; // path relative to ROOT -> source

function readTree(): Sources {
  const out: Sources = new Map();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) out.set(relative(ROOT, p), readFileSync(p, "utf8"));
    }
  };
  for (const d of ["app", "lib", "hooks", "components"]) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  return out;
}

const DECL = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/gm;
const IMPORTS = /import\s+(?!type\s)\{([^{}]*)\}\s+from\s+["']([^"']+)["']|\{([^{}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g;

/** A function body that emits a document-scoped follower notice. */
function emitsDocumentFollowers(name: string, body: string): boolean {
  if (name === "notifyCheckoutActivity") return true;
  return [...body.matchAll(/emit\(\{[\s\S]*?\n\s*\}\);/g)]
    .some((m) => /followers:\s*true/.test(m[0]) && /resource:\s*\{\s*type:\s*"document"/.test(m[0]));
}

interface Census {
  /** "file#function" of every function that emits, or calls (by name, through
   *  its own module or a named import) one that does. */
  emitting: Set<string>;
  /** Every server entry that reaches an emitting function, with whether it
   *  loads the server check. */
  entries: Array<{ file: string; reaches: string[]; loadsCheck: boolean }>;
}

function census(src: Sources): Census {
  const modOf = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? relative(ROOT, resolve(ROOT, dirname(from), spec)) : null;
    if (base == null) return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (src.has(c)) return c;
    return null;
  };
  const info = new Map<string, { fns: Map<string, string>; imp: Map<string, string> }>();
  for (const [f, s] of src) {
    const decls = [...s.matchAll(DECL)].map((m) => ({ name: (m[1] ?? m[2]) as string, at: m.index ?? 0 }));
    const fns = new Map(decls.map((d, i) => [d.name, s.slice(d.at, i + 1 < decls.length ? decls[i + 1].at : s.length)] as const));
    const imp = new Map<string, string>();
    for (const m of s.matchAll(IMPORTS)) {
      const mod = modOf(f, (m[2] ?? m[4]) as string);
      if (!mod) continue;
      for (const part of ((m[1] ?? m[3]) as string).split(",")) {
        const [orig, alias] = part.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+|\s*:\s*/).map((x) => x.trim());
        if (orig && /^\w+$/.test(orig) && /^\w*$/.test(alias ?? "")) imp.set(alias || orig, `${mod}#${orig}`);
      }
    }
    info.set(f, { fns, imp });
  }
  const calledFrom = (text: string, f: string): string[] => {
    const { fns, imp } = info.get(f)!;
    const out: string[] = [];
    for (const n of fns.keys()) if (new RegExp(`\\b${n}\\(`).test(text)) out.push(`${f}#${n}`);
    for (const [a, target] of imp) if (new RegExp(`\\b${a}\\(`).test(text)) out.push(target);
    return out;
  };
  const emitting = new Set<string>();
  for (const [f, { fns }] of info) for (const [n, b] of fns) if (emitsDocumentFollowers(n, b)) emitting.add(`${f}#${n}`);
  for (let grew = true; grew;) {
    grew = false;
    for (const [f, { fns }] of info) {
      for (const [n, b] of fns) {
        const k = `${f}#${n}`;
        if (!emitting.has(k) && calledFrom(b, f).some((c) => emitting.has(c))) { emitting.add(k); grew = true; }
      }
    }
  }
  const entries: Census["entries"] = [];
  for (const [f, s] of src) {
    const isEntry = /^app\/.*\/route\.ts$/.test(f) || /^\s*["']use server["']/.test(s);
    if (!isEntry) continue;
    // its own functions that emit or reach an emitter, and the emitters it
    // calls through a named import
    const own = [...info.get(f)!.fns.keys()].map((n) => `${f}#${n}`).filter((k) => emitting.has(k));
    const imported = [...info.get(f)!.imp.entries()].filter(([a, t]) => emitting.has(t) && new RegExp(`\\b${a}\\(`).test(s)).map(([, t]) => t);
    const reaches = [...new Set([...own, ...imported])];
    if (reaches.length > 0) entries.push({ file: f, reaches, loadsCheck: s.includes(LOADS_CHECK) });
  }
  return { emitting, entries };
}

describe("NEDGE-6 (fix pass 4) — every server entry that sends a document's followers a notice loads the discover check", () => {
  const real = census(readTree());

  it("the census finds the emitters it must (so it cannot pass by finding nothing)", () => {
    for (const k of [
      "lib/postPublish.ts#notifySuperseded",
      "lib/holds.ts#notifyHoldChange",
      "lib/staleCopies.ts#recallRetiredDocument",
      "lib/checkoutEpisodes.ts#forceReleaseDocument",
      "lib/activityThread.ts#notifyCheckoutActivity",
      // reached through a call, not an emit of its own
      "lib/postPublish.ts#runPostPublishSideEffects",
      "lib/holds.ts#openHold",
    ]) expect(real.emitting.has(k), k).toBe(true);
    // the intake door publishes (runPostPublishSideEffects → the supersede notice)
    expect(real.entries.map((e) => e.file)).toContain("app/api/intake/upload/route.ts");
  });

  it("no server entry reaches a document follower notice without importing \"@/lib/documentDiscoverers\"", () => {
    const missing = real.entries.filter((e) => !e.loadsCheck).map((e) => `${e.file} -> ${e.reaches.join(", ")}`);
    expect(missing).toEqual([]);
  });

  it("the census fails a new server entry that skips the check (a synthetic tree)", () => {
    const fake: Sources = new Map([
      ["lib/fakeNotice.ts", 'import { emit } from "@/lib/notify/dispatch";\nexport async function tellWatchers(id: string) {\n  await emit({\n    kind: "doc_superseded",\n    resource: { type: "document", id },\n    audience: { followers: true },\n  });\n}\nexport async function publishThing(id: string) {\n  await tellWatchers(id);\n}\n'],
      ["app/api/fake/route.ts", 'import { publishThing } from "@/lib/fakeNotice";\nexport async function POST() {\n  await publishThing("d");\n}\n'],
      ["app/api/fake-ok/route.ts", 'import "@/lib/documentDiscoverers";\nexport async function POST() {\n  const { publishThing } = await import("@/lib/fakeNotice");\n  await publishThing("d");\n}\n'],
      ["app/api/fake-inline/route.ts", 'import { emit } from "@/lib/notify/dispatch";\nexport async function POST() {\n  await emit({\n    kind: "hold_opened",\n    resource: { type: "document", id: "d" },\n    audience: { followers: true },\n  });\n}\n'],
      ["app/api/fake-library/route.ts", 'import { emit } from "@/lib/notify/dispatch";\nexport async function POST() {\n  await emit({\n    kind: "doc_superseded",\n    resource: { type: "library", id: "l" },\n    audience: { followers: true },\n  });\n}\n'],
    ]);
    const c = census(fake);
    expect(c.entries).toEqual([
      { file: "app/api/fake/route.ts", reaches: ["app/api/fake/route.ts#POST", "lib/fakeNotice.ts#publishThing"], loadsCheck: false },
      { file: "app/api/fake-ok/route.ts", reaches: ["app/api/fake-ok/route.ts#POST", "lib/fakeNotice.ts#publishThing"], loadsCheck: true },
      { file: "app/api/fake-inline/route.ts", reaches: ["app/api/fake-inline/route.ts#POST"], loadsCheck: false },
    ]);
    // a library-scoped follower notice is not discover-checked (NEDGE-22) and is not counted
  });

  it("with no check registered the runtime path is unchanged — everyone kept, logged loudly (lib/notify/recipients.ts)", () => {
    const src = readFileSync(join(ROOT, "lib/notify/recipients.ts"), "utf8");
    expect(src).toMatch(/if \(!check\) \{\n\s*console\.warn\(`\[notify\] no discover check in this context — /);
    expect(src).toMatch(/return \{ uids: want, outcome: "unavailable" \};/);
  });
});
