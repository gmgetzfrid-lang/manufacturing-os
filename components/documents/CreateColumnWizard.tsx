"use client";
import { useToast } from "@/components/providers/ToastProvider";

import React, { useState } from "react";
import { Type, Hash, Calendar, CheckSquare, List, User, Link as LinkIcon, Tags, X, ArrowRight, Plus, Trash2, CheckCircle2, Settings2, Camera, Zap, MousePointerClick, Image as ImageIcon, FileText, CalendarClock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MetadataFieldDefinition, MetadataFieldType } from "@/types/schema";

interface CreateColumnWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (field: MetadataFieldDefinition) => Promise<void>;
  initialType?: MetadataFieldType;
  initialStep?: 1 | 2;
  /** Optional callback to open the Column Manager (for renaming or
   *  reordering existing columns). When provided, the wizard shows a
   *  "Manage existing columns" link in its footer. */
  onOpenColumnManager?: () => void;
}

const FIELD_TYPES: { type: MetadataFieldType; label: string; icon: LucideIcon; desc: string }[] = [
  { type: 'text', label: 'Single Line of Text', icon: Type, desc: 'A few words.' },
  { type: 'number', label: 'Number', icon: Hash, desc: '1, 10, 100.' },
  { type: 'select', label: 'Choice', icon: List, desc: 'Menu to choose from.' },
  { type: 'tags', label: 'Tags / Equipment', icon: Tags, desc: 'Equipment numbers. Tags become clickable chips that open photo galleries.' },
  { type: 'date', label: 'Date & Time', icon: Calendar, desc: 'Calendar date.' },
  { type: 'user', label: 'Person', icon: User, desc: 'People in your org.' },
  { type: 'boolean', label: 'Yes / No', icon: CheckSquare, desc: 'Checkbox.' },
  { type: 'link', label: 'Hyperlink', icon: LinkIcon, desc: 'Web address.' },
  { type: 'review', label: 'Review status', icon: CalendarClock, desc: 'Shows the review-cycle pill (next due / overdue). Display only.' },
];

function FeatureMini({ icon, bg, title, body }: { icon: React.ReactNode; bg: string; title: string; body: string }) {
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-2.5 shadow-sm">
      <div className="flex items-center gap-1.5 mb-1">
        <div className={`p-1 rounded ${bg}`}>{icon}</div>
        <span className="text-[11px] font-black text-[var(--color-text)]">{title}</span>
      </div>
      <p className="text-[10px] text-[var(--color-text-muted)] leading-snug">{body}</p>
    </div>
  );
}

