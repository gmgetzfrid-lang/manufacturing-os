"use client";

// CapabilityPolicyEditor — the "Actions" side of the permissions console.
// Content permissions govern WHO SEES WHAT; this governs WHO MAY DO WHAT:
// every drafting-request workflow transition, holds, force-release, and the
// metrics/admin surfaces. Checkbox grid per capability × role token, plus
// (DEC-13 stage 2) REQUEST-TYPE OVERRIDES: a rule scoped to one of the org's
// configured request types whose tokens REPLACE the base list for tickets
// of that type — "ASBUILT may only be approved by DocCtrl".
//
// Rails: critical capabilities can never lose Admin — on the base list OR on
// any override (validateCapabilityPolicy rejects the save, here for the
// message and again on the server — WF-11: the save is a POST to
// /api/admin/capability-policy, where a critical capability is Admin's to
// change); identity rights (a ticket's own requester/drafter/assigned
// engineer) are not configurable by design; every save writes a
// before/after audit row on the server. Defaults reproduce
// historical behavior exactly, so an untouched policy changes nothing. A
// capability with no override is stored in the legacy bare-list shape, so an
// org that never adds one stores byte-identical policy JSON.
//
// drafting-flow HAND-2 (DF-P11 fix pass 3): a row that equals its shipped
// default (as a set, with no override) is NOT written. Every save used to
// write every capability, so a workspace that changed one row froze the
// defaults of all the others — holds.release was stored as ["*"] by grids
// saved before release shipped to the controller tier, without anyone
// choosing it. An absent entry IS the shipped default to both evaluators and
// to the policy route's critical-change check, so leaving it out changes no
// answer today and lets a later default reach the workspace. A holds.release
// row still exactly ["*"] is named on the row as the old default, with a
// one-click "Use the shipped default" (an explicit Admin decision, saved
// through the impact preview like any change).
//
// admin-and-org Round G, P9:
//   * ALOG-1 — the grid loads FRESH (this tab's cached copy is dropped first)
//     and a policy that could not be read is said, with Retry — never drawn
//     as the org's policy, and nothing can be saved over it.
//   * ALOG-12 — the save carries the version the grid was loaded at; the
//     route refuses a stale one (409 policy_changed). The editor then
//     re-reads: when only grants moved (the role grid it started from is
//     still the stored one) it saves again on the new version, otherwise it
//     shows the other admin's grid and says so.
//   * ALOG-9 — the token vocabulary is declared once (lib/roleCapabilities.ts
//     POLICY_TOKENS); a stored token with no column is NAMED on its row,
//     never hidden.
//   * QUAL-14 — PROJECT-SCOPED OVERRIDES: for a capability decided per
//     project (PROJECT_SCOPED_CAPS — quality.sign_off), a rule naming one
//     project, whose tokens REPLACE the row above for that project only.
//     Saved through the policy route (audited; refused until the database
//     reads projectId, 20261136), listed by project name, removable.
//   * ALOG-14 (fix pass 2) — a save announces the change
//     (announceCapabilityPolicyChanged), so the explorer and View-as panels on
//     the same page re-read instead of showing the pre-save policy; a
//     projects read that failed is said to every viewer, and a stored rule's
//     project is then "could not be listed", never "not visible to you".
//   * drafting-flow GAP-105 / TIER-4 (DF-P19; DEC-90 ruling (2)) — a
//     request presents its library, work class and code class to the policy
//     now, so a request rule scoped to one of them applies. One stored
//     before (no confirmation stamp) only ADDS until an Admin confirms it:
//     it is listed here with its state ("not yet in force where it narrows —
//     confirm to apply"), and Confirm posts `confirm_rule` to the policy
//     route (Admin only, audited).
//     DF-P19 second fix pass (review major 2 — TIER-4 done-when 1): CODE-CLASS
//     RULES — for a request capability, a rule naming ONE of the workspace's
//     code classes (org_configurations 'drafting' codeClasses), whose tokens
//     REPLACE the row above for requests of that class — "final approval on
//     a B31.3-class request only by Engineer-3". Authored here like a
//     request-type override; the policy route stamps a new one confirmed when
//     an Admin saves it, and stores a DocCtrl's unconfirmed (it only adds
//     until an Admin confirms it in the list below). A library- or
//     work-class-scoped rule is still listed, preserved and confirmed here,
//     not authored (not a TIER-4 done-when).
//     DF-P19 third fix pass (review major 2): an IN-FORCE (Admin-confirmed)
//     code-class rule is locked for anyone but an Admin (inForceClassRule) —
//     an edit by a DocCtrl would be stored unconfirmed and only add, so the
//     narrowing the Admin confirmed would silently lapse; the save checks
//     the same thing first (inForceTicketRulesDropped) and the policy route
//     refuses it (403). Fourth fix pass (review major 1): the same holds for
//     any rule AHEAD of an in-force one (inForceTicketRulesShadowed) — the
//     first match decides; the grid keeps the stored order and adds new rows
//     last, and the save checks it before sending.
//     Fifth fix pass (review major 1): a NEW code-class row is written AHEAD
//     of the capability's request-type / project / preserved rules (the first
//     match decides, so behind them it never bound for a request type with a
//     row of its own), and a stored code-class row that sits behind such
//     rules says which of them decide first (rulesDecidingBeforeClassRule).
//     Merge-time fix pass (review minor 1): not ahead of EVERY other rule —
//     a new code-class row goes after every stored rule that can match a
//     request of its class (a library rule, a rule naming that class, a
//     multi-key rule that does not exclude it), so it never cancels one, and
//     ahead of the request-type / unit rules; where such a stored rule sits
//     behind a request-type / unit rule, the new row goes right after it and
//     the row note and the save preview name the rules that decide first.
//     Only IN-FORCE rules ahead are named as deciding first; an unconfirmed
//     one ahead is described by what it does — it adds its roles, and on the
//     engineer-gate exemption nothing until confirmed (classRuleAheadNote,
//     review minor 2).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SlidersHorizontal, Loader2, RotateCcw, Check, AlertTriangle, Plus, X } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import { supabase } from "@/lib/supabase";
import {
  CAPABILITY_DEFS, defaultCapabilityPolicy, loadCapabilityPolicyEntry, saveCapabilityPolicy,
  validateCapabilityPolicy, invalidateCapabilityPolicy, isRuleArray, ruleIsConditional, describeWhen,
  CapabilityPolicyChangeError, POLICY_CHANGED, PROJECT_SCOPED_CAPS, announceCapabilityPolicyChanged,
  HOLD_OPENER_TOKEN, ticketDimensionRules, confirmCapabilityRule, capabilityRuleKey, GATE_EXEMPT_CAP, isTicketResourceCap,
  isTicketDimensionRule, ruleInForce, inForceTicketRulesDropped, inForceTicketRulesShadowed, inForceTicketRulesShadowedRefusal, describeDroppedInForceTicketRules,
  rulesCanOverlap, RULE_KEYS, capabilityRuleListDigest,
  type CapabilityId, type CapabilityEntry, type CapabilityRule, type CapabilityPolicy, type TicketDimensionRuleState,
} from "@/lib/capabilityPolicy";
import { loadRequestTypeOptions, type RequestTypeOption } from "@/lib/requestTypes";
import { reviewClassOptions } from "@/lib/reviewModel";
import type { OrgDraftingSettings } from "@/types/schema";
import { DORMANT_ROLES, POLICY_TOKENS } from "@/lib/roleCapabilities";

/** Every token the grid and the override rows can set — declared once, in
 *  lib/roleCapabilities.ts (ALOG-9); re-exported for the existing callers. */
export { POLICY_TOKENS };
const TOKENS = POLICY_TOKENS;

/** ALOG-9 done-when 2: tokens a stored list holds that the grid has no column
 *  for (an "Engineer-2", a typo, a retired role). They stay live in the
 *  evaluator, so the row names them instead of hiding them. The hold-opener
 *  token is not one of them: it has its own control on the holds.release
 *  row (drafting-flow HAND-2, DF-P11 fix pass 2). */
export function tokensOutsideGrid(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !TOKENS.includes(t) && t !== HOLD_OPENER_TOKEN);
}
const TOKEN_LABEL: Record<string, string> = {
  "*": "Everyone", DraftingSupervisor: "DraftingSup", Engineer: "Engineer (all tiers)",
  ...Object.fromEntries(DORMANT_ROLES.map((r) => [r, `${r} (dept)`])),
  [HOLD_OPENER_TOKEN]: "the hold's own opener",
};
const tokenLabel = (t: string) => TOKEN_LABEL[t] ?? t;

/** One editable override row: a rule scoped to exactly one request type. */
interface Override { type: string; tokens: string[] }
/** QUAL-14: one editable project-scoped row: a rule naming exactly one project. */
interface ProjectOverride { projectId: string; tokens: string[] }
/** DF-P19 second fix pass (TIER-4 done-when 1): one editable code-class row —
 *  a request-capability rule naming exactly one of the workspace's code
 *  classes. */
