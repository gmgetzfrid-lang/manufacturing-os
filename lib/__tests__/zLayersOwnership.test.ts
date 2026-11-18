// notifications N13 LAYERS SWEEP — lib/zLayers.ts OWNS every layer number
// (TAX-14 done-when 4), and every full-screen overlay at z >= 300 declares its
// action row or is named here as having none (STACK-14 done-when 1 and 2).
//
//   1. No z literal outside lib/zLayers.ts: no `z-N` / `z-[N]` / `-z-N` class
//      in any string or template in app/, components/, hooks/ or lib/ (tests
//      excepted), no number in a `zIndex` style, prop or default, and a
//      stylesheet's `z-index:` only where STYLESHEET_LAYERS names it, at its
//      layer's number. Comments may name a layer; code reads the module.
//   2. Each `ZC` class is the Tailwind spelling of its `Z` number, and
//      Tailwind emits it from the module's own source (Tailwind cannot build
//      a class from a runtime number, so the literal must be in the module).
//   3. Every full-screen overlay at z >= 300 — a `fixed inset-0` element, a
//      right-anchored full-height drawer, a `<Modal>` — declares its action
//      row (`useDockAvoidRow` / `useDockAvoid` on a row inside it, or a
//      `<ModalFooter>`), or is listed in NO_ACTION_ROW with its reason.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { Z, ZC, Z_SCALE, STYLESHEET_LAYERS, type ZLayer } from "@/lib/zLayers";

const ROOT = resolve(".");
const rel = (f: string) => relative(ROOT, f);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}
const FILES = ["app", "components", "hooks", "lib"].flatMap((d) => walk(resolve(d))).filter((f) => rel(f) !== "lib/zLayers.ts");
const CODE = FILES.filter((f) => /\.tsx?$/.test(f));
const CSS = FILES.filter((f) => f.endsWith(".css"));

// Every code file is parsed once (a full parse of the tree is slow under a
// loaded CI shard); the scans below read the cache.
const parsed = new Map<string, ts.SourceFile>();
const parse = (f: string) => {
  let sf = parsed.get(f);
  if (!sf) { sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS); parsed.set(f, sf); }
  return sf;
};
/** A full-tree scan's time budget (the parse dominates). */
const SCAN_MS = 120_000;

/** A Tailwind z class, with or without a variant prefix (a breakpoint, a state). */
const Z_CLASS = /(?<![\w\[\]\-\/])(?:[\w-]+:)*!?-?z-(?:\[-?\d+\]|\d+)(?![\w\]\[\-\/])/;
const CSS_Z = /z-index\s*:\s*(-?\d+)/;

function hasNumber(n: ts.Node): boolean {
  if (ts.isNumericLiteral(n)) return true;
  let found = false;
  n.forEachChild((c) => { if (!found && hasNumber(c)) found = true; });
  return found;
}

