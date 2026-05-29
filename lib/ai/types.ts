// lib/ai/types.ts
//
// AI provider contract for Phase 9.
//
// The platform MAY call an external LLM for non-mutating enhancement
// tasks: summarize a body of notes, extract entities, suggest
// follow-ups, or scaffold a handoff write-up. Per the directive:
//
//   - AI integration must degrade gracefully if keys are missing.
//   - AI must NEVER autonomously modify records.
//   - AI must NEVER spam users or behave like an "agent".
//
// Implementation:
//   - lib/ai/index.ts:getAiProvider() resolves a provider based on
//     env vars. With no provider configured, it returns the mock
//     provider so the UI stays functional without any external API.
//   - Every method here returns plain text (or a small typed
//     structure). Callers display the result; they NEVER auto-apply
//     it to the database. Apply is always a deliberate user action
//     (paste into a new note, etc.).

export interface Entity {
  /** Free-form category: "person", "equipment", "document",
   *  "deadline", "moc", etc. */
  kind: string;
  /** The raw extracted span. */
  text: string;
  /** Optional confidence 0..1; mock provider returns 1. */
  confidence?: number;
}

/** Combined per-note analysis. Returned by analyzeNote — bundles
 *  entity detection + actionable-item extraction in one call so the
 *  UI can render both with a single round-trip. */
export interface NoteInsights {
  entities: Entity[];
  /** Plain imperative lines suggested as new `- [ ]` task lines.
   *  Empty array if the note already captures everything actionable
   *  in checkbox form. Each suggestion is what the user would paste,
   *  minus the leading `- [ ] ` prefix. */
  suggestedTasks: string[];
}

/** Briefing context — what the AI sees when generating the morning
 *  briefing. Designed so the prompt builder can format it without
 *  exposing the AI to the entire note table. */
export interface BriefContext {
  /** Tasks past due, oldest first. */
  overdue: Array<{ body: string; dueAt: string | null; noteCreatedAt: string }>;
  /** Tasks due today. */
  today:   Array<{ body: string; dueAt: string | null; noteCreatedAt: string }>;
  /** Tasks due within 7 days. */
  soon:    Array<{ body: string; dueAt: string | null; noteCreatedAt: string }>;
  /** Most recent N notes the user authored (full bodies), so the AI
   *  can pick up themes like "you've been working on E-204". */
  recentNoteBodies: string[];
  /** ISO date for "today" — passed in so the AI doesn't guess. */
  today_iso: string;
}

export interface AiProvider {
  /** Display name shown in the UI. */
  name: string;
  /** True when backed by a real API, false for the mock fallback.
   *  UI uses this to render a small "(mock)" badge so users know. */
  isReal: boolean;

  /** Short paragraph summary of the given text. Single-paragraph,
   *  no headings. */
  summarize(text: string): Promise<string>;

  /** Pull out structured entities — tags, names, dates, MOC refs.
   *  Implementations should be conservative; the UI surfaces
   *  results as suggestions for the human, not commitments. */
  extractEntities(text: string): Promise<Entity[]>;

  /** Given a recent body of notes / activity, propose 3-5 likely
   *  next actions. Plain bulleted lines. The user picks which to
   *  add to the scratchpad. */
  suggestFollowups(text: string): Promise<string[]>;

  /** Scaffold a handoff note (e.g. shift change, weekend coverage).
   *  Markdown allowed; the user reviews + edits before posting. */
  generateHandoff(context: string): Promise<string>;

  /** Combined per-note analysis — entities + actionable items.
   *  Auto-runs after every note save in the scratchpad UI; results
   *  cached client-side so we don't re-hit the API on every render. */
  analyzeNote(body: string): Promise<NoteInsights>;

  /** Generate a narrated "Good morning, here's your day" briefing
   *  in markdown. The UI renders it at the top of the Brief tab.
   *  Should reference specific equipment / MOCs / people the AI
   *  sees in the context — NEVER invent new ones. Cite urgency
   *  ("3 days overdue") whenever the dueAt is present. */
  briefMe(ctx: BriefContext): Promise<string>;
}
