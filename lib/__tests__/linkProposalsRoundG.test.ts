// intelligence Round G (I-08) — link proposals: block-set semantics, bounds,
// conflict targets, provenance and the read policy.
//
//   * LNK-1  — a stale proposal re-enters the queue when the next run
//              re-derives it from the new revision; publish-time staling runs
//              on the service role through /api/links/invalidate (LNK-11),
//              for a caller who could publish the document, and retires only
//              proposals whose evidence came from THAT document.
//   * LNK-8  — a dismissal blocks the (pair, skill) that produced it, never
//              another skill's evidence; a dismissal can be reopened.
//   * LNK-12 — pending proposals are in the block-set: two runs over 528
//              drafts queue 400 then the remaining 128, and `proposed` counts
//              rows actually written.
//   * LNK-2  — every input pages past PostgREST's max-rows; decisions are
//              read by targeted query on the candidate pairs.
//   * LNK-10 — ranked before the slice; the queue holds a bounded number of
//              'inferred' proposals; one shared item proposes nothing.
//   * LNK-5 / LNK-6 — private connection skills do not run; the bounded
//              pattern subset (a filter — the worker runner's deadline is the
//              guarantee: lib/__tests__/customSkillRunner.test.ts); a skill
//              whose match overruns is switched off with the reason on the
//              row; without a bounded matcher no custom skill runs.
//   * LNK-3 / IRLS-2 / WIRE-2 — provable links apply against the plain
//              index (once, carried by the lower document number); a failed
//              apply is an ERROR and the draft falls back to the queue.
//   * LNK-13 / LNK-9 — both documents list an approved link with the same
//              evidence; provenance comes from the declared set.
//   * IRLS-4 / WIRE-2 — the mention engine writes against the plain index,
//              keeps a person's pin, and logs a failure.
//   * 20261126 — the paste contract, the indexes, the origin CHECK, the
//              RESTRICTIVE endpoints-readable proposal policy.
//
// The engine runs against an in-memory stand-in (helpers/fakeSupabase) —
// not a database; it proves what the app code does with the answers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({
  ref: null as unknown as FakeDb,
  caller: null as unknown as FakeDb,
  /** The service role's rpc answers, by function name. */
  rpc: {} as Record<string, (args: Record<string, unknown>) => unknown>,
}));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  db.ref = fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (makeFakeSupabase(db.ref) as Record<string, unknown>)[p] });
  return { supabase: proxy };
});
vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeFakeSupabase } = await import("./helpers/fakeSupabase");
  const proxy = new Proxy({}, {
    get: (_t, p: string) => {
      if (p === "auth") {
        return {
          // "tok-<name>" is the signed-in user "u-<name>".
          getUser: async (t: string) => (t.startsWith("tok-")
            ? { data: { user: { id: `u-${t.slice(4)}` } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } }),
        };
      }
      if (p === "rpc") {
        return async (fn: string, args: Record<string, unknown>) => ({ data: db.rpc[fn]?.(args) ?? false, error: null });
      }
      return (makeFakeSupabase(db.ref) as Record<string, unknown>)[p];
    },
  });
  return { supabaseAdmin: proxy };
});
vi.mock("@/lib/serverAuth", async () => {
  const { makeFakeSupabase } = await import("./helpers/fakeSupabase");
  return {
    // The caller's own RLS session: a document they cannot read is absent.
    callerScopedClient: (req: Request) => {
      if (!(req.headers.get("authorization") ?? "")) return { error: "Missing access token", status: 401 };
      return makeFakeSupabase(db.caller);
    },
  };
});

import {
  patternSafetyIssue, compileSkillPatterns, runCustomSkill, carrierOrder, filterDrafts,
  mergeDrafts, dropAlreadyQueued, rankDrafts, planBatch, MAX_SKILL_PATTERNS, TIER_RANK,
  type ProposalDraft,
} from "@/lib/linkProposalLogic";
import { runLinkProposers, invalidateProposalsForRevision, MAX_PENDING_INFERRED } from "@/lib/linkProposerServer";
import { workerSkillMatcher, type SkillMatcherFactory } from "@/lib/customSkillRunner";
import {
  listProposals, approveProposal, dismissProposal, reopenProposal, PROPOSER_LABELS,
  type LinkProposal,
} from "@/lib/linkProposals";
import { listRelatedResources, originBadge, removeRelatedResource, LINK_ORIGINS } from "@/lib/relatedResources";
import { indexDocumentMentions } from "@/lib/mentionIndexer";
import { POST as invalidateRoute } from "@/app/api/links/invalidate/route";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig = (f: string) => repo(join("supabase", "migrations", f));
const ORG = "o1";

beforeEach(() => {
  Object.assign(db.ref, newFakeDb());
  db.caller = newFakeDb();
  db.rpc = {};
  db.ref.unique = {
    document_related_resources: [["document_id", "target_document_id"]],
    proposed_links: [["document_id", "target_document_id", "proposer"]],
    entity_mentions: [["asset_id", "knowledge_document_id", "page"]],
  };
});

const admin = () => makeFakeSupabase(db.ref) as unknown as SupabaseClient;
const t = (name: string) => (db.ref.tables[name] ??= []);
const docRow = (id: string, num: string | null, rev = "1"): Row => ({ id, org_id: ORG, document_number: num, rev, ai_excluded: false });
/** Every document in `ids` carries every tag in `tags` (document_assets). */
function shareTags(ids: string[], tags: string[]) {
  for (const tag of tags) {
    if (!t("assets").some((a) => a.id === `a-${tag}`)) t("assets").push({ id: `a-${tag}`, org_id: ORG, tag });
    for (const id of ids) t("document_assets").push({ id: `da-${id}-${tag}`, org_id: ORG, document_id: id, asset_id: `a-${tag}`, tag_text: tag });
  }
}
/** A knowledge mirror of `docId` whose page carries drawing refs / text. */
function mirror(docId: string, opts: { refs?: string[]; text?: string } = {}) {
  const k = `k-${docId}`;
  t("knowledge_documents").push({ id: k, org_id: ORG, source_document_id: docId });
  for (const [i, ref] of (opts.refs ?? []).entries()) {
    t("knowledge_page_entities").push({ id: `e-${k}-${i}`, org_id: ORG, document_id: k, kind: "ref", tag: ref, raw: null, page: 1 });
  }
  if (opts.text) t("knowledge_chunks").push({ id: `c-${k}`, org_id: ORG, document_id: k, page: 1, seq: 0, content: opts.text });
}
const pending = () => t("proposed_links").filter((r) => r.status === "pending");

