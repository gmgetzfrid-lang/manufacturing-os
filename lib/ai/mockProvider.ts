// lib/ai/mockProvider.ts
//
// Local, deterministic, no-network fallback for the AiProvider
// contract. Ships in every build so the AI affordances render even
// when no key is configured. Outputs are intentionally heuristic:
//
//   - summarize: first 2 sentences (or 220 chars), tidied
//   - extractEntities: regex over equipment-tag patterns (X-101,
//     FE-204, V-3201), MOC-like refs (MOC-####), ISO dates,
//     @-mentions
//   - suggestFollowups: scans for unchecked markdown tasks and
//     surfaces them as suggestions
//   - generateHandoff: scaffold template the user edits
//
// Not "smart". Useful enough that the UI feels alive without an
// external dependency. When a real provider is wired in
// (lib/ai/anthropicProvider.ts etc.), this stays as the fallback.

import type { AiProvider, Entity } from "./types";

export const mockProvider: AiProvider = {
  name: "Local heuristics (mock)",
  isReal: false,

  async summarize(text) {
    const trimmed = text.trim();
    if (!trimmed) return "Nothing to summarize.";
    // First two sentences, or 220 chars.
    const sentences = trimmed.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    const out = sentences.length > 220 ? sentences.slice(0, 217) + "…" : sentences;
    return out;
  },

  async extractEntities(text) {
    const out: Entity[] = [];
    const seen = new Set<string>();
    const push = (kind: string, value: string) => {
      const k = `${kind}::${value.toLowerCase()}`;
      if (!seen.has(k)) { seen.add(k); out.push({ kind, text: value, confidence: 1 }); }
    };

    // Equipment-tag-ish patterns: 1-3 letters, dash, digits (+ optional
    // suffix). Avoids matching plain phone-number-ish strings.
    const EQUIP_RE = /\b([A-Z]{1,3})-?(\d{2,5}[A-Z]?)\b/g;
    let m: RegExpExecArray | null;
    while ((m = EQUIP_RE.exec(text)) !== null) {
      push("equipment", `${m[1]}-${m[2]}`);
    }

    // MOC reference patterns: MOC-2024-001, MOC#123, etc.
    const MOC_RE = /\b(MOC[-#]?\d{2,6}(?:[-/]\d{2,6})?)\b/gi;
    while ((m = MOC_RE.exec(text)) !== null) push("moc", m[1]);

    // @mentions.
    const MENTION_RE = /(?:^|\s)@(\w[\w.-]{1,40})/g;
    while ((m = MENTION_RE.exec(text)) !== null) push("person", `@${m[1]}`);

    // ISO-ish dates: 2026-05-29 or 2026/05/29.
    const DATE_RE = /\b(20\d{2}[-/]\d{2}[-/]\d{2})\b/g;
    while ((m = DATE_RE.exec(text)) !== null) push("date", m[1]);

    return out;
  },

  async suggestFollowups(text) {
    const out: string[] = [];
    const CHECKBOX_RE = /^\s*[-*]\s*\[ \]\s*(.+)$/;
    const lines = text.split("\n");
    for (const line of lines) {
      const m = line.match(CHECKBOX_RE);
      if (m) out.push(`Open task still pending: ${m[1].trim()}`);
    }
    if (out.length === 0) {
      // Heuristic fallback: look for soft-cue verbs.
      const verbs = ["need", "should", "must", "follow up", "ask", "check", "confirm", "verify", "send"];
      for (const v of verbs) {
        const re = new RegExp(`\\b${v}\\b[^.!?]*[.!?]`, "gi");
        const matches = text.match(re);
        if (matches) for (const m of matches.slice(0, 3)) out.push(m.trim());
        if (out.length >= 5) break;
      }
    }
    return out.slice(0, 5);
  },

  async generateHandoff(context) {
    const trimmed = context.trim();
    if (!trimmed) {
      return [
        "## Handoff",
        "",
        "**Status:** _(short status here)_",
        "",
        "**Open items:**",
        "- [ ] ",
        "",
        "**Next shift should:**",
        "- _(action)_",
        "",
      ].join("\n");
    }
    return [
      "## Handoff",
      "",
      "**Recent activity:**",
      trimmed.split("\n").slice(0, 6).map((l) => `> ${l}`).join("\n"),
      "",
      "**Suggested next steps:**",
      "- [ ] Confirm above items with the responsible party",
      "- [ ] Update the document inspector for affected sheets",
      "",
      "_(Edit this scaffold before posting — it's a starting point, not a finished note.)_",
    ].join("\n");
  },
};