/** Every z literal in one code file: [line, text]. */
export function zLiteralsIn(sf: ts.SourceFile): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      const m = Z_CLASS.exec(n.text) ?? CSS_Z.exec(n.text);
      if (m) out.push([at(n), m[0]]);
    }
    const named = (name: ts.Node | undefined) => !!name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "zIndex";
    if ((ts.isPropertyAssignment(n) && named(n.name) && hasNumber(n.initializer))
      || (ts.isJsxAttribute(n) && n.name.getText(sf) === "zIndex" && !!n.initializer && hasNumber(n.initializer))
      || ((ts.isBindingElement(n) || ts.isParameter(n) || ts.isVariableDeclaration(n)) && named(n.name) && !!n.initializer && hasNumber(n.initializer))) {
      out.push([at(n), n.getText(sf).slice(0, 60)]);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

describe("TAX-14 dw4 — lib/zLayers.ts owns every layer number", () => {
  it("no z class, z-index or zIndex number in app/, components/, hooks/ or lib/ outside lib/zLayers.ts", () => {
    const hits = CODE.flatMap((f) => zLiteralsIn(parse(f)).map(([line, t]) => `${rel(f)}:${line} ${t} — read it from lib/zLayers.ts (Z / ZC)`));
    expect(hits).toEqual([]);
  }, SCAN_MS);

  it("a stylesheet's z-index is a layer STYLESHEET_LAYERS names, at that layer's number", () => {
    const seen: Record<string, number[]> = {};
    for (const f of CSS) {
      const vals = [...readFileSync(f, "utf8").matchAll(new RegExp(CSS_Z.source, "g"))].map((m) => Number(m[1]));
      if (vals.length) seen[rel(f)] = vals;
    }
    const want = Object.fromEntries(Object.entries(STYLESHEET_LAYERS).map(([f, layers]) => [f, layers.map((k) => Z[k])]));
    expect(seen).toEqual(want);
  });

  it("each ZC class is the Tailwind spelling of its Z number", () => {
    for (const [k, cls] of Object.entries(ZC)) {
      const n = Z[k as ZLayer];
      const want = n < 0 ? `-z-${-n}` : [0, 10, 20, 30, 40, 50].includes(n) ? `z-${n}` : `z-[${n}]`;
      expect(cls, k).toBe(want);
    }
    expect(Z_SCALE).toEqual([...new Set(Object.values(Z))].sort((a, b) => a - b));
  });

  it("Tailwind emits every ZC class from lib/zLayers.ts itself, with its number — and the app's stylesheet scans lib/", async () => {
    const css = `@import "tailwindcss/utilities" source(none);\n@source "${ROOT}/lib/zLayers.ts";\n`;
    const out = (await postcss([tailwind({ base: ROOT })]).process(css, { from: join(ROOT, "app/__zlayers_probe.css") })).css;
    for (const [k, cls] of Object.entries(ZC)) {
      const sel = "." + cls.replace(/[[\]]/g, (c) => "\\" + c);
      const at = out.indexOf(sel + " {");
      expect(at, `${k}: ${cls} not emitted`).toBeGreaterThanOrEqual(0);
      const decl = out.slice(at, out.indexOf("}", at));
      const n = Z[k as ZLayer];
      expect(decl, k).toContain(n < 0 ? `z-index: calc(${-n} * -1)` : `z-index: ${n};`);
    }
    // The app's stylesheet uses Tailwind's automatic source detection from the
    // project root, which includes lib/ (no `source(...)` narrowing it).
    const globals = readFileSync(resolve("app/globals.css"), "utf8");
    expect(globals).toMatch(/^@import "tailwindcss";$/m);
    expect(globals).not.toMatch(/source\(|@source not/);
  }, 30_000);
});

// ── STACK-14 — every full-screen overlay at z >= 300 declares its action row ──

const HIGH_LAYERS = new Set((Object.keys(Z) as ZLayer[]).filter((k) => Z[k] >= 300));

/** Overlays at z >= 300 with no action row a dock card could cover — each
 *  with its reason. The count per file is exact: a stale entry fails too. */
const NO_ACTION_ROW: Record<string, string[]> = {
  "components/navigation/ThemeMenu.tsx": ["a transparent click-catcher behind the theme menu: no content"],
  "components/projects/ProgressControl.tsx": ["a transparent click-catcher behind the progress popover: no content"],
  "components/projects/StatusControl.tsx": ["a transparent click-catcher behind the status popover: no content"],
  "components/assets/AssetPhotoCarousel.tsx": ["a photo carousel: arrows at mid-height, close in the header, no action row"],
  "components/navigation/GlobalCommandPalette.tsx": ["the command palette: a top-centre search box and its list, no action row"],
  "components/viewers/SecureDocViewer.tsx": ["the print-only cover (hidden on screen)"],
  "components/assets/FileReferenceModal.tsx": ["a document preview: its controls are in the header, no footer"],
  "components/documents/ShareLinkModal.tsx": ["a list of share links: controls in the header and on each row, no footer"],
  "components/documents/RelationshipGraph.tsx": ["a graph and its list of links: navigation rows, no action row"],
  "components/requests/WorkflowDiagramModal.tsx": ["an explanatory diagram: close in the header, no action row"],
};
/** The shared Modal itself: its users are what is checked. */
const SKIP = new Set(["components/ui/Modal.tsx"]);

interface Overlay { line: number; declared: boolean }

export function overlaysIn(sf: ts.SourceFile): Overlay[] {
  // Refs that declare a row: `const r = useDockAvoidRow()` or `useDockAvoid(r, …)`.
  const rowRefs = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(sf) === "useDockAvoidRow") rowRefs.add(n.name.getText(sf));
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "useDockAvoid" && n.arguments[0]) rowRefs.add(n.arguments[0].getText(sf));
    n.forEachChild(collect);
  };
  collect(sf);
  const declaresInside = (el: ts.Node): boolean => {
    let ok = false;
    const v = (n: ts.Node) => {
      if (ok) return;
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === "ModalFooter") ok = true;
      if (ts.isJsxAttribute(n) && n.name.getText(sf) === "ref" && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression
        && rowRefs.has(n.initializer.expression.getText(sf))) ok = true;
      n.forEachChild(v);
    };
    v(el);
    return ok;
  };
  const out: Overlay[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = open.tagName.getText(sf);
      let cls = "";
      let layer: string | null = null;
      for (const a of open.attributes.properties) {
        if (!ts.isJsxAttribute(a) || !a.initializer) continue;
        const name = a.name.getText(sf);
        const t = a.initializer.getText(sf);
        if (name === "className") { cls = t; layer = /ZC\.(\w+)/.exec(t)?.[1] ?? layer; }
        if (name === "style") layer = /zIndex:\s*Z\.(\w+)/.exec(t)?.[1] ?? layer;
      }
      const fullScreen = /\bfixed\b/.test(cls) && (/\binset-0\b/.test(cls) || (/\bright-0\b/.test(cls) && /\b(inset-y-0|bottom-0)\b/.test(cls)));
      const high = !!layer && HIGH_LAYERS.has(layer as ZLayer);
      if ((fullScreen && high) || tag === "Modal") {
        out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, declared: declaresInside(n) });
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

