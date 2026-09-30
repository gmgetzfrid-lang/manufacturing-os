// lib/linkProposalLogic.ts — the reasoning half of link discovery.
//
// Pure functions, no I/O, fully unit-tested. The server module gathers rows
// and writes results; everything that DECIDES lives here:
//
//   * candidate generation — documents only ever meet through a shared key
//     (a drawing ref, an equipment tag, an alias). Never pairwise: 1,500
//     documents is 1.1M pairs, which is how these systems die.
//   * tiering — provable (arithmetic, applies itself) vs strong vs inferred
//     (queued with its reasons on screen).
//
// Two rules encoded throughout:
//   A link with no visible reason is worse than no link, so every proposal
//   carries evidence a human can read.
//   Ambiguity never auto-applies. One resolution = provable; two = strong;
//   a haystack = say nothing.

/** Built-in proposer keys, plus `rule:<id>` for org-authored Connection
 *  Skills — the engine stopped being a closed set of detectors. LNK-11: no
 *  embedding-similarity proposer runs, so none is named here. */
export type ProposerKind = "opc" | "tag" | "alias" | "co_citation" | (string & {});
export type ProposalTier = "provable" | "strong" | "inferred";

export interface ProposalDraft {
  documentId: string;
  targetDocumentId: string;
  proposer: ProposerKind;
  tier: ProposalTier;
  confidence: number;
  evidence: {
    summary: string; detail?: string; tags?: string[]; page?: number; rule?: string;
    /** LNK-1: the document whose text the evidence was read from — the
     *  endpoint `sourceRev` is a revision OF. The publish-time sweep stales
     *  a proposal only when THIS document moved to another revision. */
    sourceDocumentId?: string;
  };
  sourceRev?: string | null;
}

/** Punctuation/case-blind key — the same identity rule search and short
 *  links use, so "44-PID-012", "44 PID 012" and "44pid012" are one thing. */
