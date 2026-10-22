// lib/examinationScope.ts
//
// drafting-flow Round G, DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE —
// GAP-102 acceptances 4 and 1 (the integrator's rulings (1)–(3) and (6) for
// DF-P24 under DEC-90: industry best practice, fail-safe, no regression).
//
// WHAT A WORKSPACE CONFIGURES (ruling (1)). In its own vocabulary (DEC-35: no
// facility word in code), stored in the request-form configuration the
// existing editors own (org_configurations 'drafting', key
// `examinationScope` — Admin → Request forms, saved with the page's own Save
// Changes under 20261209's write rule):
//   * fields — the named data a package may have to carry (an examination
//     scope, a governing code, a service class … whatever the facility calls
//     them), each with its OWN list of allowed values: the data is picked from
//     the list, never typed (GAP-102 "Do not make the completeness gate a
//     free-text box");
//   * requirements — "field F is required for requests of work class C
//     and/or in library L", each stamped with when it starts to bind
//     (`since` — written by the DATABASE on every save of the row, never by
//     the writer: 20261266's stamp trigger, second fix pass).
// A workspace that configures nothing is exactly today's: no field, no
// read, no gate, no key on any record (pinned across every status and role)
// — with one exception: an issue whose 'drafting' row could not be read at
// all says so on its audit row (`examinationScope: { configUnchecked: true }`),
// since the route cannot know whether that workspace configured anything.
//
// WHAT A REQUEST CARRIES. The values picked for it, one per field
// (ticket_examination_scopes, 20261266 — written only by
// /api/tickets/examination-scope, by the drafter or the engineer already in
// the flow, the assignment queue, or — second fix pass — the requester
// while the request is still with the drafter (an engineer who files a
// like-in-kind request records what they already specified); never a new
// role, slot or stop). Merge-time fix pass (`scopeFieldRight`): the
// requester fills an EMPTY field, and changes or clears only what they
// recorded themselves; from the first review status (PENDING_REVIEW,
// PENDING_FINAL_APPROVAL) only the engineer of record changes a value, each
// change put on the request's history old → new; once the request has
// issued (PENDING_IFC / FINAL_DRAFT) no value is changed or cleared — a
// field still missing may be FILLED by the drafter, the engineer or the
// queue, marked "completed after issue" (`afterIssue`), so what it issued
// with stays readable (`scopeValuesAsIssued`). A request sent back opens
// again.
//
// THE ISSUE GATE (ruling (2)). The issuing transitions (lib/workflow.ts
// ISSUING_APPROVALS, a roster sign-off that completes the review, and — fix
// pass — a consent window whose close on silence would complete it, which
// lib/consentWindowScan.ts then HOLDS for a sign-off instead) refuse
// with a plain sentence naming what is missing — but ONLY where a
// requirement applies to the request AND the request was filed at least
// SCOPE_CLOCK_SKEW_GRACE_MS (15 minutes — merge-time fix pass: `since` is the
// database's clock, the filing time the app server's) after the
// requirement's `since`. A request already in flight when a requirement
// was configured is never newly blocked: it issues, and what is missing is
// said as a warning. A person who already holds the issue authority may
// record why the request issues without it (a waiver: a required reason,
// audited, bound to the revision under review and to the fields missing when
// it was recorded). The gate never acts on anything that is not an issue.
//
// FAIL-SAFE READINGS (each in the "never newly block" direction, ruling (6)):
//   * a requirement with no readable `since`, or naming a field that is not
//     configured or has no values to pick from, never refuses (it can only
//     warn, or nothing);
//   * a value recorded from a list that has since lost it still counts as
//     recorded (it was valid when picked) — the page says it is no longer in
//     the list;
//   * a configuration that cannot be read is no configuration (today's path;
//     the issuing audit row carries `examinationScope: { configUnchecked:
//     true }`, so an issue that bypassed the gate can be told apart);
//   * the request's examination data that cannot be read refuses (503) only
//     where a requirement BINDS the request (filed at or after its `since`);
//     otherwise it issues, the audit row saying the data was unchecked; at
//     the consent close it is a transient read like the others — the close
//     waits a run (never held for good over a read);
//   * a requirement's `since` is the database's: 20261266's trigger on
//     org_configurations rewrites it on every write of the 'drafting' row —
//     an unchanged requirement whose field was fillable in the stored row
//     keeps its stored time, every other one (new, re-targeted, re-added, or
//     whose field had nothing to pick from there) gets the database's clock
//     plus a minute — so no writer (the admin page, a REST PATCH, a stale
//     tab, a restore) can make a requirement bind a request already in
//     flight. Before the paste nothing stamps it, and a requirement with no
//     `since` binds nothing.
//
// Pure and browser-safe: the workflow route, the fill route, the request
// page's panel and the admin editor share it.

import type { OrgDraftingSettings, Ticket } from "@/types/schema";
import { reviewClassOptions } from "@/lib/reviewModel";

/** The key under org_configurations 'drafting'. */
export const EXAMINATION_SCOPE_KEY = "examinationScope";

/** The database update that creates the request-side table. */
export const EXAMINATION_SCOPE_MIGRATION = "20261266";

