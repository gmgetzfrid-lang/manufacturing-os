// @vitest-environment jsdom
//
// projects-tab PERF-12 (projects-joint J18 APP SHELL BUDGET) — the app
// shell's lazy boundaries, rendered.
//
// The protected layout keeps every listener it had, mounted at the same
// moment; what those listeners open is fetched when the browser is first
// idle, or at the first use. Pinned here:
//   * the command palette: Cmd+K / Ctrl+K on a COLD shell (the palette not
//     yet fetched) opens it — the first press is kept, never dropped; `?`
//     opens straight to the shortcuts; `/` from a field is left alone;
//     Escape closes; Cmd+K toggles it shut; the header's synthetic Cmd+K
//     (TopBar / QuickLaunch) opens it; once fetched it opens in the same
//     act, with no fallback frame; the idle preload fetches it unasked;
//   * the relationship map: an `open-relationship-graph` event before the
//     map is fetched opens it as soon as it lands, with the same document;
//     close and reopen;
//   * the signature ceremony: a `request-signature` before the ceremony is
//     fetched opens it; signing records through lib/eSignatures with the
//     same fields as before (reauth, the membership display name), says
//     "Signed" and announces `signature-recorded`;
//   * lib/lazyModule: one fetch for many callers, a failed fetch retried,
//     the server snapshot empty;
//   * the census: no static import from either layout reaches a module
//     that is now loaded on use (a static import added back fails here).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const fx = vi.hoisted(() => ({
  pushed: [] as string[],
  recorded: [] as Array<Record<string, unknown>>,
  toasts: [] as Array<{ type: string; title: string }>,
  searches: 0,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (h: string) => { fx.pushed.push(h); }, replace: () => {} }),
  usePathname: () => "/dashboard",
}));
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({
    activeOrgId: "o1", uid: "u1", userEmail: "pat@example.com", activeRole: "Engineer",
    member: { displayName: "Pat Doe" },
  }),
}));
vi.mock("@/components/providers/ToastProvider", () => ({
  useToast: () => ({ showToast: (t: { type: string; title: string }) => { fx.toasts.push(t); } }),
}));
vi.mock("@/lib/globalSearch", () => ({ globalSearch: async () => { fx.searches++; return []; } }));
vi.mock("@/lib/evidencePack", () => ({ openEvidencePack: async () => {}, openProjectEvidencePack: async () => {} }));
// The map and the ceremony are stand-ins: what is pinned is how the hosts
// reach them, not what they draw.
vi.mock("@/components/documents/RelationshipGraph", () => ({
  default: ({ documentId, onClose }: { documentId: string; onClose: () => void }) =>
    React.createElement("div", { "data-graph": documentId },
      React.createElement("button", { type: "button", "data-graph-close": "", onClick: onClose }, "Close")),
}));
vi.mock("@/components/signatures/SignatureCeremony", () => ({
  default: ({ signerName, resourceLabel, onSign, onCancel }: {
    signerName: string; resourceLabel?: string;
    onSign: (intent: string, statement: string, image?: string | null, reauth?: unknown) => void; onCancel: () => void;
  }) =>
    React.createElement("div", { "data-ceremony": resourceLabel ?? "", "data-signer": signerName },
      React.createElement("button", { type: "button", "data-sign": "", onClick: () => onSign("Approved", "I approve this", null, undefined) }, "Sign"),
      React.createElement("button", { type: "button", "data-cancel": "", onClick: onCancel }, "Cancel")),
}));
vi.mock("@/lib/eSignatures", () => ({
  recordSignature: async (input: Record<string, unknown>) => { fx.recorded.push(input); },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
/** The browser's idle callbacks, held until a test says the browser is idle
 *  (so a cold-shell test is never overtaken by the idle preload). */
let idleQueue = new Map<number, () => void>();
let idleIds = 0;
const browserIdle = () => act(async () => { const q = [...idleQueue.values()]; idleQueue.clear(); for (const cb of q) cb(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** Polls (in act) until `ok()` holds — a dynamic import resolves on its own time. */
async function until(ok: () => boolean, label: string, ms = 5000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}
const press = (init: KeyboardEventInit, target: EventTarget = window) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const paletteInput = () => document.querySelector('input[placeholder^="Search or run an action"]') as HTMLInputElement | null;

beforeEach(() => {
  idleQueue = new Map();
  (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback = (cb) => { idleQueue.set(++idleIds, cb); return idleIds; };
  (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback = (id) => { idleQueue.delete(id); };
  vi.resetModules(); // every test starts from a cold shell: nothing fetched yet
  fx.pushed = []; fx.recorded = []; fx.toasts = []; fx.searches = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("PERF-12 — the command palette: its listener is in the shell, the palette loads on idle or at the first press", () => {
  it("Ctrl+K on a cold shell opens the palette: the press is kept until the palette lands", async () => {
    const { default: Host, commandPaletteModule } = await import("@/components/navigation/GlobalCommandPaletteHost");
    await act(async () => { root.render(React.createElement(Host)); });
    expect(commandPaletteModule.peek()).toBeUndefined();
    expect(paletteInput()).toBeNull();
    let prevented = false;
    await act(async () => {
      const e = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
      window.dispatchEvent(e);
      prevented = e.defaultPrevented;
    });
    expect(prevented).toBe(true); // the browser's own Ctrl+K never fires
    await until(() => !!paletteInput(), "the palette to open");
    expect(commandPaletteModule.peek()).toBeDefined();
    // it opened on the empty query with the actions, as before
    expect(document.body.textContent).toContain("New drafting request");
    await until(() => document.activeElement === paletteInput(), "the input to take focus");
    // Escape closes; Cmd+K opens again, now in the same act (already fetched)
    await press({ key: "Escape" });
    expect(paletteInput()).toBeNull();
    await press({ key: "k", metaKey: true });
    expect(paletteInput()).not.toBeNull();
    // Cmd+K again toggles it shut
    await press({ key: "k", metaKey: true });
    expect(paletteInput()).toBeNull();
  });

  it("`?` on a cold shell opens straight to the shortcuts; `/` opens; `/` and `?` typed in a field are left alone", async () => {
    const { default: Host } = await import("@/components/navigation/GlobalCommandPaletteHost");
    const field = document.createElement("input");
    document.body.appendChild(field);
    try {
      await act(async () => { root.render(React.createElement(Host)); });
      await press({ key: "/" }, field);
      await press({ key: "?" }, field);
      await tick();
      expect(paletteInput()).toBeNull();
      await press({ key: "?" });
      await until(() => !!paletteInput(), "the palette to open on ?");
      expect(paletteInput()!.value).toBe("?");
      expect(document.body.textContent).toContain("Quick Navigation");
      await press({ key: "Escape" });
      expect(paletteInput()).toBeNull();
      await press({ key: "/" });
      expect(paletteInput()).not.toBeNull();
      expect(paletteInput()!.value).toBe("");
    } finally {
      field.remove();
    }
  });

  it("the header's search button (a synthetic Cmd+K on window) opens it, and a quick-nav pick routes", async () => {
    const { default: Host } = await import("@/components/navigation/GlobalCommandPaletteHost");
    await act(async () => { root.render(React.createElement(Host)); });
    // TopBar / QuickLaunch: window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }))
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); });
    await until(() => !!paletteInput(), "the palette to open from the header");
    const inbox = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Go to Inbox"))!;
    await act(async () => { inbox.click(); });
    expect(fx.pushed).toEqual(["/inbox"]);
    expect(paletteInput()).toBeNull();
  });

  it("the browser's first idle moment fetches the palette unasked, so the first press renders it in the same act", async () => {
    const { default: Host, commandPaletteModule } = await import("@/components/navigation/GlobalCommandPaletteHost");
    await act(async () => { root.render(React.createElement(Host)); });
    expect(commandPaletteModule.peek()).toBeUndefined();
    await browserIdle();
    await until(() => commandPaletteModule.peek() !== undefined, "the idle preload");
    expect(paletteInput()).toBeNull(); // fetched, not opened
    await press({ key: "k", ctrlKey: true });
    expect(paletteInput()).not.toBeNull();
  });

  it("the shortcut rules are the palette's own, unchanged", async () => {
    const { paletteKeyAction } = await import("@/components/navigation/GlobalCommandPaletteHost");
    const body = document.body;
    const input = document.createElement("input");
    const k = (key: string, extra: Partial<KeyboardEvent> = {}, target: EventTarget = body) =>
      ({ key, metaKey: false, ctrlKey: false, altKey: false, target, ...extra }) as KeyboardEvent;
    expect(paletteKeyAction(k("k", { metaKey: true }), false)).toBe("toggle");
    expect(paletteKeyAction(k("K", { ctrlKey: true }), true)).toBe("toggle");
    expect(paletteKeyAction(k("k", { ctrlKey: true }, input), false)).toBe("toggle"); // Cmd+K works from a field
    expect(paletteKeyAction(k("/"), false)).toBe("toggle");
    expect(paletteKeyAction(k("/"), true)).toBeNull();
    expect(paletteKeyAction(k("/", {}, input), false)).toBeNull();
    expect(paletteKeyAction(k("/", { altKey: true }), false)).toBeNull();
    expect(paletteKeyAction(k("?"), false)).toBe("help");
    expect(paletteKeyAction(k("?", {}, input), false)).toBeNull();
    expect(paletteKeyAction(k("?"), true)).toBeNull();
    expect(paletteKeyAction(k("Escape"), true)).toBe("close");
    expect(paletteKeyAction(k("Escape"), false)).toBeNull();
    expect(paletteKeyAction(k("k"), false)).toBeNull();
  });

  it("server-rendered, the host draws nothing (as the closed palette drew nothing)", async () => {
    const { default: Host } = await import("@/components/navigation/GlobalCommandPaletteHost");
    expect(renderToString(React.createElement(Host))).toBe("");
  });
});

describe("PERF-12 — the relationship map: its listener is in the shell, the map loads on idle or at the first open", () => {
  it("an open event before the map is fetched opens it, for that document, as soon as it lands; close; reopen at once", async () => {
    const { default: GraphHost, openRelationshipGraph, relationshipGraphModule } = await import("@/components/documents/RelationshipGraphHost");
    await act(async () => { root.render(React.createElement(GraphHost)); });
    expect(relationshipGraphModule.peek()).toBeUndefined();
    await act(async () => { openRelationshipGraph("doc-1"); });
    await until(() => !!document.querySelector('[data-graph="doc-1"]'), "the map to open");
    await act(async () => { (document.querySelector("[data-graph-close]") as HTMLButtonElement).click(); });
    expect(document.querySelector("[data-graph]")).toBeNull();
    await act(async () => { openRelationshipGraph("doc-2"); });
    expect(document.querySelector('[data-graph="doc-2"]')).not.toBeNull(); // fetched once: same act
  });

  it("an event with no document id opens nothing, and fetches nothing", async () => {
    const { default: GraphHost, relationshipGraphModule } = await import("@/components/documents/RelationshipGraphHost");
    await act(async () => { root.render(React.createElement(GraphHost)); });
    await act(async () => { window.dispatchEvent(new CustomEvent("open-relationship-graph", { detail: {} })); });
    await tick();
    expect(document.querySelector("[data-graph]")).toBeNull();
    expect(relationshipGraphModule.peek()).toBeUndefined();
  });
});

describe("PERF-12 — the signature ceremony: its listener is in the shell, the ceremony loads on idle or at the first request", () => {
  it("a request before the ceremony is fetched opens it; signing records the same fields, says so and announces it", async () => {
    const { default: SigHost, requestSignature, signatureCeremonyModule } = await import("@/components/signatures/SignatureCaptureHost");
    const announced: unknown[] = [];
    const onRecorded = (e: Event) => announced.push((e as CustomEvent).detail);
    window.addEventListener("signature-recorded", onRecorded);
    try {
      await act(async () => { root.render(React.createElement(SigHost)); });
      expect(signatureCeremonyModule.peek()).toBeUndefined();
      await act(async () => { requestSignature({ resourceType: "document", resourceId: "doc-9", resourceLabel: "this document" }); });
      await until(() => !!document.querySelector('[data-ceremony="this document"]'), "the ceremony to open");
      // RG-9: the membership display name, not the email
      expect(document.querySelector("[data-ceremony]")!.getAttribute("data-signer")).toBe("Pat Doe");
      await act(async () => { (document.querySelector("[data-sign]") as HTMLButtonElement).click(); });
      await until(() => fx.recorded.length === 1 && !document.querySelector("[data-ceremony]"), "the signature to record");
      expect(fx.recorded[0]).toEqual({
        orgId: "o1", resourceType: "document", resourceId: "doc-9", documentVersionId: null, contentHash: null,
        intent: "Approved", statement: "I approve this", signerUserId: "u1", signerName: "Pat Doe",
        signerRole: "Engineer", signerEmail: "pat@example.com", signatureImage: undefined, reauth: null,
      });
      expect(fx.toasts).toEqual([expect.objectContaining({ type: "success", title: "Signed" })]);
      expect(announced).toEqual([{ resourceType: "document", resourceId: "doc-9" }]);
      // a second request opens in the same act — fetched once
      await act(async () => { requestSignature({ resourceType: "document", resourceId: "doc-10", resourceLabel: "the next one" }); });
      expect(document.querySelector('[data-ceremony="the next one"]')).not.toBeNull();
      await act(async () => { (document.querySelector("[data-cancel]") as HTMLButtonElement).click(); });
      expect(document.querySelector("[data-ceremony]")).toBeNull();
    } finally {
      window.removeEventListener("signature-recorded", onRecorded);
    }
  });
});

describe("PERF-12 — lib/lazyModule", () => {
  it("one fetch however many ask; a failed fetch is not kept, the next ask tries again", async () => {
    const { lazyModule } = await import("@/lib/lazyModule");
    let calls = 0;
    let fail = true;
    const mod = lazyModule(async () => { calls++; if (fail) throw new Error("offline"); return { v: 1 }; }, "probe");
    await expect(Promise.all([mod.preload(), mod.preload()])).rejects.toThrow("offline");
    expect(calls).toBe(1);
    expect(mod.peek()).toBeUndefined();
    fail = false;
    const [a, b] = await Promise.all([mod.preload(), mod.preload()]);
    expect(a).toBe(b);
    expect(calls).toBe(2);
    expect(mod.peek()).toEqual({ v: 1 });
    await mod.preload();
    expect(calls).toBe(2);
  });

  it("useLoaded: undefined on the server; once loaded, the module on the first render with no empty frame", async () => {
    const { lazyModule } = await import("@/lib/lazyModule");
    const mod = lazyModule(async () => ({ label: "loaded" }), "probe");
    const seen: Array<string | undefined> = [];
    const Probe = () => { const m = mod.useLoaded(false); seen.push(m?.label); return React.createElement("span", null, m?.label ?? "none"); };
    expect(renderToString(React.createElement(Probe))).toBe("<span>none</span>");
    await mod.preload();
    seen.length = 0;
    await act(async () => { root.render(React.createElement(Probe)); });
    expect(seen).toEqual(["loaded"]);
    expect(host.textContent).toBe("loaded");
  });

  it("useLoaded(false) never fetches; useLoaded(true) does, and re-renders when it lands", async () => {
    const { lazyModule } = await import("@/lib/lazyModule");
    let calls = 0;
    const mod = lazyModule(async () => { calls++; return { label: "x" }; }, "probe");
    let want = false;
    const Probe = () => React.createElement("span", null, mod.useLoaded(want)?.label ?? "none");
    await act(async () => { root.render(React.createElement(Probe)); });
    await tick();
    expect(calls).toBe(0);
    want = true;
    await act(async () => { root.render(React.createElement(Probe)); });
    await until(() => host.textContent === "x", "the module");
    expect(calls).toBe(1);
  });
});

// ── the census ─────────────────────────────────────────────────────────────
const ROOT = process.cwd();
const EXTS = [".tsx", ".ts", ".js", ".mjs", "/index.tsx", "/index.ts"];
function resolveSpec(from: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith("@/")) p = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) p = resolve(dirname(from), spec);
  else return null;
  if (existsSync(p) && statSync(p).isFile()) return p;
  for (const e of EXTS) if (existsSync(p + e)) return p + e;
  return null;
}
/** The static (value) imports and re-exports of a file. `import type` and
 *  an all-`type` named list are erased by the compiler, and `import(…)` is a
 *  separate chunk, so neither counts. */
function staticImports(file: string, src = readFileSync(file, "utf8")): string[] {
  const out: string[] = [];
  const re = /(^|\n)\s*(import|export)\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']|(^|\n)\s*import\s+["']([^"']+)["']/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const spec = m[4] ?? m[6];
    const clause = (m[3] ?? "").trim();
    if (/^\{[^}]*\}$/.test(clause) && clause.replace(/[{}\s]/g, "").split(",").filter(Boolean).every((x) => x.startsWith("type"))) continue;
    const r = resolveSpec(file, spec);
    if (r) out.push(r);
  }
  return out;
}
function shellReach(override?: { file: string; src: string }): Set<string> {
  const seen = new Set<string>();
  const stack = [join(ROOT, "app/layout.tsx"), join(ROOT, "app/(protected)/layout.tsx")];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const deps = override && f === join(ROOT, override.file) ? staticImports(f, override.src) : staticImports(f);
    for (const d of deps) stack.push(d);
  }
  return seen;
}
const LOADED_ON_USE = [
  "components/navigation/GlobalCommandPalette.tsx",
  "lib/globalSearch.ts",
  "lib/evidencePack.ts",
  "lib/featureAtlas.ts",
  "components/documents/RelationshipGraph.tsx",
  "lib/search.ts",
  "components/signatures/SignatureCeremony.tsx",
  "lib/eSignatures.ts",
  "lib/knowledge.ts",
  "components/cockpit/CommandDeck.tsx",
  "components/branding/LogoUploadModal.tsx",
];

describe("PERF-12 — the census: the shell's static imports stop at the lazy boundaries", () => {
  it("no static import from app/layout.tsx or app/(protected)/layout.tsx reaches a module the shell now loads on use", () => {
    const reach = shellReach();
    // the census sees the shell (not vacuous): its hosts and providers are in it
    for (const f of [
      "components/navigation/GlobalCommandPaletteHost.tsx", "components/documents/RelationshipGraphHost.tsx",
      "components/signatures/SignatureCaptureHost.tsx", "components/providers/KnowledgeIndexIndicator.tsx",
      "components/notifications/NotificationCenter.tsx", "components/cockpit/AttentionFeed.tsx", "lib/formatAgo.ts",
      "components/providers/RoleContext.tsx", "lib/lazyModule.ts",
    ]) expect(reach.has(join(ROOT, f)), f).toBe(true);
    expect(LOADED_ON_USE.filter((f) => reach.has(join(ROOT, f)))).toEqual([]);
  });

  it("negative controls: a static import put back in a host, the indicator or the feed is caught", () => {
    const cases: Array<[string, string, string]> = [
      ["app/(protected)/layout.tsx", 'import GlobalCommandPalette from "@/components/navigation/GlobalCommandPaletteHost";', 'import GlobalCommandPalette from "@/components/navigation/GlobalCommandPalette";'],
      ["components/documents/RelationshipGraphHost.tsx", 'import React from "react";', 'import React from "react";\nimport RelationshipGraph from "@/components/documents/RelationshipGraph";'],
      ["components/signatures/SignatureCaptureHost.tsx", 'import type { SignatureIntent, SigningCredential } from "@/lib/eSignatures";', 'import { recordSignature, type SignatureIntent, type SigningCredential } from "@/lib/eSignatures";'],
      ["components/providers/KnowledgeIndexIndicator.tsx", 'import { lazyModule } from "@/lib/lazyModule";', 'import { lazyModule } from "@/lib/lazyModule";\nimport { ingestKnowledgeDocument, isIngestActive } from "@/lib/knowledge";'],
      ["components/cockpit/AttentionFeed.tsx", 'import { formatAgo } from "@/lib/formatAgo";', 'import { formatAgo } from "@/components/cockpit/CommandDeck";'],
      ["components/navigation/Sidebar.tsx", "import { lazyModule, usePreloadWhenIdle } from '@/lib/lazyModule';", "import { lazyModule, usePreloadWhenIdle } from '@/lib/lazyModule';\nimport LogoUploadModal from '@/components/branding/LogoUploadModal';"],
    ];
    for (const [file, from, to] of cases) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src, file).toContain(from);
      const reach = shellReach({ file, src: src.replace(from, to) });
      expect(LOADED_ON_USE.filter((f) => reach.has(join(ROOT, f))).length, file).toBeGreaterThan(0);
    }
  });

  it("the shell keeps every listener it mounts: the layout still mounts each host and indicator, and the palette module has no keydown listener of its own", () => {
    const layout = readFileSync(join(ROOT, "app/(protected)/layout.tsx"), "utf8");
    for (const tag of ["<GlobalCommandPalette />", "<RelationshipGraphHost />", "<SignatureCaptureHost />", "<KnowledgeIndexIndicator />", "<NotificationListener onOpenCenter={openCenter} />"]) {
      expect(layout).toContain(tag);
    }
    // one listener, in the host: two would toggle the palette twice per press
    const palette = readFileSync(join(ROOT, "components/navigation/GlobalCommandPalette.tsx"), "utf8");
    expect(palette).not.toMatch(/addEventListener\("keydown"/);
    const hostSrc = readFileSync(join(ROOT, "components/navigation/GlobalCommandPaletteHost.tsx"), "utf8");
    expect(hostSrc.match(/addEventListener\("keydown"/g)).toHaveLength(1);
  });

  it("CommandDeck re-exports the same formatAgo the feed now imports from lib", async () => {
    const deck = await import("@/components/cockpit/CommandDeck");
    const lib = await import("@/lib/formatAgo");
    expect(deck.formatAgo).toBe(lib.formatAgo);
    expect(lib.formatAgo(undefined)).toBe("—");
    expect(lib.formatAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m");
  });
});