export function refKey(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Endpoints are stored smallest-id-first so A→B and B→A can never both
 *  exist as separate rows. */
export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** The unordered pair key every block-set and "already linked" check uses. */
export function pairKeyOf(a: string, b: string): string {
  const [x, y] = orderPair(a, b);
  return `${x}|${y}`;
}

/** LNK-13 (DEC-55): which of two documents CARRIES an applied link — the
 *  row's document_id. The lower document number (natural order, so SH-2
 *  sorts before SH-10), falling back to the id order when either number is
 *  missing or both are equal. Deterministic and human-meaningful; both
 *  documents' Related panels render the row either way. */
export function carrierOrder(
  a: { id: string; document_number?: string | null },
  b: { id: string; document_number?: string | null },
): [string, string] {
  const na = (a.document_number ?? "").trim(), nb = (b.document_number ?? "").trim();
  if (na && nb) {
    const c = na.localeCompare(nb, undefined, { numeric: true, sensitivity: "base" });
    if (c !== 0) return c < 0 ? [a.id, b.id] : [b.id, a.id];
  }
  return orderPair(a.id, b.id);
}

// ── Off-page connector continuity ────────────────────────────────────────
//
// A P&ID set encodes the plant's flow as sheet-to-sheet continuations. We
// already extract the connector text; this turns it into real edges.

export interface OpcOccurrence {
  /** Controlled document the connector was found on. */
  documentId: string;
  /** Drawing numbers referenced by the connector text. */
  refs: string[];
  /** Connector box number, for the evidence line. */
  box?: string;
  page?: number;
  sourceRev?: string | null;
}

export function proposeOpcContinuity(
  occurrences: OpcOccurrence[],
  /** refKey(drawing number) → controlled document ids that own that number. */
  identityIndex: Map<string, string[]>,
): ProposalDraft[] {
  const best = new Map<string, ProposalDraft>();

  for (const occ of occurrences) {
    for (const ref of occ.refs) {
      const owners = identityIndex.get(refKey(ref));
      if (!owners || owners.length === 0) continue;
      // More than a couple of documents claim this number — that's a
      // numbering problem, not a link. Saying nothing beats guessing.
      if (owners.length > 2) continue;

      for (const target of owners) {
        if (target === occ.documentId) continue;
        const [a, b] = orderPair(occ.documentId, target);
        const key = `${a}|${b}`;

        // Exactly one document owns the referenced number → arithmetic.
        const provable = owners.length === 1;
        const draft: ProposalDraft = {
          documentId: a,
          targetDocumentId: b,
          proposer: "opc",
          tier: provable ? "provable" : "strong",
          confidence: provable ? 1 : 0.6,
          evidence: {
            summary: occ.box
              ? `Off-page connector ${occ.box} continues onto ${ref}`
              : `Sheet references drawing ${ref}`,
            detail: provable
              ? undefined
              : `${owners.length} documents carry the number ${ref} — confirm which one this continues onto.`,
            page: occ.page,
            sourceDocumentId: occ.documentId,
          },
          sourceRev: occ.sourceRev ?? null,
        };
        const existing = best.get(key);
        if (!existing || draft.confidence > existing.confidence) best.set(key, draft);
      }
    }
  }
  return [...best.values()];
}

// ── Shared equipment / alias co-occurrence ───────────────────────────────
//
// Candidate generation: build tag → documents, then only pairs that share a
// tag ever get compared. A tag on a hundred documents is a filing category,
// not a relationship — those are skipped (see MAX_TAG_FANOUT).
//
// LNK-10: a pair is proposed only when it shares at least MIN_SHARED_TAGS
// registry items. Two documents sharing ONE item already show each other
// under "Found automatically" (findRelatedDocuments reads the same bridge),
// so a review card per single-item pair only buried the queue — a vessel on
// 35 documents was 595 of them.

const MAX_TAG_FANOUT = 40;
export const MIN_SHARED_TAGS = 2;

export interface TagOccurrence {
  documentId: string;
  /** Normalized equipment tag. */
  tag: string;
  /** Set when the tag matched through a human/extraction alias rather than
   *  the canonical tag — recorded in the evidence so review can judge it. */
  viaAlias?: string;
  sourceRev?: string | null;
}

export function proposeSharedEquipment(occurrences: TagOccurrence[]): ProposalDraft[] {
  // tag → docs (deduped), remembering whether an alias was involved.
  const byTag = new Map<string, Map<string, string | undefined>>();
  for (const o of occurrences) {
    if (!o.tag) continue;
    const docs = byTag.get(o.tag) ?? new Map<string, string | undefined>();
    // A canonical hit beats an alias hit for the same document.
    if (!docs.has(o.documentId) || o.viaAlias === undefined) docs.set(o.documentId, o.viaAlias);
    byTag.set(o.tag, docs);
  }

  // pair → shared tags, plus whether an alias is LOAD-BEARING: true until
  // some shared tag matches canonically on both sides. If every shared tag
  // needed an alias to connect these two, the alias is the reason the pair
  // exists and review must see it.
  const pairs = new Map<string, { tags: string[]; aliasLoadBearing: boolean; aliases: string[] }>();
  for (const [tag, docs] of byTag) {
    if (docs.size < 2 || docs.size > MAX_TAG_FANOUT) continue;
    const ids = [...docs.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = orderPair(ids[i], ids[j]);
        const key = `${a}|${b}`;
        const entry = pairs.get(key) ?? { tags: [], aliasLoadBearing: true, aliases: [] };
        entry.tags.push(tag);
        const viaA = docs.get(ids[i]), viaB = docs.get(ids[j]);
        if (viaA === undefined && viaB === undefined) entry.aliasLoadBearing = false;
        for (const v of [viaA, viaB]) if (v && !entry.aliases.includes(v)) entry.aliases.push(v);
        pairs.set(key, entry);
      }
    }
  }

  const out: ProposalDraft[] = [];
  for (const [key, entry] of pairs) {
    const [documentId, targetDocumentId] = key.split("|");
    const shared = entry.tags.length;
    if (shared < MIN_SHARED_TAGS) continue;
    // Sharing two tags is weak evidence; sharing several is a relationship.
    // Nothing here is ever 'provable' — appearing on the same drawing is
    // real, but whether the documents RELATE is a human call.
    const tier: ProposalTier = shared >= 3 ? "strong" : "inferred";
    const confidence = Math.min(0.9, 0.35 + shared * 0.12);
    const tagList = entry.tags.slice().sort();
    out.push({
      documentId, targetDocumentId,
      proposer: entry.aliasLoadBearing ? "alias" : "tag",
      tier, confidence,
      evidence: {
        summary: shared === 1
          ? `Both reference ${tagList[0]}`
          : `Both reference ${shared} of the same equipment items`,
        detail: entry.aliases.length > 0
          ? `Matched through alias${entry.aliases.length > 1 ? "es" : ""}: ${entry.aliases.join(", ")}`
          : tagList.slice(0, 8).join(", "),
        tags: tagList.slice(0, 12),
      },
    });
  }
  return out;
}