/** The longest reason a waiver keeps. */
export const EXAMINATION_WAIVER_REASON_MAX = 2000;

/** A field key the parser keeps (trimmed first): a letter or digit, then
 *  letters, digits, spaces, `_`, `.`, `-` — at most 60 characters. The admin
 *  editor validates with this same rule (merge-time fix pass), so nothing it
 *  saves is silently dropped by `parseExaminationScopeConfig`. */
export const FIELD_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;
export const EXAMINATION_FIELD_KEY_MAX = 60;

/** Merge-time fix pass 2: the names no field key may take — every property
 *  of Object.prototype ("constructor", "toString", "valueOf",
 *  "hasOwnProperty" …) and `__proto__`. A plain object answers such a name
 *  with an inherited function, which a value lookup would read as a
 *  recorded value (so the requirement would never be enforced). The parser
 *  drops such a key and the editor refuses it (`examinationScopeProblems`);
 *  every value lookup is also own-property only (`scopeValueOf`). */
export const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set([...Object.getOwnPropertyNames(Object.prototype), "__proto__"]);

/** The value recorded for `key` — an OWN property only (never one inherited
 *  from Object.prototype). Pure. */
export function scopeValueOf<V>(values: Readonly<Record<string, V>>, key: string): V | null {
  return Object.hasOwn(values, key) ? values[key] ?? null : null;
}
/** Set an own property, whatever its name (never the prototype setter). */
function setOwn<V>(o: Record<string, V>, key: string, value: NoInfer<V>): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}
export const EXAMINATION_MAX_FIELDS = 50;
export const EXAMINATION_MAX_OPTIONS = 200;
export const EXAMINATION_MAX_REQUIREMENTS = 500;
const MAX_FIELDS = EXAMINATION_MAX_FIELDS;
const MAX_OPTIONS = EXAMINATION_MAX_OPTIONS;
const MAX_REQUIREMENTS = EXAMINATION_MAX_REQUIREMENTS;

/** Merge-time fix pass (DEC-90 ruling for DF-P24, clock skew): a
 *  requirement's `since` is the DATABASE's clock (20261266's stamp trigger),
 *  but a request's filing time (`tickets.created_at`) is the APP SERVER's
 *  (the create route's `now`). A request filed less than this long after
 *  `since` is treated as in flight — warned, never refused — so "a request
 *  already in flight is never newly blocked" holds under any realistic skew
 *  between the two clocks. */
export const SCOPE_CLOCK_SKEW_GRACE_MS = 15 * 60 * 1000;

/** The instant from which a requirement stored at `since` binds a request
 *  (its filing at or after it): `since` plus the skew grace. null when
 *  `since` cannot be read (such a requirement binds nothing). Pure. */
export function scopeBindsFrom(since: string | null | undefined): string | null {
  const t = since ? Date.parse(String(since)) : NaN;
  return Number.isFinite(t) ? new Date(t + SCOPE_CLOCK_SKEW_GRACE_MS).toISOString() : null;
}

export interface ExaminationScopeOption { value: string; label: string }
export interface ExaminationScopeField { key: string; label: string; options: ExaminationScopeOption[] }
export interface ExaminationScopeRequirement {
  field: string;
  workClass?: string;
  libraryId?: string;
  /** ISO instant the requirement was first stored. */
  since?: string;
}
export interface ExaminationScopeConfig {
  fields: ExaminationScopeField[];
  requirements: ExaminationScopeRequirement[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The workspace's examination-scope configuration, read tolerantly: an
 *  absent or malformed key is no configuration; a malformed field, option
 *  or requirement is left out (never guessed into something that requires
 *  more). Pure. */
export function parseExaminationScopeConfig(cfg: Partial<OrgDraftingSettings> | Record<string, unknown> | null | undefined): ExaminationScopeConfig {
  const raw = (cfg as Record<string, unknown> | null | undefined)?.[EXAMINATION_SCOPE_KEY] as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { fields: [], requirements: [] };
  const fields: ExaminationScopeField[] = [];
  const keys = new Set<string>();
  for (const f of Array.isArray(raw.fields) ? raw.fields.slice(0, MAX_FIELDS) : []) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const key = str(o.key);
    if (!FIELD_KEY_RE.test(key) || RESERVED_FIELD_KEYS.has(key) || keys.has(key)) continue;
    keys.add(key);
    const options: ExaminationScopeOption[] = [];
    const seen = new Set<string>();
    for (const op of Array.isArray(o.options) ? o.options.slice(0, MAX_OPTIONS) : []) {
      if (!op || typeof op !== "object") continue;
      const value = str((op as Record<string, unknown>).value);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      options.push({ value, label: str((op as Record<string, unknown>).label) || value });
    }
    fields.push({ key, label: str(o.label) || key, options });
  }
  const requirements: ExaminationScopeRequirement[] = [];
  for (const r of Array.isArray(raw.requirements) ? raw.requirements.slice(0, MAX_REQUIREMENTS) : []) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const field = str(o.field);
    if (!field) continue;
    const workClass = str(o.workClass);
    const libraryId = str(o.libraryId);
    // "per work class and/or per library" — an entry naming neither applies
    // to nothing (it is never read as "every request").
    if (!workClass && !libraryId) continue;
    const since = str(o.since);
    requirements.push({ field, ...(workClass ? { workClass } : {}), ...(libraryId ? { libraryId } : {}), ...(since ? { since } : {}) });
  }
  return { fields, requirements };
}