interface CodeClassOverride { codeClass: string; tokens: string[] }
type Base = Record<CapabilityId, string[]>;
type Overrides = Partial<Record<CapabilityId, Override[]>>;
type ProjectOverrides = Partial<Record<CapabilityId, ProjectOverride[]>>;
type CodeClassOverrides = Partial<Record<CapabilityId, CodeClassOverride[]>>;
/** Conditional rules this editor cannot render (unit / library / discipline
 *  or multi-key clauses) — preserved verbatim so a save never drops them. */
type Opaque = Partial<Record<CapabilityId, CapabilityRule[]>>;

/** Which editor row a stored conditional rule is: a request-type row (the
 *  rule names request types only), a project row (project only, on a
 *  project-scoped capability), a code-class row (exactly ONE code class and
 *  nothing else, on a request capability — DF-P19 second fix pass; a rule
 *  naming several classes stays preserved verbatim, so a save never splits
 *  it into rules the server would see as new and unconfirmed), or a rule
 *  the editor preserves verbatim. */
function editorRowKind(cap: CapabilityId, r: CapabilityRule): "type" | "project" | "codeClass" | "opaque" {
  const keys = Object.keys(r.when ?? {}).filter((k) => ((r.when as Record<string, string[] | undefined>)[k]?.length ?? 0) > 0);
  if (keys.length === 1 && keys[0] === "requestType") return "type";
  if (keys.length === 1 && keys[0] === "projectId" && PROJECT_SCOPED_CAPS.has(cap)) return "project";
  if (keys.length === 1 && keys[0] === "codeClass" && isTicketResourceCap(cap) && r.when?.codeClass?.length === 1) return "codeClass";
  return "opaque";
}

/** Split a stored policy into what the grid edits, what the override panels
 *  edit (request-type rows; QUAL-14: project rows on a project-scoped
 *  capability), and what must ride along untouched. */
export function splitPolicyForEditor(stored: CapabilityPolicy): { base: Base; overrides: Overrides; opaque: Opaque; projectOverrides: ProjectOverrides; codeClassOverrides: CodeClassOverrides } {
  const base = defaultCapabilityPolicy();
  const overrides: Overrides = {};
  const opaque: Opaque = {};
  const projectOverrides: ProjectOverrides = {};
  const codeClassOverrides: CodeClassOverrides = {};
  for (const def of CAPABILITY_DEFS) {
    const entry = stored.caps?.[def.id];
    if (entry === undefined) continue;
    if (!isRuleArray(entry)) { base[def.id] = entry as string[]; continue; }
    const unconditional = entry.find((r) => !ruleIsConditional(r));
    if (unconditional) base[def.id] = unconditional.tokens;
    for (const r of entry) {
      if (!ruleIsConditional(r)) continue;
      const kind = editorRowKind(def.id, r);
      if (kind === "type") {
        for (const type of r.when?.requestType ?? []) {
          (overrides[def.id] ??= []).push({ type, tokens: [...r.tokens] });
        }
      } else if (kind === "project") {
        for (const projectId of r.when?.projectId ?? []) {
          (projectOverrides[def.id] ??= []).push({ projectId, tokens: [...r.tokens] });
        }
      } else if (kind === "codeClass") {
        (codeClassOverrides[def.id] ??= []).push({ codeClass: r.when!.codeClass![0], tokens: [...r.tokens] });
      } else {
        (opaque[def.id] ??= []).push(r);
      }
    }
  }
  return { base, overrides, opaque, projectOverrides, codeClassOverrides };
}

/** True when two token lists name the same tokens (order and repeats aside). */
function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((t) => y.has(t));
}

/** HAND-2 (fix pass 3): the holds.release list every grid save before the
 *  hold-release change stored — ["*"], the old default — whether or not
 *  anyone chose it. Named on the row; never changed without an Admin. */
export function holdsReleaseOnOldDefault(tokens: readonly string[] | undefined): boolean {
  return !!tokens && sameTokens(tokens, ["*"]);
}

/** DF-P19 fix pass (review minor 4): the conditional rules of one
 *  capability in the order the STORED entry has them — the first matching
 *  rule decides, and since DF-P19 a preserved library- / class-scoped rule
 *  binds, so a grid save must not move it behind a request-type row. Each
 *  stored request-type / project rule is replaced in place by the editor's
 *  current rows for its types / project (a removed row drops out), each
 *  preserved rule stays where it was, and only rows that are new (no stored
 *  rule names that type / project) go at the end — a new row decides only
 *  where no stored rule matches first. With nothing stored as a rule list,
 *  the order is the one the grid always wrote.
 *  DF-P19 fifth fix pass (review major 1): except a NEW code-class row,
 *  which goes AHEAD of the request-type / unit rules — "final approval on
 *  this code's requests only by Engineer-3" must decide before a request
 *  type's own override, or it never binds for that type. A stored
 *  code-class row keeps its place (a save never reorders stored rules); the
 *  console says which rules decide before it (classRuleAheadNote).
 *  Merge-time fix pass (review minor 1): and AFTER every stored rule that
 *  can match a request of its class (classRuleSlot) — written ahead of a
 *  confirmed library rule, or of a stored {class, request type} rule, it
 *  would silently cancel that rule for the overlap. */
function conditionalRulesInStoredOrder(
  cap: CapabilityId,
  storedEntry: CapabilityEntry | undefined,
  rows: readonly Override[],
  projectRows: readonly ProjectOverride[],
  keep: readonly CapabilityRule[],
  classRows: readonly CodeClassOverride[] = [],
): CapabilityRule[] {
  const typeRule = (o: Override): CapabilityRule => ({ tokens: o.tokens, when: { requestType: [o.type] } });
  const projectRule = (o: ProjectOverride): CapabilityRule => ({ tokens: o.tokens, when: { projectId: [o.projectId] } });
  const classRule = (o: CodeClassOverride): CapabilityRule => ({ tokens: o.tokens, when: { codeClass: [o.codeClass] } });
  if (!isRuleArray(storedEntry)) return [...classRows.map(classRule), ...rows.map(typeRule), ...projectRows.map(projectRule), ...keep];
  const rowsLeft = [...rows];
  const projectLeft = [...projectRows];
  const classLeft = [...classRows];
  const keepLeft = [...keep];
  const take = <T,>(list: T[], pred: (x: T) => boolean): T | undefined => {
    const i = list.findIndex(pred);
    return i < 0 ? undefined : list.splice(i, 1)[0];
  };
  const out: CapabilityRule[] = [];
  for (const r of storedEntry) {
    if (!ruleIsConditional(r)) continue;
    const kind = editorRowKind(cap, r);
    if (kind === "type") {
      for (const type of r.when?.requestType ?? []) {
        const o = take(rowsLeft, (x) => x.type === type);
        if (o) out.push(typeRule(o));
      }
    } else if (kind === "project") {
      for (const projectId of r.when?.projectId ?? []) {
        const o = take(projectLeft, (x) => x.projectId === projectId);
        if (o) out.push(projectRule(o));
      }
    } else if (kind === "codeClass") {
      const o = take(classLeft, (x) => x.codeClass === r.when?.codeClass?.[0]);
      if (o) out.push(classRule(o));
    } else {
      const key = capabilityRuleKey(r);
      const k = take(keepLeft, (x) => capabilityRuleKey(x) === key);
      if (k) out.push(k);
    }
  }
  // Fifth fix pass / merge-time fix pass (review minor 1): each new
  // code-class row goes where classRuleSlot puts it among the stored rules.
  for (const o of classLeft) {
    const r = classRule(o);
    out.splice(classRuleSlot(out, r), 0, r);
  }
  return [...out, ...rowsLeft.map(typeRule), ...projectLeft.map(projectRule), ...keepLeft];
}

/** Does this rule name only keys a request presented before DF-P19 — its
 *  request type and / or its unit (a request-type row, a unit rule)? */
function isTypeOrUnitRule(r: CapabilityRule): boolean {
  const keys = RULE_KEYS.filter((k) => (r.when?.[k]?.length ?? 0) > 0);
  return keys.length > 0 && keys.every((k) => k === "requestType" || k === "unit");
}

/** DF-P19 merge-time fix pass (review minor 1): where a NEW code-class rule
 *  `rule` goes in the conditional rules `rules` (stored order): AFTER every
 *  rule there that can match a request of its class (rulesCanOverlap — a
 *  library rule, a rule naming that class, a multi-key rule whose `when`
 *  does not exclude it; a request-type / unit rule aside) — so it never
 *  cancels one of them for the overlap — and AHEAD of every request-type /
 *  unit rule, so it binds whatever the request type. It is written just
 *  ahead of the first request-type / unit rule: the rules between the last
 *  one that can match and that slot cannot match a request of its class,
 *  so every request is decided as at the earliest such slot, and the stored
 *  rules ahead keep their order. Where a rule that can match sits BEHIND a
 *  request-type / unit rule, no slot is both; it then goes right after the
 *  last rule that can match, and classRuleAheadNote names the rules that
 *  decide first for it (the row note and the save preview). Pure. */