// ── Built-in skills ──────────────────────────────────────────────────────
//
// The engine's own detectors, expressed as seedable Connection Skills so
// nothing about them is privileged: an org can rename, disable, or reason
// about them like any skill it authors. Wording is industry-neutral — the
// engine ships MECHANICS; the org's paperwork conventions are data.

export interface BuiltinSkillDef {
  builtin_key: string;
  name: string;
  description: string;
  kind: "reference" | "shared_entity" | "co_citation";
  config: { patterns?: string[]; minCoCitations?: number };
}

export const BUILTIN_SKILLS: BuiltinSkillDef[] = [
  {
    builtin_key: "opc_continuity",
    name: "Drawing cross-reference continuity",
    description:
      "Follows references extracted from drawings — continuation callouts, off-page connectors, " +
      "referenced sheet numbers — to the document that owns the referenced number. A reference " +
      "resolving to exactly one document applies itself; anything ambiguous queues for review.",
    kind: "reference",
    config: {},
  },
  {
    builtin_key: "shared_equipment",
    name: "Shared equipment",
    description:
      "Connects documents linked to the same registry assets (directly or through an alias). " +
      "Two documents sharing two or more physical items usually relate; several make the case " +
      "strong. A single shared item already shows under “Found automatically”. Nothing here " +
      "auto-applies — relating is a human call.",
    kind: "shared_entity",
    config: {},
  },
  {
    builtin_key: "co_citation",
    name: "Answered together",
    description:
      "Watches your team's questions: when answers repeatedly cite the same pair of documents, " +
      "that pair is proposed as related — with the questions as evidence. Your usage of the " +
      "knowledge base becomes connective tissue.",
    kind: "co_citation",
    config: { minCoCitations: 2 },
  },
];

// ── Custom cross-reference skills ────────────────────────────────────────
//
// The generalization of off-page continuity: ANY identifier convention —
// work orders, permits, ISO sheets, SOP numbers, whatever the facility
// writes — expressed as a pattern by the org, matched against indexed
// document text, resolved against document numbers. The engine supplies
// the mechanics; the org supplies the industry knowledge.

export interface TextOccurrence {
  /** Controlled document whose indexed text this is. */
  documentId: string;
  text: string;
  page?: number;
  sourceRev?: string | null;
}

/** LNK-6: at most this many patterns per skill (the database refuses more
 *  on a person's write — 20261125 link_rules_guard). */
export const MAX_SKILL_PATTERNS = 8;

/** LNK-6: an upper repeat bound above 10 — such a repeat backtracks like an
 *  unbounded one, so the side-by-side and count rules treat it as one. */
const WIDE_BOUND = "0*(1[1-9]|[2-9][0-9]|[1-9][0-9]{2,})";
const WIDE_FROM_ZERO = new RegExp(`\\{0+,${WIDE_BOUND}\\}`, "g");
const WIDE_FROM_ONE = new RegExp(`\\{0*[1-9][0-9]*,${WIDE_BOUND}\\}`, "g");

/** LNK-6: the normalised pattern as the adjacency rule sees it — whatever
 *  can match nothing is dropped, so two repeats with only optional atoms
 *  between them are side by side. Repeated until nothing changes:
 *    a group with an empty branch is optional; an optional group holding an
 *    unbounded repeat is one optional unbounded atom (`C*`); any other
 *    optional group or atom (`?`, `{0,n}`) is dropped; an empty group is
 *    dropped; a repeated group (a plain run, by the group rule) is one atom;
 *    a plain group with no alternation is its contents. */
