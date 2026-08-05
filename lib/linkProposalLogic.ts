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

export type ProposerKind = "opc" | "tag" | "alias" | "semantic";
export type ProposalTier = "provable" | "strong" | "inferred";

export interface ProposalDraft {
  documentId: string;
  targetDocumentId: string;
  proposer: ProposerKind;
  tier: ProposalTier;
  confidence: number;
  evidence: { summary: string; detail?: string; tags?: string[]; page?: number };
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

const MAX_TAG_FANOUT = 40;

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
    // Sharing one tag is weak evidence; sharing several is a relationship.
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

// ── Merge + gate ─────────────────────────────────────────────────────────

/** One proposal per pair: the strongest evidence wins, provable always
 *  beating inferred regardless of raw confidence. */
export function mergeDrafts(drafts: ProposalDraft[]): ProposalDraft[] {
  const rank: Record<ProposalTier, number> = { provable: 3, strong: 2, inferred: 1 };
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

/** Drop anything already linked, already decided, or previously dismissed —
 *  a rejected proposal must never come back to nag. */
export function filterDrafts(drafts: ProposalDraft[], known: {
  linked: Set<string>;
  decided: Set<string>;
}): ProposalDraft[] {
  return drafts.filter((d) => {
    const key = `${d.documentId}|${d.targetDocumentId}`;
    return !known.linked.has(key) && !known.decided.has(key);
  });
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
