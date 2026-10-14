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
//     a bare category WITH NO REASONS OF ITS OWN — the picker's rule, held on
//     the server too (DF-P14 fix pass, DEC-29: "requires a reason" holds for
//     any caller, not only the dialog): a bare category the workspace keeps
//     reasons under, or a Cancel Request naming no category at all while the
//     workspace keeps reasons, is refused (`checkBareOutcome`).
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

/** A category the editor shows reasons under (a cancel's four ways). */
const isEditorCategory = (v: unknown): v is TicketOutcome =>
  isTicketOutcome(v) && OUTCOME_REASON_CATEGORIES.includes(v);

/**
 * What the request-form save writes: the same settings, with `outcomeReasons`
 * cleaned — a reason with no words, or under no category the editor shows
 * (`OUTCOME_REASON_CATEGORIES`), is dropped (the editor keeps a blank one
 * while it is being typed), the words are trimmed and bounded, a reason the
 * editor just added (no id yet) is given one from its words, an id already
 * saved is KEPT (a rename never changes it), and the list is bounded.
 * DF-P14 fix pass: every saved id is claimed FIRST (its first holder keeps
 * it), and only then are ids minted for new reasons — so a new reason listed
 * before a saved one can never take the saved one's id and push it to `_2`.
 * Settings WITHOUT the key are returned as they are (the same object), so a
 * workspace that never configured reasons saves exactly what it saved before.
 */
export function withNormalizedOutcomeReasons<T extends object>(settings: T): T {
  if (!(OUTCOME_REASONS_KEY in settings)) return settings;
  const raw = (settings as Record<string, unknown>)[OUTCOME_REASONS_KEY];
  const entries = (Array.isArray(raw) ? raw : []).map((e) => {
    if (!e || typeof e !== "object") return null;
    const r = e as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.trim().slice(0, OUTCOME_REASON_LABEL_MAX) : "";
    if (!label || !isEditorCategory(r.category)) return null;
    return { kept: typeof r.id === "string" ? r.id.trim() : "", label, category: r.category };
  });
  // Saved ids first: the first entry holding a valid id keeps it.
  const holder = new Map<string, number>();
  entries.forEach((e, i) => { if (e && ID_RE.test(e.kept) && !holder.has(e.kept)) holder.set(e.kept, i); });
  const taken = new Set<string>(holder.keys());
  const out: OutcomeReason[] = [];
  entries.forEach((e, i) => {
    if (!e || out.length >= OUTCOME_REASONS_MAX) return;
    const id = holder.get(e.kept) === i ? e.kept : newOutcomeReasonId(e.label, taken);
    taken.add(id);
    out.push({ id, label: e.label, category: e.category });
  });
  return { ...settings, [OUTCOME_REASONS_KEY]: out } as T;
}

/**
 * What the editor is handed from a stored `outcomeReasons` value (DF-P14 fix
 * pass): whatever the JSON holds — a restore, another tool or a hand edit may
 * have written an object, a string or junk entries — it never crashes the
 * Request forms page. The entries the editor can show (an object under one of
 * its categories; id and words read as text, a missing one blank) are
 * `reasons`; every other stored entry — or a stored value that is not a list
 * at all — is counted in `hidden`, so the page can SAY that Save Changes will
 * not keep it, instead of dropping it without a word.
 */
export function editableOutcomeReasons(stored: unknown): { reasons: OutcomeReason[]; hidden: number } {
  if (stored === undefined || stored === null) return { reasons: [], hidden: 0 };
  if (!Array.isArray(stored)) return { reasons: [], hidden: 1 };
  const reasons: OutcomeReason[] = [];
  let hidden = 0;
  for (const e of stored) {
    const r = e && typeof e === "object" ? (e as Record<string, unknown>) : null;
    if (!r || !isEditorCategory(r.category)) { hidden++; continue; }
    reasons.push({
      id: typeof r.id === "string" ? r.id : "",
      label: typeof r.label === "string" ? r.label : "",
      category: r.category,
    });
  }
  return { reasons, hidden };
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
 * category the request is ending with? (A bare category is checked by
 * `checkBareOutcome`.)
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

/** A few of a category's reasons, for a refusal a person reads. */
function reasonNames(list: readonly OutcomeReason[]): string {
  const shown = list.slice(0, 5).map((r) => r.label).join(", ");
  return list.length > 5 ? `${shown}, …` : shown;
}

/**
 * No reason named: may the request end this way? The picker's own rule, held
 * on the server (DF-P14 fix pass — roles-and-permissions GAP-13 acceptance 1
 * "requires selecting a reason from the org's configured list" holds for any
 * caller, never only the dialog):
 *   * a named category (`outcome`) is accepted bare only when the workspace
 *     keeps no reason of its own under it;
 *   * no category named (`outcome` null — Cancel Request's no-category path,
 *     DF-P3) is accepted only when the workspace keeps no reason under any of
 *     the ways the action can end a request (`categories`);
 *   * `completed` never takes a reason (the editor offers none under it), so
 *     a close naming it is never refused here;
 *   * with no list configured, everything is accepted exactly as before.
 */
export function checkBareOutcome(
  outcome: TicketOutcome | null,
  categories: readonly TicketOutcome[],
  reasons: readonly OutcomeReason[],
): { ok: true } | { ok: false; error: string } {
  const keptUnder = (o: TicketOutcome) =>
    (OUTCOME_REASON_CATEGORIES.includes(o) ? reasons.filter((r) => r.category === o) : []);
  if (outcome) {
    const own = keptUnder(outcome);
    if (own.length === 0) return { ok: true };
    return {
      ok: false,
      error: `This workspace records why a request ends as "${OUTCOME_LABEL[outcome]}" — choose one of its reasons (${reasonNames(own)})`,
    };
  }
  const withReasons = categories.filter((o) => keptUnder(o).length > 0);
  if (withReasons.length === 0) return { ok: true };
  return {
    ok: false,
    error: `This workspace records how a request ends and why — say how it ends (${categories.map((o) => OUTCOME_LABEL[o]).join(", ")}), with one of its reasons for ${withReasons.map((o) => `"${OUTCOME_LABEL[o]}"`).join(", ")}`,
  };
}