function adjacencyView(u: string): string {
  let v = u;
  for (let prev = ""; v !== prev; ) {
    prev = v;
    v = v
      .replace(/\(\|([^()]*)\)/g, "($1)?")
      .replace(/\(([^()]*)\|\)/g, "($1)?")
      .replace(/\(([^()]*)\|\|([^()]*)\)/g, "($1|$2)?")
      .replace(/\([^()]*([*+]|\{[0-9]+,\})[^()]*\)(\?|\{0+(,[0-9]+)?\})/g, "C*")
      .replace(/\([^()]*\)(\?|\{0+(,[0-9]+)?\})/g, "")
      .replace(/[^()|*+?{}](\?|\{0+(,[0-9]+)?\})/g, "")
      .replace(/\(\)/g, "")
      .replace(/\([^()]*\)([*+{])/g, "C$1")
      .replace(/\(([^()|]*)\)([^*+?{]|$)/g, "$1$2");
  }
  return v;
}

/**
 * LNK-6 (DEC-55): the bounded pattern subset a Connection Skill pattern must
 * stay inside. A pattern is data a member authors and the engine runs over
 * the whole corpus, so the known catastrophic shapes are refused before
 * anything compiles it — here, in the Studio's live tester, and (the same
 * rules, on the same normalised text) in the database's
 * skill_pattern_issue(), so a direct PATCH of `config` cannot bypass them.
 * Returns the reason, or null when the pattern is inside it.
 *
 * The subset is a FILTER, not a proof of linear time: a pattern inside it
 * can still backtrack for seconds on a pathological text (two repeats
 * around a separator both of them match, e.g. `\w+a\w+X` over a long run of
 * letters). What bounds a run is the engine's hard deadline — custom skills
 * run in a worker thread that is terminated when one text or the run
 * overruns (lib/customSkillRunner.ts).
 *
 * Normalisation: an escape (`\d`, `\.`) is one atom `E`; a character class
 * is one atom `C`; `(?:` is a plain group. A repeat whose upper bound is
 * above 10 counts as unbounded. Then, in order:
 *   backreferences; lookarounds / named groups / inline flags; a repeated
 *   group holding a repeat, an alternation or another group (the
 *   exponential class); an unbounded repeat of `.`; two unbounded repeats
 *   with nothing but optional atoms between them (the polynomial class);
 *   more than 2 unbounded repeats; a repeat bound above 100.
 */
export function patternSafetyIssue(pattern: string): string | null {
  const p = pattern ?? "";
  if (!p.trim()) return "empty pattern";
  if (p.length > 200) return "longer than 200 characters";
  const raw = p.replace(/\\\\/g, "EE");
  if (/\\[1-9]/.test(raw) || /\\k</.test(raw)) return "backreferences are not supported";
  let s = p.replace(/\\[\s\S]/g, "E");
  s = s.replace(/\[[^\]]*\]/g, "C");
  s = s.split("(?:").join("(");
  if (s.includes("(?")) return "lookarounds, named groups and inline flags are not supported";
  if (/\([^()]*[*+?{|][^()]*\)[*+{]/.test(s) || /\)[^()]*\)[*+{]/.test(s)) {
    return "a repeated group may not contain a repeat, an alternation or another group";
  }
  const u = s.replace(WIDE_FROM_ZERO, "*").replace(WIDE_FROM_ONE, "+");
  if (/\.([*+]|\{[0-9]+,\})/.test(u)) return "an unbounded repeat of \".\" is not supported";
  if (/([*+]|\{[0-9]+,\})\??[^()|*+?{}]([*+]|\{[0-9]+,\})/.test(adjacencyView(u))) {
    return "two unbounded repeats may not sit side by side";
  }
  if ((u.match(/[*+]|\{[0-9]+,\}/g) ?? []).length > 2) return "more than 2 unbounded repeats";
  for (const m of s.matchAll(/\{([0-9]+)(,([0-9]*))?\}/g)) {
    if (Number(m[1]) > 100 || (m[3] && Number(m[3]) > 100)) return "a repeat bound above 100 is not supported";
  }
  return null;
}

/** Compile user-authored patterns defensively: bad regex or absurd length
 *  is reported, never thrown mid-run. Patterns that can match empty text
 *  are rejected — they'd hit everywhere and mean nothing. LNK-6: a pattern
 *  outside the bounded subset is refused before it is compiled, and a skill
 *  holds at most MAX_SKILL_PATTERNS patterns (the rest are reported). */
export function compileSkillPatterns(patterns: string[]): {
  regexes: RegExp[]; errors: string[];
} {
  const regexes: RegExp[] = [];
  const errors: string[] = [];
  let kept = 0;
  for (const raw of patterns) {
    const p = (raw ?? "").trim();
    if (!p) continue;
    if (kept >= MAX_SKILL_PATTERNS) {
      errors.push(`At most ${MAX_SKILL_PATTERNS} patterns per skill — ${p.slice(0, 40)} and any after it were not used.`);
      break;
    }
    kept += 1;
    if (p.length > 200) { errors.push(`Pattern too long: ${p.slice(0, 40)}…`); continue; }
    const unsafe = patternSafetyIssue(p);
    if (unsafe) { errors.push(`Pattern not allowed (${unsafe}): ${p}`); continue; }
    try {
      const re = new RegExp(p, "gi");
      if (re.test("")) { errors.push(`Pattern matches empty text: ${p}`); continue; }
      regexes.push(new RegExp(p, "gi"));
    } catch (e) {
      errors.push(`Invalid pattern ${p}: ${(e as Error).message}`);
    }
  }
  return { regexes, errors };
}

/** At most this many matches per pattern per text (a sloppy pattern is not
 *  allowed to flood one page). The worker runner applies the same cap. */
export const MAX_MATCHES_PER_TEXT = 20;

/** Run one custom reference skill over indexed text. A match becomes a link
 *  only when the matched identifier resolves to a real document number —
 *  so a sloppy pattern produces nothing, not garbage. Custom skills never
 *  reach the 'provable' tier: they queue for review, always. */
export function proposeCustomReferences(
  rule: { id: string; name: string; regexes: RegExp[] },
  occurrences: TextOccurrence[],
  identityIndex: Map<string, string[]>,
): ProposalDraft[] {
  return runCustomSkill(rule, occurrences, identityIndex).drafts;
}

/** LNK-6 (DEC-55): the time one skill may spend on one document's text,
 *  read between matches. The hard ceiling on a single match that never
 *  returns is the worker runner's (lib/customSkillRunner.ts). */
export const SKILL_DOC_BUDGET_MS = 50;

/** Fold the matches one skill found in one text into the best draft per
 *  pair — the resolution step, shared by the in-thread run below and the
 *  engine's worker run (customSkillDrafts). `seen` is per text. */
function addSkillMatch(
  best: Map<string, ProposalDraft>,
  rule: { id: string; name: string },
  occ: TextOccurrence,
  matched: string,
  seen: Set<string>,
  identityIndex: Map<string, string[]>,
): void {
  const key = refKey(matched);
  if (!key || seen.has(key)) return;
  seen.add(key);
  const owners = identityIndex.get(key);
  if (!owners || owners.length === 0 || owners.length > 2) return;
  for (const target of owners) {
    if (target === occ.documentId) continue;
    const [a, b] = orderPair(occ.documentId, target);
    const pairKey = `${a}|${b}`;
    const unique = owners.length === 1;
    const draft: ProposalDraft = {
      documentId: a,
      targetDocumentId: b,
      proposer: `rule:${rule.id}`,
      tier: unique ? "strong" : "inferred",
      confidence: unique ? 0.75 : 0.45,
      evidence: {
        summary: `Text references “${matched}”`,
        detail: unique
          ? `Found by the “${rule.name}” skill.`
          : `Found by the “${rule.name}” skill — ${owners.length} documents carry this number.`,
        page: occ.page,
        rule: rule.name,
        sourceDocumentId: occ.documentId,
      },
      sourceRev: occ.sourceRev ?? null,
    };
    const existing = best.get(pairKey);
    if (!existing || draft.confidence > existing.confidence) best.set(pairKey, draft);
  }
}

/** The drafts one skill's matches make, from matches found elsewhere (the
 *  engine's worker run): `found[i]` holds the strings matched in
 *  `occurrences[i]`, in match order; a text with no entry was not run. */
export function customSkillDrafts(
  rule: { id: string; name: string },
  occurrences: TextOccurrence[],
  found: ReadonlyArray<readonly string[] | undefined>,
  identityIndex: Map<string, string[]>,
): ProposalDraft[] {
  const best = new Map<string, ProposalDraft>();
  occurrences.forEach((occ, i) => {
    const seen = new Set<string>();
    for (const matched of found[i] ?? []) addSkillMatch(best, rule, occ, matched, seen, identityIndex);
  });
  return [...best.values()];
}

/** proposeCustomReferences under a per-document time budget and a run
 *  deadline, both read between matches on THIS thread: a skill whose time
 *  on one document passes the budget stops there and reports the overrun
 *  (the caller switches it off with a note); one that reaches `deadline`
 *  (in `now()` units) stops and says so. Neither can interrupt a single
 *  match — the engine therefore runs custom skills through the worker
 *  runner, which can; this in-thread form serves the author's live tester. */
export function runCustomSkill(
  rule: { id: string; name: string; regexes: RegExp[] },
  occurrences: TextOccurrence[],
  identityIndex: Map<string, string[]>,
  opts?: { budgetMs?: number; now?: () => number; deadline?: number },
): {
  drafts: ProposalDraft[];
  overBudget: { documentId: string; ms: number } | null;
  deadlineHit: boolean;
} {
  const budget = opts?.budgetMs ?? Number.POSITIVE_INFINITY;
  const deadline = opts?.deadline ?? Number.POSITIVE_INFINITY;
  const now = opts?.now ?? (() => Date.now());
  const spent = new Map<string, number>();
  const best = new Map<string, ProposalDraft>();
  for (const occ of occurrences) {
    const started = now();
    const stop = (): { documentId: string; ms: number } | "deadline" | null => {
      const t = now();
      const ms = (spent.get(occ.documentId) ?? 0) + (t - started);
      if (ms > budget) return { documentId: occ.documentId, ms: Math.round(ms) };
      return t >= deadline ? "deadline" : null;
    };
    const seen = new Set<string>();
    for (const re of rule.regexes) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(occ.text)) !== null && count < MAX_MATCHES_PER_TEXT) {
        count += 1;
        // Zero-width safety: never loop in place.
        if (m.index === re.lastIndex) re.lastIndex += 1;
        const late = stop();
        if (late === "deadline") return { drafts: [...best.values()], overBudget: null, deadlineHit: true };
        if (late) return { drafts: [...best.values()], overBudget: late, deadlineHit: false };
        addSkillMatch(best, rule, occ, m[0], seen, identityIndex);
      }
      const o = stop();
      if (o === "deadline") return { drafts: [...best.values()], overBudget: null, deadlineHit: true };
      if (o) return { drafts: [...best.values()], overBudget: o, deadlineHit: false };
    }
    spent.set(occ.documentId, (spent.get(occ.documentId) ?? 0) + (now() - started));
  }
  return { drafts: [...best.values()], overBudget: null, deadlineHit: false };
}