export function classRuleSlot(rules: readonly CapabilityRule[], rule: CapabilityRule): number {
  let lastMatch = -1;
  let firstTypeOrUnit = rules.length;
  rules.forEach((r, i) => {
    if (isTypeOrUnitRule(r)) { if (i < firstTypeOrUnit) firstTypeOrUnit = i; return; }
    if (ruleIsConditional(r) && rulesCanOverlap(r, rule)) lastMatch = i;
  });
  return lastMatch < firstTypeOrUnit ? firstTypeOrUnit : lastMatch + 1;
}

/** The conditional rules AHEAD of the code-class rule for `codeClass` in
 *  `entry` that can match a request of that class (rulesCanOverlap: every
 *  rule that does not exclude the class). Empty when the code-class rule is
 *  not in `entry`. */
function rulesAheadOfClassRule(cap: CapabilityId, entry: CapabilityEntry | undefined, codeClass: string): CapabilityRule[] {
  if (!isRuleArray(entry)) return [];
  const at = entry.findIndex((r) => editorRowKind(cap, r) === "codeClass" && r.when?.codeClass?.[0] === codeClass);
  if (at < 0) return [];
  const probe: CapabilityRule = { tokens: [], when: { codeClass: [codeClass] } };
  return entry.slice(0, at).filter((r) => ruleIsConditional(r) && rulesCanOverlap(r, probe));
}

/** DF-P19 fifth fix pass (review major 1): the rules that sit AHEAD of the
 *  code-class rule for `codeClass` in `entry`, can match a request of that
 *  class, and are IN FORCE (ruleInForce) — for the requests they match they
 *  decide first, so the code-class rule does not apply to them. Merge-time
 *  fix pass (review minor 2): an unconfirmed rule ahead is not one of them —
 *  the evaluator scans past it (effectiveTokens): it adds its roles to the
 *  answer, or on `ticket.engineer_gate_exempt` does nothing
 *  (unconfirmedRulesBeforeClassRule). Empty when nothing in force that can
 *  match sits ahead, or the rule is not in `entry`. Pure. */
export function rulesDecidingBeforeClassRule(cap: CapabilityId, entry: CapabilityEntry | undefined, codeClass: string): CapabilityRule[] {
  return rulesAheadOfClassRule(cap, entry, codeClass).filter((r) => ruleInForce(cap, r));
}

/** DF-P19 merge-time fix pass (review minor 2): the NOT-yet-confirmed
 *  request dimension rules ahead of the code-class rule for `codeClass`
 *  that can match a request of that class. Pure. */
export function unconfirmedRulesBeforeClassRule(cap: CapabilityId, entry: CapabilityEntry | undefined, codeClass: string): CapabilityRule[] {
  return rulesAheadOfClassRule(cap, entry, codeClass).filter((r) => !ruleInForce(cap, r));
}

/** DF-P19 merge-time fix pass (review minors 1 and 2): what the row note
 *  and the save preview say about the rules ahead of the code-class rule
 *  for `codeClass` — what the evaluator does with each (effectiveTokens):
 *  an in-force rule that can match decides first where it matches; an
 *  unconfirmed one adds its roles to the answer (on
 *  `ticket.engineer_gate_exempt` it does nothing) until an Admin confirms
 *  it, and then decides first. "" when nothing ahead can match. Pure. */
export function classRuleAheadNote(cap: CapabilityId, entry: CapabilityEntry | undefined, codeClass: string): string {
  const deciding = rulesDecidingBeforeClassRule(cap, entry, codeClass);
  const unconfirmed = unconfirmedRulesBeforeClassRule(cap, entry, codeClass);
  const parts: string[] = [];
  if (deciding.length > 0) {
    parts.push(`does not apply where ${deciding.map((x) => describeWhen(x.when)).join(" / ")} — ${deciding.length > 1 ? "those rules sit ahead and decide" : "that rule sits ahead and decides"} first`);
  }
  for (const r of unconfirmed) {
    parts.push(cap === GATE_EXEMPT_CAP
      ? `where ${describeWhen(r.when)} a rule not yet confirmed sits ahead — it does nothing until an Admin confirms it, and then it decides first`
      : `where ${describeWhen(r.when)} a rule not yet confirmed sits ahead — it adds ${r.tokens.join(", ") || "nobody"} to this rule's answer until an Admin confirms it, and then it decides first`);
  }
  return parts.join("; ");
}

/** Recombine for saving: a capability with no override keeps the bare-list
 *  shape (byte-compatible with what it stored before); one with overrides
 *  becomes a rule list — base first, then one rule per code-class row
 *  (DF-P19 second fix pass; ahead of the others since the fifth fix pass,
 *  review major 1 — the first match decides; with a stored rule list, see
 *  classRuleSlot), then one rule per
 *  request-type row, then one rule per project row (QUAL-14), then any
 *  preserved rules.
 *  DF-P19 fix pass (review minor 4): given the `stored` policy the grid was
 *  loaded from, the conditional rules keep the stored order instead
 *  (conditionalRulesInStoredOrder) — a save never changes which stored rule
 *  decides first.
 *  HAND-2 (fix pass 3): a capability with no override whose row equals its
 *  shipped default is left out — absent IS the default, and writing it out
 *  froze that default in the workspace. */
export function joinPolicyFromEditor(base: Base, overrides: Overrides, opaque: Opaque, projectOverrides: ProjectOverrides = {}, stored?: CapabilityPolicy | null, codeClassOverrides: CodeClassOverrides = {}): Partial<Record<CapabilityId, CapabilityEntry>> {
  const caps: Partial<Record<CapabilityId, CapabilityEntry>> = {};
  for (const def of CAPABILITY_DEFS) {
    const rows = overrides[def.id] ?? [];
    const projectRows = projectOverrides[def.id] ?? [];
    const classRows = codeClassOverrides[def.id] ?? [];
    const keep = opaque[def.id] ?? [];
    if (rows.length === 0 && projectRows.length === 0 && classRows.length === 0 && keep.length === 0) {
      const tokens = base[def.id] ?? [];
      if (!sameTokens(tokens, def.defaultRoles)) caps[def.id] = tokens;
      continue;
    }
    caps[def.id] = [
      { tokens: base[def.id] ?? [] },
      ...conditionalRulesInStoredOrder(def.id, stored?.caps?.[def.id], rows, projectRows, keep, classRows),
    ];
  }
  return caps;
}

/** DF-P19: what the console says about one stored request rule scoped to a
 *  library or a work / code class. */
export function ticketDimensionRuleStatus(r: Pick<TicketDimensionRuleState, "inForce" | "effect"> & Partial<Pick<TicketDimensionRuleState, "cap">>): string {
  if (r.inForce) return "In force";
  // fix pass (review major 2): on the engineer-gate exemption an unconfirmed
  // rule does nothing at all (adding a role there removes a review).
  if (r.cap === GATE_EXEMPT_CAP) return "Not in force until an Admin confirms it — it changes whose own requests skip engineer sign-off";
  if (r.effect === "narrow") return "Not yet in force where it would take an action away — confirm to apply";
  return "In force (it only adds people) — not yet confirmed";
}

/** DF-P19 second fix pass (TIER-4 done-when 1): the workspace's code classes
 *  (org_configurations 'drafting' codeClasses — DEC-35, no code names in the
 *  application), for the code-class rows. A failed read is said, and a
 *  stored rule's class is then shown by its value. */
async function loadCodeClassOptions(orgId: string): Promise<{ options: Array<{ value: string; label: string }>; error: string | null }> {
  try {
    const { data, error } = await supabase.from("org_configurations").select("data").eq("org_id", orgId).eq("key", "drafting").maybeSingle();
    if (error) return { options: [], error: error.message };
    const cfg = ((data as { data?: unknown } | null)?.data ?? null) as Partial<OrgDraftingSettings> | null;
    return { options: reviewClassOptions(cfg, "codeClasses").map((o) => ({ value: o.value, label: o.label })), error: null };
  } catch (e) {
    return { options: [], error: (e as Error)?.message ?? "the read failed" };
  }
}

/** DF-P19 second fix pass: the request capabilities a code-class row can be
 *  written on (the evaluator reads `when.codeClass` on `ticket.*` only). */
export const CODE_CLASS_RULE_CAPS: readonly CapabilityId[] = CAPABILITY_DEFS.filter((d) => isTicketResourceCap(d.id)).map((d) => d.id);

/** DF-P19 third fix pass (review major 2): does the STORED policy hold an
 *  in-force (Admin-confirmed) code-class rule on `cap` for `codeClass` —
 *  the row only an Admin may change or remove? */
export function inForceClassRule(stored: CapabilityPolicy | null | undefined, cap: CapabilityId, codeClass: string): boolean {
  const entry = stored?.caps?.[cap];
  return isRuleArray(entry) && entry.some((r) => editorRowKind(cap, r) === "codeClass" && r.when?.codeClass?.[0] === codeClass
    && isTicketDimensionRule(cap, r) && ruleInForce(cap, r));
}

/** DF-P19 third fix pass: what a code-class rule saved by this person does
 *  (the impact preview). An Admin's is in force at once; anyone else's is
 *  stored unconfirmed — it only adds people, and on
 *  `ticket.engineer_gate_exempt` it does nothing — until an Admin confirms
 *  it (lib/capabilityPolicy.ts effectiveTokens). */
