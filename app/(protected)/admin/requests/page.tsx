"use client";

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { DRAFTING_CONFIG_EDITORS } from '@/lib/adminSurfaces';
import { OrgDraftingSettings, FormFieldConfig, SelectOption, CustomCategoryConfig, CustomFieldDef, CustomFieldType } from '@/types/schema';
import {
  Settings,
  Loader2,
  Plus,
  Trash2,
  Save,
  GripVertical,
  ArrowUp,
  ArrowDown
} from 'lucide-react';
import { PageShell, PageHeaderBar } from '@/components/ui/PageShell';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { appAlert, appConfirm } from '@/components/providers/DialogProvider';
import { SLA_DEFAULT_DAYS_MAX } from '@/lib/notifications';
import {
  builtInSlaDays,
  clearSlaDefault,
  loadSlaDefaults,
  parseSlaDays,
  saveSlaDefault,
  slaClockState,
  SLA_WARN_PERCENT,
  storedWindowUsable,
  untargetedImpact,
  untargetedImpactQuestion,
  warnAfterDays,
  type SlaDefaultRow,
} from '@/lib/slaDefaultsEditor';

const DEFAULT_SETTINGS: OrgDraftingSettings = {
  requestTypes: {
    label: "Request Type",
    enabled: true,
    options: [
      { label: "ISO (Isometric)", value: "ISO" },
      { label: "RFI (Info Request)", value: "RFI", closeWithoutReview: true },
      { label: "MOC (Change Mgmt)", value: "MOC" },
      { label: "As-Built", value: "ASBUILT" },
      { label: "Inspection", value: "INSPECTION" }
    ]
  },
  units: {
    label: "Unit / Area",
    enabled: true,
    options: [
      { label: "Unit 100", value: "100" },
      { label: "Unit 200", value: "200" }
    ]
  },
  priorities: {
    label: "Priority / Urgency",
    enabled: true,
    options: [
      { label: "1 - Urgent (1-2 Days)", value: 1, color: "red" },
      { label: "2 - High (1 Week)", value: 2, color: "orange" },
      { label: "3 - Normal (2 Weeks)", value: 3, color: "blue" },
      { label: "4 - Low (3 Weeks)", value: 4, color: "slate" },
      { label: "5 - Planned (1 Month)", value: 5, color: "slate" }
    ]
  }
};