// ── Co-citation: questions answered from two documents together ──────────
//
// The knowledge base's own usage is evidence: when people's questions keep
// being answered from the same pair of documents, those documents relate —
// in whatever industry. The question itself is the evidence a reviewer sees.

export interface CoCitationRow {
  question: string;
  /** Controlled document ids the answer cited (deduped). */
  docIds: string[];
}

export function proposeCoCitations(
  rows: CoCitationRow[],
  opts?: { minCoCitations?: number },
): ProposalDraft[] {
  const min = Math.max(1, opts?.minCoCitations ?? 2);
  const pairs = new Map<string, { count: number; questions: string[] }>();
  for (const row of rows) {
    const ids = [...new Set(row.docIds)];
    // A question citing a dozen documents is a survey, not a relationship.
    if (ids.length < 2 || ids.length > 6) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = orderPair(ids[i], ids[j]);
        const key = `${a}|${b}`;
        const entry = pairs.get(key) ?? { count: 0, questions: [] };
        entry.count += 1;
        if (entry.questions.length < 2 && row.question) entry.questions.push(row.question);
        pairs.set(key, entry);
      }
    }
  }
  const out: ProposalDraft[] = [];
  for (const [key, entry] of pairs) {
    if (entry.count < min) continue;
    const [documentId, targetDocumentId] = key.split("|");
    out.push({
      documentId, targetDocumentId,
      proposer: "co_citation",
      tier: entry.count >= 3 ? "strong" : "inferred",
      confidence: Math.min(0.85, 0.3 + entry.count * 0.15),
      evidence: {
        summary: `Answered ${entry.count} question${entry.count === 1 ? "" : "s"} together`,
        detail: entry.questions.length > 0 ? `e.g. “${entry.questions[0].slice(0, 140)}”` : undefined,
        rule: "Answered together",
      },
    });
  }
  return out;
}

