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
import { sheet, field, fieldBox, btnIcon, btnRow, btnQuiet, FormRow, Section, Problem } from '@/components/admin/kit';
import HelpTooltip from '@/components/ui/HelpTooltip';

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
        <Problem className="mt-6" retry={() => setReloadTick((n) => n + 1)}>Couldn&apos;t load the request form settings{loadError ? `: ${loadError}` : "."}</Problem>
      </PageShell>
    );
  }

  const extra = (settings.customCategories ?? []).length;
  const answer = "What a request asks for.";

  return (
    <PageShell width="work">
        <PageHero
          kicker="Admin · Request forms"
          title={answer}
          sub={`The drafting request form${extra > 0 ? `, with ${extra} custom section${extra === 1 ? "" : "s"}` : ""}. Changes apply to new requests once saved.`}
          facts={[
            { label: "Request types", value: settings.requestTypes.options.length },
            { label: "Units", value: settings.units.options.length },
            { label: "Priorities", value: settings.priorities.options.length },
          ]}
          primary={
            <button type="button" onClick={handleSave} disabled={saving} className={heroPrimary}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save changes
            </button>
          }
        />

        <PageBody>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-6 gap-y-8 items-start">
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
                  className={`${fieldBox} h-10 text-[15px] flex-1 min-w-0`}
                  placeholder="Display label"
                  aria-label="Display label"
                />
                <input 
                  value={opt.value}
                  onChange={(e) => updateOption('requestTypes', i, 'value', e.target.value)}
                  className={`${fieldBox} h-10 text-[15px] w-24 sm:w-36 shrink-0 tabular-nums`}
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
                  className={`${fieldBox} h-10 text-[15px] flex-1 min-w-0`}
                  placeholder="Unit name"
                  aria-label="Unit name"
                />
                <input 
                  value={opt.value}
                  onChange={(e) => updateOption('units', i, 'value', e.target.value)}
                  className={`${fieldBox} h-10 text-[15px] w-24 sm:w-36 shrink-0 tabular-nums`}
                  placeholder="Code"
                  aria-label="Code"
                />
              </div>
            )}
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
                  className={`${fieldBox} h-10 text-[15px] flex-1 min-w-0`}
                  placeholder="Level description"
                  aria-label="Level description"
                />
                <input 
                  type="number"
                  value={opt.value}
                  onChange={(e) => updateOption('priorities', i, 'value', Number(e.target.value))}
                  className={`${fieldBox} h-10 text-[15px] w-24 shrink-0 tabular-nums`}
                  placeholder="Level number"
                  aria-label="Level number"
                />
              </div>
            )}
          />

          {/* SECTION: REQUEST ROUTING */}
          <Section label="Request routing">
            <div className={sheet}>
              <label className="flex items-start gap-3 cursor-pointer px-4 sm:px-5 py-4">
                <input
                  type="checkbox"
                  checked={!!settings.routing?.adminsAlsoReceiveWhenSupervisorSet}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      routing: { ...settings.routing, adminsAlsoReceiveWhenSupervisorSet: e.target.checked },
                    })
                  }
                  className="mt-1 w-4 h-4 accent-[var(--color-text)]"
                />
                <span>
                  <span className="block text-[15px] font-semibold text-[var(--color-text)]">Keep Admins notified when a Drafting Supervisor is set</span>
                  <span className="block text-[14px] text-[var(--color-text-muted)] mt-0.5">Otherwise new-request notices go only to the Drafting Supervisor. With no supervisor, Admins always get them.</span>
                </span>
              </label>
            </div>
          </Section>
          </div>

          {/* SECTION: CUSTOM CATEGORIES */}
          <CustomCategoriesSection
            categories={settings.customCategories ?? []}
            onChange={(next) => setSettings({ ...settings, customCategories: next })}
          />

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
    <Section label={title} action={<span className="text-[13px] text-[var(--color-text-muted)] max-sm:hidden">{desc}</span>}>
      <div className={sheet}>
        <FormRow label="Form label" htmlFor={`label-${title}`}>
          <input id={`label-${title}`} value={config.label} onChange={(e) => onLabelChange(e.target.value)} className={`${field} font-semibold`} />
        </FormRow>
        <div className="border-t border-[var(--color-border)] px-4 sm:px-5 pt-3 pb-4">
          <div className="flex items-center gap-2 pb-1.5 text-[13px] font-semibold text-[var(--color-text-muted)]">
            <span className="w-4 shrink-0 max-sm:hidden" />
            <span className="flex-1">Shown as</span>
            <span className="w-24 sm:w-36 shrink-0">Stored as</span>
            <span className="w-8 shrink-0" />
          </div>
          <div className="space-y-2">
            {config.options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2 group">
                <GripVertical className="w-4 h-4 text-[var(--color-text-faint)] cursor-move shrink-0 max-sm:hidden" />
                {renderOption(opt, i)}
                <button type="button" aria-label={`Remove option ${i + 1}`} onClick={() => onRemoveOption(i)} className={`${btnIcon} hover:text-[var(--state-overdue)]`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={onAddOption} className={`${btnRow} mt-3`}>
            <Plus className="w-3.5 h-3.5" /> Add option
          </button>
        </div>
      </div>
    </Section>
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
    <Section label={<span className="inline-flex items-center gap-2">Custom sections <HelpTooltip>Sections with your own fields (for example Inspection type, Equipment tag, MOC phase). Each one becomes its own section on the request form.</HelpTooltip></span>}
      action={<button type="button" onClick={addCategory} className={btnQuiet}><Plus className="w-3.5 h-3.5" /> Add section</button>}>
      <div className="space-y-4">
        {categories.length === 0 && (
          <div className={`${sheet} px-4 py-6 text-center text-[15px] text-[var(--color-text-muted)]`}>No custom sections yet.</div>
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
    </Section>
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
    <div className={`${sheet} overflow-hidden`}>
      <div className="px-4 py-3 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <input
          value={cat.label}
          onChange={(e) => onChange({ label: e.target.value })}
          aria-label="Section name"
          className={`${fieldBox} h-10 text-[15px] flex-1 min-w-[160px] font-semibold`}
          placeholder="Section name"
        />
        <label className="inline-flex items-center gap-1.5 text-[14px] text-[var(--color-text)] px-1">
          <input type="checkbox" checked={cat.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} className="w-4 h-4 accent-[var(--color-text)]" />
          Shown on the form
        </label>
        <button type="button" onClick={onMoveUp} disabled={!canMoveUp} aria-label="Move up" className={btnIcon}><ArrowUp className="w-4 h-4" /></button>
        <button type="button" onClick={onMoveDown} disabled={!canMoveDown} aria-label="Move down" className={btnIcon}><ArrowDown className="w-4 h-4" /></button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${cat.label}`} className={`${btnIcon} hover:text-[var(--state-overdue)]`}>
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      <div className="px-4 py-3 space-y-2">
        <input
          value={cat.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value })}
          aria-label="Description"
          placeholder="Description under the section name (optional)"
          className={field}
        />
        <div className="space-y-2 mt-2">
          {cat.fields.length === 0 && <div className="text-[14px] text-[var(--color-text-muted)]">No fields yet.</div>}
          {cat.fields.map((f, i) => (
            <FieldEditor key={f.key} field={f} onChange={(patch) => updateField(i, patch)} onRemove={() => removeField(i)} />
          ))}
        </div>
        <button type="button" onClick={addField} className={`${btnRow} mt-1`}>
          <Plus className="w-3.5 h-3.5" /> Add field
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
    <div className="border border-[var(--color-border)] rounded-md p-3 bg-[var(--color-surface)]">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Field label"
          aria-label="Field label"
          className={`${fieldBox} h-10 text-[15px] flex-1 min-w-[140px] font-semibold`}
        />
        <select
          aria-label="Field type"
          value={field.type}
          onChange={(e) => onChange({ type: e.target.value as CustomFieldType, options: e.target.value === "select" || e.target.value === "multiselect" ? (field.options || []) : undefined })}
          className={`${fieldBox} h-10 text-[15px]`}
        >
          {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <label className="inline-flex items-center gap-1.5 text-[14px] text-[var(--color-text)] px-1">
          <input type="checkbox" checked={!!field.required} onChange={(e) => onChange({ required: e.target.checked })} className="w-4 h-4 accent-[var(--color-text)]" />
          Required
        </label>
        <button type="button" onClick={onRemove} aria-label={`Remove ${field.label}`} className={`${btnIcon} hover:text-[var(--state-overdue)]`}>
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      {(field.type === "text" || field.type === "textarea" || field.type === "number") && (
        <input
          value={field.placeholder ?? ""}
          onChange={(e) => onChange({ placeholder: e.target.value })}
          placeholder="Placeholder (optional)"
          aria-label="Placeholder"
          className={`${fieldBox} w-full mt-2 h-9 text-[14px]`}
        />
      )}
      <input
        value={field.description ?? ""}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="Help text (optional)"
        aria-label="Help text"
        className={`${fieldBox} w-full mt-2 h-9 text-[14px]`}
      />
      {isChoice && (
        <div className="mt-2 space-y-1">
          <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Choices</div>
          {(field.options ?? []).map((opt, oi) => (
            <div key={oi} className="flex gap-1 items-center">
              <input
                value={opt.label}
                onChange={(e) => {
                  const next = [...(field.options ?? [])];
                  next[oi] = { ...next[oi], label: e.target.value };
                  onChange({ options: next });
                }}
                placeholder="Shown as"
                aria-label="Shown as"
                className={`${fieldBox} flex-1 h-9 text-[14px]`}
              />
              <input
                value={String(opt.value)}
                onChange={(e) => {
                  const next = [...(field.options ?? [])];
                  next[oi] = { ...next[oi], value: e.target.value };
                  onChange({ options: next });
                }}
                placeholder="Stored as"
                aria-label="Stored as"
                className={`${fieldBox} w-24 sm:w-36 h-9 text-[14px]`}
              />
              <button
                type="button"
                aria-label={`Remove choice ${oi + 1}`}
                onClick={() => onChange({ options: (field.options ?? []).filter((_, j) => j !== oi) })}
                className={`${btnIcon} hover:text-[var(--state-overdue)]`}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange({ options: [...(field.options ?? []), { label: "Option", value: "" }] })}
            className={btnRow}
          >
            <Plus className="w-3.5 h-3.5" /> Add choice
          </button>
        </div>
      )}
    </div>
  );
}