export default function CreateColumnWizard({ isOpen, onClose, onSave, initialType = 'text', initialStep = 1, onOpenColumnManager }: CreateColumnWizardProps) {
  const { showToast } = useToast();
  const [step, setStep] = useState<1 | 2>(initialStep);
  const [selectedType, setSelectedType] = useState<MetadataFieldType>(initialType);

  // Effect to reset/sync when opening
  React.useEffect(() => {
    if (isOpen) {
      setStep(initialStep);
      setSelectedType(initialType);
    }
  }, [isOpen, initialStep, initialType]);
  
  // Form State
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [required, setRequired] = useState(false);
  const [searchable, setSearchable] = useState(true);
  
  // Choice State
  const [options, setOptions] = useState<string[]>(["Option 1", "Option 2", "Option 3"]);
  const [isPill, setIsPill] = useState(false);
  // Tags: what a tag's pill opens — photos (asset gallery) or linked drawings.
  const [referenceKind, setReferenceKind] = useState<"photos" | "files">("photos");

  const handleNext = () => setStep(2);

  const reset = () => {
    setLabel("");
    setDescription("");
    setRequired(false);
    setSearchable(true);
    setOptions(["Option 1", "Option 2", "Option 3"]);
    setIsPill(false);
    setReferenceKind("photos");
  };

  const handleSave = async () => {
    if (!label.trim()) { showToast({ type: "warning", title: "Column name is required." }); return; }
    
    // Auto-generate key
    const key = label.toLowerCase().replace(/[^a-z0-9]/g, '_');

    const field: MetadataFieldDefinition = {
      key,
      label,
      type: selectedType,
      description,
      required,
      searchable,
      visible: true,
      // Choice specific
      ...(selectedType === 'select' || selectedType === 'multi' ? { options: options.filter(o => o.trim()), isPill } : {}),
      ...(selectedType === 'tags' ? { referenceKind } : {}),
    };

    await onSave(field);
    reset();
    onClose();
  };

  const handleAddOption = () => setOptions([...options, `Option ${options.length + 1}`]);
  const handleRemoveOption = (idx: number) => setOptions(options.filter((_, i) => i !== idx));
  const handleUpdateOption = (idx: number, val: string) => {
    const newOpts = [...options];
    newOpts[idx] = val;
    setOptions(newOpts);
  };

  const currentTypeLabel = FIELD_TYPES.find(t => t.type === selectedType)?.label || "Column";

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[400] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 p-4 animate-in fade-in">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95">
        
        {/* HEADER */}
        <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-[var(--color-text)]">{step === 1 ? "Add a Column" : `Configure ${currentTypeLabel}`}</h2>
            <p className="text-xs text-[var(--color-text-muted)]">{step === 1 ? "Choose the type of data to store." : "Define settings and validation."}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-lg text-[var(--color-text-muted)] transition-colors"><X className="w-5 h-5" /></button>
        </div>

        {/* BODY */}
        <div className="flex-1 overflow-y-auto p-6">
          {step === 1 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {FIELD_TYPES.map((t) => {
                const Icon = t.icon;
                const active = selectedType === t.type;
                return (
                  <button
                    key={t.type}
                    onClick={() => setSelectedType(t.type)}
                    className={`text-left p-4 rounded-xl border-2 transition-all flex items-start group ${active ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]' : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-surface-2)]'}`}
                  >
                    <div className={`p-2.5 rounded-lg shrink-0 mr-3 ${active ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]' : 'bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] group-hover:text-[var(--color-accent)]'}`}>
                      <Icon className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className={`font-bold text-sm ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>{t.label}</h3>
                      <p className={`text-xs mt-1 ${active ? 'text-[var(--color-accent)]/80' : 'text-[var(--color-text-muted)]'}`}>{t.desc}</p>
                    </div>
                    {active && <CheckCircle2 className="w-5 h-5 text-[var(--color-accent)] ml-auto self-center" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-bold text-[var(--color-text)] mb-2">Name <span className="text-red-500">*</span></label>
                  <input 
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="w-full px-4 py-2 border border-[var(--color-border)] rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm font-bold"
                    placeholder="e.g. Due Date"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-[var(--color-text)] mb-2">Description</label>
                  <input 
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full px-4 py-2 border border-[var(--color-border)] rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                    placeholder="Optional tooltip..."
                  />
                </div>
              </div>

              {/* TYPE SPECIFIC CONFIG */}
              {selectedType === 'select' && (
                <div className="bg-[var(--color-surface-2)] p-4 rounded-xl border border-[var(--color-border)]">
                  <label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-3">Choices</label>
                  <div className="space-y-2 mb-3">
                    {options.map((opt, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input 
                          value={opt}
                          onChange={(e) => handleUpdateOption(idx, e.target.value)}
                          className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm focus:border-blue-500 outline-none"
                        />
                        <button onClick={() => handleRemoveOption(idx)} className="p-2 text-[var(--color-text-faint)] hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    ))}
                  </div>
                  <button onClick={handleAddOption} className="text-xs font-bold text-blue-600 hover:underline flex items-center"><Plus className="w-3 h-3 mr-1" /> Add Choice</button>
                  
                  <div className="mt-4 pt-4 border-t border-[var(--color-border)]">
                    <label className="flex items-center cursor-pointer">
                      <input type="checkbox" checked={isPill} onChange={(e) => setIsPill(e.target.checked)} className="w-4 h-4 rounded text-blue-600" />
                      <span className="ml-2 text-sm font-medium text-[var(--color-text)]">Display as colored pills</span>
                    </label>
                  </div>
                </div>
              )}

              {/* TAGS — supercharged feature callout */}
              {selectedType === 'tags' && (
                <div className="relative rounded-2xl border-2 border-purple-200 bg-gradient-to-br from-purple-50 via-white to-blue-50 p-5 overflow-hidden">
                  {/* Decorative sparkle */}
                  <div className="absolute -top-2 -right-2 p-2 bg-gradient-to-br from-purple-500 to-blue-500 rounded-xl shadow-lg">
                    <Zap className="w-4 h-4 text-white" />
                  </div>

                  <div className="flex items-center gap-2 mb-3">
                    <div className="p-1.5 bg-purple-100 rounded-lg">
                      <Tags className="w-4 h-4 text-purple-700" />
                    </div>
                    <h4 className="text-sm font-black text-[var(--color-text)]">
                      This isn&apos;t just a tag column — it&apos;s connected to your Asset Registry
                    </h4>
                  </div>

                  <p className="text-xs text-[var(--color-text-muted)] leading-relaxed mb-4">
                    Every tag you add here is recognized as an equipment, instrument, valve, or other tracked asset.
                    Click any tag, anywhere in the library, and you instantly see that asset&apos;s full photo gallery.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <FeatureMini
                      icon={<MousePointerClick className="w-4 h-4 text-purple-700" />}
                      bg="bg-purple-100"
                      title="Clickable chips"
                      body="Tags become interactive pills with a camera icon + photo count. One click opens the gallery."
                    />
                    <FeatureMini
                      icon={<Camera className="w-4 h-4 text-blue-700" />}
                      bg="bg-blue-100"
                      title="Photo galleries"
                      body="Full-screen carousel with date watermarks. Replaces $20k-100k/yr point-cloud subscriptions."
                    />
                    <FeatureMini
                      icon={<Zap className="w-4 h-4 text-emerald-700" />}
                      bg="bg-emerald-100"
                      title="Registry-synced"
                      body="Same tag on a P&ID, ISO, or MOC = same asset. Photos and history follow the equipment, not the doc."
                    />
                  </div>

                  {/* Visual mockup: tag chip → carousel */}
                  <div className="mt-4 pt-4 border-t border-purple-200/60 flex items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--color-surface)] border border-blue-200 font-bold text-blue-800 shadow-sm">
                      <Tags className="w-3 h-3 text-blue-500" />
                      FE-201
                      <span className="ml-1 inline-flex items-center gap-0.5 px-1 py-px rounded bg-blue-50 text-blue-700 text-[9px]">
                        <Camera className="w-2.5 h-2.5" /> 4
                      </span>
                    </span>
                    <span className="text-[var(--color-text-faint)]">→ click →</span>
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-900 text-white text-[10px] font-bold">
                      <ImageIcon className="w-3 h-3" /> Full-screen photo carousel
                    </span>
                  </div>

                  <p className="text-[10px] text-[var(--color-text-muted)] mt-3 leading-relaxed">
                    <b>How to start:</b> Add tags here as you normally would (typing &quot;FE-201&quot; and pressing Enter).
                    The asset is auto-created in the registry. Then go to <b>Admin → Asset Registry</b> to upload photos.
                  </p>
                </div>
              )}

              {/* TAGS — reference kind: photos vs linked drawings */}
              {selectedType === 'tags' && (
                <div className="bg-[var(--color-surface-2)] p-4 rounded-xl border border-[var(--color-border)]">
                  <h4 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-3 flex items-center"><MousePointerClick className="w-3 h-3 mr-2" /> What does clicking a tag open?</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button type="button" onClick={() => setReferenceKind("photos")} className={`text-left p-3 rounded-lg border-2 transition-all ${referenceKind === "photos" ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]' : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/40'}`}>
                      <div className="flex items-center gap-2 mb-1"><Camera className="w-4 h-4 text-blue-600" /><span className="text-sm font-bold text-[var(--color-text)]">Photos</span><span className="ml-auto text-[9px] font-bold text-[var(--color-text-faint)] uppercase">Default</span></div>
                      <p className="text-[11px] text-[var(--color-text-muted)] leading-snug">Asset Registry photo gallery — site photos of the equipment.</p>
                    </button>
                    <button type="button" onClick={() => setReferenceKind("files")} className={`text-left p-3 rounded-lg border-2 transition-all ${referenceKind === "files" ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]' : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/40'}`}>
                      <div className="flex items-center gap-2 mb-1"><FileText className="w-4 h-4 text-orange-600" /><span className="text-sm font-bold text-[var(--color-text)]">Linked drawings</span></div>
                      <p className="text-[11px] text-[var(--color-text-muted)] leading-snug">Reference another document in the system — e.g. a circuit id → its isometric. Opens in a drawing viewer.</p>
                    </button>
                  </div>
                </div>
              )}

              {/* GENERAL OPTIONS */}
              <div className="bg-[var(--color-surface-2)] p-4 rounded-xl border border-[var(--color-border)]">
                 <h4 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-3 flex items-center"><Settings2 className="w-3 h-3 mr-2" /> More Options</h4>
                 <div className="space-y-3">
                   <label className="flex items-center justify-between cursor-pointer group">
                     <span className="text-sm font-medium text-[var(--color-text)]">Require that this column contains information</span>
                     <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="w-5 h-5 rounded text-blue-600 focus:ring-blue-500" />
                   </label>
                   <label className="flex items-center justify-between cursor-pointer group">
                     <span className="text-sm font-medium text-[var(--color-text)]">Add to search index</span>
                     <input type="checkbox" checked={searchable} onChange={(e) => setSearchable(e.target.checked)} className="w-5 h-5 rounded text-blue-600 focus:ring-blue-500" />
                   </label>
                 </div>
              </div>
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex justify-between items-center gap-3">
          {onOpenColumnManager ? (
            <button
              onClick={() => { onOpenColumnManager(); onClose(); }}
              className="text-xs font-bold text-[var(--color-text-muted)] hover:text-blue-700 flex items-center gap-1 hover:underline"
              title="Manage existing columns — rename, reorder, hide, or delete"
            >
              <Settings2 className="w-3.5 h-3.5" /> Manage existing columns
            </button>
          ) : <div />}
          <div className="flex items-center gap-3">
          {step === 2 && (
            <button onClick={() => setStep(1)} className="px-4 py-2 text-sm font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Back</button>
          )}
          <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] rounded-lg">Cancel</button>
          {step === 1 ? (
            <button onClick={handleNext} className="px-6 py-2 bg-slate-900 text-white text-sm font-bold rounded-lg hover:bg-slate-800 flex items-center">
              Next <ArrowRight className="w-4 h-4 ml-2" />
            </button>
          ) : (
            <button onClick={handleSave} className="px-6 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 flex items-center shadow-md shadow-blue-900/20">
              Save Column
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}