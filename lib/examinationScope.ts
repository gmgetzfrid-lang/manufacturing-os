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
// role, slot or stop). Once the request has issued (PENDING_IFC /
// FINAL_DRAFT) its data is the issued record and is not changed; it opens
// again if the request is sent back.
//
// THE ISSUE GATE (ruling (2)). The issuing transitions (lib/workflow.ts
// ISSUING_APPROVALS, a roster sign-off that completes the review, and — fix
// pass — a consent window whose close on silence would complete it, which
// lib/consentWindowScan.ts then HOLDS for a sign-off instead) refuse
// with a plain sentence naming what is missing — but ONLY where a
// requirement applies to the request AND the request was filed at or after
// the requirement's `since`. A request already in flight when a requirement
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

const FIELD_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;
const MAX_FIELDS = 50;
const MAX_OPTIONS = 200;
const MAX_REQUIREMENTS = 500;

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
    if (!FIELD_KEY_RE.test(key) || keys.has(key)) continue;
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

/** One recorded value on a request. */
export interface ExaminationScopeValue { value: string; by: string | null; byName?: string | null; at: string | null }
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
    out[k] = {
      value,
      by: typeof o.by === "string" ? o.by : null,
      ...(typeof o.byName === "string" ? { byName: o.byName } : {}),
      at: typeof o.at === "string" ? o.at : null,
    };
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
  /** True when a requirement binds this request (it was filed at or after
   *  the requirement's `since`) — a missing value then refuses an issue. */
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
    const enforced = Number.isFinite(since) && Number.isFinite(filed) && filed >= since;
    const basis = [e.workClass ? `work class "${classLabel(e.workClass)}"` : null, e.libraryId ? "its library" : null].filter((x): x is string => !!x).join(" in ");
    const cur = byField.get(field.key);
    const value = values[field.key] ?? null;
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
 *  (a readable `since`, the request filed at or after it) — knowable before
 *  the request's data is read. Pure. */
export function hasBindingRequirement(
  config: ExaminationScopeConfig,
  ticket: Pick<Ticket, "workClass" | "libraryId" | "createdAt">,
): boolean {
  const filed = at(ticket.createdAt as string | null | undefined);
  if (!Number.isFinite(filed)) return false;
  return applicableRequirements(config, ticket).some((e) => { const since = at(e.since); return Number.isFinite(since) && filed >= since; });
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
  ticket: Pick<Ticket, "workClass" | "libraryId" | "createdAt" | "deliverableRev">,
  read: { data: unknown; error: { code?: string | null; message?: string | null } | null },
  draftingCfg?: Partial<OrgDraftingSettings> | Record<string, unknown> | null,
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
  if (status.blocking.length > 0 && !waived) return { kind: "blocked", blocking: status.blocking, refusal: examinationScopeRefusal(status.blocking) };
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
 *  missing and who records it). */
export function examinationScopeRefusal(blocking: readonly RequiredScopeField[]): string {
  const names = list(blocking.map((b) => b.label));
  const bases = [...new Set(blocking.flatMap((b) => b.basis))];
  return `This request can't issue yet: ${names} must be recorded for it first (this workspace requires ${blocking.length === 1 ? "it" : "them"} for ${list(bases)}). The drafter or the engineer records ${blocking.length === 1 ? "it" : "them"} under "Examination data" on the request; someone who can issue it may instead record why it issues without ${blocking.length === 1 ? "it" : "them"}.`;
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
    if (v === null) { changes[k] = null; continue; }
    if (typeof v !== "string" || !field.options.some((o) => o.value === v)) {
      return { ok: false, error: `Pick ${field.label} from its list — that value is not one of its choices.` };
    }
    changes[k] = v;
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
): { values: ExaminationScopeValues; changed: string[] } {
  const values: ExaminationScopeValues = { ...current };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) {
      if (values[k]) { delete values[k]; changed.push(k); }
      continue;
    }
    if (values[k]?.value === v) continue;
    values[k] = { value: v, by: who.uid, ...(who.name ? { byName: who.name } : {}), at: nowIso };
    changed.push(k);
  }
  return { values, changed };
}

/** Second fix pass (GAP-102 acceptance 1): the statuses in which the
 *  request is still with the drafter — not yet under review, not issued —
 *  where its requester may record its examination data (the engineer who
 *  files a like-in-kind request has usually specified it already). */
export const SCOPE_REQUESTER_STATUSES: ReadonlySet<string> = new Set(["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ"]);

/** Who may record a request's examination data (ruling (1): the drafter or
 *  the engineer already in the flow — or the assignment queue that sets the
 *  class — never a new role): the assigned drafter, the assigned engineer, a
 *  person named on an engineering sign-off of the request's review roster,
 *  (`queue`) a holder of the queue's capability for this request, or —
 *  second fix pass — its requester while the request is still with the
 *  drafter (SCOPE_REQUESTER_STATUSES; never once it is under review or
 *  issued). Pure. */
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
 *  PENDING_IFC, or FINAL_DRAFT when issued as-is). The data it issued with
 *  is the issued record: neither values nor a waiver change here (no
 *  issuing action is offered in these statuses — lib/workflow.ts — so
 *  nothing here can be blocked by it); a request sent back opens again. */
export const SCOPE_ISSUED_STATUSES: ReadonlySet<string> = new Set(["PENDING_IFC", "FINAL_DRAFT"]);

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