export default function DraftingConfigPage() {
  const { activeOrgId } = useRole();
  const [settings, setSettings] = useState<OrgDraftingSettings | null>(null);
  // The request types as last loaded or saved (DF-P13): the due-date windows
  // are listed for these, never for an unsaved edit of the form above.
  const [savedRequestTypes, setSavedRequestTypes] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // --- ACCESS ---
  // AUTHZ-10 (drafting-flow DF-P4): no client redirect. The admin layout's
  // server gate (lib/adminGate.ts, the `requests` surface of
  // lib/adminSurfaces.ts — DRAFTING_CONFIG_EDITORS) decides who opens this
  // page, and the database's org_config_key_writes_* policies (20261209)
  // admit the same set to the save.

  // --- DATA FETCHING ---
  useEffect(() => {
    if (!activeOrgId) return;
    const loadSettings = async () => {
      setLoading(true);
      try {
        const { data } = await supabase
          .from('org_configurations')
          .select('data')
          .eq('org_id', activeOrgId)
          .eq('key', 'drafting')
          .single();
        const loaded = data ? (data.data as OrgDraftingSettings) : DEFAULT_SETTINGS;
        setSettings(loaded);
        setSavedRequestTypes(loaded.requestTypes?.options ?? []);
      } catch (e) {
        console.error("Failed to load settings:", e);
      } finally {
        setLoading(false);
      }
    };
    loadSettings();
  }, [activeOrgId]);

  const handleSave = async () => {
    if (!activeOrgId || !settings) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('org_configurations')
        .upsert({ org_id: activeOrgId, key: 'drafting', data: settings }, { onConflict: 'org_id,key' });
      if (error) throw error;
      setSavedRequestTypes(settings.requestTypes?.options ?? []);
      await appAlert("Configuration saved successfully.");
    } catch (e) {
      console.error("Save failed:", e);
      // AUTHZ-10: the database's own reason, never a generic line — a refusal
      // says who may save.
      const reason = (e as { message?: unknown })?.message;
      const refused = typeof reason === "string" && /row-level security|permission denied|42501/i.test(reason);
      await appAlert({
        message: refused
          ? `Not saved: the database refused the change (${reason}). Request forms are saved by ${DRAFTING_CONFIG_EDITORS.join(", ")}.`
          : `Not saved: ${typeof reason === "string" && reason ? reason : "the configuration could not be written"}.`,
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  // Only the three legacy sections use FormFieldConfig. customCategories is
  // managed by its own component below.
  type FormSectionKey = "requestTypes" | "units" | "priorities";

  const updateSection = (
    key: FormSectionKey,
    patch: Partial<FormFieldConfig>
  ) => {
    if (!settings) return;
    setSettings({
      ...settings,
      [key]: { ...settings[key], ...patch }
    });
  };

  const updateOption = (
    sectionKey: FormSectionKey,
    idx: number,
    field: keyof SelectOption,
    value: string | number | boolean
  ) => {
    if (!settings) return;
    const newOptions = [...settings[sectionKey].options];
    newOptions[idx] = { ...newOptions[idx], [field]: value };
    updateSection(sectionKey, { options: newOptions });
  };

  const addOption = (sectionKey: FormSectionKey) => {
    if (!settings) return;
    const newOptions = [...settings[sectionKey].options, { label: "New Option", value: "" }];
    updateSection(sectionKey, { options: newOptions });
  };

  const removeOption = (sectionKey: FormSectionKey, idx: number) => {
    if (!settings) return;
    const newOptions = settings[sectionKey].options.filter((_, i) => i !== idx);
    updateSection(sectionKey, { options: newOptions });
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!settings) return null;

  // A request type added, renamed or removed above and not yet saved: the
  // windows below follow the saved form until Save Changes.
  const typeValues = (opts: SelectOption[] | undefined) =>
    new Set((opts ?? []).map((o) => String(o.value ?? '').trim()).filter(Boolean));
  const editedTypes = typeValues(settings.requestTypes.options);
  const savedTypes = typeValues(savedRequestTypes);
  const requestTypesUnsaved = editedTypes.size !== savedTypes.size || [...editedTypes].some((v) => !savedTypes.has(v));

  return (
    <PageShell width="work">
        <PageHeaderBar
          icon={Settings}
          title="Drafting Portal Configuration"
          subtitle="Customize the request form fields for your organization."
          actions={
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </Button>
          }
        />

        <div className="space-y-8">
          
          {/* SECTION: REQUEST TYPES */}
          <ConfigSection 
            title="Request Types"
            desc="Define the categories of work available (e.g. ISO, RFI)."
            config={settings.requestTypes}
            onLabelChange={(val) => updateSection('requestTypes', { label: val })}
            onAddOption={() => addOption('requestTypes')}
            onRemoveOption={(i) => removeOption('requestTypes', i)}
            renderOption={(opt, i) => (
              <div className="flex gap-2 w-full items-center">
                <input
                  value={opt.label}
                  onChange={(e) => updateOption('requestTypes', i, 'label', e.target.value)}
                  className="flex-1 p-2 border border-[var(--color-border)] rounded text-sm"
                  placeholder="Display Label"
                />
                <input
                  value={opt.value}
                  onChange={(e) => updateOption('requestTypes', i, 'value', e.target.value)}
                  className="w-24 sm:w-32 p-2 border border-[var(--color-border)] rounded text-sm font-mono bg-[var(--color-surface-2)]"
                  placeholder="Value (ID)"
                />
                <label
                  className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] whitespace-nowrap cursor-pointer select-none"
                  title="Tickets of this type can be closed by the requester without the draft/review/IFC cycle (like an RFI answered in discussion). If no type is checked, RFI keeps this by default."
                >
                  <input
                    type="checkbox"
                    checked={opt.closeWithoutReview === true}
                    onChange={(e) => updateOption('requestTypes', i, 'closeWithoutReview', e.target.checked)}
                    className="rounded border-[var(--color-border)]"
                  />
                  Close w/o review
                </label>
                <label
                  className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] whitespace-nowrap cursor-pointer select-none"
                  title="Tickets of this type must go through engineering review before a drafter can be assigned or pick the ticket up. The assignment actions stay visible but disabled until an engineer has reviewed the scope."
                >
                  <input
                    type="checkbox"
                    checked={opt.engineeringFirst === true}
                    onChange={(e) => updateOption('requestTypes', i, 'engineeringFirst', e.target.checked)}
                    className="rounded border-[var(--color-border)]"
                  />
                  Engineering first
                </label>
              </div>
            )}
          />

          {/* SECTION: DUE-DATE WINDOWS (sla_defaults — drafting-flow DF-P13) */}
          <SlaDefaultsSection orgId={activeOrgId} requestTypes={savedRequestTypes} requestTypesUnsaved={requestTypesUnsaved} />

          {/* SECTION: UNITS */}
          <ConfigSection 
            title="Units / Areas"
            desc="Define the list of selectable plant areas or departments."
            config={settings.units}
            onLabelChange={(val) => updateSection('units', { label: val })}
            onAddOption={() => addOption('units')}
            onRemoveOption={(i) => removeOption('units', i)}
            renderOption={(opt, i) => (
              <div className="flex gap-2 w-full">
                <input 
                  value={opt.label}
                  onChange={(e) => updateOption('units', i, 'label', e.target.value)}
                  className="flex-1 p-2 border border-[var(--color-border)] rounded text-sm"
                  placeholder="Unit Name"
                />
                <input 
                  value={opt.value}
                  onChange={(e) => updateOption('units', i, 'value', e.target.value)}
                  className="w-24 sm:w-32 p-2 border border-[var(--color-border)] rounded text-sm font-mono bg-[var(--color-surface-2)]"
                  placeholder="Code"
                />
              </div>
            )}
          />

          {/* SECTION: CUSTOM CATEGORIES */}
          <CustomCategoriesSection
            categories={settings.customCategories ?? []}
            onChange={(next) => setSettings({ ...settings, customCategories: next })}
          />

          {/* SECTION: PRIORITIES */}
          <ConfigSection
            title="Priority Levels"
            desc="Define urgency levels. Value must be numeric (1 = Highest)."
            config={settings.priorities}
            onLabelChange={(val) => updateSection('priorities', { label: val })}
            onAddOption={() => addOption('priorities')}
            onRemoveOption={(i) => removeOption('priorities', i)}
            renderOption={(opt, i) => (
              <div className="flex gap-2 w-full">
                <input 
                  value={opt.label}
                  onChange={(e) => updateOption('priorities', i, 'label', e.target.value)}
                  className="flex-1 p-2 border border-[var(--color-border)] rounded text-sm"
                  placeholder="Level Description"
                />
                <input 
                  type="number"
                  value={opt.value}
                  onChange={(e) => updateOption('priorities', i, 'value', Number(e.target.value))}
                  className="w-24 p-2 border border-[var(--color-border)] rounded text-sm font-mono bg-[var(--color-surface-2)]"
                  placeholder="Level #"
                />
              </div>
            )}
          />

          {/* SECTION: REQUEST ROUTING */}
          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden">
            <div className="px-6 py-4 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
              <h3 className="font-bold text-[var(--color-text)]">Request Routing</h3>
              <p className="text-xs text-[var(--color-text-muted)]">Who gets notified when a new request needs approval or assignment.</p>
            </div>
            <div className="p-6">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!settings.routing?.adminsAlsoReceiveWhenSupervisorSet}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      routing: { ...settings.routing, adminsAlsoReceiveWhenSupervisorSet: e.target.checked },
                    })
                  }
                  className="mt-0.5 w-4 h-4 accent-slate-900"
                />
                <span className="text-sm text-[var(--color-text)]">
                  <span className="font-bold">Keep Admins notified even when a Drafting Supervisor is set</span>
                  <span className="block text-xs text-[var(--color-text-muted)] mt-1 leading-relaxed">
                    By default, once you assign someone the <b>Drafting Supervisor</b> role, new-request
                    approval &amp; assignment notifications route to them and stop hitting Admins. Turn this
                    on to keep Admins in the loop too. When no Drafting Supervisor exists, Admins always
                    receive them.
                  </span>
                </span>
              </label>
            </div>
          </div>

        </div>
    </PageShell>
  );
}

