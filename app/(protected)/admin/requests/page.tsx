"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { OrgDraftingSettings, FormFieldConfig, SelectOption, CustomCategoryConfig, CustomFieldDef, CustomFieldType } from '@/types/schema';
import {
  Loader2,
  Plus,
  Trash2,
  Save,
  GripVertical,
  ArrowUp,
  ArrowDown
} from 'lucide-react';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody, heroPrimary } from '@/components/ui/PageHero';
import { plural } from '@/components/admin/band';
import { Input } from '@/components/ui/Field';
import LoadingBlock from '@/components/ui/LoadingBlock';
import { appAlert, appConfirm } from '@/components/providers/DialogProvider';

const DEFAULT_SETTINGS: OrgDraftingSettings = {
  requestTypes: {
    label: "Request Type",
    enabled: true,
    options: [
      { label: "ISO (Isometric)", value: "ISO" },
      { label: "RFI (Info Request)", value: "RFI" },
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
      { label: "1: Urgent (1-2 days)", value: 1, color: "red" },
      { label: "2: High (1 week)", value: 2, color: "orange" },
      { label: "3: Normal (2 weeks)", value: 3, color: "blue" },
      { label: "4: Low (3 weeks)", value: 4, color: "slate" },
      { label: "5: Planned (1 month)", value: 5, color: "slate" }
    ]
  }
};

