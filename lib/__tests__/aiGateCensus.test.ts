// intelligence Round G — I-05 GOV-11 / PR-12: the census of provider calls.
//
// Every file that calls a provider directly (callAiModel / embedPassages /
// transcribePageImage) — and every route that spends a key INDIRECTLY, by
// handing a VisionContext to the ingest engine (lib/knowledgeIngest →
// lib/knowledgeVision) — is classified:
//   GATED      — runs lib/ai/aiGates (or governedAiCall, built on it)
//   INLINE     — an older inline stack that carries ALL FIVE gates: it reads
//                the member's own key (ai_connections), checks the provider
//                allowlist, the signed agreement (AGREEMENT_VERSION), the cap
//                (getCapUsd / getMonthUsage / reserveWithinCap) and meters
//                (recordAskUsage / settleUsage). A static reference check —
//                that each gate is present in the file, not a proof of its
//                order before the call; its owner moves it onto aiGates
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
/** Routes that build a VisionContext: the engine transcribes pages on the key
 *  they pass, so the route is where the gates belong. */
const VISION_CONTEXT = /\bVisionContext\b/;
const indirect = files.filter((f) => f.startsWith("app/") && VISION_CONTEXT.test(src(f)) && !callers.includes(f));

const usesGates = (s: string) => /from "@\/lib\/ai\/aiGates"/.test(s) || /\bgovernedAiCall\s*\(/.test(s);
/** GOV-11 done-when 3: the five gates an INLINE stack must carry, each by
 *  the reference that implements it. */
const FIVE_GATES: Array<[gate: string, ref: RegExp]> = [
  ["own key", /\bai_connections\b/],
  ["provider allowlist", /\b(ALLOWED_PROVIDERS|EMBEDDING_PROVIDERS)\b/],
  ["signed agreement", /\bAGREEMENT_VERSION\b/],
  ["monthly cap", /\b(getCapUsd|getMonthUsage|reserveWithinCap)\s*\(/],
  ["metering", /\b(recordAskUsage|settleUsage)\s*\(/],
];
const missingGates = (s: string) => FIVE_GATES.filter(([, re]) => !re.test(s)).map(([g]) => g);
const carriesAllFive = (s: string) => missingGates(s).length === 0;

/** Routes whose agreement gate is another package's file (owner — limb). */
const PENDING: Record<string, string> = {
  // app/api/flows/read/route.ts left this list with intelligence Round G
  // I-09: it runs assertAiGates before the render and calls the model
  // through governedAiCall with its page images — GATED, checked below.
  "app/api/knowledge/locate/route.ts": "I-07 — locate adopts aiGates with the refine-pass metering (GOV-8 / DWG-5)",
  // app/api/knowledge/ingest/route.ts left this list in I-05's fix pass 5:
  // its vision context now checks the agreement (the GOV-11 verifier's sixth
  // route), so it is INLINE — checked below.
};
/** lib code that calls a provider for a caller that runs the gates. */
const HELPERS: Record<string, string> = {
  "lib/ai/providerCall.ts": "the provider client itself",
  "lib/ai/embeddings.ts": "the embeddings client itself",
  "lib/ai/governedCall.ts": "governedAiCall — runs assertAiGates (checked below)",
  "lib/knowledgeVision.ts": "page transcription for the ingest engine: the drain gates the sponsor's key (loadSponsorVision); the interactive route builds its own VisionContext and is classified on its own below (INLINE)",
  "lib/knowledgeEmbedCore.ts": "the embed slice for /api/knowledge/embed and the drain, which gate the payer",
  "lib/knowledgeIngest.ts": "the ingest drain's sponsor path (loadSponsorVision: key, allowlist, agreement, cap)",
};

describe("GOV-11 / PR-12 — every provider call is behind the gates, or named", () => {
  it("the scan sees the provider callers (a census that matched nothing would pass vacuously)", () => {
    for (const f of ["app/api/ai/connection/route.ts", "app/api/templates/generate/route.ts", "app/api/knowledge/ask/route.ts", "lib/ai/governedCall.ts"]) {
      expect(callers, f).toContain(f);
    }
  });

  it("the scan sees the routes that spend a key through the ingest engine (VisionContext)", () => {
    expect(indirect).toContain("app/api/knowledge/ingest/route.ts");
  });

  it("every direct caller is GATED, INLINE (carries all five gates), PENDING with an owner, or a HELPER", () => {
    const unclassified = [...callers, ...indirect]
      .filter((f) => !HELPERS[f] && !PENDING[f] && !usesGates(src(f)))
      .map((f) => ({ f, missing: missingGates(src(f)) }))
      .filter((x) => x.missing.length > 0);
    expect(unclassified).toEqual([]);
  });

  it("INLINE needs all five gates — the agreement reference alone (the old rule) is not enough", () => {
    const agreementOnly = 'import { AGREEMENT_VERSION } from "@/lib/ai/pricing";\nawait callAiModel({ provider, model, apiKey });';
    expect(missingGates(agreementOnly)).toEqual(["own key", "provider allowlist", "monthly cap", "metering"]);
    expect(carriesAllFive(agreementOnly)).toBe(false);
    // the INLINE routes as they stand carry each of the five
    const inline = [...callers, ...indirect].filter((f) => !HELPERS[f] && !PENDING[f] && !usesGates(src(f)));
    expect(inline.length).toBeGreaterThan(0);
    for (const f of inline) expect(missingGates(src(f)), f).toEqual([]);
  });

  it("the routes this package owns run aiGates: governedAiCall, /api/ai/connection, /api/templates/generate", () => {
    expect(src("lib/ai/governedCall.ts")).toMatch(/await assertAiGates\(\{ orgId, userId, op: input\.op \}\)/);
    expect(usesGates(src("app/api/ai/connection/route.ts"))).toBe(true);
    expect(usesGates(src("app/api/templates/generate/route.ts"))).toBe(true);
    // the connection probes waive the agreement — in writing, and only there
    expect(src("app/api/ai/connection/route.ts")).toMatch(/requireAgreement: false, \/\/ liveness probe, no org content \(GOV-11 done-when 4\)/);
    expect(src("app/api/templates/generate/route.ts")).not.toMatch(/requireAgreement: false/);
  });

  it("the interactive ingest route's vision context carries all five gates — the agreement included (GOV-11 limb, no longer PENDING)", () => {
    const f = "app/api/knowledge/ingest/route.ts";
    expect(PENDING[f]).toBeUndefined();
    // Since ING-13 (I-06b) the route imports aiGates for the table-aware
    // re-index's vision test; its own VisionContext is still the INLINE
    // stack, checked gate by gate here.
    expect(missingGates(src(f))).toEqual([]);
    // the agreement is read for the requester, at the current version, before the VisionContext is built
    const s = src(f);
    const agreementAt = s.indexOf('.from("ai_key_agreements")');
    expect(agreementAt).toBeGreaterThan(0);
    expect(s.slice(agreementAt, agreementAt + 300)).toMatch(/\.eq\("user_id", user\.id\)[\s\S]*\.eq\("agreement_version", AGREEMENT_VERSION\)/);
    expect(agreementAt).toBeLessThan(s.indexOf("vision = {"));
  });

  it("the table-aware re-index runs THE vision test — assertAiGates — before it audits or resets anything (ING-13, I-06b)", () => {
    const s = src("app/api/knowledge/ingest/route.ts");
    expect(usesGates(s)).toBe(true);
    const fn = s.slice(s.indexOf("async function reindex("));
    const gate = fn.indexOf('await assertAiGates({ orgId: lib.org_id as string, userId, op: "knowledgeVision" })');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(fn.indexOf('action: "KNOWLEDGE_LIBRARY_REINDEXED"'));
    expect(gate).toBeLessThan(fn.indexOf("reindexLibraryChunks(libraryId, chunker, { deadlineMs })"));
    // No parallel copy of the test: the re-index reads no key or agreement itself.
    expect(fn.slice(0, fn.indexOf('action: "KNOWLEDGE_LIBRARY_REINDEXED"'))).not.toMatch(/ai_connections|ai_key_agreements|getCapUsd|getMonthUsage/);
  });

  it("flows/read is GATED (I-09, GOV-11 / PR-12): the gates before the render, governedAiCall with the images, no direct provider call", () => {
    const f = "app/api/flows/read/route.ts";
    const s = src(f);
    expect(PENDING[f]).toBeUndefined();
    expect(callers).not.toContain(f);
    expect(usesGates(s)).toBe(true);
    expect(s).not.toMatch(/\bcallAiModel\s*\(/);
    expect(s).toMatch(/await assertAiGates\(\{ orgId, userId, op: "flowRead" \}\)/);
    expect(s).toMatch(/governedAiCall\(\{[\s\S]*?op: "flowRead"[\s\S]*?images: images\.map/);
    // the gates run before the pages are rendered: a refusal costs no render
    expect(s.indexOf("await assertAiGates(")).toBeLessThan(s.indexOf("renderKnowledgePagesReport(fileKey"));
    // the stale comments PR-12 names are gone
    expect(s).not.toMatch(/doesn't carry images/);
  });

  it("PENDING names real provider callers, each with its owner", () => {
    for (const [f, owner] of Object.entries(PENDING)) {
      expect([...callers, ...indirect], `${f} no longer calls a provider — remove it from PENDING`).toContain(f);
      expect(owner).toMatch(/^I-\d\d — /);
    }
  });

  it("HELPERS is exhaustive for lib/ — a new lib-level provider caller must be classified", () => {
    const libCallers = callers.filter((f) => f.startsWith("lib/"));
    expect(libCallers.sort()).toEqual(Object.keys(HELPERS).sort());
  });
});