// ── Merge + gate ─────────────────────────────────────────────────────────

/** Tier strength — the queue and every slice order by THIS, never by the
 *  tier text (alphabetically 'inferred' sorts first — LNK-10). */
export const TIER_RANK: Record<ProposalTier, number> = { provable: 3, strong: 2, inferred: 1 };

/** One proposal per pair: the strongest evidence wins, provable always
 *  beating inferred regardless of raw confidence. */
export function mergeDrafts(drafts: ProposalDraft[]): ProposalDraft[] {
  const rank = TIER_RANK;
  const best = new Map<string, ProposalDraft>();
  for (const d of drafts) {
    const key = `${d.documentId}|${d.targetDocumentId}`;
    const cur = best.get(key);
    if (!cur || rank[d.tier] > rank[cur.tier] ||
        (rank[d.tier] === rank[cur.tier] && d.confidence > cur.confidence)) {
      best.set(key, d);
    }
  }
  return [...best.values()];
}

/** What the engine already knows about a pair, by the keys the table's
 *  unique index uses: `a|b` for the pair and `a|b|proposer` for one skill's
 *  opinion of it (proposed_links_pair_idx is (document_id,
 *  target_document_id, proposer)). */
export interface KnownPairs {
  /** Pairs already linked, in either direction. */
  linked: Set<string>;
  /** Pairs a person APPROVED — settled for every skill. */
  decided: Set<string>;
  /** LNK-8: `a|b|proposer` a person dismissed — blocks only that skill's
   *  opinion of the pair, never another skill's different evidence. */
  dismissed?: Set<string>;
  /** LNK-12: `a|b|proposer` already waiting in the queue, with what it said. */
  pending?: Map<string, { tier: ProposalTier; confidence: number }>;
}

