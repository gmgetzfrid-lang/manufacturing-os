"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { OrgDraftingSettings, FormFieldConfig, SelectOption, CustomCategoryConfig, CustomFieldDef, CustomFieldType } from '@/types/schema';
import { 
  Settings, 
  Loader2, 
  Plus, 
  Trash2, 
  Save, 
  CheckCircle2, 
  AlertCircle,
  GripVertical
} from 'lucide-react';

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
      { label: "1 - Urgent (1-2 Days)", value: 1, color: "red" },
      { label: "2 - High (1 Week)", value: 2, color: "orange" },
      { label: "3 - Normal (2 Weeks)", value: 3, color: "blue" },
      { label: "4 - Low (3 Weeks)", value: 4, color: "slate" },
      { label: "5 - Planned (1 Month)", value: 5, color: "slate" }
    ]
  }
};

export default function DraftingConfigPage() {
  const router = useRouter();
  const { activeRole, activeOrgId } = useRole();
  const [settings, setSettings] = useState<OrgDraftingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
      try {
        const { data } = await supabase
          .from('org_configurations')
          .select('data')
          .eq('org_id', activeOrgId)
          .eq('key', 'drafting')
          .single();
        setSettings(data ? (data.data as OrgDraftingSettings) : DEFAULT_SETTINGS);
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
      alert("Configuration saved successfully.");
    } catch (e) {
      console.error("Save failed:", e);
      alert("Failed to save configuration.");
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
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-32">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center">
              <Settings className="w-6 h-6 mr-3 text-slate-500" />
              Drafting Portal Configuration
            </h1>
            <p className="text-slate-500 text-sm mt-1">Customize the request form fields for your organization.</p>
          </div>
          <button 
            onClick={handleSave}
            disabled={saving}
            className="flex items-center px-6 py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 disabled:opacity-50 transition-all shadow-lg"
          >
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save Changes
          </button>
        </div>

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
              <div className="flex gap-2 w-full">
                <input 
                  value={opt.label}
                  onChange={(e) => updateOption('requestTypes', i, 'label', e.target.value)}
                  className="flex-1 p-2 border border-slate-200 rounded text-sm"
                  placeholder="Display Label"
                />
                <input 
                  value={opt.value}
                  onChange={(e) => updateOption('requestTypes', i, 'value', e.target.value)}
                  className="w-32 p-2 border border-slate-200 rounded text-sm font-mono bg-slate-50"
                  placeholder="Value (ID)"
                />
              </div>
            )}
          />

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
                  className="flex-1 p-2 border border-slate-200 rounded text-sm"
                  placeholder="Unit Name"
                />
                <input 
                  value={opt.value}
                  onChange={(e) => updateOption('units', i, 'value', e.target.value)}
                  className="w-32 p-2 border border-slate-200 rounded text-sm font-mono bg-slate-50"
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
                  className="flex-1 p-2 border border-slate-200 rounded text-sm"
                  placeholder="Level Description"
                />
                <input 
                  type="number"
                  value={opt.value}
                  onChange={(e) => updateOption('priorities', i, 'value', Number(e.target.value))}
                  className="w-24 p-2 border border-slate-200 rounded text-sm font-mono bg-slate-50"
                  placeholder="Level #"
                />
              </div>
            )}
          />

        </div>
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
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
        <div>
          <h3 className="font-bold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500">{desc}</p>
        </div>
      </div>
      <div className="p-6">
        <div className="mb-6">
          <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Form Label</label>
          <input 
            value={config.label}
            onChange={(e) => onLabelChange(e.target.value)}
            className="w-full p-2 border border-slate-200 rounded-lg text-sm font-bold text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        
        <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Dropdown Options</label>
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
          className="mt-4 flex items-center text-xs font-bold text-blue-600 hover:text-blue-800"
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
  const removeCategory = (idx: number) => {
    if (!confirm(`Remove "${categories[idx].label}" and all its fields? Tickets created before today keep their stored values.`)) return;
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
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 bg-violet-50 border-b border-violet-100 flex justify-between items-center">
        <div>
          <h3 className="font-bold text-slate-900">Custom Categories</h3>
          <p className="text-xs text-slate-600">
            Add sections with your own fields so requesters can capture
            org-specific context (e.g. <i>Inspection Type</i>, <i>Equipment Tag</i>,
            <i> MOC Phase</i>). Each section becomes its own card on the request form.
          </p>
        </div>
        <button
          onClick={addCategory}
          className="inline-flex items-center px-3 py-2 rounded-lg text-xs font-black text-white bg-violet-600 hover:bg-violet-500"
        >
          <Plus className="w-3.5 h-3.5 mr-1" /> Add Category
        </button>
      </div>
      <div className="p-6 space-y-6">
        {categories.length === 0 && (
          <div className="text-xs italic text-slate-500">No custom categories yet. Click <b>Add Category</b> above.</div>
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
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 flex items-center gap-2">
        <input
          value={cat.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="flex-1 px-2 py-1 border border-slate-200 rounded text-sm font-bold text-slate-900 focus:ring-2 focus:ring-violet-500 outline-none"
          placeholder="Category label"
        />
        <label className="inline-flex items-center gap-1 text-[11px] text-slate-600">
          <input type="checkbox" checked={cat.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} className="accent-violet-600" />
          Enabled
        </label>
        <button onClick={onMoveUp} disabled={!canMoveUp} className="p-1.5 rounded hover:bg-slate-200 disabled:opacity-30">↑</button>
        <button onClick={onMoveDown} disabled={!canMoveDown} className="p-1.5 rounded hover:bg-slate-200 disabled:opacity-30">↓</button>
        <button onClick={onRemove} className="p-1.5 rounded text-slate-400 hover:text-red-600 hover:bg-red-50">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="px-4 py-3 space-y-2">
        <input
          value={cat.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Optional description shown under the section header"
          className="w-full px-2 py-1 border border-slate-200 rounded text-xs text-slate-700"
        />
        <div className="space-y-2 mt-2">
          {cat.fields.length === 0 && <div className="text-[11px] italic text-slate-400">No fields yet — add one below.</div>}
          {cat.fields.map((f, i) => (
            <FieldEditor key={f.key} field={f} onChange={(patch) => updateField(i, patch)} onRemove={() => removeField(i)} />
          ))}
        </div>
        <button onClick={addField} className="mt-1 inline-flex items-center text-[11px] font-bold text-violet-700 hover:text-violet-900">
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
    <div className="border border-slate-200 rounded-md p-2 bg-white">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Field label"
          className="flex-1 min-w-[120px] px-2 py-1 border border-slate-200 rounded text-xs font-bold"
        />
        <select
          value={field.type}
          onChange={(e) => onChange({ type: e.target.value as CustomFieldType, options: e.target.value === "select" || e.target.value === "multiselect" ? (field.options || []) : undefined })}
          className="px-2 py-1 border border-slate-200 rounded text-xs bg-white"
        >
          {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <label className="inline-flex items-center gap-1 text-[10px] text-slate-600">
          <input type="checkbox" checked={!!field.required} onChange={(e) => onChange({ required: e.target.checked })} className="accent-violet-600" />
          Required
        </label>
        <button onClick={onRemove} className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {(field.type === "text" || field.type === "textarea" || field.type === "number") && (
        <input
          value={field.placeholder ?? ""}
          onChange={(e) => onChange({ placeholder: e.target.value })}
          placeholder="Placeholder (optional)"
          className="mt-2 w-full px-2 py-1 border border-slate-100 rounded text-[11px] text-slate-600"
        />
      )}
      <input
        value={field.description ?? ""}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="Help text (optional)"
        className="mt-2 w-full px-2 py-1 border border-slate-100 rounded text-[11px] text-slate-600"
      />
      {isChoice && (
        <div className="mt-2 space-y-1">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Choices</div>
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
                className="flex-1 px-2 py-1 border border-slate-200 rounded text-[11px]"
              />
              <input
                value={String(opt.value)}
                onChange={(e) => {
                  const next = [...(field.options ?? [])];
                  next[oi] = { ...next[oi], value: e.target.value };
                  onChange({ options: next });
                }}
                placeholder="Stored value"
                className="w-32 px-2 py-1 border border-slate-200 rounded text-[11px] font-mono bg-slate-50"
              />
              <button
                onClick={() => onChange({ options: (field.options ?? []).filter((_, j) => j !== oi) })}
                className="p-1 text-slate-400 hover:text-red-600"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          <button
            onClick={() => onChange({ options: [...(field.options ?? []), { label: "Option", value: "" }] })}
            className="text-[10px] font-bold text-violet-700 hover:text-violet-900 inline-flex items-center"
          >
            <Plus className="w-3 h-3 mr-1" /> Add Choice
          </button>
        </div>
      )}
    </div>
  );
}