/** True when the workspace configured at least one field a person can pick a
 *  value for — the request page shows its panel (and reads) only then. */
export function examinationScopeConfigured(config: ExaminationScopeConfig): boolean {
  return config.fields.some((f) => f.options.length > 0);
}

/** The requirements that apply to one request: its work class and/or its
 *  library, on a field a person can fill. Pure. */
export function applicableRequirements(
  config: ExaminationScopeConfig,
  ticket: Pick<Ticket, "workClass" | "libraryId">,
): ExaminationScopeRequirement[] {
  const fillable = new Set(config.fields.filter((f) => f.options.length > 0).map((f) => f.key));
  return config.requirements.filter((r) => fillable.has(r.field)
    && (!r.workClass || r.workClass === (ticket.workClass ?? null))
    && (!r.libraryId || r.libraryId === (ticket.libraryId ?? null)));
}

/** One recorded value on a request. `afterIssue` (merge-time fix pass,
 *  ruling 4(b)): the value was FILLED after the request issued (it was
 *  missing then) — "completed after issue", for the revision named; it is
 *  not part of what the request issued with. */
export interface ExaminationScopeValue { value: string; by: string | null; byName?: string | null; at: string | null; afterIssue?: { rev: string | null } }
export type ExaminationScopeValues = Record<string, ExaminationScopeValue>;

/** The values a ticket_examination_scopes row carries, read tolerantly. */
export function parseScopeValues(raw: unknown): ExaminationScopeValues {
  const out: ExaminationScopeValues = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const value = str(o.value);
    if (!value) continue;
    setOwn(out, k, {
      value,
      by: typeof o.by === "string" ? o.by : null,
      ...(typeof o.byName === "string" ? { byName: o.byName } : {}),
      at: typeof o.at === "string" ? o.at : null,
      ...(o.afterIssue && typeof o.afterIssue === "object" && !Array.isArray(o.afterIssue)
        ? { afterIssue: { rev: typeof (o.afterIssue as { rev?: unknown }).rev === "string" ? (o.afterIssue as { rev: string }).rev : null } }
        : {}),
    });
  }
  return out;
}

/** The values a request issued with (merge-time fix pass, ruling 4(a)/(b)):
 *  after an issue a value can only be FILLED (never changed or cleared), and
 *  each such fill is marked `afterIssue` for the revision then issued — so
 *  the values as they stood at that issue are the recorded values less those
 *  marked for it. Pure. */
export function scopeValuesAsIssued(values: ExaminationScopeValues, deliverableRev: string | null | undefined): ExaminationScopeValues {
  const out: ExaminationScopeValues = {};
  for (const [k, v] of Object.entries(values)) {
    if (v.afterIssue && (v.afterIssue.rev ?? null) === (deliverableRev ?? null)) continue;
    setOwn(out, k, v);
  }
  return out;
}

/** A waiver: why a request issues without data its requirement names. */
export interface ExaminationScopeWaiver {
  reason: string;
  by: string | null;
  byName?: string | null;
  at: string | null;
  /** The fields missing (and enforced) when it was recorded. */
  fields: string[];
  /** The deliverable revision under review when it was recorded. */
  rev: string | null;
}

export function parseScopeWaiver(raw: unknown): ExaminationScopeWaiver | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const reason = str(o.reason);
  const fields = Array.isArray(o.fields) ? o.fields.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
  if (!reason || fields.length === 0) return null;
  return {
    reason,
    by: typeof o.by === "string" ? o.by : null,
    ...(typeof o.byName === "string" ? { byName: o.byName } : {}),
    at: typeof o.at === "string" ? o.at : null,
    fields,
    rev: typeof o.rev === "string" ? o.rev : null,
  };
}

/** One required field, as a request reads it. */
export interface RequiredScopeField {
  key: string;
  label: string;
  /** True when a requirement binds this request (it was filed at least
   *  SCOPE_CLOCK_SKEW_GRACE_MS after the requirement's `since`) — a missing
   *  value then refuses an issue. */
  enforced: boolean;
  /** The earliest `since` among the requirements that name the field. */
  since: string | null;
  /** What the requirement names: "work class X", "its library", or both. */
  basis: string[];
  /** The value recorded, if any. */
  value: ExaminationScopeValue | null;
  /** The recorded value is no longer one of the field's values (it was when
   *  picked — still counted as recorded). */
  valueRetired: boolean;
}

export interface ExaminationScopeStatus {
  required: RequiredScopeField[];
  /** Required, no value recorded. */
  missing: RequiredScopeField[];
  /** Missing AND enforced — what refuses an issue (unless waived). */
  blocking: RequiredScopeField[];
  /** Missing, not enforced (the request was filed before the requirement,
   *  or the requirement's time cannot be read) — said, never refused. */
  warnOnly: RequiredScopeField[];
}

