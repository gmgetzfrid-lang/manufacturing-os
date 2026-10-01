// intelligence Round G — I-05 GOV-11 / PR-12: the census of provider calls.
//
// Every file that calls a provider directly (callAiModel / embedPassages /
// transcribePageImage) is classified:
//   GATED      — runs lib/ai/aiGates (or governedAiCall, built on it)
//   INLINE     — an older inline stack that still checks the signed agreement
//                (references AGREEMENT_VERSION); its owner moves it onto aiGates
//   PENDING    — a route whose agreement gate is a cross-package handoff,
//                named with its owner (I-09 and I-07 run in parallel with
//                this package; once a route checks the agreement or runs
//                aiGates it is classified INLINE / GATED on its own and its
//                PENDING line can go)
//   HELPER     — lib code gated by its callers
// A provider call in a file on none of these lists fails the suite.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].map((p) => relative(ROOT, p));
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");
const CALLS = /\b(callAiModel|embedPassages|transcribePageImage)\s*\(/;
const callers = files.filter((f) => CALLS.test(src(f)));

const usesGates = (s: string) => /from "@\/lib\/ai\/aiGates"/.test(s) || /\bgovernedAiCall\s*\(/.test(s);
const checksAgreement = (s: string) => /\bAGREEMENT_VERSION\b/.test(s);

/** Routes whose agreement gate is another package's file (owner — limb). */
const PENDING: Record<string, string> = {
  "app/api/flows/read/route.ts": "I-09 — flows/read adopts aiGates (GOV-11 / PR-12 limb; a local agreement check until it lands)",
  "app/api/knowledge/locate/route.ts": "I-07 — locate adopts aiGates with the refine-pass metering (GOV-8 / DWG-5)",
};
/** lib code that calls a provider for a caller that runs the gates. */
const HELPERS: Record<string, string> = {
  "lib/ai/providerCall.ts": "the provider client itself",
  "lib/ai/embeddings.ts": "the embeddings client itself",
  "lib/ai/governedCall.ts": "governedAiCall — runs assertAiGates (checked below)",
  "lib/knowledgeVision.ts": "page transcription for the ingest paths, which gate the sponsor's key",
  "lib/knowledgeEmbedCore.ts": "the embed slice for /api/knowledge/embed and the drain, which gate the payer",
  "lib/knowledgeIngest.ts": "the ingest drain's sponsor path (loadSponsorVision: key, allowlist, agreement, cap)",
};

describe("GOV-11 / PR-12 — every provider call is behind the gates, or named", () => {
  it("the scan sees the provider callers (a census that matched nothing would pass vacuously)", () => {
    for (const f of ["app/api/ai/connection/route.ts", "app/api/templates/generate/route.ts", "app/api/knowledge/ask/route.ts", "lib/ai/governedCall.ts"]) {
      expect(callers, f).toContain(f);
    }
  });

  it("every direct caller is GATED, INLINE (checks the agreement), PENDING with an owner, or a HELPER", () => {
    const unclassified = callers.filter((f) => {
      if (HELPERS[f] || PENDING[f]) return false;
      const s = src(f);
      return !usesGates(s) && !checksAgreement(s);
    });
    expect(unclassified).toEqual([]);
  });

  it("the routes this package owns run aiGates: governedAiCall, /api/ai/connection, /api/templates/generate", () => {
    expect(src("lib/ai/governedCall.ts")).toMatch(/await assertAiGates\(\{ orgId, userId, op: input\.op \}\)/);
    expect(usesGates(src("app/api/ai/connection/route.ts"))).toBe(true);
    expect(usesGates(src("app/api/templates/generate/route.ts"))).toBe(true);
    // the connection probes waive the agreement — in writing, and only there
    expect(src("app/api/ai/connection/route.ts")).toMatch(/requireAgreement: false, \/\/ liveness probe, no org content \(GOV-11 done-when 4\)/);
    expect(src("app/api/templates/generate/route.ts")).not.toMatch(/requireAgreement: false/);
  });

  it("PENDING names real provider callers, each with its owner", () => {
    for (const [f, owner] of Object.entries(PENDING)) {
      expect(callers, `${f} no longer calls a provider — remove it from PENDING`).toContain(f);
      expect(owner).toMatch(/^I-\d\d — /);
    }
  });

  it("HELPERS is exhaustive for lib/ — a new lib-level provider caller must be classified", () => {
    const libCallers = callers.filter((f) => f.startsWith("lib/"));
    expect(libCallers.sort()).toEqual(Object.keys(HELPERS).sort());
  });
});