export default function DraftingConfigPage() {
  const router = useRouter();
  const { activeRole, activeOrgId } = useRole();
  const [settings, setSettings] = useState<OrgDraftingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // --- ACCESS GUARD ---
  useEffect(() => {
    if (activeRole && !['Admin', 'DocCtrl'].includes(activeRole)) {
      router.push('/dashboard');
    }
  }, [activeRole, router]);

  // --- DATA FETCHING ---
  useEffect(() => {
    if (!activeOrgId) return;
    const loadSettings = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        // A failed read must not fall back to the defaults: saving those
        // would overwrite the real form.
        const { data, error } = await supabase
          .from('org_configurations')
          .select('data')
          .eq('org_id', activeOrgId)
          .eq('key', 'drafting')
          .maybeSingle();
        if (error) throw error;
        setSettings(data ? (data.data as OrgDraftingSettings) : DEFAULT_SETTINGS);
      } catch (e) {
        console.error("Failed to load settings:", e);
        setLoadError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? "Couldn't load the form settings."));
      } finally {
        setLoading(false);
      }
    };
    loadSettings();
  }, [activeOrgId, reloadTick]);

  const handleSave = async () => {
    if (!activeOrgId || !settings) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('org_configurations')
        .upsert({ org_id: activeOrgId, key: 'drafting', data: settings }, { onConflict: 'org_id,key' });
      if (error) throw error;
      await appAlert("Configuration saved successfully.");
    } catch (e) {
      console.error("Save failed:", e);
      await appAlert({ title: "Couldn't save the form settings", message: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? "Try again."), tone: "danger" });
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
    value: string | number
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
    return <PageShell width="work"><PageHero kicker="Admin · Request forms" title="Request forms" overlap={false} /><LoadingBlock what="the request form settings" /></PageShell>;
  }

  if (!settings) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Request forms" title="Couldn't load the form settings." overlap={false} />
        <p role="alert" className="px-1 text-[14px] text-red-700 dark:text-red-400">
          Couldn&apos;t load the request form settings{loadError ? `: ${loadError}` : "."}{" "}
          <button type="button" onClick={() => setReloadTick((n) => n + 1)} className="font-bold underline">Try again</button>
        </p>
      </PageShell>
    );
  }

  const extra = (settings.customCategories ?? []).length;
  const answer = `${plural(settings.requestTypes.options.length, "request type")}, ${plural(settings.units.options.length, "unit")}.`;

  return (
    <PageShell width="work">
        <PageHero
          kicker="Admin · Request forms"
          title={answer}
          sub={<>{plural(settings.priorities.options.length, "priority level")}{extra > 0 ? `, ${plural(extra, "custom section")}` : ""}. What a drafting request asks for; changes apply to new requests once saved.</>}
          primary={
            <button type="button" onClick={handleSave} disabled={saving} className={heroPrimary}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save changes
            </button>
          }
        />

        <PageBody>

          {/* SECTION: REQUEST TYPES */}
          <ConfigSection 
            title="Request types"
            desc="Define the categories of work available (e.g. ISO, RFI)."
            config={settings.requestTypes}
            onLabelChange={(val) => updateSection('requestTypes', { label: val })}
            onAddOption={() => addOption('requestTypes')}
            onRemoveOption={(i) => removeOption('requestTypes', i)}
            renderOption={(opt, i) => (
              <div className="flex gap-2 flex-1 min-w-0">
                <input 
                  value={opt.label}
                  onChange={(e) => updateOption('requestTypes', i, 'label', e.target.value)}
                  className="flex-1 min-w-0 h-10 px-2.5 border border-[var(--color-border)] rounded-lg text-[14px]"
                  placeholder="Display label"
                  aria-label="Display label"
                />
                <input 
                  value={opt.value}
                  onChange={(e) => updateOption('requestTypes', i, 'value', e.target.value)}
                  className="w-20 sm:w-32 shrink-0 h-10 px-2.5 border border-[var(--color-border)] rounded-lg text-[13px] font-mono bg-[var(--color-surface-2)]"
                  placeholder="Value (ID)"
                  aria-label="Value (ID)"
                />
              </div>
            )}
          />

          {/* SECTION: UNITS */}
          <ConfigSection 
            title="Units and areas"
            desc="Define the list of selectable plant areas or departments."
            config={settings.units}
            onLabelChange={(val) => updateSection('units', { label: val })}
            onAddOption={() => addOption('units')}
            onRemoveOption={(i) => removeOption('units', i)}
            renderOption={(opt, i) => (
              <div className="flex gap-2 flex-1 min-w-0">
                <input 
                  value={opt.label}
                  onChange={(e) => updateOption('units', i, 'label', e.target.value)}
                  className="flex-1 min-w-0 h-10 px-2.5 border border-[var(--color-border)] rounded-lg text-[14px]"
                  placeholder="Unit name"
                  aria-label="Unit name"
                />
                <input 
                  value={opt.value}
                  onChange={(e) => updateOption('units', i, 'value', e.target.value)}
                  className="w-20 sm:w-32 shrink-0 h-10 px-2.5 border border-[var(--color-border)] rounded-lg text-[13px] font-mono bg-[var(--color-surface-2)]"
                  placeholder="Code"
                  aria-label="Code"
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
            title="Priority levels"
            desc="Define urgency levels. Value must be numeric (1 = Highest)."
            config={settings.priorities}
            onLabelChange={(val) => updateSection('priorities', { label: val })}
            onAddOption={() => addOption('priorities')}
            onRemoveOption={(i) => removeOption('priorities', i)}
            renderOption={(opt, i) => (
              <div className="flex gap-2 flex-1 min-w-0">
                <input 
                  value={opt.label}
                  onChange={(e) => updateOption('priorities', i, 'label', e.target.value)}
                  className="flex-1 min-w-0 h-10 px-2.5 border border-[var(--color-border)] rounded-lg text-[14px]"
                  placeholder="Level description"
                  aria-label="Level description"
                />
                <input 
                  type="number"
                  value={opt.value}
                  onChange={(e) => updateOption('priorities', i, 'value', Number(e.target.value))}
                  className="w-20 shrink-0 h-10 px-2.5 border border-[var(--color-border)] rounded-lg text-[13px] font-mono bg-[var(--color-surface-2)]"
                  placeholder="Level number"
                  aria-label="Level number"
                />
              </div>
            )}
          />

          {/* SECTION: REQUEST ROUTING */}
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] overflow-hidden">
            <div className="px-5 sm:px-6 pt-5 pb-3 border-b border-[var(--color-border)]">
              <h3 className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Request routing</h3>
              <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">Who gets notified when a new request needs approval or assignment.</p>
            </div>
            <div className="p-5 sm:p-6">
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
                  className="mt-0.5 w-4 h-4 accent-[var(--color-text)]"
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

        </PageBody>
    </PageShell>
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
    <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] overflow-hidden">
      <div className="px-5 sm:px-6 pt-5 pb-3 border-b border-[var(--color-border)] flex justify-between items-center">
        <div>
          <h3 className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">{title}</h3>
          <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{desc}</p>
        </div>
      </div>
      <div className="p-5 sm:p-6">
        <div className="mb-6">
          <label className="block text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.12em] mb-2">Form label</label>
          <Input
            value={config.label}
            onChange={(e) => onLabelChange(e.target.value)}
            className="font-bold"
          />
        </div>
        
        <label className="block text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.12em] mb-2">Dropdown options</label>
        <div className="space-y-2">
          {config.options.map((opt, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <GripVertical className="w-4 h-4 text-[var(--color-text-faint)] cursor-move shrink-0 max-sm:hidden" />
              {renderOption(opt, i)}
              <button 
                type="button"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => onRemoveOption(i)}
                className="p-2 text-[var(--color-text-faint)] hover:text-red-500 hover:bg-[var(--color-surface-2)] rounded transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onAddOption}
          className="mt-4 flex items-center text-[13px] font-bold text-[var(--color-text)] hover:underline transition-colors"
        >
          <Plus className="w-4 h-4 mr-1" /> Add option
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
    <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] overflow-hidden">
      <div className="px-5 sm:px-6 pt-5 pb-3 border-b border-[var(--color-border)] flex flex-wrap justify-between items-center gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Custom categories</h3>
          <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
            Add sections with your own fields so requesters can capture
            org-specific context (e.g. <i>Inspection Type</i>, <i>Equipment Tag</i>,
            <i> MOC Phase</i>). Each section becomes its own card on the request form.
          </p>
        </div>
        <button
          type="button"
          onClick={addCategory}
          className="inline-flex items-center h-9 px-3 rounded-lg text-[13px] font-semibold text-[var(--color-text)] border border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5 mr-1" /> Add category
        </button>
      </div>
      <div className="p-5 sm:p-6 space-y-6">
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
          className="flex-1 min-w-[140px] px-2 py-1 border border-[var(--color-border)] rounded text-sm font-bold text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
          placeholder="Category label"
        />
        <label className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
          <input type="checkbox" checked={cat.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} className="accent-[var(--color-text)]" />
          Enabled
        </label>
        <button onClick={onMoveUp} disabled={!canMoveUp} className="p-1.5 rounded hover:bg-[var(--color-surface-2)] disabled:opacity-30 transition-colors"><ArrowUp className="w-3.5 h-3.5" /></button>
        <button onClick={onMoveDown} disabled={!canMoveDown} className="p-1.5 rounded hover:bg-[var(--color-surface-2)] disabled:opacity-30 transition-colors"><ArrowDown className="w-3.5 h-3.5" /></button>
        <button onClick={onRemove} className="p-1.5 rounded text-[var(--color-text-faint)] hover:text-red-600 hover:bg-[var(--color-surface-2)] transition-colors">
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
          {cat.fields.length === 0 && <div className="text-[11px] italic text-[var(--color-text-faint)]">No fields yet. Add one below.</div>}
          {cat.fields.map((f, i) => (
            <FieldEditor key={f.key} field={f} onChange={(patch) => updateField(i, patch)} onRemove={() => removeField(i)} />
          ))}
        </div>
        <button type="button" onClick={addField} className="mt-1 inline-flex items-center text-[13px] font-bold text-[var(--color-text)] hover:underline transition-colors">
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
        <label className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
          <input type="checkbox" checked={!!field.required} onChange={(e) => onChange({ required: e.target.checked })} className="accent-[var(--color-text)]" />
          Required
        </label>
        <button onClick={onRemove} className="p-1 rounded text-[var(--color-text-faint)] hover:text-red-600 hover:bg-[var(--color-surface-2)] transition-colors">
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
          <div className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Choices</div>
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
            className="text-[11px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors inline-flex items-center"
          >
            <Plus className="w-3 h-3 mr-1" /> Add Choice
          </button>
        </div>
      )}
    </div>
  );
}