const at = (iso: string | null | undefined): number => (iso ? Date.parse(String(iso)) : NaN);
/** Does a requirement stored at `since` bind a request filed at `filed`?
 *  Only with both readable, and the filing at least the skew grace after
 *  `since` (SCOPE_CLOCK_SKEW_GRACE_MS). */
const binds = (since: number, filed: number): boolean => Number.isFinite(since) && Number.isFinite(filed) && filed >= since + SCOPE_CLOCK_SKEW_GRACE_MS;

/** Where a request stands against its workspace's requirements. Pure. */
export function examinationScopeStatus(
  config: ExaminationScopeConfig,
  ticket: Pick<Ticket, "workClass" | "libraryId" | "createdAt">,
  values: ExaminationScopeValues,
  draftingCfg?: Partial<OrgDraftingSettings> | Record<string, unknown> | null,
): ExaminationScopeStatus {
  const entries = applicableRequirements(config, ticket);
  const filed = at(ticket.createdAt as string | null | undefined);
  const classLabel = (v: string) => reviewClassOptions((draftingCfg ?? null) as Partial<OrgDraftingSettings> | null, "workClasses").find((o) => o.value === v)?.label ?? v;
  const byField = new Map<string, RequiredScopeField>();
  for (const e of entries) {
    const field = config.fields.find((f) => f.key === e.field)!;
    const since = at(e.since);
    const enforced = binds(since, filed);
    const basis = [e.workClass ? `work class "${classLabel(e.workClass)}"` : null, e.libraryId ? "its library" : null].filter((x): x is string => !!x).join(" in ");
    const cur = byField.get(field.key);
    const value = scopeValueOf(values, field.key);
    if (!cur) {
      byField.set(field.key, {
        key: field.key, label: field.label, enforced, since: Number.isFinite(since) ? e.since! : null, basis: [basis],
        value, valueRetired: !!value && !field.options.some((o) => o.value === value.value),
      });
    } else {
      cur.enforced = cur.enforced || enforced;
      if (Number.isFinite(since) && (!cur.since || since < at(cur.since))) cur.since = e.since!;
      if (!cur.basis.includes(basis)) cur.basis.push(basis);
    }
  }
  const required = [...byField.values()];
  const missing = required.filter((r) => !r.value);
  return { required, missing, blocking: missing.filter((r) => r.enforced), warnOnly: missing.filter((r) => !r.enforced) };
}

/** True when at least one requirement that applies to the request BINDS it
 *  (a readable `since`, the request filed at least SCOPE_CLOCK_SKEW_GRACE_MS
 *  after it) — knowable before
 *  the request's data is read. Pure. */
export function hasBindingRequirement(
  config: ExaminationScopeConfig,
  ticket: Pick<Ticket, "workClass" | "libraryId" | "createdAt">,
): boolean {
  const filed = at(ticket.createdAt as string | null | undefined);
  if (!Number.isFinite(filed)) return false;
  return applicableRequirements(config, ticket).some((e) => binds(at(e.since), filed));
}

/** What an issuing transition does with the request's examination data, from
 *  the read of its ticket_examination_scopes row (the workflow route and the
 *  consent-window close share it). Only called where a requirement applies.
 *  Pure.
 *   * `unreadable` — the row could not be read AND a requirement binds the
 *     request: the issue is refused (route 503) or held (consent close);
 *   * `blocked` — enforced data missing, no waiver covers it;
 *   * `pass` — it issues; `audit` is the issuing row's `examinationScope`
 *     key, `warning` what is missing but not enforced. */
export type ScopeGateOutcome =
  | { kind: "unreadable"; error: string }
  | { kind: "blocked"; blocking: RequiredScopeField[]; refusal: string }
  | { kind: "pass"; audit: Record<string, unknown>; warning: string | null };

export function scopeGateOutcome(
  config: ExaminationScopeConfig,
  ticket: Pick<Ticket, "workClass" | "libraryId" | "createdAt" | "deliverableRev"> & Partial<Pick<Ticket, "status" | "assignedEngineerId">>,
  read: { data: unknown; error: { code?: string | null; message?: string | null } | null },
  draftingCfg?: Partial<OrgDraftingSettings> | Record<string, unknown> | null,
  /** Merge-time fix pass 2: the act's caller already holds the issue
   *  authority (the workflow route's gate runs only after its own authority
   *  checks), so the refusal may tell them they can record a waiver. */
  opts: { callerMayWaive?: boolean } = {},
): ScopeGateOutcome {
  const required = [...new Set(applicableRequirements(config, ticket).map((e) => e.field))];
  if (read.error) {
    // 20261266 not applied: nothing can be recorded yet — never a refusal.
    if (isMissingScopeTable(read.error)) return { kind: "pass", audit: { notMigrated: true, required }, warning: null };
    // Unreadable: refused only where a requirement binds this request; a
    // request filed before every requirement could only ever be warned.
    if (hasBindingRequirement(config, ticket)) return { kind: "unreadable", error: String(read.error.message ?? "unreadable") };
    return { kind: "pass", audit: { unchecked: true, required }, warning: null };
  }
  const row = read.data as { field_values?: unknown; waiver?: unknown } | null;
  const status = examinationScopeStatus(config, ticket, parseScopeValues(row?.field_values), draftingCfg);
  const waiver = parseScopeWaiver(row?.waiver);
  const waived = waiverCovers(waiver, status.blocking, ticket.deliverableRev);
  if (status.blocking.length > 0 && !waived) return { kind: "blocked", blocking: status.blocking, refusal: examinationScopeRefusal(status.blocking, { ticket, callerMayWaive: opts.callerMayWaive === true }) };
  return { kind: "pass", audit: examinationScopeAuditFields(status, waiver, waived), warning: status.warnOnly.length > 0 ? examinationScopeWarning(status.warnOnly) : null };
}

