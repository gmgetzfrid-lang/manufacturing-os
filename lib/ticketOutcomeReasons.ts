// lib/ticketOutcomeReasons.ts
//
// drafting-flow Round G, DF-P14 — roles-and-permissions GAP-13 acceptance 1
// and drafting-flow GAP-107 acceptance 1: the org's OWN reasons for ending a
// request, under DEC-103's five outcome categories (completed, withdrawn,
// duplicate, handled_out_of_band, rejected — the `tickets.outcome` CHECK
// stays exactly those five; a reason never becomes a category).
//
// The integrator's ruling under DEC-90 (fail-safe, no regression):
//   * the list is OPTIONAL. With none configured, the Cancel Request picker
//     and the workflow route behave exactly as before — the categories;
//   * with a list, the picker offers the org's reasons grouped by category
//     (a category with none of its own is offered bare), and the route
//     accepts only a configured reason (of the category it is sent with) or
//     a bare category.
//
// Where it lives: the request-form configuration, `org_configurations`
// key `'drafting'`, under `outcomeReasons` — the row the request types,
// units and priorities already live in, edited on Admin → Request forms by
// the drafting-form editor set (DEC-107 item 1: Admin, DocCtrl,
// DraftingSupervisor — the admin gate's `requests` surface and the database's
// `org_config_key_writes_*` 'drafting' branch, 20261209). No schema change.
//
// Stored on the ticket (by the workflow route) as `metadata.outcome_reason`
// = { id, label, category } — the label as it read when the request ended,
// so a later rename of the list never rewrites what a closed request says.
//
// Pure: no IO.

import { CANCEL_OUTCOMES, OUTCOME_LABEL, isTicketOutcome, type TicketOutcome } from "@/lib/ticketOutcome";

/** One configured reason. `id` is stable (the editor mints it once); the
 *  label may be edited later. */
export interface OutcomeReason {
  id: string;
  label: string;
  category: TicketOutcome;
}

/** The key under the drafting configuration's JSON. */
export const OUTCOME_REASONS_KEY = "outcomeReasons";
/** A reason's words, at most. */
export const OUTCOME_REASON_LABEL_MAX = 120;
/** Reasons in one workspace's list, at most. */
export const OUTCOME_REASONS_MAX = 100;
/** The categories the editor offers reasons under: the ways Cancel Request
 *  can end a request (a cancel is never "completed" — DEC-103 item 3). */
export const OUTCOME_REASON_CATEGORIES: readonly TicketOutcome[] = CANCEL_OUTCOMES;

const ID_RE = /^[a-z0-9][a-z0-9_]{0,47}$/;

/**
 * The org's reasons from the drafting configuration's data (the
 * `org_configurations` row's `data`), cleaned: an entry without a valid id,
 * words or category is dropped, an id is kept once (the first), the words are
 * trimmed and bounded, and the list is bounded. Anything that is not a list
 * reads as none configured — the categories, as before.
 */
export function parseOutcomeReasons(cfgData: unknown): OutcomeReason[] {
  const raw = (cfgData && typeof cfgData === "object" ? (cfgData as Record<string, unknown>)[OUTCOME_REASONS_KEY] : null);
  if (!Array.isArray(raw)) return [];
  const out: OutcomeReason[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (out.length >= OUTCOME_REASONS_MAX) break;
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const label = typeof r.label === "string" ? r.label.trim().slice(0, OUTCOME_REASON_LABEL_MAX) : "";
    if (!ID_RE.test(id) || !label || !isTicketOutcome(r.category) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, category: r.category });
  }
  return out;
}

/** The id the editor gives a NEW reason: a slug of its words, unique in the
 *  list ("Not drafting work" → "not_drafting_work", then "_2", "_3"…). */