// ── pure logic ────────────────────────────────────────────────────────────
describe("LNK-6 — the bounded pattern subset (the same rules as 20261125 skill_pattern_issue)", () => {
  it("refuses the catastrophic and polynomial shapes", () => {
    for (const p of [
      "(a+)+b", "(\\w+\\s?)+$", "(a|aa)*c", "((ab)c)+", "(?=x)y", "(?<n>a)", "(a)\\1",
      "WO.*x", ".+", "\\d{1,5000}", "\\w+\\s+\\w+", "\\b[A-Z]+-\\d+-\\d+\\b",
    ]) {
      expect(patternSafetyIssue(p), p).not.toBeNull();
    }
  });
  it("fix pass: repeats separated only by optional atoms are side by side; a bound above 10 counts as unbounded", () => {
    // The reviewer's four (each ran 5-135 s in one exec), and their cousins.
    for (const p of [
      "\\d+-?\\d+X", "\\w+\\s?\\w+", "\\d{0,100}\\d{0,100}\\d{0,100}\\d{0,100}X",
      "[A-Z0-9]{1,100}[A-Z0-9]{1,100}[A-Z0-9]{1,100}#",
      "\\d+(-)?\\d+", "\\d+(-|)\\d+X", "\\d+(|-)\\d+", "\\d+(-?)\\d+", "(\\d+)-?(\\d+)X",
      "\\d+(\\d+)?X", "(ab)+(ab)+X", "\\d{1,11}\\d{1,11}", "\\d+[-]{0,5}\\d+", ".{1,20}x",
      "\\d{1,20}-\\d{1,20}-\\d{1,20}",
    ]) {
      expect(patternSafetyIssue(p), p).not.toBeNull();
    }
    // Bounded small repeats and a mandatory separator stay allowed.
    for (const p of ["\\d{1,10}\\d{1,10}", ".{0,3}\\d{5}", "\\b[A-Z]{2,4}-\\d{4,6}\\b", "\\d+-\\d+"]) {
      expect(patternSafetyIssue(p), p).toBeNull();
    }
  });
  it("accepts identifier conventions", () => {
    for (const p of [
      "\\bWO-\\d{5}\\b", "\\b(?:WO|PTW)-\\d{4,6}\\b", "\\b[A-Z]{2,4}-\\d+\\b", "\\b[A-Z]+-\\d+\\b",
      "(\\d{3}-)?\\d{4}", "\\bPERMIT-\\d{4}\\b", "\\\\d+",
    ]) {
      expect(patternSafetyIssue(p), p).toBeNull();
    }
  });
  it("compileSkillPatterns refuses an unsafe pattern before compiling it and caps the count", () => {
    const { regexes, errors } = compileSkillPatterns(["(a+)+b", "\\bWO-\\d{5}\\b"]);
    expect(regexes).toHaveLength(1);
    expect(errors[0]).toMatch(/not allowed \(a repeated group/);
    const many = compileSkillPatterns(Array.from({ length: MAX_SKILL_PATTERNS + 2 }, (_, i) => `\\bX${i}-\\d{3}\\b`));
    expect(many.regexes).toHaveLength(MAX_SKILL_PATTERNS);
    expect(many.errors[0]).toMatch(/At most 8 patterns/);
  });
  it("the database function carries the same normalisation and rules", () => {
    const sql = mig("20261125_intel_roundG_skills_authority.sql");
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION skill_pattern_issue"), sql.indexOf("CREATE OR REPLACE FUNCTION link_rules_guard"));
    for (const frag of [
      "raw := regexp_replace(p, '\\\\\\\\', 'EE', 'g');",
      "IF raw ~ '\\\\[1-9]' OR raw ~ '\\\\k<' THEN RETURN 'backreferences are not supported'; END IF;",
      "s := regexp_replace(p, '\\\\.', 'E', 'g');",
      "s := regexp_replace(s, '\\[[^]]*\\]', 'C', 'g');",
      "s := replace(s, '(?:', '(');",
      "IF position('(?' in s) > 0 THEN RETURN 'lookarounds, named groups and inline flags are not supported'; END IF;",
      "IF s ~ '\\([^()]*[*+?{|][^()]*\\)[*+{]' OR s ~ '\\)[^()]*\\)[*+{]' THEN",
      "u := regexp_replace(s, '\\{0+,0*(1[1-9]|[2-9][0-9]|[1-9][0-9]{2,})\\}', '*', 'g');",
      "u := regexp_replace(u, '\\{0*[1-9][0-9]*,0*(1[1-9]|[2-9][0-9]|[1-9][0-9]{2,})\\}', '+', 'g');",
      "IF u ~ '\\.([*+]|\\{[0-9]+,\\})' THEN RETURN 'an unbounded repeat of \".\" is not supported'; END IF;",
      "v := regexp_replace(v, '\\(\\|([^()]*)\\)', '(\\1)?', 'g');",
      "v := regexp_replace(v, '\\(([^()]*)\\|\\)', '(\\1)?', 'g');",
      "v := regexp_replace(v, '\\(([^()]*)\\|\\|([^()]*)\\)', '(\\1|\\2)?', 'g');",
      "v := regexp_replace(v, '\\([^()]*([*+]|\\{[0-9]+,\\})[^()]*\\)(\\?|\\{0+(,[0-9]+)?\\})', 'C*', 'g');",
      "v := regexp_replace(v, '\\([^()]*\\)(\\?|\\{0+(,[0-9]+)?\\})', '', 'g');",
      "v := regexp_replace(v, '[^()|*+?{}](\\?|\\{0+(,[0-9]+)?\\})', '', 'g');",
      "v := regexp_replace(v, '\\(\\)', '', 'g');",
      "v := regexp_replace(v, '\\([^()]*\\)([*+{])', 'C\\1', 'g');",
      "v := regexp_replace(v, '\\(([^()|]*)\\)([^*+?{]|$)', '\\1\\2', 'g');",
      "EXIT WHEN v = prev;",
      "IF v ~ '([*+]|\\{[0-9]+,\\})\\??[^()|*+?{}]([*+]|\\{[0-9]+,\\})' THEN",
      "IF (SELECT COUNT(*) FROM regexp_matches(u, '[*+]|\\{[0-9]+,\\}', 'g')) > 2 THEN",
      "WHERE g[1]::numeric > 100 OR (COALESCE(g[3], '') <> '' AND g[3]::numeric > 100)) THEN",
    ]) {
      expect(fn, frag).toContain(frag);
    }
    // The JS twin carries the same regex sources, step for step.
    const js = repo("lib/linkProposalLogic.ts");
    for (const frag of [
      "/\\([^()]*[*+?{|][^()]*\\)[*+{]/", "/\\)[^()]*\\)[*+{]/", "/\\.([*+]|\\{[0-9]+,\\})/",
      'const WIDE_BOUND = "0*(1[1-9]|[2-9][0-9]|[1-9][0-9]{2,})";',
      ".replace(/\\(\\|([^()]*)\\)/g, \"($1)?\")",
      ".replace(/\\(([^()]*)\\|\\)/g, \"($1)?\")",
      ".replace(/\\(([^()]*)\\|\\|([^()]*)\\)/g, \"($1|$2)?\")",
      ".replace(/\\([^()]*([*+]|\\{[0-9]+,\\})[^()]*\\)(\\?|\\{0+(,[0-9]+)?\\})/g, \"C*\")",
      ".replace(/\\([^()]*\\)(\\?|\\{0+(,[0-9]+)?\\})/g, \"\")",
      ".replace(/[^()|*+?{}](\\?|\\{0+(,[0-9]+)?\\})/g, \"\")",
      ".replace(/\\(\\)/g, \"\")",
      ".replace(/\\([^()]*\\)([*+{])/g, \"C$1\")",
      ".replace(/\\(([^()|]*)\\)([^*+?{]|$)/g, \"$1$2\")",
      "/([*+]|\\{[0-9]+,\\})\\??[^()|*+?{}]([*+]|\\{[0-9]+,\\})/.test(adjacencyView(u))",
      "(u.match(/[*+]|\\{[0-9]+,\\}/g) ?? []).length > 2",
      "/\\{([0-9]+)(,([0-9]*))?\\}/g",
    ]) {
      expect(js, frag).toContain(frag);
    }
  });
});

describe("LNK-6 — a per-document time budget", () => {
  it("runCustomSkill stops and reports the overrun instead of holding the run", () => {
    let clock = 0;
    const { regexes } = compileSkillPatterns(["\\bWO-\\d{5}\\b"]);
    const res = runCustomSkill(
      { id: "r", name: "Work orders", regexes },
      [{ documentId: "d1", text: "WO-10001 WO-10002" }, { documentId: "d2", text: "WO-10003" }],
      new Map([["wo10001", ["x"]]]),
      { budgetMs: 50, now: () => (clock += 30) },
    );
    expect(res.overBudget).toEqual({ documentId: "d1", ms: expect.any(Number) });
    expect(res.overBudget!.ms).toBeGreaterThan(50);
  });
  it("under budget, it is exactly proposeCustomReferences", () => {
    const { regexes } = compileSkillPatterns(["\\bWO-\\d{5}\\b"]);
    const res = runCustomSkill({ id: "r", name: "WO", regexes }, [{ documentId: "d1", text: "see WO-10001" }],
      new Map([["wo10001", ["d2"]]]), { budgetMs: 50, now: () => 0 });
    expect(res.overBudget).toBeNull();
    expect(res.drafts).toHaveLength(1);
  });
});

describe("LNK-13 — the carrier is the lower document number", () => {
  it("natural order, falling back to the id order", () => {
    expect(carrierOrder({ id: "zz", document_number: "SH-2" }, { id: "aa", document_number: "SH-10" })).toEqual(["zz", "aa"]);
    expect(carrierOrder({ id: "zz", document_number: null }, { id: "aa", document_number: "SH-10" })).toEqual(["aa", "zz"]);
    expect(carrierOrder({ id: "zz", document_number: "X" }, { id: "aa", document_number: "x" })).toEqual(["aa", "zz"]);
  });
});

describe("LNK-8 / LNK-12 / LNK-10 — the block-set, keyed like the unique index", () => {
  const d = (over: Partial<ProposalDraft>): ProposalDraft => ({
    documentId: "a", targetDocumentId: "b", proposer: "tag", tier: "inferred", confidence: 0.47, evidence: { summary: "x" }, ...over,
  });
  it("a dismissal blocks only its own skill's opinion, and is applied BEFORE the merge", () => {
    const drafts = [d({ proposer: "tag", tier: "strong", confidence: 0.8 }), d({ proposer: "rule:r1", tier: "strong", confidence: 0.75 })];
    const known = { linked: new Set<string>(), decided: new Set<string>(), dismissed: new Set(["a|b|tag"]) };
    const out = mergeDrafts(filterDrafts(drafts, known));
    expect(out).toHaveLength(1);
    expect(out[0].proposer).toBe("rule:r1");
  });
  it("a dismissed inferred opinion does not silence a later provable reference for the pair", () => {
    const out = filterDrafts([d({ proposer: "opc", tier: "provable", confidence: 1 })],
      { linked: new Set(), decided: new Set(), dismissed: new Set(["a|b|tag"]) });
    expect(out).toHaveLength(1);
  });
  it("approved settles the pair for every skill", () => {
    expect(filterDrafts([d({ proposer: "rule:r1" })], { linked: new Set(), decided: new Set(["a|b"]) })).toHaveLength(0);
  });
  it("an identical queued proposal is not new work; a changed one is", () => {
    const pendingMap = new Map([["a|b|tag", { tier: "inferred" as const, confidence: 0.47 }]]);
    expect(dropAlreadyQueued([d({})], pendingMap)).toHaveLength(0);
    expect(dropAlreadyQueued([d({ tier: "strong", confidence: 0.71 })], pendingMap)).toHaveLength(1);
  });
  it("ranks by tier strength, never alphabetically, and bounds inferred per slice", () => {
    const ranked = rankDrafts([
      d({ documentId: "c", tier: "inferred", confidence: 0.59 }),
      d({ documentId: "e", tier: "provable", confidence: 1 }),
      d({ documentId: "f", tier: "strong", confidence: 0.6 }),
      d({ documentId: "g", tier: "strong", confidence: 0.75 }),
    ]);
    expect(ranked.map((x) => x.documentId)).toEqual(["e", "g", "f", "c"]);
    expect(TIER_RANK.provable > TIER_RANK.strong && TIER_RANK.strong > TIER_RANK.inferred).toBe(true);
    const plan = planBatch([...ranked, d({ documentId: "h" })], { batch: 4, inferredRoom: 1 });
    expect(plan.take.map((x) => x.documentId)).toEqual(["e", "g", "f", "c"]);
    expect(plan.heldInferred).toBe(1); // h: the queue's inferred room is used
    expect(plan.more).toBe(false);     // held guesses do not keep the loop going
    const tight = planBatch(ranked, { batch: 2, inferredRoom: 5 });
    expect(tight.take.map((x) => x.documentId)).toEqual(["e", "g"]);
    expect(tight.more).toBe(true);
  });
});

// ── the engine, end to end ────────────────────────────────────────────────
describe("LNK-12 — the 12-pass driver advances instead of rewriting the head", () => {
  it("two runs over 528 strong drafts queue 400, then the remaining 128; `proposed` is rows written", async () => {
    const ids = Array.from({ length: 33 }, (_, i) => `d${String(i).padStart(2, "0")}`);
    t("documents").push(...ids.map((id) => docRow(id, null)));
    shareTags(ids, ["E-1", "E-2", "E-3"]);
    const r1 = await runLinkProposers(admin(), ORG);
    expect(r1.proposed).toBe(400);
    expect(r1.more).toBe(true);
    expect(pending()).toHaveLength(400);
    const r2 = await runLinkProposers(admin(), ORG);
    expect(r2.proposed).toBe(128);
    expect(r2.more).toBe(false);
    expect(pending()).toHaveLength(528);
    const r3 = await runLinkProposers(admin(), ORG);
    expect(r3.proposed).toBe(0);
    expect(r3.more).toBe(false);
  });
});

describe("LNK-1 / LNK-11 — a stale proposal re-enters the queue from the new revision", () => {
  it("queue at rev 3, publish rev 4 (stale), re-run with the same facts: pending again, from rev 4", async () => {
    t("documents").push(docRow("sheet", "P-12", "3"), docRow("b1", "P-13"), docRow("b2", "P-13"));
    mirror("sheet", { refs: ["P-13"] });
    await runLinkProposers(admin(), ORG);
    expect(pending().map((r) => r.source_rev)).toEqual(["3", "3"]);
    // publish rev 4: the document moves, the server-side sweep stales
    (t("documents").find((r) => r.id === "sheet") as Row).rev = "4";
    const swept = await invalidateProposalsForRevision(admin(), { orgId: ORG, documentId: "sheet", newRev: "4" });
    expect(swept).toEqual({ staled: 2, error: null });
    expect(pending()).toHaveLength(0);
    const again = await runLinkProposers(admin(), ORG);
    expect(again.proposed).toBe(2);
    expect(pending().map((r) => r.source_rev)).toEqual(["4", "4"]);
    expect(t("proposed_links")).toHaveLength(2); // refreshed in place, never duplicated
  });
  it("the publish pipeline sweeps on the service role — never the publisher's RLS session", () => {
    const src = repo("lib/postPublish.ts");
    expect(src).not.toMatch(/staleProposalsForDocument/);
    expect(src).toMatch(/invalidateProposalsForRevision\(input\.serviceClient!/);
    expect(src).toMatch(/requestProposalInvalidation\(input\.documentId\)/);
    expect(src).toMatch(/proposal invalidation did not run/);
    expect(repo("lib/linkProposals.ts")).not.toMatch(/export async function staleProposalsForDocument/);
  });
});

describe("LNK-1 — the sweep retires only proposals whose evidence came from the published document", () => {
  const prop = (id: string, a: string, b: string, rev: string, src?: string): Row => ({
    id, org_id: ORG, document_id: a, target_document_id: b, proposer: "opc", status: "pending", source_rev: rev,
    tier: "strong", confidence: 0.6, evidence: src ? { summary: "x", sourceDocumentId: src } : { summary: "x" },
  });
  beforeEach(() => {
    t("documents").push(docRow("A", "SH-A", "3"), docRow("B", "SH-B", "5"), docRow("C", "SH-C", "2"));
  });
  it("sheet A (rev 3) refers to B: re-issuing B leaves the proposal; re-issuing A retires it", async () => {
    t("proposed_links").push(prop("p1", "A", "B", "3", "A"));
    expect(await invalidateProposalsForRevision(admin(), { orgId: ORG, documentId: "B", newRev: "5" })).toEqual({ staled: 0, error: null });
    expect(t("proposed_links")[0].status).toBe("pending");
    (t("documents").find((d) => d.id === "A") as Row).rev = "4";
    expect(await invalidateProposalsForRevision(admin(), { orgId: ORG, documentId: "A", newRev: "4" })).toEqual({ staled: 1, error: null });
    expect(t("proposed_links")[0].status).toBe("stale");
  });
  it("a proposal written before the source was recorded: kept while its revision matches the other endpoint's, retired when it matches neither", async () => {
    t("proposed_links").push(prop("legacy-b", "A", "B", "5"), prop("legacy-none", "A", "C", "1"));
    const res = await invalidateProposalsForRevision(admin(), { orgId: ORG, documentId: "A", newRev: "3" });
    expect(res).toEqual({ staled: 1, error: null });
    expect(Object.fromEntries(t("proposed_links").map((r) => [r.id, r.status]))).toEqual({ "legacy-b": "pending", "legacy-none": "stale" });
  });
  it("the proposers record where the evidence was read", async () => {
    t("documents").push(docRow("sheet", "P-12", "7"), docRow("p13", "P-13"));
    mirror("sheet", { refs: ["P-13"] });
    await runLinkProposers(admin(), ORG);
    const link = t("document_related_resources")[0] as Row & { evidence: { sourceDocumentId?: string } };
    expect(link.evidence.sourceDocumentId).toBe("sheet");
  });
});

describe("/api/links/invalidate — who may trigger the sweep, and against which revision", () => {
  const post = (token: string | null, body: unknown) => invalidateRoute(new NextRequest("http://t/api/links/invalidate", {
    method: "POST", body: JSON.stringify(body),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }));
  const sheet: Row = { ...docRow("sheet", "P-12", "4"), library_id: "L1", collection_id: null, owner_user_id: "u-owner" };
  beforeEach(() => {
    t("documents").push({ ...sheet });
    db.caller.tables.documents = [{ ...sheet }];
    t("org_members").push(
      { org_id: ORG, uid: "u-member", role: "Supervisor", roles: ["Supervisor"], status: "active" },
      { org_id: ORG, uid: "u-viewer", role: "Viewer", roles: ["Viewer"], status: "active" },
      { org_id: ORG, uid: "u-granted", role: "Engineer-2", roles: ["Engineer-2"], status: "active" },
      { org_id: ORG, uid: "u-owner", role: "Drafter", roles: ["Drafter"], status: "active" },
    );
    t("proposed_links").push(
      { id: "p1", org_id: ORG, document_id: "sheet", target_document_id: "x", proposer: "opc", status: "pending", source_rev: "3", evidence: { summary: "s", sourceDocumentId: "sheet" } },
      { id: "p2", org_id: ORG, document_id: "sheet", target_document_id: "y", proposer: "opc", status: "pending", source_rev: "4", evidence: { summary: "s", sourceDocumentId: "sheet" } },
    );
    db.rpc.user_can_publish_on_library = (a) => a.p_uid === "u-granted" && a.p_library === "L1";
    db.rpc.user_is_effective_owner = (a) => a.p_uid === a.p_doc_owner;
  });
  it("401 without a session", async () => {
    expect((await post(null, { documentId: "sheet" })).status).toBe(401);
  });
  it("404 for a document the caller cannot read (their own RLS decides)", async () => {
    db.caller.tables.documents = [];
    expect((await post("tok-member", { documentId: "sheet" })).status).toBe(404);
  });
  it("403 for a caller who is not an active member of the document's org", async () => {
    expect((await post("tok-outsider", { documentId: "sheet" })).status).toBe(403);
  });
  it("403 for a member who can read the document but could not publish it — a reader cannot empty the queue", async () => {
    const res = await post("tok-viewer", { documentId: "sheet" });
    expect(res.status).toBe(403);
    expect(t("proposed_links").map((r) => r.status)).toEqual(["pending", "pending"]);
  });
  it("the proposal-writer tier, a library publish grant and the effective owner may sweep", async () => {
    for (const tok of ["tok-member", "tok-granted", "tok-owner"]) {
      for (const r of t("proposed_links")) r.status = "pending";
      const res = await post(tok, { documentId: "sheet" });
      expect(res.status, tok).toBe(200);
      expect(await res.json(), tok).toEqual({ staled: 1 });
    }
  });
  it("stales against the document's CURRENT revision (a client value is never read)", async () => {
    const res = await post("tok-member", { documentId: "sheet", newRev: "999" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ staled: 1 });
    expect(t("proposed_links").map((r) => r.status)).toEqual(["stale", "pending"]);
  });
});

describe("LNK-8 / LNK-5 — dismissals block one skill; private skills do not run", () => {
  const setup = (visibility: "org" | "private") => {
    t("documents").push(docRow("a", "DOC-A"), docRow("b", "WO-10023"));
    shareTags(["a", "b"], ["E-1", "E-2"]);
    t("link_rules").push({ id: "r1", org_id: ORG, builtin_key: null, name: "Work orders", kind: "reference",
      config: { patterns: ["\\bWO-\\d{5}\\b"] }, enabled: true, visibility, created_by: "u1" });
    mirror("a", { text: "Repairs per WO-10023 completed." });
  };
  it("dismissing the shared-equipment opinion leaves the work-order reference free to queue", async () => {
    setup("org");
    t("proposed_links").push({ id: "old", org_id: ORG, document_id: "a", target_document_id: "b", proposer: "tag",
      tier: "inferred", confidence: 0.59, status: "dismissed", evidence: {} });
    const run = await runLinkProposers(admin(), ORG, { matcher: workerSkillMatcher() });
    expect(run.proposed).toBe(1);
    expect(pending().map((r) => r.proposer)).toEqual(["rule:r1"]);
  });
  it("a private connection skill never runs over the org's corpus (and its name reaches no evidence)", async () => {
    setup("private");
    const run = await runLinkProposers(admin(), ORG, { matcher: workerSkillMatcher() });
    expect(pending().map((r) => r.proposer)).toEqual(["tag"]);
    expect(JSON.stringify(t("proposed_links"))).not.toContain("Work orders");
    expect(run.notes.join(" ")).toMatch(/1 private connection skill was not run/);
  });
  it("a dismissal can be reopened; a decision RLS refuses is an error, not a silent success", async () => {
    t("proposed_links").push({ id: "p1", org_id: ORG, document_id: "a", target_document_id: "b", proposer: "tag", status: "dismissed", tier: "inferred", confidence: 0.5 });
    await reopenProposal("p1");
    expect(t("proposed_links")[0]).toMatchObject({ status: "pending", decided_by: null });
    db.ref.refuseWrites.add("proposed_links");
    await expect(dismissProposal("p1", { userId: "u" })).rejects.toThrow(/was not changed/);
  });
});

describe("LNK-6 — an overrunning skill is switched off with the reason, never silently skipped", () => {
  const setup = (pattern: string, text: string) => {
    t("documents").push(docRow("a", "DOC-A"), docRow("b", "WO-10023"));
    t("link_rules").push({ id: "r1", org_id: ORG, builtin_key: null, name: "Work orders", kind: "reference",
      config: { patterns: [pattern] }, enabled: true, visibility: "org", created_by: "u1" });
    mirror("a", { text });
  };
  it("a match inside the subset that never returns is stopped by the worker's deadline; the skill is switched off, its output not queued", async () => {
    // \w+a\w+Q is inside the bounded subset and cubic on a run of letters:
    // only the worker's hard ceiling can stop it (DEC-55).
    setup("\\w+a\\w+Q", `WO-10023 ${"a".repeat(5_000)}`);
    const t0 = Date.now();
    const run = await runLinkProposers(admin(), ORG, { matcher: workerSkillMatcher({ hardDocMs: 300 }) });
    expect(Date.now() - t0).toBeLessThan(8_000);
    const rule = t("link_rules").find((r) => r.id === "r1")!;
    expect(rule.enabled).toBe(false);
    expect(String(rule.disabled_reason)).toMatch(/one match ran for more than \d+ ms on one document and was stopped/);
    expect(run.disabledSkills).toEqual(["Work orders"]);
    expect(run.notes.join(" ")).toMatch(/overran its time budget/);
    expect(pending().filter((r) => String(r.proposer).startsWith("rule:"))).toHaveLength(0);
  }, 20_000);
  it("a soft overrun (read between matches) says how long it took", async () => {
    setup("\\bWO-\\d{5}\\b", "Repairs per WO-10023 completed.");
    const soft: SkillMatcherFactory = () => ({
      match: async () => ({ found: [], overBudget: { index: 0, ms: 73, hard: false }, budgetSpent: false, error: null }),
      close: async () => {},
    });
    await runLinkProposers(admin(), ORG, { matcher: soft });
    expect(String(t("link_rules").find((r) => r.id === "r1")!.disabled_reason)).toMatch(/it took 73 ms on one document \(the budget is 50 ms\)/);
  });
  it("the run's budget reached inside a skill keeps what it found and says the rest runs next time", async () => {
    setup("\\bWO-\\d{5}\\b", "Repairs per WO-10023 completed.");
    const spent: SkillMatcherFactory = () => ({
      match: async () => ({ found: [["WO-10023"]], overBudget: null, budgetSpent: true, error: null }),
      close: async () => {},
    });
    const run = await runLinkProposers(admin(), ORG, { matcher: spent });
    expect(t("link_rules").find((r) => r.id === "r1")!.enabled).toBe(true);
    expect(run.notes.join(" ")).toMatch(/ran part of the text; it and the remaining skills run next time/);
    expect(pending().map((r) => r.proposer)).toContain("rule:r1");
  });
  it("without a bounded matcher no member-authored pattern runs, and the run says so", async () => {
    setup("\\bWO-\\d{5}\\b", "Repairs per WO-10023 completed.");
    const run = await runLinkProposers(admin(), ORG);
    expect(run.notes.join(" ")).toMatch(/Custom skills did not run — this pass has no bounded matcher/);
    expect(pending().filter((r) => String(r.proposer).startsWith("rule:"))).toHaveLength(0);
    expect(run.inputs.chunksScanned).toBe(0);
  });
  it("a worker that cannot run is a note, never a crash", async () => {
    setup("\\bWO-\\d{5}\\b", "Repairs per WO-10023 completed.");
    const broken: SkillMatcherFactory = () => ({
      match: async () => ({ found: [], overBudget: null, budgetSpent: false, error: "the custom-skill worker could not start (x)" }),
      close: async () => {},
    });
    const run = await runLinkProposers(admin(), ORG, { matcher: broken });
    expect(run.notes.join(" ")).toMatch(/Custom skills did not run to the end — the custom-skill worker could not start/);
    expect(t("link_rules").find((r) => r.id === "r1")!.enabled).toBe(true);
  });
  it("the propose route hands the engine the worker matcher", () => {
    expect(repo("app/api/links/propose/route.ts")).toMatch(/runLinkProposers\(supabaseAdmin, orgId, \{ matcher: workerSkillMatcher\(\) \}\)/);
    // the engine never imports the node-only runner (it is reachable from browser bundles)
    expect(repo("lib/linkProposerServer.ts")).toMatch(/import type \{ SkillMatcherFactory \} from "@\/lib\/customSkillRunner";/);
    expect(repo("lib/linkProposerServer.ts")).not.toMatch(/^import \{[^}]*\} from "@\/lib\/customSkillRunner"/m);
  });
});

describe("LNK-10 — the queue holds a bounded number of guesses", () => {
  it("with the inferred room used up, new inferred proposals wait and the run says so", async () => {
    for (let i = 0; i < MAX_PENDING_INFERRED; i++) {
      t("proposed_links").push({ id: `q${i}`, org_id: ORG, document_id: `x${i}`, target_document_id: `y${i}`, proposer: "tag", tier: "inferred", confidence: 0.5, status: "pending" });
    }
    t("documents").push(docRow("a", null), docRow("b", null));
    shareTags(["a", "b"], ["E-1", "E-2"]);
    const run = await runLinkProposers(admin(), ORG);
    expect(run.proposed).toBe(0);
    expect(run.heldInferred).toBe(1);
    expect(run.more).toBe(false);
    expect(run.notes.join(" ")).toMatch(/waiting for room/);
  });
});

describe("fix pass — the inferred ceiling fails closed; a failed write stops the slice driver", () => {
  it("a count that cannot be read admits no new inferred proposals, and says so", async () => {
    t("documents").push(docRow("a", null), docRow("b", null));
    shareTags(["a", "b"], ["E-1", "E-2"]);
    const orig = makeFakeSupabase(db.ref);
    // proposed_links answers the head count (select with { head: true }) with an error.
    const failedCount: unknown = new Proxy({}, { get: (_x, q: string) => (q === "then"
      ? (res: (x: unknown) => void) => res({ data: null, count: null, error: { message: "count boom" } })
      : () => failedCount) });
    const broken = {
      ...orig,
      from: (tbl: string) => {
        const b = orig.from(tbl) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (tbl !== "proposed_links") return b;
        return new Proxy(b, {
          get: (tt, p: string) => (p === "select"
            ? (cols: string, o?: { head?: boolean }) => (o?.head ? failedCount : tt.select(cols, o))
            : tt[p]),
        });
      },
    } as unknown as SupabaseClient;
    const run = await runLinkProposers(broken, ORG);
    expect(run.proposed).toBe(0);
    expect(run.heldInferred).toBe(1);
    expect(run.notes.join(" ")).toMatch(/could not be counted \(count boom\) — no new inferred proposals were added/);
  });
  it("a queue write that fails returns more: false, so the 12-pass driver does not repeat it", async () => {
    const ids = Array.from({ length: 33 }, (_, i) => `d${String(i).padStart(2, "0")}`);
    t("documents").push(...ids.map((id) => docRow(id, null)));
    shareTags(ids, ["E-1", "E-2", "E-3"]);
    db.ref.refuseWrites.add("proposed_links");
    const run = await runLinkProposers(admin(), ORG);
    expect(run.errors[0]).toMatch(/Queue write failed/);
    expect(run.more).toBe(false);
  });
});

describe("LNK-2 — inputs page past max-rows; decisions are read by targeted query", () => {
  it("120 documents and 120 mirrors are all read though every response is capped at 40 rows", async () => {
    db.ref.maxRows = 40;
    const ids = Array.from({ length: 120 }, (_, i) => `d${String(i).padStart(3, "0")}`);
    t("documents").push(...ids.map((id) => docRow(id, `N-${id}`)));
    for (const id of ids) mirror(id);
    const run = await runLinkProposers(admin(), ORG);
    expect(run.inputs.documents).toBe(120);
    expect(run.inputs.mirroredDocs).toBe(120);
    expect(run.inputs.saturated).toEqual([]);
  });
  it("a dismissal past the old bulk window still blocks its pair", async () => {
    db.ref.maxRows = 40;
    for (let i = 0; i < 100; i++) {
      t("proposed_links").push({ id: `n${i}`, org_id: ORG, document_id: `x${i}`, target_document_id: `y${i}`, proposer: "tag", tier: "strong", confidence: 0.7, status: "dismissed" });
    }
    t("proposed_links").push({ id: "zz-last", org_id: ORG, document_id: "a", target_document_id: "b", proposer: "tag", tier: "strong", confidence: 0.71, status: "dismissed" });
    t("documents").push(docRow("a", null), docRow("b", null));
    shareTags(["a", "b"], ["E-1", "E-2", "E-3"]);
    const run = await runLinkProposers(admin(), ORG);
    expect(run.proposed).toBe(0);
    expect(pending()).toHaveLength(0);
  });
});

describe("LNK-3 / IRLS-2 — provable links apply themselves, once", () => {
  const setup = () => {
    // ids sort opposite to the numbers: the carrier is the lower NUMBER.
    t("documents").push(docRow("zz-sheet12", "44-PID-012"), docRow("aa-sheet13", "44-PID-013"));
    mirror("zz-sheet12", { refs: ["44-PID-013"] });
  };
  it("a provable draft run twice leaves exactly one system link, carried by the lower document number", async () => {
    setup();
    const r1 = await runLinkProposers(admin(), ORG);
    expect(r1.autoApplied).toBe(1);
    expect(r1.errors).toEqual([]);
    const r2 = await runLinkProposers(admin(), ORG);
    expect(r2.autoApplied).toBe(0);
    const links = t("document_related_resources");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ document_id: "zz-sheet12", target_document_id: "aa-sheet13", origin: "system", proposer: "opc" });
    const upsert = db.ref.calls.find((c) => c.table === "document_related_resources" && c.method === "upsert");
    expect(upsert!.args[1]).toEqual({ onConflict: "document_id,target_document_id", ignoreDuplicates: true });
  });
  it("a provable draft that cannot be applied is an ERROR and falls back to the review queue", async () => {
    setup();
    db.ref.refuseWrites.add("document_related_resources");
    const run = await runLinkProposers(admin(), ORG);
    expect(run.autoApplied).toBe(0);
    expect(run.fellBackToQueue).toBe(1);
    expect(run.errors[0]).toMatch(/could not be applied .* queued for review instead/);
    expect(pending()).toEqual([expect.objectContaining({ tier: "provable", proposer: "opc" })]);
  });
  it("a failed decisions read writes nothing (a dismissed pair must not come back)", async () => {
    setup();
    db.ref.tables.proposed_links = [];
    const orig = makeFakeSupabase(db.ref);
    // proposed_links answers every paged read with an error.
    const failRange = (b: unknown): unknown => new Proxy(b as object, {
      get: (tt, p: string) => {
        const v = (tt as Record<string, unknown>)[p];
        if (p === "range") return () => Promise.resolve({ data: null, error: { message: "boom" } });
        if (p === "then" || typeof v !== "function") return v;
        return (...a: unknown[]) => failRange((v as (...x: unknown[]) => unknown)(...a));
      },
    });
    const broken = {
      ...orig,
      from: (tbl: string) => (tbl === "proposed_links" ? failRange(orig.from(tbl)) : orig.from(tbl)),
    } as unknown as SupabaseClient;
    const run = await runLinkProposers(broken, ORG);
    expect(run.errors[0]).toMatch(/could not be read \(boom\) — nothing was written/);
    expect(t("document_related_resources")).toHaveLength(0);
  });
});

