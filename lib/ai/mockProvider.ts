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

import type {
  AiProvider, Entity, NoteInsights, BriefContext,
  ScheduleBrief, ScheduleQuestion, GeneratedSchedule, GeneratedTask,
} from "./types";

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

  async analyzeNote(body): Promise<NoteInsights> {
    const entities = await mockProvider.extractEntities(body);
    // Suggest tasks from prose lines that aren't already checkboxes.
    const lines = body.split("\n").filter((l) => !/^\s*[-*]\s*\[/.test(l));
    const text = lines.join(" ");
    const verbCue = /\b(need to|have to|must|should|follow up|schedule|call|email|verify|confirm|review|send)\b[^.!?]*/gi;
    const matches = (text.match(verbCue) ?? []).slice(0, 4).map((s) => s.trim().replace(/\s+/g, " "));
    return { entities, suggestedTasks: Array.from(new Set(matches)) };
  },

  async briefMe(ctx: BriefContext): Promise<string> {
    const lines: string[] = ["Good day. Here is what your scratchpad looks like:\n"];
    if (ctx.overdue.length > 0) {
      lines.push(`**Overdue (${ctx.overdue.length}):**`);
      for (const t of ctx.overdue.slice(0, 5)) {
        const days = t.dueAt ? Math.max(0, Math.round((Date.parse(ctx.today_iso) - Date.parse(t.dueAt)) / 86400000)) : null;
        lines.push(`- ${t.body}${days ? ` (${days}d past due)` : ""}`);
      }
      lines.push("");
    }
    if (ctx.today.length > 0) {
      lines.push(`**Due today (${ctx.today.length}):**`);
      for (const t of ctx.today.slice(0, 5)) lines.push(`- ${t.body}`);
      lines.push("");
    }
    if (ctx.soon.length > 0) {
      lines.push(`**This week (${ctx.soon.length}):**`);
      for (const t of ctx.soon.slice(0, 5)) lines.push(`- ${t.body}`);
      lines.push("");
    }
    if (ctx.overdue.length + ctx.today.length + ctx.soon.length === 0) {
      lines.push("_No urgent items. Nice._");
    }
    lines.push("\n_(This is the local heuristic brief — connect a real AI provider to get a narrated summary.)_");
    return lines.join("\n");
  },

  async clarifySchedule(brief: ScheduleBrief): Promise<ScheduleQuestion[]> {
    // Heuristic: ask only about the structured gaps the stepper didn't
    // already fill. A real provider asks domain-smart questions.
    const qs: ScheduleQuestion[] = [];
    if (!brief.startDate) {
      qs.push({ question: "What day should this start?", why: "Anchors every task's dates.", options: ["Today", "Next Monday"] });
    }
    if (!brief.shiftPattern) {
      qs.push({ question: "What shift pattern?", why: "Sets how many hours/day the work packs into.", options: ["Day only", "Day + night", "24/7"] });
    }
    if (!brief.crew) {
      qs.push({ question: "Who's doing the work — in-house crew or a contractor?", why: "Sets the planned responsible party." });
    }
    return qs;
  },

  async generateSchedule(brief: ScheduleBrief): Promise<GeneratedSchedule> {
    // Deterministic phased skeleton built from the description. Not
    // smart — it splits the description into candidate work items and
    // wraps them in a sensible shutdown→work→startup envelope so the
    // user has a real, editable starting structure even with no API.
    const start = brief.startDate ? new Date(`${brief.startDate}T06:00:00Z`) : new Date();
    const hoursPerDay = brief.shiftPattern === "24x7" ? 24 : brief.shiftPattern === "day-night" ? 20 : 10;
    const crew = brief.crew?.trim() || null;

    // Pull candidate work items out of the prose: split on commas,
    // "and", semicolons, newlines; keep verb-ish chunks.
    const items = brief.description
      .split(/[,;\n]|\band\b/gi)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && /[a-z]/i.test(s))
      .slice(0, 12);

    const tasks: GeneratedTask[] = [];
    let cursor = new Date(start);
    const addDays = (d: Date, n: number) => { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; };

    const phase = (name: string) => {
      tasks.push({ name, plannedStartAt: cursor.toISOString(), plannedAt: cursor.toISOString(), outlineLevel: 1, isSummary: true });
    };
    const work = (name: string, days: number) => {
      const s = new Date(cursor);
      const f = addDays(s, Math.max(0, days - 1));
      tasks.push({
        name, plannedStartAt: s.toISOString(), plannedAt: f.toISOString(),
        outlineLevel: 2, durationHours: days * hoursPerDay, responsibleParty: crew,
      });
      cursor = addDays(f, 1);
    };

    phase("Shutdown & isolation");
    work("Shut down and depressure", 1);
    work("Isolate and lock out", 1);

    phase("Execution");
    if (items.length === 0) work("Perform the work", 2);
    else for (const it of items) work(cap(it), 1);

    phase("Startup");
    work("Reinstate and test", 1);
    work("Start up and return to service", 1);

    // Backfill phase finish dates to envelope their children.
    fillSummaryDates(tasks);

    return {
      title: deriveTitle(brief.description),
      tasks,
      notes: [
        "Generated locally (no AI key configured) — a rough skeleton from your description. Edit freely before applying.",
        `Assumed ${hoursPerDay}h/day from the shift pattern${crew ? `, ${crew} doing the work` : ""}.`,
      ],
    };
  },
};

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

function deriveTitle(desc: string): string {
  const first = desc.trim().split(/[.\n]/)[0].trim();
  return first.length > 60 ? first.slice(0, 57) + "…" : (first || "New schedule");
}

/** Set each summary row's start/finish to envelope the work rows that
 *  follow it (until the next summary), so phases render as real spans. */
function fillSummaryDates(tasks: GeneratedTask[]): void {
  for (let i = 0; i < tasks.length; i++) {
    if (!tasks[i].isSummary) continue;
    let lo = Infinity, hi = -Infinity;
    for (let j = i + 1; j < tasks.length && !tasks[j].isSummary; j++) {
      const s = Date.parse(tasks[j].plannedStartAt ?? tasks[j].plannedAt);
      const f = Date.parse(tasks[j].plannedAt);
      if (Number.isFinite(s)) lo = Math.min(lo, s);
      if (Number.isFinite(f)) hi = Math.max(hi, f);
    }
    if (Number.isFinite(lo)) tasks[i].plannedStartAt = new Date(lo).toISOString();
    if (Number.isFinite(hi)) tasks[i].plannedAt = new Date(hi).toISOString();
  }
}
