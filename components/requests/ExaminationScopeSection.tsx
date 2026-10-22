"use client";

// ExaminationScopeSection — drafting-flow Round G, DF-P24 EXAMINATION SCOPE
// DATA AND ISSUE GATE (GAP-102 acceptance 4), on Admin → Request forms.
//
// The workspace MAY name the examination data a package must carry, in its
// own words (DEC-35: no facility vocabulary in code) — each piece of data a
// list of values to pick from, never typed free (GAP-102: "a field nobody can
// validate is a field everyone types N/A into") — and say which work classes
// and/or libraries require which. It lives in the request-form configuration
// beside the work classes (org_configurations 'drafting', key
// examinationScope) and is saved with the page's own Save Changes (the
// 20261209 write rule decides who may). A requirement binds only requests
// filed AFTER the save that stores it: the database stamps its time on that
// write (20261266's trigger — second fix pass; whatever `since` the page
// sends is ignored); a request already in flight is never newly blocked, it
// shows what is missing as a warning. Nothing configured = exactly today.
//
// Merge-time fix pass (ruling 3): the editor validates with the SAME rule the
// parser reads by (lib/examinationScope.ts examinationScopeProblems —
// FIELD_KEY_RE, the 60-character key, one entry per key, a blank key, the
// list limits, a requirement naming a field that would be dropped or
// naming neither a class nor a library): each problem is shown inline, and
// the page's Save Changes refuses to save until it is fixed
// (`editorScopeProblems`), so nothing saved here is silently dropped.

import React, { useEffect, useState } from "react";
import { Plus, Trash2, ClipboardCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { OrgDraftingSettings } from "@/types/schema";
import { reviewClassOptions } from "@/lib/reviewModel";
import { EXAMINATION_SCOPE_KEY, examinationScopeProblems, scopeBindsFrom, type ExaminationScopeProblem } from "@/lib/examinationScope";

interface EditableOption { value: string; label: string }
interface EditableField { key: string; label: string; options: EditableOption[] }
interface EditableRequirement { field: string; workClass?: string; libraryId?: string; since?: string }
export interface EditableScope { fields: EditableField[]; requirements: EditableRequirement[] }

/** The stored configuration as the editor holds it — every stored entry
 *  kept (a malformed one shown as best it can be), so a save never drops
 *  what it did not touch. Pure; exported for tests. */
export function editableScope(settings: Partial<OrgDraftingSettings> | null | undefined): EditableScope {
  const raw = (settings as Record<string, unknown> | null | undefined)?.[EXAMINATION_SCOPE_KEY] as Record<string, unknown> | undefined;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const fields = (Array.isArray(raw?.fields) ? raw!.fields as unknown[] : []).filter((f): f is Record<string, unknown> => !!f && typeof f === "object").map((f) => ({
    key: s(f.key), label: s(f.label),
    options: (Array.isArray(f.options) ? f.options as unknown[] : []).filter((o): o is Record<string, unknown> => !!o && typeof o === "object").map((o) => ({ value: s(o.value), label: s(o.label) })),
  }));
  const requirements = (Array.isArray(raw?.requirements) ? raw!.requirements as unknown[] : []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object").map((r) => ({
    field: s(r.field),
    ...(s(r.workClass) ? { workClass: s(r.workClass) } : {}),
    ...(s(r.libraryId) ? { libraryId: s(r.libraryId) } : {}),
    ...(s(r.since) ? { since: s(r.since) } : {}),
  }));
  return { fields, requirements };
}

/** One option per line; "value | label" when they differ. Pure; exported for tests. */
export function optionsToText(options: EditableOption[]): string {
  return options.map((o) => (o.label && o.label !== o.value ? `${o.value} | ${o.label}` : o.value)).join("\n");
}
export function textToOptions(text: string): EditableOption[] {
  return text.split("\n").map((line) => {
    const [v, ...rest] = line.split("|");
    const value = (v ?? "").trim();
    const label = rest.join("|").trim();
    return { value, label: label || value };
  }).filter((o) => o.value);
}

/** A requirement edited to name another field, class or library is a NEW
 *  requirement: its time is dropped from the editor (the database stamps it
 *  afresh at the save — it binds only requests filed after it). Pure;
 *  exported for tests. */