// ── the client: approvals, provenance, both panels ────────────────────────
describe("LNK-13 / LNK-9 — an approved link reads the same from both documents", () => {
  const proposal = (): LinkProposal => ({
    id: "p1", org_id: ORG, document_id: "aa", target_document_id: "zz", proposer: "tag", tier: "strong",
    confidence: 0.7, evidence: { summary: "Both reference 3 of the same equipment items", tags: ["E-1"] },
    status: "pending", source_rev: null, created_at: "2026-09-30",
  });
  beforeEach(() => {
    t("documents").push(
      { id: "aa", org_id: ORG, document_number: "PD-4471", title: "Pump datasheet", library_id: "L1" },
      { id: "zz", org_id: ORG, document_number: "44-PID-012", title: "P&ID", library_id: "L1" },
    );
    t("proposed_links").push({ ...proposal() });
  });
  it("approval writes the row once, carried by the lower number, and both panels list it with its evidence", async () => {
    await approveProposal(proposal(), { userId: "u1", userName: "rev" });
    expect(t("document_related_resources")).toEqual([expect.objectContaining({
      document_id: "zz", target_document_id: "aa", origin: "proposed", approved_by: "u1",
    })]);
    const fromA = await listRelatedResources("aa");
    const fromZ = await listRelatedResources("zz");
    for (const [list, other, dir] of [[fromA, "zz", "in"], [fromZ, "aa", "out"]] as const) {
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ other_document_id: other, direction: dir, origin: "proposed" });
      expect(list[0].evidence?.summary).toBe("Both reference 3 of the same equipment items");
      expect(originBadge(list[0].origin)?.label).toBe("approved");
    }
    expect(t("proposed_links")[0].status).toBe("approved");
  });
  it("a pair already linked the other way is not written twice; the proposal still resolves", async () => {
    t("document_related_resources").push({ id: "man", org_id: ORG, document_id: "aa", target_document_id: "zz", kind: "document", origin: "human", label: "" });
    await approveProposal(proposal(), { userId: "u1" });
    expect(t("document_related_resources")).toHaveLength(1);
    expect(t("proposed_links")[0].status).toBe("approved");
  });
  it("provenance renders from the declared set; an unknown value is never 'approved'", () => {
    expect(LINK_ORIGINS).toEqual(["human", "system", "proposed", "shaped"]);
    expect(originBadge("human")).toBeNull();
    expect(originBadge("system")?.label).toBe("auto");
    expect(originBadge("shaped")?.label).toBe("from answer");
    // legacy 'user' IS 'shaped' — until 20261126 backfills it, the rows still say 'user'
    expect(originBadge("user")?.label).toBe("from answer");
    expect(originBadge("bogus")?.label).toBe("origin?");
    expect(repo("components/graph/GraphShapeWizard.tsx")).toMatch(/origin: "shaped",/);
    expect(repo("components/graph/GraphShapeWizard.tsx")).not.toMatch(/origin: "user"/);
    const panel = repo("components/documents/RelatedPanel.tsx");
    expect(panel).toMatch(/const badge = originBadge\(r\.origin\);/);
    expect(panel).not.toMatch(/r\.origin === "system" \? "auto" : "approved"/);
  });
  it("a link carried by a document the viewer cannot read is not listed; one to such a document says restricted", async () => {
    // "hidden" is not in the viewer's documents read (RLS), yet links touch it.
    t("document_related_resources").push(
      { id: "in-hidden", org_id: ORG, document_id: "hidden", target_document_id: "aa", kind: "document", origin: "system",
        evidence: { summary: "Off-page connector 44-098 continues onto PD-4471" }, sort_order: 0, created_at: "1" },
      { id: "out-hidden", org_id: ORG, document_id: "aa", target_document_id: "hidden2", kind: "document", origin: "human", sort_order: 1, created_at: "2" },
    );
    const list = await listRelatedResources("aa");
    expect(list.map((r) => r.id)).toEqual(["out-hidden"]);
    expect(list[0]).toMatchObject({ direction: "out", other_document_id: "hidden2", target: null });
    const panel = repo("components/documents/RelatedPanel.tsx");
    expect(panel).toMatch(/\{r\.other_document_id \? "restricted document" : "missing document"\}/);
  });
  it("an unreadable inbound carrier no longer hides the outbound row to the same document", async () => {
    t("document_related_resources").push(
      { id: "in", org_id: ORG, document_id: "hidden", target_document_id: "aa", kind: "document", sort_order: 0, created_at: "1" },
      { id: "out", org_id: ORG, document_id: "aa", target_document_id: "hidden", kind: "document", sort_order: 1, created_at: "2" },
    );
    expect((await listRelatedResources("aa")).map((r) => r.id)).toEqual(["out"]);
  });
  it("an unpin RLS refuses is reported (checked write)", async () => {
    t("document_related_resources").push({ id: "l1", org_id: ORG, document_id: "aa", target_document_id: "zz", kind: "document" });
    db.ref.refuseWrites.add("document_related_resources");
    await expect(removeRelatedResource("l1")).rejects.toThrow(/was not changed/);
  });
});