describe("STACK-14 — every full-screen overlay at z >= 300 declares its action row", () => {
  let cached: Array<{ file: string; overlays: Overlay[] }> | null = null;
  const perFileOverlays = () => (cached ??= CODE.filter((f) => f.endsWith(".tsx") && !SKIP.has(rel(f)))
    .map((f) => ({ file: rel(f), overlays: overlaysIn(parse(f)) }))
    .filter((x) => x.overlays.length > 0));

  it("an undeclared overlay is refused unless NO_ACTION_ROW names it (exact counts, so a stale entry fails too)", () => {
    const undeclared: Record<string, number[]> = {};
    for (const { file, overlays } of perFileOverlays()) {
      const lines = overlays.filter((o) => !o.declared).map((o) => o.line);
      if (lines.length) undeclared[file] = lines;
    }
    const counts = Object.fromEntries(Object.entries(undeclared).map(([f, l]) => [f, l.length]));
    const allowed = Object.fromEntries(Object.entries(NO_ACTION_ROW).map(([f, r]) => [f, r.length]));
    expect(counts, `undeclared overlays (file → lines): ${JSON.stringify(undeclared)}`).toEqual(allowed);
  }, SCAN_MS);

  it("the census is the sweep's: 44 full-screen overlays at z >= 300, 34 declared", () => {
    const perFile = perFileOverlays();
    const all = perFile.flatMap((x) => x.overlays);
    expect(all.length).toBe(44);
    expect(all.filter((o) => o.declared).length).toBe(34);
    // the asset editor drawer (the finding's own scenario) and the pages that
    // compose Modal with their own footer are among the declared
    const declaredIn = new Set(perFile.filter((x) => x.overlays.every((o) => o.declared)).map((x) => x.file));
    for (const f of ["app/(protected)/admin/assets/page.tsx", "app/(protected)/companies/page.tsx", "app/(protected)/companies/[id]/page.tsx",
      "app/(protected)/projects/[id]/page.tsx", "components/projects/ProjectWizard.tsx"]) expect(declaredIn.has(f), f).toBe(true);
  }, SCAN_MS);

  it("the scan sees an undeclared overlay (self-check on a fixture)", () => {
    const src = `import { ZC } from "@/lib/zLayers";
      export function A() { return <div className={\`fixed inset-0 \${ZC.sharedModal} flex\`}><div className="border-t"><button>Save</button></div></div>; }
      export function B() { const r = useDockAvoidRow(); return <div className={\`fixed inset-0 \${ZC.policyModal}\`}><div ref={r}><button>Save</button></div></div>; }
      export function C() { return <Modal onClose={() => {}}><ModalFooter><button>OK</button></ModalFooter></Modal>; }
      export function D() { return <Modal onClose={() => {}}><div><button>OK</button></div></Modal>; }
      export function E() { return <div className={\`fixed inset-0 \${ZC.drawer}\`} />; }`;
    const sf = ts.createSourceFile("fixture.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(overlaysIn(sf).map((o) => o.declared)).toEqual([false, true, true, false]);
    // and the literal scan refuses a class, a style number and a default
    const lit = ts.createSourceFile("fixture.tsx", `const a = <div className="fixed z-[400]" style={{ zIndex: 5 }} />; function M({ zIndex = 400 }) { return a; }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(zLiteralsIn(lit).length).toBe(3);
  });
});