export function editRequirement(r: EditableRequirement, patch: Partial<Pick<EditableRequirement, "field" | "workClass" | "libraryId">>): EditableRequirement {
  const next: EditableRequirement = { ...r, ...patch };
  for (const k of ["workClass", "libraryId"] as const) if (!next[k]) delete next[k];
  const identity = (x: EditableRequirement) => `${x.field}\u0000${x.workClass ?? ""}\u0000${x.libraryId ?? ""}`;
  if (identity(next) !== identity(r)) delete next.since;
  return next;
}

/** The problems the page's Save refuses over — checked on the configuration
 *  as this editor holds and shows it (so each one is shown, at its row).
 *  Settings without the key have none: an unconfigured workspace saves
 *  exactly as before. Pure; exported for the page and tests. */
export function editorScopeProblems(settings: Partial<OrgDraftingSettings> | null | undefined): ExaminationScopeProblem[] {
  const raw = (settings as Record<string, unknown> | null | undefined)?.[EXAMINATION_SCOPE_KEY];
  if (raw === undefined || raw === null) return [];
  return examinationScopeProblems({ [EXAMINATION_SCOPE_KEY]: editableScope(settings) });
}

export default function ExaminationScopeSection({
  settings, orgId, onChange,
}: {
  settings: OrgDraftingSettings;
  orgId: string | null;
  onChange: (patch: Partial<OrgDraftingSettings>) => void;
}) {
  const scope = editableScope(settings);
  const [libraries, setLibraries] = useState<Array<{ id: string; name: string }>>([]);
  const [optionText, setOptionText] = useState<Record<number, string>>({});
  const workClasses = reviewClassOptions(settings, "workClasses");

  // The library choices are read only once a requirement row exists (a
  // workspace that configures nothing reads nothing more on this page); a
  // failed read leaves the stored ids shown as they are.
  const needsLibraries = scope.requirements.length > 0;
  useEffect(() => {
    if (!orgId || !needsLibraries) return;
    let alive = true;
    (async () => {
      try {
        const { data } = await supabase.from("libraries").select("id, name").eq("org_id", orgId);
        if (!alive) return;
        setLibraries(((data as Array<{ id: string; name: string | null }> | null) ?? [])
          .map((l) => ({ id: l.id, name: (l.name ?? "").trim() || l.id }))
          .sort((a, b) => a.name.localeCompare(b.name)));
      } catch { /* the stored ids stay shown as they are */ }
    })();
    return () => { alive = false; };
  }, [orgId, needsLibraries]);

  const set = (next: EditableScope) => onChange({ [EXAMINATION_SCOPE_KEY]: next } as unknown as Partial<OrgDraftingSettings>);
  const fieldKeys = new Set(scope.fields.map((f) => f.key));
  const input = "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm";
  const problems = editorScopeProblems(settings);
  const problemsAt = (where: ExaminationScopeProblem["where"], i: number) => problems.filter((p) => p.where === where && p.index === i);
  const problemLines = (where: ExaminationScopeProblem["where"], i: number) => problemsAt(where, i).map((p, k) => (
    <p key={k} role="alert" data-testid="examination-scope-problem" className="w-full text-[11px] text-red-700">{p.message}</p>
  ));

  return (
    <div data-testid="examination-scope-section" className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 shadow-sm">
      <h2 className="text-sm font-bold text-[var(--color-text)] uppercase tracking-wide mb-1 flex items-center"><ClipboardCheck className="w-4 h-4 mr-2 text-orange-500" />Examination Data</h2>
      <p className="text-xs text-[var(--color-text-muted)] mb-4">
        Optional. The data a package must carry before it issues — in your facility&apos;s words, each picked from its own list. The drafter or the engineer records it on the request; an issue that is missing what its work class or library requires is refused with what is missing. A requirement applies only to requests filed at least 15 minutes after you save it (a margin for the servers&apos; clocks) — a request already in progress shows what is missing as a warning and can still issue.
      </p>

      {problems.length > 0 && (
        <p data-testid="examination-scope-problems" role="alert" className="mb-3 text-xs font-bold text-red-700">
          {problems.length === 1 ? "One entry below needs" : `${problems.length} entries below need`} fixing — Save Changes won&apos;t save until {problems.length === 1 ? "it is" : "they are"} fixed (otherwise it would be dropped).
        </p>
      )}
      <h3 className="text-xs font-bold text-[var(--color-text)] mb-2">Data</h3>
      {scope.fields.length === 0 && <p className="text-xs text-[var(--color-text-faint)] mb-3">None configured.</p>}
      <div className="space-y-3">
        {scope.fields.map((f, i) => (
          <div key={i} className="flex flex-wrap items-start gap-2" data-testid="examination-scope-field">
            <input aria-label="Data label" className={`flex-1 min-w-[10rem] ${input}`} placeholder="Label" value={f.label}
              onChange={(e) => set({ ...scope, fields: scope.fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <input aria-label="Data key" className={`w-36 font-mono ${input}`} placeholder="Key" value={f.key}
              onChange={(e) => set({ ...scope, fields: scope.fields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
            <textarea aria-label="Choices, one per line" className={`flex-1 min-w-[12rem] h-20 ${input}`} placeholder={"Choices, one per line\nvalue | label"}
              value={optionText[i] ?? optionsToText(f.options)}
              onChange={(e) => setOptionText({ ...optionText, [i]: e.target.value })}
              onBlur={(e) => {
                set({ ...scope, fields: scope.fields.map((x, j) => (j === i ? { ...x, options: textToOptions(e.target.value) } : x)) });
                const rest = { ...optionText };
                delete rest[i];
                setOptionText(rest);
              }} />
            <button type="button" aria-label="Remove data" className="p-1 text-[var(--color-text-muted)] hover:text-red-600"
              onClick={() => set({ ...scope, fields: scope.fields.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></button>
            {f.options.length === 0 && <p className="w-full text-[11px] text-amber-700">No choices yet — a requirement on this data refuses nothing until it has some.</p>}
            {problemLines("field", i)}
          </div>
        ))}
      </div>
      <button type="button" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
        onClick={() => set({ ...scope, fields: [...scope.fields, { key: "", label: "", options: [] }] })}><Plus className="w-3.5 h-3.5" />Add data</button>

      <h3 className="text-xs font-bold text-[var(--color-text)] mt-5 mb-2">Required for</h3>
      {scope.requirements.length === 0 && <p className="text-xs text-[var(--color-text-faint)] mb-3">Nothing is required.</p>}
      <div className="space-y-2">
        {scope.requirements.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2" data-testid="examination-scope-requirement">
            <select aria-label="Required data" className={input} value={r.field}
              onChange={(e) => set({ ...scope, requirements: scope.requirements.map((x, j) => (j === i ? editRequirement(x, { field: e.target.value }) : x)) })}>
              <option value="">Pick the data…</option>
              {scope.fields.filter((f) => f.key).map((f) => <option key={f.key} value={f.key}>{f.label || f.key}</option>)}
              {r.field && !fieldKeys.has(r.field) && <option value={r.field}>{r.field} (not configured)</option>}
            </select>
            <span className="text-xs text-[var(--color-text-muted)]">for work class</span>
            <select aria-label="Work class" className={input} value={r.workClass ?? ""}
              onChange={(e) => set({ ...scope, requirements: scope.requirements.map((x, j) => (j === i ? editRequirement(x, { workClass: e.target.value }) : x)) })}>
              <option value="">any</option>
              {workClasses.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              {r.workClass && !workClasses.some((c) => c.value === r.workClass) && <option value={r.workClass}>{r.workClass}</option>}
            </select>
            <span className="text-xs text-[var(--color-text-muted)]">in library</span>
            <select aria-label="Library" className={input} value={r.libraryId ?? ""}
              onChange={(e) => set({ ...scope, requirements: scope.requirements.map((x, j) => (j === i ? editRequirement(x, { libraryId: e.target.value }) : x)) })}>
              <option value="">any</option>
              {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              {r.libraryId && !libraries.some((l) => l.id === r.libraryId) && <option value={r.libraryId}>{r.libraryId}</option>}
            </select>
            <span className="text-[11px] text-[var(--color-text-faint)]">{scopeBindsFrom(r.since) ? `applies to requests filed from ${new Date(scopeBindsFrom(r.since)!).toLocaleString()}` : "applies to requests filed after you save"}</span>
            <button type="button" aria-label="Remove requirement" className="p-1 text-[var(--color-text-muted)] hover:text-red-600"
              onClick={() => set({ ...scope, requirements: scope.requirements.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></button>
            {problemLines("requirement", i)}
          </div>
        ))}
      </div>
      <button type="button" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
        onClick={() => set({ ...scope, requirements: [...scope.requirements, { field: "" }] })}><Plus className="w-3.5 h-3.5" />Add requirement</button>
    </div>
  );
}