describe("LNK-10 / LNK-11 — the queue's order and labels", () => {
  it("listProposals returns provable, then strong, then inferred", async () => {
    t("documents").push(
      { id: "a", org_id: ORG, document_number: "A", title: null, library_id: "L" },
      { id: "b", org_id: ORG, document_number: "B", title: null, library_id: "L" },
    );
    for (const [id, tier] of [["i", "inferred"], ["p", "provable"], ["s", "strong"]] as const) {
      t("proposed_links").push({ id, org_id: ORG, document_id: "a", target_document_id: "b", proposer: id, tier, confidence: 0.5, status: "pending", created_at: "2026-09-30" });
    }
    expect((await listProposals(ORG)).map((r) => r.tier)).toEqual(["provable", "strong", "inferred"]);
  });
  it("no label names a detector that does not run", () => {
    expect(Object.keys(PROPOSER_LABELS).sort()).toEqual(["alias", "co_citation", "opc", "tag"]);
    for (const f of ["lib/linkProposals.ts", "lib/linkProposalLogic.ts"]) expect(repo(f)).not.toMatch(/"semantic"/);
  });
  it("the review page tells the truth about dismissals and ceilings", () => {
    const page = repo("app/(protected)/admin/proposed-links/page.tsx");
    expect(page).not.toMatch(/unless a new revision brings new evidence/);
    expect(page).toMatch(/the same skill won’t propose that pair again/);
    expect(page).toMatch(/for \(const k of inputs\.saturated \?\? \[\]\)/);
    expect(page).toMatch(/lastRun\.errors\.map/);
    expect(page).toMatch(/reopenProposal\(p\.id\)/);
  });
});