/** Does a recorded waiver cover what blocks the issue now — every blocking
 *  field among those it named, recorded for the revision under review? */
export function waiverCovers(
  waiver: ExaminationScopeWaiver | null,
  blocking: readonly Pick<RequiredScopeField, "key">[],
  deliverableRev: string | null | undefined,
): boolean {
  if (!waiver || blocking.length === 0) return false;
  if ((waiver.rev ?? null) !== (deliverableRev ?? null)) return false;
  return blocking.every((b) => waiver.fields.includes(b.key));
}

const list = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The refusal sentence an issue meets (ruling (2): plain, names what is
 *  missing and who records it). Merge-time fix pass 2: worded by phase and
 *  fact — in review (where every issuing act is) only the engineer of
 *  record writes a value (`scopeFieldRight`), so the sentence names them
 *  and a revision, and the waiver when the caller may record one; with no
 *  engineer of record it names only the waiver and a revision. Before
 *  review (no issuing act is offered there today) the drafter or the
 *  engineer records it. */
export function examinationScopeRefusal(
  blocking: readonly RequiredScopeField[],
  ctx: { ticket?: Partial<Pick<Ticket, "status" | "assignedEngineerId">> | null; callerMayWaive?: boolean } = {},
): string {
  const names = list(blocking.map((b) => b.label));
  const bases = [...new Set(blocking.flatMap((b) => b.basis))];
  const it = blocking.length === 1 ? "it" : "them";
  const head = `This request can't issue yet: ${names} must be recorded for it first (this workspace requires ${it} for ${list(bases)}).`;
  const waive = ctx.callerMayWaive ? "you can" : "someone who can issue it may";
  if (scopePhase(ctx.ticket?.status) === "before_review") {
    return `${head} The drafter or the engineer can record ${it} on the request page${ctx.callerMayWaive ? `, or you can record why it issues without ${it}` : ""}.`;
  }
  if (ctx.ticket?.assignedEngineerId) {
    return `${head} Its engineer of record can record ${it} on the request page, or the request can be sent back for revision${ctx.callerMayWaive ? `; you can instead record why it issues without ${it}` : ""}.`;
  }
  return `${head} It has no engineer of record, so ${waive} record why it issues without ${it}, or the request can be sent back for revision.`;
}

/** The warning an in-flight request carries instead (never a refusal). */
export function examinationScopeWarning(warnOnly: readonly RequiredScopeField[]): string {
  return `${list(warnOnly.map((w) => w.label))} ${warnOnly.length === 1 ? "is" : "are"} not recorded — this workspace requires ${warnOnly.length === 1 ? "it" : "them"} now, but this request was filed before the requirement was set, so it can still issue.`;
}

/** The facts an issuing transition's audit row carries (only when a
 *  requirement applies — an unconfigured request's row is today's). */
export function examinationScopeAuditFields(
  status: ExaminationScopeStatus,
  waiver: ExaminationScopeWaiver | null,
  waived: boolean,
): Record<string, unknown> {
  return {
    required: status.required.map((r) => ({ field: r.key, enforced: r.enforced, since: r.since, value: r.value?.value ?? null })),
    ...(status.missing.length > 0 ? { missing: status.missing.map((r) => r.key) } : {}),
    ...(status.warnOnly.length > 0 ? { warnedNotRefused: status.warnOnly.map((r) => r.key) } : {}),
    ...(waived && waiver ? { waiver: { reason: waiver.reason, by: waiver.by, at: waiver.at, fields: waiver.fields, rev: waiver.rev } } : {}),
  };
}

// ─── Filling (the fill route and the panel) ─────────────────────────────

/** A fill request's values (`{ fieldKey: value | null }`) checked against the
 *  workspace's lists: an unknown field, or a value not in the field's list,
 *  is refused with the reason (nothing is typed free). null clears. Pure. */
export function checkScopeValuesInput(
  config: ExaminationScopeConfig,
  raw: unknown,
): { ok: true; changes: Record<string, string | null> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The examination data is not in the expected shape — reload the request and try again." };
  const changes: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const field = config.fields.find((f) => f.key === k);
    if (!field) return { ok: false, error: `"${k}" is not examination data this workspace records — reload the request and try again.` };
    if (v === null) { setOwn(changes, k, null); continue; }
    if (typeof v !== "string" || !field.options.some((o) => o.value === v)) {
      return { ok: false, error: `Pick ${field.label} from its list — that value is not one of its choices.` };
    }
    setOwn(changes, k, v);
  }
  if (Object.keys(changes).length === 0) return { ok: false, error: "Nothing to record." };
  return { ok: true, changes };
}