export function classRuleTakesEffect(cap: CapabilityId, isAdmin: boolean): string {
  if (isAdmin) return "in force once saved";
  return cap === GATE_EXEMPT_CAP ? "no effect at all until an Admin confirms it" : "adds people only until an Admin confirms it";
}

export default function CapabilityPolicyEditor({ canEdit }: { canEdit: boolean }) {
  const { activeOrgId, uid, userEmail, hasAnyRole } = useRole();
  // DF-P19: the stored policy as loaded, for the request dimension rules.
  const [storedPolicy, setStoredPolicy] = useState<CapabilityPolicy | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [policy, setPolicy] = useState<Base | null>(null);
  const [baseline, setBaseline] = useState<Base | null>(null);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [baselineOverrides, setBaselineOverrides] = useState<Overrides>({});
  const [opaque, setOpaque] = useState<Opaque>({});
  const [projectOverrides, setProjectOverrides] = useState<ProjectOverrides>({});
  const [baselineProjectOverrides, setBaselineProjectOverrides] = useState<ProjectOverrides>({});
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectsErr, setProjectsErr] = useState<string | null>(null);
  const [newProjectCap, setNewProjectCap] = useState<CapabilityId>("quality.sign_off");
  const [newProject, setNewProject] = useState("");
  // DF-P19 second fix pass (TIER-4 done-when 1): code-class rows.
  const [codeClassOverrides, setCodeClassOverrides] = useState<CodeClassOverrides>({});
  const [baselineCodeClassOverrides, setBaselineCodeClassOverrides] = useState<CodeClassOverrides>({});
  const [codeClasses, setCodeClasses] = useState<Array<{ value: string; label: string }>>([]);
  const [codeClassesErr, setCodeClassesErr] = useState<string | null>(null);
  const [newClassCap, setNewClassCap] = useState<CapabilityId>("ticket.final_approve");
  const [newClass, setNewClass] = useState("");
  // ALOG-12: the version the grid was loaded at, and the grid it started from.
  const [version, setVersion] = useState<string | null>(null);
  const [baselineCaps, setBaselineCaps] = useState<string>("");
  // ALOG-1: a policy that could not be read is said, never drawn as the org's.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestTypes, setRequestTypes] = useState<RequestTypeOption[]>([]);
  const [newCap, setNewCap] = useState<CapabilityId>("ticket.direct_approve");
  const [newType, setNewType] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  /** A FRESH read: this tab's cached copy is dropped first, so the grid —
   *  and the version a save carries — is the stored row, not a minute-old
   *  copy (ALOG-12), and a failed read has no stale copy to hide behind. */
  const readFresh = useCallback(async () => {
    if (!activeOrgId) return null;
    invalidateCapabilityPolicy(activeOrgId);
    return loadCapabilityPolicyEntry(activeOrgId);
  }, [activeOrgId]);
  const apply = useCallback((stored: CapabilityPolicy, at: string | null) => {
    setStoredPolicy(stored);
    const split = splitPolicyForEditor(stored);
    setPolicy(split.base);
    setBaseline(split.base);
    setOverrides(split.overrides);
    setBaselineOverrides(split.overrides);
    setProjectOverrides(split.projectOverrides);
    setBaselineProjectOverrides(split.projectOverrides);
    setCodeClassOverrides(split.codeClassOverrides);
    setBaselineCodeClassOverrides(split.codeClassOverrides);
    setOpaque(split.opaque);
    setVersion(at);
    setBaselineCaps(JSON.stringify(joinPolicyFromEditor(split.base, split.overrides, split.opaque, split.projectOverrides, stored, split.codeClassOverrides)));
    setDirty(false);
  }, []);
  const load = useCallback(async () => {
    if (!activeOrgId) return;
    const [entry, types, proj, classes] = await Promise.all([
      readFresh(),
      loadRequestTypeOptions(activeOrgId),
      supabase.from("projects").select("id, name").eq("org_id", activeOrgId).order("name"),
      loadCodeClassOptions(activeOrgId),
    ]);
    setRequestTypes(types);
    setCodeClasses(classes.options);
    setCodeClassesErr(classes.error);
    setProjectsErr(proj.error ? proj.error.message : null);
    setProjects((((proj.data ?? []) as Array<Record<string, unknown>>)).map((r) => ({ id: String(r.id), name: String(r.name ?? r.id) })));
    if (!entry) return;
    if (entry.unreadable) {
      setLoadError(entry.unreadable);
      setPolicy(null);
      return;
    }
    setLoadError(null);
    apply(entry.policy, entry.version);
  }, [activeOrgId, readFresh, apply]);
  useEffect(() => { void load(); }, [load]);

  const areas = useMemo(() => [...new Set(CAPABILITY_DEFS.map((d) => d.area))], []);
  const typeLabel = (v: string) => requestTypes.find((t) => t.value === v)?.label ?? v;
  const projectLabel = (id: string) => projects.find((p) => p.id === id)?.name
    ?? `project ${id.slice(0, 8)}… (${projectsErr ? "projects could not be listed" : "not visible to you"})`;
  const capLabel = (c: CapabilityId) => CAPABILITY_DEFS.find((d) => d.id === c)?.label ?? c;
  const classLabel = (v: string) => codeClasses.find((c) => c.value === v)?.label ?? v;

  const toggle = (cap: CapabilityId, token: string) => {
    if (!canEdit || !policy) return;
    setPolicy((p) => {
      if (!p) return p;
      const cur = p[cap] ?? [];
      const next = cur.includes(token) ? cur.filter((t) => t !== token) : [...cur, token];
      return { ...p, [cap]: next };
    });
    setDirty(true);
    setMsg(null);
  };

  const toggleOverride = (cap: CapabilityId, idx: number, token: string) => {
    if (!canEdit) return;
    setOverrides((o) => {
      const rows = [...(o[cap] ?? [])];
      const row = rows[idx];
      if (!row) return o;
      const tokens = row.tokens.includes(token) ? row.tokens.filter((t) => t !== token) : [...row.tokens, token];
      rows[idx] = { ...row, tokens };
      return { ...o, [cap]: rows };
    });
    setDirty(true);
    setMsg(null);
  };

  const addOverride = () => {
    if (!canEdit || !newType || !policy) return;
    if ((overrides[newCap] ?? []).some((r) => r.type === newType)) {
      setMsg({ tone: "err", text: `${capLabel(newCap)} already has an override for ${typeLabel(newType)} — edit that row.` });
      return;
    }
    const def = CAPABILITY_DEFS.find((d) => d.id === newCap);
    // Start a critical capability's override from Admin so the rail holds.
    setOverrides((o) => ({ ...o, [newCap]: [...(o[newCap] ?? []), { type: newType, tokens: def?.critical ? ["Admin"] : [] }] }));
    setDirty(true);
    setMsg(null);
  };

  const removeOverride = (cap: CapabilityId, idx: number) => {
    if (!canEdit) return;
    setOverrides((o) => ({ ...o, [cap]: (o[cap] ?? []).filter((_, i) => i !== idx) }));
    setDirty(true);
    setMsg(null);
  };

  // QUAL-14: project-scoped rows (a capability decided per project only).
  const addProjectOverride = () => {
    if (!canEdit || !newProject || !policy) return;
    if ((projectOverrides[newProjectCap] ?? []).some((r) => r.projectId === newProject)) {
      setMsg({ tone: "err", text: `${capLabel(newProjectCap)} already has a rule for ${projectLabel(newProject)} — edit that row.` });
      return;
    }
    setProjectOverrides((o) => ({ ...o, [newProjectCap]: [...(o[newProjectCap] ?? []), { projectId: newProject, tokens: [] }] }));
    setDirty(true);
    setMsg(null);
  };
  const toggleProjectOverride = (cap: CapabilityId, idx: number, token: string) => {
    if (!canEdit) return;
    setProjectOverrides((o) => {
      const rows = [...(o[cap] ?? [])];
      const row = rows[idx];
      if (!row) return o;
      rows[idx] = { ...row, tokens: row.tokens.includes(token) ? row.tokens.filter((t) => t !== token) : [...row.tokens, token] };
      return { ...o, [cap]: rows };
    });
    setDirty(true);
    setMsg(null);
  };
  const removeProjectOverride = (cap: CapabilityId, idx: number) => {
    if (!canEdit) return;
    setProjectOverrides((o) => ({ ...o, [cap]: (o[cap] ?? []).filter((_, i) => i !== idx) }));
    setDirty(true);
    setMsg(null);
  };

  // DF-P19 second fix pass (TIER-4 done-when 1): code-class rows — a request
  // capability decided for requests of one code class.
  const addClassOverride = () => {
    if (!canEdit || !newClass || !policy) return;
    if ((codeClassOverrides[newClassCap] ?? []).some((r) => r.codeClass === newClass)) {
      setMsg({ tone: "err", text: `${capLabel(newClassCap)} already has a rule for ${classLabel(newClass)} — edit that row.` });
      return;
    }
    const def = CAPABILITY_DEFS.find((d) => d.id === newClassCap);
    // Start a critical capability's row from Admin so the rail holds.
    setCodeClassOverrides((o) => ({ ...o, [newClassCap]: [...(o[newClassCap] ?? []), { codeClass: newClass, tokens: def?.critical ? ["Admin"] : [] }] }));
    setDirty(true);
    setMsg(null);
  };
  const toggleClassOverride = (cap: CapabilityId, idx: number, token: string) => {
    if (!canEdit) return;
    setCodeClassOverrides((o) => {
      const rows = [...(o[cap] ?? [])];
      const row = rows[idx];
      if (!row) return o;
      // Third fix pass (review major 2): an in-force rule is Admin's to change.
      if (!hasAnyRole(["Admin"]) && inForceClassRule(storedPolicy, cap, row.codeClass)) return o;
      rows[idx] = { ...row, tokens: row.tokens.includes(token) ? row.tokens.filter((t) => t !== token) : [...row.tokens, token] };
      return { ...o, [cap]: rows };
    });
    setDirty(true);
    setMsg(null);
  };
  const removeClassOverride = (cap: CapabilityId, idx: number) => {
    if (!canEdit) return;
    const row = (codeClassOverrides[cap] ?? [])[idx];
    if (row && !hasAnyRole(["Admin"]) && inForceClassRule(storedPolicy, cap, row.codeClass)) return;
    setCodeClassOverrides((o) => ({ ...o, [cap]: (o[cap] ?? []).filter((_, i) => i !== idx) }));
    setDirty(true);
    setMsg(null);
  };

  const save = async () => {
    if (!activeOrgId || !uid || !policy) return;
    const caps = joinPolicyFromEditor(policy, overrides, opaque, projectOverrides, storedPolicy, codeClassOverrides);
    const err = validateCapabilityPolicy({ caps });
    if (err) { setMsg({ tone: "err", text: err }); return; }
    // DF-P19 third fix pass (review major 2): the route refuses a non-Admin's
    // save that changes or removes an in-force library- / class-scoped rule —
    // said here first, nothing sent.
    if (!hasAnyRole(["Admin"])) {
      const dropped = inForceTicketRulesDropped(caps, storedPolicy?.caps);
      if (dropped.length > 0) {
        setMsg({ tone: "err", text: `Only an Admin may change or remove an in-force code-class / library rule (${dropped.map((x) => `${CAPABILITY_DEFS.find((d) => d.id === x.cap)?.label ?? x.cap} where ${describeWhen(x.rule.when)}`).join("; ")}) — nothing was saved.` });
        return;
      }
      // Fourth fix pass (review major 1): nor a rule ahead of one (the first
      // match decides) — the route refuses that too.
      // Merge-time fix pass (review nit 4): one wording with the route's.
      const shadowed = inForceTicketRulesShadowed(caps, storedPolicy?.caps);
      if (shadowed.length > 0) {
        setMsg({ tone: "err", text: inForceTicketRulesShadowedRefusal(shadowed, capLabel) });
        return;
      }
    }
    // IMPACT PREVIEW — spell out exactly what changes before it takes effect.
    const changes: string[] = [];
    for (const d of CAPABILITY_DEFS) {
      const was = baseline?.[d.id] ?? d.defaultRoles;
      const now = policy[d.id] ?? [];
      const added = now.filter((t) => !was.includes(t));
      const removed = was.filter((t) => !now.includes(t));
      if (added.length || removed.length) {
        changes.push(`${d.label}: ${added.length ? `+${added.map(tokenLabel).join(", +")}` : ""}${added.length && removed.length ? " · " : ""}${removed.length ? `−${removed.map(tokenLabel).join(", −")}` : ""}`);
      }
      const wasRows = baselineOverrides[d.id] ?? [];
      const nowRows = overrides[d.id] ?? [];
      for (const r of nowRows) {
        const prev = wasRows.find((w) => w.type === r.type);
        if (!prev) changes.push(`${d.label} for ${typeLabel(r.type)}: ONLY ${r.tokens.join(", ") || "nobody"} (new override)`);
        else if (prev.tokens.join("|") !== r.tokens.join("|")) changes.push(`${d.label} for ${typeLabel(r.type)}: ONLY ${r.tokens.join(", ") || "nobody"} (was ${prev.tokens.join(", ") || "nobody"})`);
      }
      for (const w of wasRows) {
        if (!nowRows.some((r) => r.type === w.type)) changes.push(`${d.label} for ${typeLabel(w.type)}: override removed — base list applies again`);
      }
      const wasProj = baselineProjectOverrides[d.id] ?? [];
      const nowProj = projectOverrides[d.id] ?? [];
      for (const r of nowProj) {
        const prev = wasProj.find((w) => w.projectId === r.projectId);
        if (!prev) changes.push(`${d.label} on ${projectLabel(r.projectId)}: ${r.tokens.join(", ") || "nobody by role"} (new project rule)`);
        else if (prev.tokens.join("|") !== r.tokens.join("|")) changes.push(`${d.label} on ${projectLabel(r.projectId)}: ${r.tokens.join(", ") || "nobody by role"} (was ${prev.tokens.join(", ") || "nobody by role"})`);
      }
      for (const w of wasProj) {
        if (!nowProj.some((r) => r.projectId === w.projectId)) changes.push(`${d.label} on ${projectLabel(w.projectId)}: project rule removed — the row above applies again`);
      }
      // DF-P19 second fix pass: a new or edited code-class rule is in force at
      // once only when an Admin saves it; anyone else's only adds people until
      // an Admin confirms it (the policy route decides — review minor 3).
      const wasCls = baselineCodeClassOverrides[d.id] ?? [];
      const nowCls = codeClassOverrides[d.id] ?? [];
      const takesEffect = classRuleTakesEffect(d.id, hasAnyRole(["Admin"]));
      for (const r of nowCls) {
        const prev = wasCls.find((w) => w.codeClass === r.codeClass);
        // Fifth fix pass (review major 1): name the rules that decide first;
        // merge-time fix pass (review minor 2): only in-force ones, and an
        // unconfirmed one ahead by what it does.
        const ahead = classRuleAheadNote(d.id, caps[d.id], r.codeClass);
        const except = ahead ? `; ${ahead}` : "";
        if (!prev) changes.push(`${d.label} for code class ${classLabel(r.codeClass)}: ONLY ${r.tokens.join(", ") || "nobody"} (new code-class rule — ${takesEffect}${except})`);
        else if (!sameTokens(prev.tokens, r.tokens)) changes.push(`${d.label} for code class ${classLabel(r.codeClass)}: ONLY ${r.tokens.join(", ") || "nobody"} (was ${prev.tokens.join(", ") || "nobody"} — ${takesEffect}${except})`);
      }
      for (const w of wasCls) {
        if (!nowCls.some((r) => r.codeClass === w.codeClass)) changes.push(`${d.label} for code class ${classLabel(w.codeClass)}: code-class rule removed — the row above applies again`);
      }
    }
    // Merge-time fix pass 2 (review nit 4): an Admin's save may drop an
    // in-force library / class rule (anyone else's was refused above) — said
    // here, with what remains of it, and recorded by the route.
    if (hasAnyRole(["Admin"])) {
      for (const x of describeDroppedInForceTicketRules(caps, storedPolicy?.caps)) {
        changes.push(`${capLabel(x.cap)} where ${describeWhen(x.rule.when)} → ${x.rule.tokens.join(", ") || "nobody"}: in force today; ${x.remains === "unconfirmed-copy"
          ? "after this save the copy of this rule that is kept is an UNCONFIRMED one, so it only adds people until an Admin confirms it again"
          : "this save removes it (an edited rule is saved as a new one)"}`);
      }
    }
    if (changes.length > 0) {
      const ok = await appConfirm({
        message: `This changes who can act, effective immediately:\n\n${changes.slice(0, 8).join("\n")}${changes.length > 8 ? `\n…and ${changes.length - 8} more` : ""}\n\nApply?`,
      });
      if (!ok) return;
    }
    setSaving(true);
    const commit = (written: string | null, storedCaps?: CapabilityPolicy["caps"]) => {
      setBaseline(policy);
      setBaselineOverrides(overrides);
      setBaselineProjectOverrides(projectOverrides);
      setBaselineCodeClassOverrides(codeClassOverrides);
      setVersion(written);
      setBaselineCaps(JSON.stringify(caps));
      // DF-P19 fix pass: the order the next save keeps is the one just stored.
      // Second fix pass: the caps the server stored (with the confirmation
      // stamps it decided), so the rule list below says what is in force.
      setStoredPolicy((p) => ({ ...(p ?? {}), caps: storedCaps ?? caps }));
      setDirty(false);
      setMsg({ tone: "ok", text: "Saved — validated and audited on the server; enforced on the next action." });
      // ALOG-14 (fix pass 2): the other panels on this page re-read.
      announceCapabilityPolicyChanged(activeOrgId);
    };
    try {
      // This editor only owns the role grid: the policy route preserves the
      // per-person grants, re-validates, requires Admin for a critical
      // capability and writes the before/after audit row (WF-11). ALOG-12:
      // it carries the version the grid was loaded at.
      const out = await saveCapabilityPolicy({ orgId: activeOrgId, policy: { caps }, actorUserId: uid, actorEmail: userEmail, version });
      invalidateCapabilityPolicy(activeOrgId);
      commit(out.version, out.policy?.caps);
    } catch (e) {
      if (!(e instanceof CapabilityPolicyChangeError) || e.code !== POLICY_CHANGED) {
        setMsg({ tone: "err", text: (e as Error).message });
        return;
      }
      // ALOG-12: the stored row moved on since this grid loaded. Re-read it.
      const fresh = await readFresh();
      if (!fresh || fresh.unreadable) {
        setMsg({ tone: "err", text: `${e.message} The current policy could not be read${fresh?.unreadable ? ` (${fresh.unreadable})` : ""} — reload the page.` });
        return;
      }
      const s2 = splitPolicyForEditor(fresh.policy);
      const storedCaps = JSON.stringify(joinPolicyFromEditor(s2.base, s2.overrides, s2.opaque, s2.projectOverrides, fresh.policy, s2.codeClassOverrides));
      if (storedCaps === baselineCaps) {
        // Only grants moved (a delegation, an expiry pruned): the grid this
        // edit started from is still the stored one — save it on the new version.
        try {
          const out = await saveCapabilityPolicy({ orgId: activeOrgId, policy: { caps }, actorUserId: uid, actorEmail: userEmail, version: fresh.version });
          invalidateCapabilityPolicy(activeOrgId);
          commit(out.version, out.policy?.caps);
        } catch (e2) {
          setMsg({ tone: "err", text: (e2 as Error).message });
        }
        return;
      }
      // Someone else changed the grid: show theirs, never overwrite it.
      apply(fresh.policy, fresh.version);
      announceCapabilityPolicyChanged(activeOrgId);
      setMsg({ tone: "err", text: "Another admin changed the action permissions since you opened this page — the grid now shows their version and your change was NOT saved. Make your change again." });
    } finally { setSaving(false); }
  };

  /** DF-P19 (DEC-90 ruling (2)): an Admin confirms one stored request rule
   *  scoped to a library or a class, so a narrowing it makes applies. */
  const confirmRule = async (r: TicketDimensionRuleState) => {
    if (!activeOrgId || !hasAnyRole(["Admin"])) return;
    if (dirty) { setMsg({ tone: "err", text: "Save or reset your changes to the grid first — confirming a rule reloads the policy." }); return; }
    const ok = await appConfirm({
      message: `Confirm this rule? From now on it applies in full, including where it takes the action away from people who can do it today:\n\n${capLabel(r.cap)} when ${describeWhen(r.rule.when)} → ${r.rule.tokens.join(", ") || "nobody"}`,
    });
    if (!ok) return;
    setConfirming(`${r.cap}:${r.key}#${r.ordinal}`);
    try {
      // DF-P23 (the DF-P19 final review's nit): the confirmation carries the
      // version the rule was read at; a policy saved since is refused (409
      // policy_changed), so a stale copy ordinal never confirms a copy at a
      // place the Admin did not click. Merge-time fix pass 2: with the
      // capability's rule list as read (ruleDigest), so a grant, a revoke or
      // another capability's edit since does not refuse it — only a change
      // to THIS capability's rules does.
      await confirmCapabilityRule({ orgId: activeOrgId, cap: r.cap, rule: r.rule, ordinal: r.ordinal, version, ruleDigest: capabilityRuleListDigest(storedPolicy?.caps, r.cap) });
      invalidateCapabilityPolicy(activeOrgId);
      announceCapabilityPolicyChanged(activeOrgId);
      await load();
      setMsg({ tone: "ok", text: "Rule confirmed — it now applies in full (audited on the server)." });
    } catch (e) {
      if (e instanceof CapabilityPolicyChangeError && e.code === POLICY_CHANGED) {
        invalidateCapabilityPolicy(activeOrgId);
        await load();
        setMsg({ tone: "err", text: "Another admin changed the action permissions since you opened this page — the list now shows their version and the rule was NOT confirmed. Confirm it again if it is still listed." });
      } else {
        setMsg({ tone: "err", text: (e as Error).message });
      }
    } finally { setConfirming(null); }
  };

  const resetDefaults = () => {
    setPolicy(defaultCapabilityPolicy());
    setOverrides({});
    setProjectOverrides({});
    setCodeClassOverrides({});
    setOpaque({});
    setDirty(true);
    setMsg(null);
  };

  if (loadError) {
    return (
      <div role="alert" className="rounded-2xl border border-rose-500/30 bg-rose-500/[0.06] mb-5 px-4 py-3 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-bold">Action permissions — this workspace&apos;s policy could not be read</div>
          <div className="mt-0.5">({loadError}) Nothing is shown here rather than the shipped defaults, and nothing can be saved over the stored policy until it loads.</div>
        </div>
        <button onClick={() => void load()} className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-500/40 text-[11px] font-bold">
          <RotateCcw className="w-3 h-3" /> Retry
        </button>
      </div>
    );
  }
  if (!policy) return null;

  const overrideRows = CAPABILITY_DEFS.flatMap((d) => (overrides[d.id] ?? []).map((row, idx) => ({ def: d, row, idx })));
  const projectRows = CAPABILITY_DEFS.flatMap((d) => (projectOverrides[d.id] ?? []).map((row, idx) => ({ def: d, row, idx })));
  const classRows = CAPABILITY_DEFS.flatMap((d) => (codeClassOverrides[d.id] ?? []).map((row, idx) => ({ def: d, row, idx })));
  // Fifth fix pass (review major 1): the entries a save would write, for the
  // rules that decide before a code-class row.
  const draftCaps = joinPolicyFromEditor(policy, overrides, opaque, projectOverrides, storedPolicy, codeClassOverrides);
  const projectScopedDefs = CAPABILITY_DEFS.filter((d) => PROJECT_SCOPED_CAPS.has(d.id));
  const opaqueCount = Object.values(opaque).reduce((n, rs) => n + (rs?.length ?? 0), 0);
  const dimensionRules = ticketDimensionRules(storedPolicy);
  const mayConfirm = hasAnyRole(["Admin"]);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] mb-5 overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <SlidersHorizontal className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-base font-bold text-[var(--color-text)]">Action permissions</span>
        <span className="text-xs text-[var(--color-text-muted)]">who may perform each workflow action — enforced on the server, audited on save</span>
        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            <button onClick={resetDefaults} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <RotateCcw className="w-3 h-3" /> Restore defaults
            </button>
            <button onClick={() => void save()} disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-40">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save policy
            </button>
          </div>
        )}
      </div>
      {msg && (
        <div className={`mx-4 mt-3 rounded-xl border p-2.5 text-xs flex items-start gap-2 ${msg.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300" : "border-rose-500/30 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300"}`}>
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {msg.text}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[var(--color-surface-2)]">
              <th className="sticky left-0 bg-[var(--color-surface-2)] text-left font-black px-4 py-2 min-w-[230px]">Action</th>
              {TOKENS.map((t) => (
                <th key={t} className="px-2 py-2 font-black text-[var(--color-text-muted)] whitespace-nowrap">{TOKEN_LABEL[t] ?? t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => (
              <React.Fragment key={area}>
                <tr><td colSpan={TOKENS.length + 1} className="sticky left-0 bg-[var(--color-surface)] px-4 pt-3 pb-1 text-[11px] font-black uppercase tracking-wider text-[var(--color-accent)]">{area}</td></tr>
                {CAPABILITY_DEFS.filter((d) => d.area === area).map((d) => (
                  // DEC-11 / WF-17: a dormant capability (no live status
                  // consults its base list) renders greyed with the reason —
                  // never as a live-looking control.
                  <tr key={d.id} title={d.dormant ? d.dormantNote : undefined} className={`border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/50 ${d.dormant ? "opacity-50" : ""}`}>
                    <td className="sticky left-0 bg-[var(--color-surface)] px-4 py-1.5">
                      <span className="font-medium text-[var(--color-text)]">{d.label}</span>
                      {d.critical && <span className="ml-1.5 text-[9px] font-black text-amber-600 dark:text-amber-400 cursor-help" title="Critical: Admin cannot be removed">CRITICAL</span>}
                      {d.dormant && <span className="ml-1.5 text-[9px] font-black text-[var(--color-text-faint)] cursor-help" title={d.dormantNote}>DORMANT</span>}
                      {(overrides[d.id]?.length ?? 0) > 0 && <span className="ml-1.5 text-[9px] font-black text-sky-700 dark:text-sky-300 cursor-help" title="Request-type overrides below replace this row for tickets of those types">{overrides[d.id]?.length} OVERRIDE{(overrides[d.id]?.length ?? 0) > 1 ? "S" : ""}</span>}
                      {(codeClassOverrides[d.id]?.length ?? 0) > 0 && <span className="ml-1.5 text-[9px] font-black text-teal-700 dark:text-teal-300 cursor-help" title="Code-class rules below replace this row for requests of those code classes">{codeClassOverrides[d.id]?.length} CODE-CLASS RULE{(codeClassOverrides[d.id]?.length ?? 0) > 1 ? "S" : ""}</span>}
                      {(projectOverrides[d.id]?.length ?? 0) > 0 && <span className="ml-1.5 text-[9px] font-black text-violet-700 dark:text-violet-300 cursor-help" title="Project rules below replace this row on those projects">{projectOverrides[d.id]?.length} PROJECT RULE{(projectOverrides[d.id]?.length ?? 0) > 1 ? "S" : ""}</span>}
                      <div className="text-[10px] text-[var(--color-text-faint)]">{d.description}</div>
                      {/* drafting-flow HAND-2 (DF-P11 fix pass 2): the opener of
                          a hold may lift their own stop while this is ticked
                          (HOLD_OPENER_TOKEN — shipped on; untick it for
                          "only the roles ticked here lift holds"). The
                          database reads the same token (20261239). */}
                      {d.id === "holds.release" && (() => {
                        const on = (policy[d.id] ?? []).includes(HOLD_OPENER_TOKEN);
                        return (
                          <label className={`mt-0.5 inline-flex items-center gap-1.5 text-[10px] font-bold ${canEdit ? "cursor-pointer" : "opacity-70 cursor-not-allowed"}`}>
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={!canEdit}
                              onChange={() => toggle(d.id, HOLD_OPENER_TOKEN)}
                              aria-label="The hold's own opener may release or re-date it"
                            />
                            The hold&apos;s own opener may release or re-date it
                          </label>
                        );
                      })()}
                      {/* HAND-2 (fix pass 3): a row still exactly ["*"] is
                          most likely the old default that an earlier save
                          stored with every other row — say so, and offer the
                          shipped default as an explicit, saved decision. */}
                      {d.id === "holds.release" && holdsReleaseOnOldDefault(policy[d.id]) && (
                        <div role="note" data-testid="holds-release-old-default" className="mt-1 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                          Everyone may release any hold here: this workspace stores &ldquo;everyone&rdquo; for this action. It was the old default, which saving this grid used to store with every other action whether or not anyone chose it. It is this workspace&apos;s stored list, so the hold-release change did not rewrite it (ruled by the integrator at the DF-P11 merge, 2026-10-21, DEC-90). The recommended, shipped default is Admin, Document Control and the hold&apos;s own opener.
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => {
                                const def = CAPABILITY_DEFS.find((x) => x.id === "holds.release");
                                setPolicy((p) => (p ? { ...p, "holds.release": [...(def?.defaultRoles ?? [])] } : p));
                                setDirty(true);
                                setMsg(null);
                              }}
                              className="ml-1.5 underline"
                            >
                              Use the shipped default
                            </button>
                          )}
                        </div>
                      )}
                      {tokensOutsideGrid(policy[d.id] ?? []).length > 0 && (
                        <div className="text-[10px] font-bold text-amber-700 dark:text-amber-300" title="The evaluator still matches these stored tokens; the grid has no column for them. Unticking every column leaves them in place.">
                          Also stored, no column here: {tokensOutsideGrid(policy[d.id] ?? []).join(", ")} — still live
                        </div>
                      )}
                    </td>
                    {TOKENS.map((t) => {
                      const on = (policy[d.id] ?? []).includes(t);
                      const locked = !canEdit || (d.critical && t === "Admin" && on);
                      return (
                        <td key={t} className="px-2 py-1.5 text-center">
                          <button
                            onClick={() => !locked && toggle(d.id, t)}
                            disabled={locked}
                            title={locked && on ? "Admin is locked on critical capabilities" : undefined}
                            className={`w-5 h-5 rounded border inline-flex items-center justify-center transition-colors ${on ? "bg-emerald-500 border-emerald-500 text-white" : "border-[var(--color-border-strong)] hover:border-[var(--color-accent-ring)]"} ${locked ? "opacity-70 cursor-not-allowed" : ""}`}
                          >
                            {on && <Check className="w-3 h-3" />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* DEC-13 stage 2 — request-type overrides */}
      <div className="px-4 py-3 border-t border-[var(--color-border)]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-black text-[var(--color-text)]">Request-type overrides</span>
          <span className="text-[10px] text-[var(--color-text-faint)]">for tickets of one request type, the override&apos;s list REPLACES the row above — &ldquo;ASBUILT may only be approved by DocCtrl&rdquo;. Enforced in the workflow route and honoured by the database evaluator.</span>
        </div>
        {canEdit && (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <select value={newCap} onChange={(e) => setNewCap(e.target.value as CapabilityId)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px]">
              {CAPABILITY_DEFS.filter((d) => d.area === "Requests").map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            <select value={newType} onChange={(e) => setNewType(e.target.value)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px] min-w-[160px]">
              <option value="">Request type…</option>
              {requestTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button onClick={addOverride} disabled={!newType} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40">
              <Plus className="w-3 h-3" /> Add override
            </button>
            {requestTypes.length === 0 && <span className="text-[10px] text-[var(--color-text-faint)]">No request types are configured (Admin → Requests) — overrides key off that list.</span>}
          </div>
        )}
        {overrideRows.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {overrideRows.map(({ def, row, idx }) => (
              <li key={`${def.id}:${row.type}`} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] flex items-center gap-2 flex-wrap">
                <span className="font-bold text-[var(--color-text)]">{def.label}</span>
                <span className="text-[var(--color-text-faint)]">for</span>
                <span className="font-mono font-bold text-sky-700 dark:text-sky-300">{typeLabel(row.type)}</span>
                <span className="text-[var(--color-text-faint)]">→ only</span>
                <div className="flex items-center gap-1 flex-wrap">
                  {TOKENS.map((t) => {
                    const on = row.tokens.includes(t);
                    const locked = !canEdit || (def.critical && t === "Admin" && on);
                    return (
                      <button key={t} onClick={() => !locked && toggleOverride(def.id, idx, t)} disabled={locked}
                        title={locked && on ? "Admin is locked on critical capabilities" : undefined}
                        className={`px-1.5 py-0.5 rounded border text-[10px] ${on ? "bg-emerald-500 border-emerald-500 text-white" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"} ${locked ? "opacity-70 cursor-not-allowed" : ""}`}>
                        {TOKEN_LABEL[t] ?? t}
                      </button>
                    );
                  })}
                </div>
                {row.tokens.length === 0 && <span className="text-[10px] font-bold text-rose-700 dark:text-rose-300">nobody by role — only personal grants and identity rights apply</span>}
                {tokensOutsideGrid(row.tokens).length > 0 && <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300">also stored: {tokensOutsideGrid(row.tokens).join(", ")} — still live</span>}
                {canEdit && (
                  <button onClick={() => removeOverride(def.id, idx)} className="ml-auto text-[var(--color-text-faint)] hover:text-rose-600" title="Remove this override (the base row applies again)">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-2 text-[11px] italic text-[var(--color-text-faint)]">No request-type overrides — every capability uses its row above for every ticket.</div>
        )}
        {/* DF-P19 second fix pass (TIER-4 done-when 1) — code-class rules */}
        <div className="mt-3 pt-3 border-t border-[var(--color-border)]" data-testid="code-class-rules">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-[var(--color-text)]">Code-class rules</span>
            <span className="text-[10px] text-[var(--color-text-faint)]">for requests of one code class (set at triage), the rule&apos;s list REPLACES the row above &mdash; &ldquo;final approval on this code&apos;s requests only by Engineer-3&rdquo;. The first matching rule decides: a new code-class rule is written after every stored rule that can match a request of its class (a library rule, a rule naming that class) and ahead of the request-type and unit rules, so it cancels none of those rules and applies whatever the request type. Where such a stored rule sits behind a request-type or unit rule, the new rule goes after it. A rule that has rules ahead of it says so: where one of them is in force, that rule decides first for the requests it matches. Enforced in the workflow route, the request page, the requests list, the inbox and the badge. An Admin&apos;s save puts a new rule in force; anyone else&apos;s only adds people until an Admin confirms it (listed below).</span>
          </div>
          {canEdit && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <select aria-label="Code-class rule capability" value={newClassCap} onChange={(e) => setNewClassCap(e.target.value as CapabilityId)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px]">
                {CAPABILITY_DEFS.filter((d) => CODE_CLASS_RULE_CAPS.includes(d.id)).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
              <select aria-label="Code class" value={newClass} onChange={(e) => setNewClass(e.target.value)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px] min-w-[160px]">
                <option value="">Code class…</option>
                {codeClasses.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              <button onClick={addClassOverride} disabled={!newClass} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40">
                <Plus className="w-3 h-3" /> Add code-class rule
              </button>
              {codeClasses.length === 0 && !codeClassesErr && <span className="text-[10px] text-[var(--color-text-faint)]">No code classes are configured (Admin → Request forms) — these rules key off that list.</span>}
            </div>
          )}
          {codeClassesErr && <div role="alert" className="mt-1 text-[10px] font-bold text-rose-700 dark:text-rose-300">The code classes could not be read ({codeClassesErr}) — a rule&apos;s class below is shown by its stored value.</div>}
          {classRows.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {classRows.map(({ def, row, idx }) => (
                <li key={`${def.id}:${row.codeClass}`} data-code-class-rule={row.codeClass} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-[var(--color-text)]">{def.label}</span>
                  <span className="text-[var(--color-text-faint)]">for code class</span>
                  <span className="font-bold text-teal-700 dark:text-teal-300">{classLabel(row.codeClass)}</span>
                  <span className="text-[var(--color-text-faint)]">→ only</span>
                  <div className="flex items-center gap-1 flex-wrap">
                    {TOKENS.map((t) => {
                      const on = row.tokens.includes(t);
                      const adminOnly = !mayConfirm && inForceClassRule(storedPolicy, def.id, row.codeClass);
                      const locked = !canEdit || adminOnly || (def.critical && t === "Admin" && on);
                      return (
                        <button key={t} onClick={() => !locked && toggleClassOverride(def.id, idx, t)} disabled={locked}
                          title={adminOnly ? "In force — only an Admin may change this rule" : locked && on ? "Admin is locked on critical capabilities" : undefined}
                          className={`px-1.5 py-0.5 rounded border text-[10px] ${on ? "bg-emerald-500 border-emerald-500 text-white" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"} ${locked ? "opacity-70 cursor-not-allowed" : ""}`}>
                          {TOKEN_LABEL[t] ?? t}
                        </button>
                      );
                    })}
                  </div>
                  {row.tokens.length === 0 && <span className="text-[10px] font-bold text-rose-700 dark:text-rose-300">nobody by role — only personal grants and identity rights apply</span>}
                  {tokensOutsideGrid(row.tokens).length > 0 && <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300">also stored: {tokensOutsideGrid(row.tokens).join(", ")} — still live</span>}
                  {classRuleAheadNote(def.id, draftCaps[def.id], row.codeClass) && (
                    <span data-class-rule-decided-first className="text-[10px] font-bold text-amber-700 dark:text-amber-300">
                      {classRuleAheadNote(def.id, draftCaps[def.id], row.codeClass)}
                    </span>
                  )}
                  {!mayConfirm && inForceClassRule(storedPolicy, def.id, row.codeClass) && <span data-class-rule-admin-only className="text-[10px] font-bold text-[var(--color-text-faint)]">in force — only an Admin may change or remove it</span>}
                  {canEdit && (mayConfirm || !inForceClassRule(storedPolicy, def.id, row.codeClass)) && (
                    <button onClick={() => removeClassOverride(def.id, idx)} className="ml-auto text-[var(--color-text-faint)] hover:text-rose-600" title="Remove this code-class rule (the row above applies again)">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-2 text-[11px] italic text-[var(--color-text-faint)]">No code-class rules — every request capability uses its row above whatever the request&apos;s code class.</div>
          )}
        </div>
        {/* QUAL-14 — project-scoped rules */}
        {projectScopedDefs.length > 0 && (
          <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-black text-[var(--color-text)]">Project-scoped rules</span>
              <span className="text-[10px] text-[var(--color-text-faint)]">for one project, the rule&apos;s list REPLACES the row above — &ldquo;on this project, Safety signs off its quality records&rdquo;. Admin, Document Control and the project&apos;s owner always can. Enforced by the database per project (needs migration 20261136; the save is refused until it is applied).</span>
            </div>
            {canEdit && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <select value={newProjectCap} onChange={(e) => setNewProjectCap(e.target.value as CapabilityId)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px]">
                  {projectScopedDefs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
                <select value={newProject} onChange={(e) => setNewProject(e.target.value)} className="h-7 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[11px] min-w-[160px]">
                  <option value="">Project…</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button onClick={addProjectOverride} disabled={!newProject} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40">
                  <Plus className="w-3 h-3" /> Add project rule
                </button>
              </div>
            )}
            {/* Said to every viewer, not only an editor: a read-only viewer
                otherwise sees each stored rule's project as "not visible to
                you" when the list simply failed to load. */}
            {projectsErr && <div role="alert" className="mt-1 text-[10px] font-bold text-rose-700 dark:text-rose-300">Projects could not be listed ({projectsErr}) — a rule&apos;s project below is shown by its id.</div>}
            {projectRows.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {projectRows.map(({ def, row, idx }) => (
                  <li key={`${def.id}:${row.projectId}`} data-project-rule={row.projectId} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-[var(--color-text)]">{def.label}</span>
                    <span className="text-[var(--color-text-faint)]">on</span>
                    <span className="font-bold text-violet-700 dark:text-violet-300">{projectLabel(row.projectId)}</span>
                    <span className="text-[var(--color-text-faint)]">→ only</span>
                    <div className="flex items-center gap-1 flex-wrap">
                      {TOKENS.map((t) => {
                        const on = row.tokens.includes(t);
                        return (
                          <button key={t} onClick={() => toggleProjectOverride(def.id, idx, t)} disabled={!canEdit}
                            className={`px-1.5 py-0.5 rounded border text-[10px] ${on ? "bg-emerald-500 border-emerald-500 text-white" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"} ${!canEdit ? "opacity-70 cursor-not-allowed" : ""}`}>
                            {TOKEN_LABEL[t] ?? t}
                          </button>
                        );
                      })}
                    </div>
                    {row.tokens.length === 0 && <span className="text-[10px] font-bold text-rose-700 dark:text-rose-300">nobody by role — only the standing holders and personal grants</span>}
                    {tokensOutsideGrid(row.tokens).length > 0 && <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300">also stored: {tokensOutsideGrid(row.tokens).join(", ")} — still live</span>}
                    {canEdit && (
                      <button onClick={() => removeProjectOverride(def.id, idx)} className="ml-auto text-[var(--color-text-faint)] hover:text-rose-600" title="Remove this project rule (the row above applies again)">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-2 text-[11px] italic text-[var(--color-text-faint)]">No project-scoped rules — {projectScopedDefs.map((d) => d.label).join(", ")} uses its row above on every project.</div>
            )}
            <div className="mt-1 text-[10px] text-[var(--color-text-faint)]">A rule names roles, not people: everyone holding a ticked role who can see the project is granted there. A personal grant (View as… below) applies on every project unless it names one — a grant on one project names one person there (QUAL-14; needs migration 20261239).</div>
          </div>
        )}
        {opaqueCount > 0 && (
          <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">
            {opaqueCount} rule{opaqueCount > 1 ? "s" : ""} scoped by unit / library / discipline {opaqueCount > 1 ? "are" : "is"} stored on this policy and preserved on save (not editable here): {
              CAPABILITY_DEFS.flatMap((d) => (opaque[d.id] ?? []).map((r) => `${d.label} when ${describeWhen(r.when)} → ${r.tokens.join(", ") || "nobody"}`)).join("; ")
            }
          </div>
        )}
        {dimensionRules.length > 0 && (
          <div data-testid="ticket-dimension-rules" className="mt-2 rounded-lg border border-[var(--color-border)] px-2.5 py-2">
            <div className="text-xs font-black text-[var(--color-text)]">Request rules scoped to a library or a work / code class — state</div>
            <div className="text-[10px] text-[var(--color-text-faint)]">Requests present their library and classes to these rules. A rule no Admin has saved or confirmed (one stored before requests presented them, or added by a non-Admin) only adds people until an Admin confirms it: where it would take an action away from someone, that person keeps it until then. On &ldquo;Approve own request without an engineer&rdquo; it does nothing at all until confirmed (adding a role there removes an engineer review).</div>
            <ul className="mt-1 space-y-1">
              {dimensionRules.map((r) => (
                <li key={`${r.cap}:${r.key}#${r.ordinal}`} data-dimension-rule={r.inForce ? "in-force" : r.effect} className="text-[11px] flex items-center gap-2 flex-wrap">
                  <span className="text-[var(--color-text)]">{capLabel(r.cap)} when {describeWhen(r.rule.when)} → {r.rule.tokens.join(", ") || "nobody"}</span>
                  <span className={r.inForce ? "text-[var(--color-text-faint)]" : r.effect === "narrow" ? "font-bold text-amber-700 dark:text-amber-300" : "text-[var(--color-text-faint)]"}>{ticketDimensionRuleStatus(r)}</span>
                  {!r.inForce && mayConfirm && (
                    <button type="button" disabled={confirming !== null} onClick={() => void confirmRule(r)} className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border)] text-[10px] font-bold disabled:opacity-50">
                      {confirming === `${r.cap}:${r.key}#${r.ordinal}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Confirm
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)]">
        Identity rights are never configurable: a ticket&apos;s requester, assigned drafter, and assigned engineer always keep their own-ticket actions — except that a request-type override on &ldquo;Direct engineering approval&rdquo; binds the requester&apos;s own approval too (they send for engineer approval instead), and a reviewer picked for an overridden type must be inside that override. &ldquo;Engineer&rdquo; covers every Engineer-1…4 tier (tiers are labels, enforced identically).
      </div>
    </div>
  );
}