// ── the mention engine ────────────────────────────────────────────────────
describe("IRLS-4 / WIRE-2 — the mention engine writes against the plain index", () => {
  const dict = [{ assetId: "a1", alias: "E-101", origin: "tag" as const }];
  beforeEach(() => {
    t("knowledge_chunks").push({ id: "c1", org_id: ORG, document_id: "k1", page: 1, seq: 0, content: "Exchanger E-101 feeds the column." });
  });
  it("re-indexing replaces, never stacks, and counts rows actually written", async () => {
    const first = await indexDocumentMentions(ORG, "k1", dict, "d1");
    const second = await indexDocumentMentions(ORG, "k1", dict, "d1");
    expect(first.mentionsWritten).toBe(1);
    expect(second.mentionsWritten).toBe(1);
    expect(t("entity_mentions")).toHaveLength(1);
    const up = db.ref.calls.find((c) => c.table === "entity_mentions" && c.method === "upsert");
    expect(up!.args[1]).toEqual({ onConflict: "asset_id,knowledge_document_id,page", ignoreDuplicates: true });
  });
  it("a person's explicit pin on the same (asset, page) survives the machine pass", async () => {
    t("entity_mentions").push({ id: "pin", org_id: ORG, asset_id: "a1", knowledge_document_id: "k1", page: 1, is_explicit: true, context_snippet: "pinned by hand" });
    const r = await indexDocumentMentions(ORG, "k1", dict, "d1");
    expect(r.mentionsWritten).toBe(0);
    expect(t("entity_mentions")).toEqual([expect.objectContaining({ id: "pin", is_explicit: true, context_snippet: "pinned by hand" })]);
  });
  it("before 20261126 (42P10) the batch is written with plain inserts", async () => {
    db.ref.beforeInsert!.entity_mentions = (row) => {
      const recent = db.ref.calls.slice(-2)[0];
      if (recent?.method === "upsert") throw { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" };
      return row;
    };
    const r = await indexDocumentMentions(ORG, "k1", dict, "d1");
    expect(r.mentionsWritten).toBe(1);
    expect(t("entity_mentions")).toHaveLength(1);
  });
  it("any other failure is logged where it happens, then thrown", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    db.ref.refuseWrites.add("entity_mentions");
    await expect(indexDocumentMentions(ORG, "k1", dict, "d1")).rejects.toThrow(/mention index write/);
    expect(err).toHaveBeenCalledWith("[mentionIndexer]", expect.stringMatching(/mention index write/), { knowledgeDocumentId: "k1" });
    err.mockRestore();
  });
});