/** The values after a fill: each change recorded with who and when; a
 *  value set to what it already is keeps its original record. Pure. */
export function applyScopeChanges(
  current: ExaminationScopeValues,
  changes: Record<string, string | null>,
  who: { uid: string; name: string | null },
  nowIso: string,
  /** Merge-time fix pass: a fill after issue carries `afterIssue`. */
  mark?: Pick<ExaminationScopeValue, "afterIssue">,
): { values: ExaminationScopeValues; changed: string[] } {
  const values: ExaminationScopeValues = {};
  for (const [k, v] of Object.entries(current)) setOwn(values, k, v);
  const changed: string[] = [];
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) {
      if (scopeValueOf(values, k)) { delete values[k]; changed.push(k); }
      continue;
    }
    if (scopeValueOf(values, k)?.value === v) continue;
    setOwn(values, k, { value: v, by: who.uid, ...(who.name ? { byName: who.name } : {}), at: nowIso, ...(mark?.afterIssue ? { afterIssue: mark.afterIssue } : {}) });
    changed.push(k);
  }
  return { values, changed };
}

/** Second fix pass (GAP-102 acceptance 1): the statuses in which the
 *  request is still with the drafter — not yet under review, not issued —
 *  where its requester may record its examination data (the engineer who
 *  files a like-in-kind request has usually specified it already). These are
 *  every status BEFORE review (merge-time fix pass: `scopePhase`
 *  "before_review"). */
export const SCOPE_REQUESTER_STATUSES: ReadonlySet<string> = new Set(["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ"]);

/** Merge-time fix pass (ruling 4(a)): the review statuses the engine uses —
 *  PENDING_REVIEW (the first: a submitted draft) and PENDING_FINAL_APPROVAL
 *  (the engineer's final approval). From the first of them on, the request
 *  is "in review": its values change only by its engineer of record. */
export const SCOPE_REVIEW_STATUSES: ReadonlySet<string> = new Set(["PENDING_REVIEW", "PENDING_FINAL_APPROVAL"]);

/** Who may record a request's examination data (ruling (1): the drafter or
 *  the engineer already in the flow — or the assignment queue that sets the
 *  class — never a new role): the assigned drafter, the assigned engineer, a
 *  person named on an engineering sign-off of the request's review roster,
 *  (`queue`) a holder of the queue's capability for this request, or —
 *  second fix pass — its requester while the request is still with the
 *  drafter (SCOPE_REQUESTER_STATUSES; never once it is under review or
 *  issued). WHAT each may do depends on where the request stands —
 *  `scopeFieldRight` (merge-time fix pass). Pure. */
export function scopeEditorBasis(
  ticket: Pick<Ticket, "assignedDrafterId" | "assignedEngineerId" | "metadata"> & Partial<Pick<Ticket, "requesterId" | "status">>,
  uid: string | null | undefined,
  queue: boolean,
): "drafter" | "engineer" | "roster_engineer" | "assignment_queue" | "requester" | null {
  if (!uid) return null;
  if (ticket.assignedDrafterId === uid) return "drafter";
  if (ticket.assignedEngineerId === uid) return "engineer";
  const roster = (ticket.metadata as Record<string, unknown> | undefined)?.review_roster as { slots?: Array<{ engineering?: boolean; primaries?: string[]; alternates?: string[] }> } | undefined;
  if (Array.isArray(roster?.slots) && roster!.slots!.some((s) => s?.engineering === true && ((s.primaries ?? []).includes(uid) || (s.alternates ?? []).includes(uid)))) return "roster_engineer";
  if (queue) return "assignment_queue";
  if (ticket.requesterId === uid && SCOPE_REQUESTER_STATUSES.has(String(ticket.status ?? ""))) return "requester";
  return null;
}

/** The statuses whose examination data is part of the closed record. */
export const SCOPE_CLOSED_STATUSES: ReadonlySet<string> = new Set(["CLOSED", "CANCELED"]);

/** Second fix pass: the statuses after an issue (lib/ticketTransitions.ts —
 *  every issuing approval and a completing sign-off move the request to
 *  PENDING_IFC, or FINAL_DRAFT when issued as-is). No issuing action is
 *  offered in these statuses (lib/workflow.ts), so nothing here can be
 *  blocked by the data. Merge-time fix pass (ruling 4(b)): a value it issued
 *  with is never changed or cleared here, and no waiver is recorded; a field
 *  still MISSING may be filled (drafter, engineer, queue) — "completed after
 *  issue", re-opening nothing. A request sent back opens again. */
export const SCOPE_ISSUED_STATUSES: ReadonlySet<string> = new Set(["PENDING_IFC", "FINAL_DRAFT"]);

/** Where a request stands for its examination data (merge-time fix pass).
 *  An unknown status is read as closed (nothing changes — never a guess). */
export type ScopePhase = "before_review" | "in_review" | "after_issue" | "closed";
export function scopePhase(status: string | null | undefined): ScopePhase {
  const st = String(status ?? "");
  if (SCOPE_REQUESTER_STATUSES.has(st)) return "before_review";
  if (SCOPE_REVIEW_STATUSES.has(st)) return "in_review";
  if (SCOPE_ISSUED_STATUSES.has(st)) return "after_issue";
  return "closed";
}