export function newOutcomeReasonId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = (label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)) || "reason";
  const stem = /^[a-z0-9]/.test(base) ? base : `r_${base}`.slice(0, 40);
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const id = `${stem}_${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * What the request-form save writes: the same settings, with `outcomeReasons`
 * cleaned — a reason with no words, or under no known category, is dropped
 * (the editor keeps a blank one while it is being typed), the words are
 * trimmed and bounded, a reason the editor just added (no id yet) is given
 * one from its words, an id already saved is KEPT (a rename never changes
 * it), and the list is bounded. Settings WITHOUT the key are returned as they
 * are (the same object), so a workspace that never configured reasons saves
 * exactly what it saved before.
 */
export function withNormalizedOutcomeReasons<T extends object>(settings: T): T {
  if (!(OUTCOME_REASONS_KEY in settings)) return settings;
  const raw = (settings as Record<string, unknown>)[OUTCOME_REASONS_KEY];
  const out: OutcomeReason[] = [];
  const taken = new Set<string>();
  for (const e of Array.isArray(raw) ? raw : []) {
    if (out.length >= OUTCOME_REASONS_MAX) break;
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.trim().slice(0, OUTCOME_REASON_LABEL_MAX) : "";
    if (!label || !isTicketOutcome(r.category)) continue;
    const kept = typeof r.id === "string" ? r.id.trim() : "";
    const id = ID_RE.test(kept) && !taken.has(kept) ? kept : newOutcomeReasonId(label, taken);
    taken.add(id);
    out.push({ id, label, category: r.category });
  }
  return { ...settings, [OUTCOME_REASONS_KEY]: out } as T;
}

// ─── the Cancel Request picker ────────────────────────────────────────────────

/** One option of the picker. `value` is what the select carries. */
export interface OutcomeChoice {
  value: string;
  outcome: TicketOutcome;
  /** The configured reason, or null for a bare category. */
  reasonId: string | null;
  label: string;
}

export interface OutcomeChoiceGroup {
  outcome: TicketOutcome;
  /** The category's words (the optgroup's label). */
  label: string;
  choices: OutcomeChoice[];
}

const REASON_VALUE_PREFIX = "reason:";

/**
 * The picker's choices for an action that may end a request with
 * `categories`. With no configured reason under any of them (`grouped:
 * false`) the choices are the categories themselves, one each, in order —
 * exactly the picker as it was. With some, each category is a group: its
 * reasons, or — a category with none of its own — the bare category.
 */
export function outcomeChoiceGroups(
  categories: readonly TicketOutcome[],
  reasons: readonly OutcomeReason[],
): { grouped: boolean; groups: OutcomeChoiceGroup[] } {
  const applicable = reasons.filter((r) => categories.includes(r.category));
  const bare = (o: TicketOutcome): OutcomeChoice => ({ value: o, outcome: o, reasonId: null, label: OUTCOME_LABEL[o] });
  return {
    grouped: applicable.length > 0,
    groups: categories.map((o) => {
      const own = applicable.filter((r) => r.category === o);
      return {
        outcome: o,
        label: OUTCOME_LABEL[o],
        choices: own.length > 0
          ? own.map((r) => ({ value: `${REASON_VALUE_PREFIX}${r.id}`, outcome: o, reasonId: r.id, label: r.label }))
          : [bare(o)],
      };
    }),
  };
}

/** The category and reason a picker value stands for, or null. */
export function decodeOutcomeChoice(
  value: string,
  groups: readonly OutcomeChoiceGroup[],
): { outcome: TicketOutcome; reasonId: string | null } | null {
  for (const g of groups) for (const c of g.choices) if (c.value === value) return { outcome: c.outcome, reasonId: c.reasonId };
  return null;
}

// ─── the workflow route's check ───────────────────────────────────────────────

/**
 * Is `reasonId` one of this workspace's configured reasons, under the
 * category the request is ending with? (A bare category never reaches here:
 * the route accepts it as before.)
 */
export function checkOutcomeReason(
  reasonId: string,
  outcome: TicketOutcome,
  reasons: readonly OutcomeReason[],
): { ok: true; reason: OutcomeReason } | { ok: false; error: string } {
  const id = reasonId.trim();
  const found = reasons.find((r) => r.id === id);
  if (!found) {
    return {
      ok: false,
      error: reasons.length === 0
        ? "This workspace has no reasons configured for ending a request — choose how it ends without one"
        : `"${id.slice(0, 48)}" is not one of this workspace's reasons for ending a request`,
    };
  }
  if (found.category !== outcome) {
    return { ok: false, error: `"${found.label}" is a reason for "${OUTCOME_LABEL[found.category]}", not for "${OUTCOME_LABEL[outcome]}"` };
  }
  return { ok: true, reason: found };
}
