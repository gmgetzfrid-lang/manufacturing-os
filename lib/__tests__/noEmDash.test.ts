// The app never shows an em dash: none in its own wording (every string,
// template and JSX text in the app's code), and text from elsewhere — a
// model's answer, what someone types — is cleaned on the way through.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { noEmDash, noEmDashDeep } from "@/lib/noEmDash";

const EM = "—";
const ROOT = path.resolve(__dirname, "../..");
const DIRS = ["app", "components", "lib", "hooks", "types"];
// Reading the library's document names (input, not output).
const READS_INPUT = new Set(["lib/ask/knowledgeAskHandler.ts"]);
// The cleaner, and this test, name what they look for.
const NAMES_IT = new Set(["lib/noEmDash.ts", "lib/__tests__/noEmDash.test.ts"]);
const READ_CALLS = new Set(["split", "indexOf", "includes", "startsWith", "endsWith", "lastIndexOf"]);

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) files(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// A regex's character class only reads input ([-–—] accepts any dash).
const outsideClasses = (re: string) => {
  let out = "", inClass = false;
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (!inClass) out += c;
  }
  return out;
};

describe("no em dash", () => {
  it("in anything the app's code says (comments aside)", () => {
    const found: string[] = [];
    for (const d of DIRS) {
      const dir = path.join(ROOT, d);
      if (!fs.existsSync(dir)) continue;
      for (const f of files(dir)) {
        const text = fs.readFileSync(f, "utf8");
        if (!text.includes(EM) && !text.includes("&mdash;")) continue;
        const rel = path.relative(ROOT, f);
        if (NAMES_IT.has(rel)) continue;
        const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = (n: ts.Node) => {
          const k = n.kind;
          const str = k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateHead
            || k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail || k === ts.SyntaxKind.JsxText;
          if (str || k === ts.SyntaxKind.RegularExpressionLiteral) {
            const src = text.slice(k === ts.SyntaxKind.JsxText ? n.pos : n.getStart(sf), n.end);
            const said = str ? src : outsideClasses(src);
            const p = n.parent;
            const readsInput = READS_INPUT.has(rel) && !!p && ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && READ_CALLS.has(p.expression.name.text);
            if ((said.includes(EM) || said.includes("&mdash;")) && !readsInput) found.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    }
    expect(found).toEqual([]);
  }, 120_000);

  it("in text from elsewhere: a hyphen instead", () => {
    expect(noEmDash(`Pull bundle ${EM} 2 of 5 out`)).toBe("Pull bundle - 2 of 5 out");
    expect(noEmDash("a &mdash; b")).toBe("a - b");
    expect(noEmDashDeep({ notes: [{ text: `x${EM}y`, at: 1 }], crews: { S: { supervisor: `M ${EM} R` } } }))
      .toEqual({ notes: [{ text: "x-y", at: 1 }], crews: { S: { supervisor: "M - R" } } });
  });
});