/** Drop anything already linked, approved, or dismissed for the same skill
 *  — a rejected proposal must never come back to nag. LNK-1: a STALE row is
 *  none of these; the revision it was read from was superseded, so the pair
 *  is re-derived from the current text and re-enters the queue. Run BEFORE
 *  mergeDrafts, so a dismissed opinion cannot win the merge and hide a
 *  different skill's evidence for the pair (LNK-8). */
export function filterDrafts(drafts: ProposalDraft[], known: KnownPairs): ProposalDraft[] {
  return drafts.filter((d) => {
    const key = `${d.documentId}|${d.targetDocumentId}`;
    if (known.linked.has(key) || known.decided.has(key)) return false;
    return !known.dismissed?.has(`${key}|${d.proposer}`);
  });
}

/** LNK-12: a draft identical to the proposal already queued for its (pair,
 *  skill) is not new work — writing it again only re-counted it. */
export function dropAlreadyQueued(drafts: ProposalDraft[], pending: KnownPairs["pending"]): ProposalDraft[] {
  if (!pending || pending.size === 0) return drafts;
  return drafts.filter((d) => {
    const q = pending.get(`${d.documentId}|${d.targetDocumentId}|${d.proposer}`);
    return !q || q.tier !== d.tier || Math.abs(q.confidence - d.confidence) > 1e-6;
  });
}

/** LNK-10: strongest first — tier rank, then confidence, then the pair key
 *  so two runs over the same facts slice identically. */
export function rankDrafts(drafts: ProposalDraft[]): ProposalDraft[] {
  return [...drafts].sort((x, y) =>
    TIER_RANK[y.tier] - TIER_RANK[x.tier] ||
    y.confidence - x.confidence ||
    `${x.documentId}|${x.targetDocumentId}|${x.proposer}`.localeCompare(`${y.documentId}|${y.targetDocumentId}|${y.proposer}`));
}

/** The slice one pass writes: the strongest `batch` drafts, of which at
 *  most `inferredRoom` are 'inferred' (LNK-10 — the queue holds a bounded
 *  number of guesses at a time; the rest wait for room and are counted, not
 *  lost). `more` is true only when drafts that fit remain for a next pass. */
export function planBatch(ranked: ProposalDraft[], opts: { batch: number; inferredRoom: number }): {
  take: ProposalDraft[]; heldInferred: number; more: boolean;
} {
  const take: ProposalDraft[] = [];
  let inferred = 0, heldInferred = 0, more = false;
  for (const d of ranked) {
    if (d.tier === "inferred" && inferred >= opts.inferredRoom) { heldInferred += 1; continue; }
    if (take.length >= opts.batch) { more = true; continue; }
    take.push(d);
    if (d.tier === "inferred") inferred += 1;
  }
  return { take, heldInferred, more };
}

/** Provable proposals apply themselves; everything else queues. Split so
 *  the caller can write them to different places in one pass. */
export function splitByAutoApply(drafts: ProposalDraft[]): {
  autoApply: ProposalDraft[]; queue: ProposalDraft[];
} {
  return {
    autoApply: drafts.filter((d) => d.tier === "provable"),
    queue: drafts.filter((d) => d.tier !== "provable"),
  };
}