// ─── Due-date windows (sla_defaults) ─────────────────────────────────
// drafting-flow EDGE-7 done-when 2's editor / EDGE-16 (DF-P13). One window
// per request type: the days a request filed without a requested date has
// before it is due (/api/tickets/create), and the window the SLA clock gives
// an open request of the type that has no due date of its own. Each save is
// its own checked write (lib/slaDefaultsEditor.ts), validated to the create
// route's own bound; a refusal shows the database's words. The admin gate
// holds this page to DRAFTING_CONFIG_EDITORS, and 20261218 makes the same set
// the database's write rule.

type SlaLoadState =
  | { kind: "loading" }
  | { kind: "ready"; rows: SlaDefaultRow[] }
  | { kind: "error"; missing: boolean; error: string };

function SlaDefaultsSection({ orgId, requestTypes, requestTypesUnsaved }: { orgId: string | null; requestTypes: SelectOption[]; requestTypesUnsaved: boolean }) {
  const [load, setLoad] = useState<SlaLoadState>({ kind: "loading" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: string; tone: "ok" | "error"; text: string } | null>(null);

  // quiet: re-read after a save without blanking the list.
  const refresh = React.useCallback(async (quiet = false) => {
    if (!orgId) return;
    if (!quiet) setLoad({ kind: "loading" });
    const r = await loadSlaDefaults(supabase, orgId);
    setLoad(r.ok ? { kind: "ready", rows: r.rows } : { kind: "error", missing: r.missing, error: r.error });
  }, [orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // The request types on the SAVED form (blank values skipped, each once),
  // then any stored window whose type is no longer on it, so it can be
  // removed. An unsaved edit of the form never adds or renames a row here.
  const formTypes: Array<{ value: string; label: string; onForm: boolean }> = [];
  for (const o of requestTypes) {
    const value = String(o.value ?? '').trim();
    if (value && !formTypes.some((t) => t.value === value)) formTypes.push({ value, label: o.label || value, onForm: true });
  }
  const rows = load.kind === "ready" ? load.rows : [];
  for (const r of rows) {
    if (!formTypes.some((t) => t.value === r.requestType)) formTypes.push({ value: r.requestType, label: r.requestType, onForm: false });
  }
  const rowFor = (type: string) => rows.find((r) => r.requestType === type) ?? null;

  const save = async (type: string, label: string) => {
    if (!orgId) return;
    const parsed = parseSlaDays(drafts[type] ?? '');
    if (!parsed.ok) return;
    setBusy(type);
    setNotice(null);
    try {
      const impact = await untargetedImpact(supabase, orgId, type, parsed.days);
      if (!impact.ok || impact.impact.overdue + impact.impact.dueSoon > 0) {
        // What happens to them depends on whether the SLA clock has started
        // (20261195) — read as the clock's own gate reads it.
        const message = untargetedImpactQuestion(label, parsed.days, impact, await slaClockState(supabase));
        if (message) {
          const go = await appConfirm({ title: "Save this window?", message, confirmLabel: "Save window", tone: "danger" });
          if (!go) return;
        }
      }
      const w = await saveSlaDefault(supabase, orgId, type, parsed.days);
      if (!w.ok) {
        setNotice({ type, tone: "error", text: w.message });
        return;
      }
      setDrafts((d) => { const next = { ...d }; delete next[type]; return next; });
      setNotice({ type, tone: "ok", text: `Saved: ${label} requests filed without a requested date are due ${parsed.days} day(s) after filing.` });
      await refresh(true);
    } finally {
      setBusy(null);
    }
  };

  const clear = async (type: string, label: string) => {
    if (!orgId) return;
    const go = await appConfirm({
      title: "Use the built-in window?",
      message: `New ${label} requests will be due ${builtInSlaDays(type)} day(s) after filing (the built-in window), and the SLA clock stops timing open ${label} requests that have no due date of their own.`,
      confirmLabel: "Use built-in",
    });
    if (!go) return;
    setBusy(type);
    setNotice(null);
    try {
      const w = await clearSlaDefault(supabase, orgId, type);
      if (!w.ok) {
        setNotice({ type, tone: "error", text: w.message });
        return;
      }
      setDrafts((d) => { const next = { ...d }; delete next[type]; return next; });
      setNotice({ type, tone: "ok", text: `${label} uses the built-in window again (${builtInSlaDays(type)} day(s)).` });
      await refresh(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden" data-testid="sla-defaults">
      <div className="px-6 py-4 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
        <h3 className="font-bold text-[var(--color-text)]">Due-date windows</h3>
        <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
          Per request type: how many days a request filed without a requested date has before it is due (at 17:00 on the last day).
          The SLA clock warns the person a request waits on at {SLA_WARN_PERCENT}% of its window and escalates at the due date.
          Open requests of a type that have no due date of their own are timed from their filing date with the same window.
          Each type is saved on its own; a type with no window uses the built-in one.
        </p>
        {requestTypesUnsaved && (
          <p role="status" className="mt-1 text-xs text-amber-700">
            The request types above have unsaved changes. These windows follow the saved request form: save it (Save Changes) to set a window for a new or renamed type.
          </p>
        )}
      </div>
      <div className="p-6">
        {!orgId || load.kind === "loading" ? (
          <div className="text-xs text-[var(--color-text-muted)]">Loading due-date windows…</div>
        ) : load.kind === "error" ? (
          <div role="alert" className="text-xs text-rose-700">
            {load.missing
              ? "Due-date windows need the sla_defaults table (migration 20260529_phase_b_notifications.sql) — nothing can be edited here until it is applied."
              : `The due-date windows could not be read (${load.error}). Nothing is shown as saved.`}
            {!load.missing && (
              <button onClick={() => void refresh()} className="ml-2 font-bold underline">Retry</button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {formTypes.length === 0 && (
              <div className="text-xs italic text-[var(--color-text-muted)]">No request types on the form yet.</div>
            )}
            {formTypes.map((t) => {
              const row = rowFor(t.value);
              const usable = row ? storedWindowUsable(row.defaultDays) : false;
              const draft = drafts[t.value];
              const parsed = draft === undefined ? null : parseSlaDays(draft);
              const changed = parsed?.ok === true && (!row || row.defaultDays !== parsed.days);
              const inputId = `sla-days-${t.value}`;
              return (
                <div key={t.value} className="flex flex-wrap items-start gap-2" data-sla-type={t.value}>
                  <label htmlFor={inputId} className="w-40 shrink-0 pt-2 text-sm text-[var(--color-text)]">
                    <span className="font-bold">{t.label}</span>{' '}
                    <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{t.value}</span>
                    {!t.onForm && <span className="block text-[11px] text-amber-700">not on the request form</span>}
                  </label>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <input
                        id={inputId}
                        inputMode="numeric"
                        aria-label={`Due-date window in days for ${t.label}`}
                        aria-invalid={parsed !== null && !parsed.ok}
                        value={draft ?? (row && usable ? String(row.defaultDays) : '')}
                        placeholder={`Built-in: ${builtInSlaDays(t.value)}`}
                        onChange={(e) => setDrafts((d) => ({ ...d, [t.value]: e.target.value }))}
                        className="w-28 p-2 border border-[var(--color-border)] rounded text-sm font-mono"
                      />
                      <span className="text-xs text-[var(--color-text-muted)]">days (1–{SLA_DEFAULT_DAYS_MAX})</span>
                      <Button size="sm" onClick={() => void save(t.value, t.label)} disabled={!changed || busy !== null} loading={busy === t.value}>
                        Save
                      </Button>
                      {row && (
                        <Button size="sm" variant="secondary" onClick={() => void clear(t.value, t.label)} disabled={busy !== null}>
                          Use built-in
                        </Button>
                      )}
                    </div>
                    {parsed !== null && !parsed.ok && (
                      <div role="alert" className="text-[11px] text-rose-700">{parsed.error}</div>
                    )}
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {!row
                        ? `Built-in window: ${builtInSlaDays(t.value)} day(s).`
                        : usable
                          ? `Saved: ${row.defaultDays} day(s) — the clock warns after ${warnAfterDays(row.defaultDays)} day(s).`
                          : null}
                    </div>
                    {row && !usable && (
                      <div role="alert" className="text-[11px] text-amber-700">
                        The stored window ({String(row.defaultDays)}) is outside 1–{SLA_DEFAULT_DAYS_MAX} days: new requests use the built-in {builtInSlaDays(t.value)} day(s).
                        {row.defaultDays > 0 && ` The SLA clock does not apply this bound yet: until the window is corrected, it still reads the stored value for open ${t.label} requests with no due date of their own.`}
                        {' '}Enter a window, or use the built-in one.
                      </div>
                    )}
                    {notice && notice.type === t.value && (
                      <div role={notice.tone === "error" ? "alert" : "status"} className={`text-[11px] ${notice.tone === "error" ? "text-rose-700" : "text-emerald-700"}`}>
                        {notice.text}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigSection({
  title, 
  desc, 
  config, 
  onLabelChange, 
  onAddOption, 
  onRemoveOption,
  renderOption
}: {
  title: string;
  desc: string;
  config: FormFieldConfig;
  onLabelChange: (val: string) => void;
  onAddOption: () => void;
  onRemoveOption: (idx: number) => void;
  renderOption: (opt: SelectOption, idx: number) => React.ReactNode;
}) {
  return (
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden">
      <div className="px-6 py-4 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] flex justify-between items-center">
        <div>
          <h3 className="font-bold text-[var(--color-text)]">{title}</h3>
          <p className="text-xs text-[var(--color-text-muted)]">{desc}</p>
        </div>
      </div>
      <div className="p-6">
        <div className="mb-6">
          <label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase mb-2">Form Label</label>
          <Input
            value={config.label}
            onChange={(e) => onLabelChange(e.target.value)}
            className="font-bold"
          />
        </div>
        
        <label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase mb-2">Dropdown Options</label>
        <div className="space-y-2">
          {config.options.map((opt, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <GripVertical className="w-4 h-4 text-slate-300 cursor-move" />
              {renderOption(opt, i)}
              <button 
                onClick={() => onRemoveOption(i)}
                className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={onAddOption}
          className="mt-4 flex items-center text-xs font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
        >
          <Plus className="w-4 h-4 mr-1" /> Add Option
        </button>
      </div>
    </div>
  );
}

// ─── Custom Categories editor ─────────────────────────────────────────
// Admin-defined top-level sections beyond Request Type / Unit / Priority.
// Each category renders as its own card in /requests/new and stores values
// at ticket.metadata.custom_categories[category.id][field.key].

function CustomCategoriesSection({
  categories,
  onChange,
}: {
  categories: CustomCategoryConfig[];
  onChange: (next: CustomCategoryConfig[]) => void;
}) {
  const addCategory = () => {
    const id = `cat_${Date.now().toString(36)}`;
    onChange([...categories, { id, label: "New category", description: "", enabled: true, fields: [] }]);
  };
  const updateCategory = (idx: number, patch: Partial<CustomCategoryConfig>) => {
    onChange(categories.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const removeCategory = async (idx: number) => {
    if (!(await appConfirm({ message: `Remove "${categories[idx].label}" and all its fields? Tickets created before today keep their stored values.`, tone: "danger" }))) return;
    onChange(categories.filter((_, i) => i !== idx));
  };
  const moveCategory = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= categories.length) return;
    const next = [...categories];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden">
      <div className="px-6 py-4 bg-violet-50 border-b border-violet-100 flex flex-wrap justify-between items-center gap-3">
        <div>
          <h3 className="font-bold text-[var(--color-text)]">Custom Categories</h3>
          <p className="text-xs text-[var(--color-text-muted)]">
            Add sections with your own fields so requesters can capture
            org-specific context (e.g. <i>Inspection Type</i>, <i>Equipment Tag</i>,
            <i> MOC Phase</i>). Each section becomes its own card on the request form.
          </p>
        </div>
        <button
          onClick={addCategory}
          className="inline-flex items-center px-3 py-2 rounded-lg text-xs font-black text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5 mr-1" /> Add Category
        </button>
      </div>
      <div className="p-6 space-y-6">
        {categories.length === 0 && (
          <div className="text-xs italic text-[var(--color-text-muted)]">No custom categories yet. Click <b>Add Category</b> above.</div>
        )}
        {categories.map((cat, idx) => (
          <CategoryCard
            key={cat.id}
            cat={cat}
            canMoveUp={idx > 0}
            canMoveDown={idx < categories.length - 1}
            onChange={(patch) => updateCategory(idx, patch)}
            onRemove={() => removeCategory(idx)}
            onMoveUp={() => moveCategory(idx, -1)}
            onMoveDown={() => moveCategory(idx, 1)}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryCard({
  cat, onChange, onRemove, onMoveUp, onMoveDown, canMoveUp, canMoveDown,
}: {
  cat: CustomCategoryConfig;
  onChange: (patch: Partial<CustomCategoryConfig>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const addField = () => {
    const key = `field_${Date.now().toString(36)}`;
    onChange({ fields: [...cat.fields, { key, label: "New field", type: "text" }] });
  };
  const updateField = (idx: number, patch: Partial<CustomFieldDef>) => {
    onChange({ fields: cat.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)) });
  };
  const removeField = (idx: number) => {
    onChange({ fields: cat.fields.filter((_, i) => i !== idx) });
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-[var(--color-surface-2)] flex items-center gap-2 flex-wrap">
        <input
          value={cat.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="flex-1 min-w-[140px] px-2 py-1 border border-[var(--color-border)] rounded text-sm font-bold text-[var(--color-text)] focus:ring-2 focus:ring-violet-500 outline-none"
          placeholder="Category label"
        />
        <label className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
          <input type="checkbox" checked={cat.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} className="accent-[var(--color-accent)]" />
          Enabled
        </label>
        <button onClick={onMoveUp} disabled={!canMoveUp} className="p-1.5 rounded hover:bg-slate-200 disabled:opacity-30 transition-colors"><ArrowUp className="w-3.5 h-3.5" /></button>
        <button onClick={onMoveDown} disabled={!canMoveDown} className="p-1.5 rounded hover:bg-slate-200 disabled:opacity-30 transition-colors"><ArrowDown className="w-3.5 h-3.5" /></button>
        <button onClick={onRemove} className="p-1.5 rounded text-[var(--color-text-faint)] hover:text-red-600 hover:bg-red-50 transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="px-4 py-3 space-y-2">
        <input
          value={cat.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Optional description shown under the section header"
          className="w-full px-2 py-1 border border-[var(--color-border)] rounded text-xs text-[var(--color-text)]"
        />
        <div className="space-y-2 mt-2">
          {cat.fields.length === 0 && <div className="text-[11px] italic text-[var(--color-text-faint)]">No fields yet — add one below.</div>}
          {cat.fields.map((f, i) => (
            <FieldEditor key={f.key} field={f} onChange={(patch) => updateField(i, patch)} onRemove={() => removeField(i)} />
          ))}
        </div>
        <button onClick={addField} className="mt-1 inline-flex items-center text-[11px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors">
          <Plus className="w-3.5 h-3.5 mr-1" /> Add Field
        </button>
      </div>
    </div>
  );
}

const FIELD_TYPES: Array<{ value: CustomFieldType; label: string }> = [
  { value: "text", label: "Single line" },
  { value: "textarea", label: "Paragraph" },
  { value: "number", label: "Number" },
  { value: "select", label: "Choice" },
  { value: "multiselect", label: "Multi-choice" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Yes / No" },
];

function FieldEditor({
  field, onChange, onRemove,
}: {
  field: CustomFieldDef;
  onChange: (patch: Partial<CustomFieldDef>) => void;
  onRemove: () => void;
}) {
  const isChoice = field.type === "select" || field.type === "multiselect";
  return (
    <div className="border border-[var(--color-border)] rounded-md p-2 bg-[var(--color-surface)]">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Field label"
          className="flex-1 min-w-[120px] px-2 py-1 border border-[var(--color-border)] rounded text-xs font-bold"
        />
        <select
          value={field.type}
          onChange={(e) => onChange({ type: e.target.value as CustomFieldType, options: e.target.value === "select" || e.target.value === "multiselect" ? (field.options || []) : undefined })}
          className="px-2 py-1 border border-[var(--color-border)] rounded text-xs bg-[var(--color-surface)]"
        >
          {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
          <input type="checkbox" checked={!!field.required} onChange={(e) => onChange({ required: e.target.checked })} className="accent-[var(--color-accent)]" />
          Required
        </label>
        <button onClick={onRemove} className="p-1 rounded text-[var(--color-text-faint)] hover:text-red-600 hover:bg-red-50 transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {(field.type === "text" || field.type === "textarea" || field.type === "number") && (
        <input
          value={field.placeholder ?? ""}
          onChange={(e) => onChange({ placeholder: e.target.value })}
          placeholder="Placeholder (optional)"
          className="mt-2 w-full px-2 py-1 border border-[var(--color-border)] rounded text-[11px] text-[var(--color-text-muted)]"
        />
      )}
      <input
        value={field.description ?? ""}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="Help text (optional)"
        className="mt-2 w-full px-2 py-1 border border-[var(--color-border)] rounded text-[11px] text-[var(--color-text-muted)]"
      />
      {isChoice && (
        <div className="mt-2 space-y-1">
          <div className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Choices</div>
          {(field.options ?? []).map((opt, oi) => (
            <div key={oi} className="flex gap-1 items-center">
              <input
                value={opt.label}
                onChange={(e) => {
                  const next = [...(field.options ?? [])];
                  next[oi] = { ...next[oi], label: e.target.value };
                  onChange({ options: next });
                }}
                placeholder="Display label"
                className="flex-1 px-2 py-1 border border-[var(--color-border)] rounded text-[11px]"
              />
              <input
                value={String(opt.value)}
                onChange={(e) => {
                  const next = [...(field.options ?? [])];
                  next[oi] = { ...next[oi], value: e.target.value };
                  onChange({ options: next });
                }}
                placeholder="Stored value"
                className="w-24 sm:w-32 px-2 py-1 border border-[var(--color-border)] rounded text-[11px] font-mono bg-[var(--color-surface-2)]"
              />
              <button
                onClick={() => onChange({ options: (field.options ?? []).filter((_, j) => j !== oi) })}
                className="p-1 text-[var(--color-text-faint)] hover:text-red-600 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          <button
            onClick={() => onChange({ options: [...(field.options ?? []), { label: "Option", value: "" }] })}
            className="text-[10px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors inline-flex items-center"
          >
            <Plus className="w-3 h-3 mr-1" /> Add Choice
          </button>
        </div>
      )}
    </div>
  );
}