// ── 20261126 ──────────────────────────────────────────────────────────────
describe("20261126 — the paste contract and what it builds", () => {
  const sql = mig("20261126_intel_roundG_link_conflict_targets.sql");
  const body = sql.replace(/--[^\n]*/g, "");
  it("inventory (TEMP TABLE, aggregates) before BEGIN; one COMMIT; one final SELECT of (check, ok, n)", () => {
    const temp = body.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g26_before");
    const begin = body.indexOf("BEGIN;");
    const commit = body.indexOf("COMMIT;");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(body.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(body.match(/\bCOMMIT;/g)).toHaveLength(1);
    const tail = body.slice(commit + "COMMIT;".length);
    expect(tail.trim().startsWith("SELECT ")).toBe(true);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(tail.trim().endsWith(";")).toBe(true);
    expect((tail.replace(/'([^']|'')*'/g, "''").match(/;/g) ?? []).length).toBe(1);
    // aggregates only — never a customer row
    const inventory = body.slice(temp, begin);
    expect(inventory).not.toMatch(/SELECT\s+\*/);
    for (const m of inventory.matchAll(/SELECT '([^']|'')*'(?: AS what)?, (\w+\(\*\))/g)) expect(m[2]).toBe("COUNT(*)");
  });
  it("a PLAIN unique pair index replaces the partial one; URL rows stay unconstrained", () => {
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS document_related_resources_doc_target_uniq\s+ON document_related_resources \(document_id, target_document_id\);/);
    expect(body).toMatch(/DROP INDEX IF EXISTS document_related_resources_doc_target_idx;/);
    expect(body).toMatch(/target_document_id IS NULL/); // the inventory of the carve-out
  });
  it("entity_mentions: two plain keys with the old meaning, built only when nothing is duplicated", () => {
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_kdoc_page_uniq\s+ON entity_mentions \(asset_id, knowledge_document_id, page\);/);
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_doc_page_uniq\s+ON entity_mentions \(asset_id, document_id, page\)\s+WHERE knowledge_document_id IS NULL;/);
    expect(body).toMatch(/DROP INDEX IF EXISTS entity_mentions_unique_idx;/);
    expect(body.indexOf("RAISE NOTICE 'entity_mentions carries duplicate keys")).toBeLessThan(body.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_kdoc_page_uniq"));
    // entity_mentions_read belongs to I-02 — not touched here
    expect(body).not.toMatch(/POLICY\s+(IF EXISTS\s+)?entity_mentions_read/);
  });
  it("LNK-9: the origin normaliser, the backfill and the two-world CHECK", () => {
    expect(body).toMatch(/IF NEW\.origin = 'user' THEN NEW\.origin := 'shaped'; END IF;/);
    expect(body).toMatch(/RETURNS trigger LANGUAGE plpgsql SET search_path = public AS \$\$/);
    expect(body).toMatch(/UPDATE document_related_resources SET origin = 'shaped' WHERE origin = 'user';/);
    expect(body).toMatch(/CHECK \(origin IN \('human', 'system', 'proposed', 'shaped'\)\) NOT VALID;/);
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM document_related_resources\s+WHERE origin NOT IN \('human', 'system', 'proposed', 'shaped'\)\) THEN\s+ALTER TABLE document_related_resources VALIDATE CONSTRAINT document_related_resources_origin_check;/);
  });
  it("LNK-4: a RESTRICTIVE select policy requires both endpoints readable under the caller's documents RLS", () => {
    expect(body).toMatch(/CREATE POLICY proposed_links_read_endpoints ON proposed_links\s+AS RESTRICTIVE FOR SELECT\s+USING \(\s+EXISTS \(SELECT 1 FROM documents d WHERE d\.id = proposed_links\.document_id\)\s+AND EXISTS \(SELECT 1 FROM documents d WHERE d\.id = proposed_links\.target_document_id\)\s+\);/);
    // no SECURITY DEFINER shortcut around the documents policy
    expect(body).not.toMatch(/SECURITY DEFINER/);
    // the write policies are verified, not re-created
    expect(body).not.toMatch(/CREATE POLICY proposed_links_write|CREATE POLICY entity_mentions_write/);
    expect(body).toMatch(/qual LIKE '%caller_holds_any_role\(org_id%'/);
  });
  it("probes read deparsed text with no bare casts", () => {
    const tail = body.slice(body.indexOf("COMMIT;"));
    for (const m of tail.matchAll(/(?:qual|with_check|indexdef) (?:NOT )?LIKE '([^']|'')*'/g)) expect(m[0]).not.toMatch(/::/);
  });
});