/** What one person may do to one field now (merge-time fix pass, rulings 1
 *  and 4): `fill` — set a value on an EMPTY field; `change` — change or
 *  clear a RECORDED value.
 *   * before review: the drafter, the engineer (assigned, or on an
 *     engineering sign-off), the queue — both; the requester may fill an
 *     empty field, and change or clear only a value they recorded
 *     themselves (never one someone else recorded);
 *   * in review: only the assigned engineer of record — both (each change
 *     is put on the request's history, old → new); nobody else, anything;
 *   * after issue: the drafter, the engineer or the queue may FILL a field
 *     still missing (recorded as completed after issue) — nobody changes or
 *     clears a value;
 *   * closed: nobody. Pure. */
export interface ScopeFieldRight { fill: boolean; change: boolean }
export function scopeFieldRight(
  ticket: Pick<Ticket, "assignedDrafterId" | "assignedEngineerId" | "metadata"> & Partial<Pick<Ticket, "requesterId" | "status">>,
  uid: string | null | undefined,
  queue: boolean,
  current: Pick<ExaminationScopeValue, "by"> | null | undefined,
): ScopeFieldRight {
  const none = { fill: false, change: false };
  if (!uid) return none;
  const phase = scopePhase(ticket.status);
  if (phase === "closed") return none;
  if (phase === "in_review") return ticket.assignedEngineerId === uid ? { fill: true, change: true } : none;
  const basis = scopeEditorBasis(ticket, uid, queue);
  if (!basis) return none;
  if (phase === "after_issue") return basis === "requester" ? none : { fill: true, change: false };
  if (basis === "requester") return { fill: true, change: !!current && current.by === uid };
  return { fill: true, change: true };
}

/** A fill request checked against `scopeFieldRight` for every field it
 *  touches (a value set to what it already is is no change and never
 *  refused). Merge-time fix pass. Pure. */
export function checkScopeWrite(
  ticket: Pick<Ticket, "assignedDrafterId" | "assignedEngineerId" | "metadata"> & Partial<Pick<Ticket, "requesterId" | "status">>,
  uid: string | null | undefined,
  queue: boolean,
  config: ExaminationScopeConfig,
  current: ExaminationScopeValues,
  changes: Record<string, string | null>,
): { ok: true; phase: ScopePhase; basis: string } | { ok: false; status: 403 | 409; code: string; error: string } {
  const phase = scopePhase(ticket.status);
  if (phase === "closed") return { ok: false, status: 409, code: "closed", error: "This request is closed — its examination data is part of its record and is not changed." };
  const label = (k: string) => config.fields.find((f) => f.key === k)?.label ?? k;
  if (phase === "in_review") {
    if (ticket.assignedEngineerId !== uid) {
      return { ok: false, status: 403, code: "in_review", error: ticket.assignedEngineerId
        ? "This request is in review — only its engineer of record changes its examination data now (each change goes on the request's history)."
        : "This request is in review and has no engineer of record, so its examination data is not changed now. Someone who can issue it may record why it issues without the missing data, or it can be sent back for revision." };
    }
    return { ok: true, phase, basis: "engineer_of_record" };
  }
  const basis = scopeEditorBasis(ticket, uid, queue);
  if (!basis || (phase === "after_issue" && basis === "requester")) {
    return { ok: false, status: 403, code: "not_in_flow", error: phase === "after_issue"
      ? "The request's drafter or engineer (or whoever runs the assignment queue) completes data still missing after it issued."
      : "The request's drafter or engineer records its examination data (or whoever runs the assignment queue; its requester, until it goes for review)." };
  }
  for (const [k, v] of Object.entries(changes)) {
    const cur = scopeValueOf(current, k);
    if (v !== null && cur?.value === v) continue;
    if (v === null && !cur) continue;
    const right = scopeFieldRight(ticket, uid, queue, cur);
    if (!cur && right.fill) continue;
    if (cur && right.change) continue;
    if (phase === "after_issue") {
      return { ok: false, status: 409, code: "issued", error: `This request has issued — ${label(k)} is part of what it issued with and is not changed or cleared (only data still missing may be completed).` };
    }
    return { ok: false, status: 403, code: "recorded_by_someone_else", error: `${label(k)} was recorded by someone else — as the requester you may fill a field that is empty, or change one you recorded yourself.` };
  }
  return { ok: true, phase, basis };
}

/** The request's history line for a change of its examination data in
 *  review (old → new, ruling 4(a)) or a fill after issue ("completed after
 *  issue", ruling 4(b)) — merge-time fix pass. Values are named by their
 *  labels in the workspace's lists ("—" for none). `attempt` is the
 *  TICKET_EXAMINATION_SCOPE_SET row written before the change (no
 *  `historyAttempt` rides that row, so the audit drain never reads it as a
 *  transition's). Pure. */
