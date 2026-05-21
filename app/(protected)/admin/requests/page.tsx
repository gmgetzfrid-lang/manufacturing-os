"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { OrgDraftingSettings, FormFieldConfig, SelectOption } from '@/types/schema';
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

  const updateSection = (
    key: keyof OrgDraftingSettings, 
    patch: Partial<FormFieldConfig>
  ) => {
    if (!settings) return;
    setSettings({
      ...settings,
      [key]: { ...settings[key], ...patch }
    });
  };

  const updateOption = (
    sectionKey: keyof OrgDraftingSettings,
    idx: number,
    field: keyof SelectOption,
    value: string | number
  ) => {
    if (!settings) return;
    const newOptions = [...settings[sectionKey].options];
    newOptions[idx] = { ...newOptions[idx], [field]: value };
    updateSection(sectionKey, { options: newOptions });
  };

  const addOption = (sectionKey: keyof OrgDraftingSettings) => {
    if (!settings) return;
    const newOptions = [...settings[sectionKey].options, { label: "New Option", value: "" }];
    updateSection(sectionKey, { options: newOptions });
  };

  const removeOption = (sectionKey: keyof OrgDraftingSettings, idx: number) => {
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