export function examinationScopeHistoryEntry(p: {
  phase: "in_review" | "after_issue";
  config: ExaminationScopeConfig;
  changed: ReadonlyArray<{ field: string; from: string | null; to: string | null }>;
  user: string | null;
  role: string | null;
  now: string;
  attempt: string;
  actorId: string;
}): Record<string, unknown> {
  const field = (k: string) => p.config.fields.find((f) => f.key === k);
  const name = (k: string, v: string | null) => (v === null ? "—" : field(k)?.options.find((o) => o.value === v)?.label ?? v);
  const lines = p.changed.map((c) => `${field(c.field)?.label ?? c.field}: ${name(c.field, c.from)} → ${name(c.field, c.to)}`);
  return {
    action: p.phase === "in_review" ? "Examination data changed in review" : "Examination data completed after issue",
    ...(p.user ? { user: p.user } : {}),
    ...(p.role ? { role: p.role } : {}),
    date: p.now,
    details: p.phase === "in_review"
      ? `${lines.join("; ")} (changed by the engineer of record while the request was in review)`
      : `${lines.join("; ")} (completed after issue — not part of what the request issued with)`,
    attempt: p.attempt,
    actorId: p.actorId,
  };
}

/** True when the error means 20261266 is not applied (42P01 / PGRST205, or
 *  the table named as missing). */
export function isMissingScopeTable(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code === "42P01" || code === "PGRST205") return true;
  const m = String(err.message ?? "").toLowerCase();
  return m.includes("ticket_examination_scopes") && (m.includes("does not exist") || m.includes("could not find") || m.includes("schema cache"));
}

// ─── The editor (Admin → Request forms) ─────────────────────────────────

/** True when the settings carry at least one examination-data requirement —
 *  the admin page then reads the row back after its save, to show the time
 *  the database gave each requirement (20261266's stamp trigger). Settings
 *  without one are saved exactly as before (one upsert, nothing re-read).
 *  Pure. */
export function examinationScopeHasRequirements(settings: object | null | undefined): boolean {
  const raw = (settings as Record<string, unknown> | null | undefined)?.[EXAMINATION_SCOPE_KEY] as Record<string, unknown> | undefined;
  return !!raw && typeof raw === "object" && Array.isArray(raw.requirements) && raw.requirements.length > 0;
}

/** One thing in the editor's examination-data configuration that the parser
 *  would silently drop (merge-time fix pass, ruling 3). `index` is the
 *  entry's position in the stored `fields` / `requirements` list. */
export interface ExaminationScopeProblem { where: "field" | "requirement"; index: number; message: string }

/** The editor's check — the SAME rule `parseExaminationScopeConfig` reads by
 *  (FIELD_KEY_RE on the trimmed key, the first 50 fields, one entry per key,
 *  the first 200 choices, the first 500 requirements, a requirement naming a
 *  kept field and a work class and/or a library): every entry the parser
 *  would leave out is named, so the page shows it inline and refuses to
 *  save until it is fixed. Settings without the key have no problem (an
 *  unconfigured workspace saves exactly as before). Pure. */
export function examinationScopeProblems(settings: object | null | undefined): ExaminationScopeProblem[] {
  const raw = (settings as Record<string, unknown> | null | undefined)?.[EXAMINATION_SCOPE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const r = raw as Record<string, unknown>;
  const out: ExaminationScopeProblem[] = [];
  const kept = new Set<string>();
  (Array.isArray(r.fields) ? r.fields : []).forEach((f: unknown, i: number) => {
    const bad = (message: string) => out.push({ where: "field", index: i, message });
    if (i >= MAX_FIELDS) return bad(`Only the first ${MAX_FIELDS} pieces of data are kept — remove this one or another.`);
    if (!f || typeof f !== "object") return bad("This entry can't be read — remove it.");
    const o = f as Record<string, unknown>;
    const key = str(o.key);
    if (!key) return bad("Give this data a key.");
    if (key.length > EXAMINATION_FIELD_KEY_MAX) return bad(`The key is longer than ${EXAMINATION_FIELD_KEY_MAX} characters.`);
    if (!FIELD_KEY_RE.test(key)) return bad("A key starts with a letter or a digit and uses only letters, digits, spaces, _ . and -.");
    if (RESERVED_FIELD_KEYS.has(key)) return bad(`"${key}" can't be used as a key (it is a name the system reserves) — choose another.`);
    if (kept.has(key)) return bad(`Another piece of data already uses the key "${key}".`);
    kept.add(key);
    if (Array.isArray(o.options) && o.options.length > MAX_OPTIONS) bad(`Only the first ${MAX_OPTIONS} choices are kept — remove some.`);
  });
  (Array.isArray(r.requirements) ? r.requirements : []).forEach((q: unknown, i: number) => {
    const bad = (message: string) => out.push({ where: "requirement", index: i, message });
    if (i >= MAX_REQUIREMENTS) return bad(`Only the first ${MAX_REQUIREMENTS} requirements are kept — remove this one or another.`);
    if (!q || typeof q !== "object") return bad("This entry can't be read — remove it.");
    const o = q as Record<string, unknown>;
    const field = str(o.field);
    if (!field) return bad("Pick the data this requirement names.");
    if (!kept.has(field)) return bad(`"${field}" is not data configured above (or its key has a problem) — fix the data, or remove this requirement.`);
    if (!str(o.workClass) && !str(o.libraryId)) bad("Pick a work class, a library, or both — a requirement naming neither applies to nothing.");
  });
  return out;
}
