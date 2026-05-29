"use client";

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { uploadTicketAttachment } from '@/lib/storage';
import { useRole } from '@/components/providers/RoleContext';
import { TicketAttachment, TicketStatus, OrgDraftingSettings } from '@/types/schema';
import { defaultSlaTargetDate } from '@/lib/notifications';
import IsoGuidance from '@/components/ui/IsoGuidance';
import { 
  ArrowLeft, 
  UploadCloud, 
  FileText, 
  Loader2, 
  X, 
  Save, 
  Info,
  CheckCircle2
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
      { label: "1 - Urgent (1-2 Days)", value: 1 },
      { label: "2 - High (1 Week)", value: 2 },
      { label: "3 - Normal (2 Weeks)", value: 3 },
      { label: "4 - Low (3 Weeks)", value: 4 },
      { label: "5 - Planned (1 Month)", value: 5 }
    ]
  }
};

export default function NewTicketPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeRole, userEmail, activeOrgId, uid } = useRole();

  // Pre-fill from URL params when arriving via "Send to Drafting" from the
  // document viewer. Parameters that aren't present just fall through to
  // the regular empty defaults.
  const prefillTitle = searchParams.get('title') ?? '';
  const prefillDescription = searchParams.get('description') ?? '';
  const sourceDocId = searchParams.get('sourceDocId') ?? '';
  const sourceDocNum = searchParams.get('sourceDocNum') ?? '';
  const sourceDocTitle = searchParams.get('sourceDocTitle') ?? '';
  const sourceDocRev = searchParams.get('sourceDocRev') ?? '';
  const sourceFileUrl = searchParams.get('sourceFileUrl') ?? '';
  const sourceFileName = searchParams.get('sourceFileName') ?? '';

  // Config State
  const [config, setConfig] = useState<OrgDraftingSettings>(DEFAULT_SETTINGS);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // Form State
  const [title, setTitle] = useState(prefillTitle);
  const [description, setDescription] = useState(prefillDescription);
  const [targetDate, setTargetDate] = useState<string>('');
  const [unit, setUnit] = useState('');
  const [requestType, setRequestType] = useState<string>('');
  const [priority, setPriority] = useState<number>(3);
  // Per-category, per-field values. Keyed as customValues[categoryId][fieldKey].
  const [customValues, setCustomValues] = useState<Record<string, Record<string, unknown>>>({});
  
  // File State
  const [files, setFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');

  // --- FETCH CONFIG ---
  useEffect(() => {
    if (!activeOrgId) return;
    const loadConfig = async () => {
      setLoadingConfig(true);
      try {
        const { data } = await supabase
          .from('org_configurations')
          .select('data')
          .eq('org_id', activeOrgId)
          .eq('key', 'drafting')
          .single();
        const cfg: OrgDraftingSettings = (data?.data as OrgDraftingSettings) || DEFAULT_SETTINGS;
        setConfig(cfg);
        if (cfg.requestTypes?.options?.length > 0) setRequestType(String(cfg.requestTypes.options[0].value));
        if (cfg.units?.options?.length > 0) setUnit(String(cfg.units.options[0].value));
        if (cfg.priorities?.options?.length > 0) {
          const mid = Math.floor(cfg.priorities.options.length / 2);
          setPriority(Number(cfg.priorities.options[mid].value));
        }
      } catch (e) {
        console.error("Config Load Failed", e);
      } finally {
        setLoadingConfig(false);
      }
    };
    loadConfig();
  }, [activeOrgId]);

  // --- HANDLERS ---

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFiles(prev => [...prev, ...Array.from(e.target.files || [])]);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !description || !unit) return;
    if (!activeOrgId) {
      alert("No active workspace selected.");
      return;
    }
    
    setIsSubmitting(true);
    setUploadStatus('Initializing Request...');

    try {
      if (!uid) throw new Error("Not authenticated");

      const tempTicketId = `REQ-${Math.floor(1000 + Math.random() * 9000)}`;
      const uploadedAttachments: TicketAttachment[] = [];

      // If we arrived via "Send to Drafting" with a source file URL,
      // attach it as a Source reference. The url is the R2 storage path —
      // FileViewerModal resolves it to a presigned URL on view.
      if (sourceFileUrl) {
        uploadedAttachments.push({
          id: crypto.randomUUID(),
          name: sourceFileName || sourceDocNum || 'source.pdf',
          url: sourceFileUrl,
          type: 'Source',
          status: 'submitted',
          size: '—',
          uploadedBy: userEmail || 'Unknown',
          uploadedAt: new Date().toISOString(),
        } as TicketAttachment);
      }

      if (files.length > 0) {
        setUploadStatus(`Uploading ${files.length} files...`);
        for (const file of files) {
          const result = await uploadTicketAttachment({ file, orgId: activeOrgId, ticketId: tempTicketId });
          uploadedAttachments.push({
            id: crypto.randomUUID(),
            name: file.name,
            url: result.url,
            type: 'Source',
            status: 'submitted',
            size: (file.size / 1024 / 1024).toFixed(2) + ' MB',
            uploadedBy: userEmail || 'Unknown',
            uploadedAt: new Date().toISOString()
          });
        }
      }

      setUploadStatus('Finalizing Ticket...');
      const now = new Date().toISOString();
      const initialStatus: TicketStatus = activeRole.includes('Engineer') ? 'PENDING_ASSIGNMENT' : 'PENDING_ENG_INITIAL';

      // Resolve target completion: user-supplied wins, else default per request_type
      const targetCompletion = targetDate
        ? new Date(targetDate).toISOString()
        : defaultSlaTargetDate(requestType);

      const historyEntries: Array<Record<string, unknown>> = [
        { action: 'Created', user: userEmail, role: activeRole, date: now, details: 'Ticket created via portal' },
      ];
      if (sourceDocId) {
        historyEntries.push({
          action: 'Source Linked', user: userEmail, role: activeRole, date: now,
          details: `Sent from document viewer · ${sourceDocNum || sourceDocTitle || sourceDocId} Rev ${sourceDocRev || '?'}`,
        });
      }

      // Validate required custom fields before insert
      for (const cat of (config.customCategories ?? []).filter((c) => c.enabled)) {
        const vals = customValues[cat.id] ?? {};
        for (const f of cat.fields) {
          if (!f.required) continue;
          const v = vals[f.key];
          const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
          if (empty) {
            alert(`"${f.label}" (${cat.label}) is required.`);
            setIsSubmitting(false);
            setUploadStatus('');
            return;
          }
        }
      }

      const metadata: Record<string, unknown> = {};
      if (Object.keys(customValues).length > 0) metadata.custom_categories = customValues;
      if (sourceDocId) {
        metadata.source_document = {
          id: sourceDocId,
          document_number: sourceDocNum,
          title: sourceDocTitle,
          rev: sourceDocRev,
          path: sourceFileUrl,
        };
      }

      await supabase.from('tickets').insert({
        org_id: activeOrgId,
        ticket_id: tempTicketId,
        title, description, unit,
        request_type: requestType,
        priority, status: initialStatus,
        requester_id: uid,
        requester_name: userEmail?.split('@')[0] || 'Unknown',
        requester_email: userEmail,
        requester_role: activeRole,
        attachments: uploadedAttachments,
        history: historyEntries,
        comments: [], unread_by: [],
        // Requester auto-subscribes as a watcher so they see all activity
        watchers: uid ? [uid] : [],
        target_completion_at: targetCompletion,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        created_at: now, last_modified: now,
      });

      setUploadStatus('Done!');
      setTimeout(() => {
        router.push('/requests'); // Redirect to new route
      }, 500);

    } catch (error) {
      console.error("Creation failed:", error);
      alert("Failed to create ticket. Please try again.");
      setIsSubmitting(false);
    }
  };

  if (loadingConfig) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      
      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => router.back()} 
              className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 inline-flex items-center gap-2">
                New Request
                <IsoGuidance topic="drafting_request_intent" />
              </h1>
              <p className="text-sm text-slate-500">Submit a new job ticket.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto p-6">
        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Source-document chip when arriving via "Send to Drafting" */}
          {sourceFileUrl && (
            <div className="bg-teal-50 border border-teal-200 rounded-xl p-3 flex items-start gap-3">
              <FileText className="w-5 h-5 text-teal-700 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-black text-teal-800 uppercase tracking-widest">Source document</div>
                <div className="text-sm font-bold text-slate-900 truncate mt-0.5">
                  {sourceDocNum || sourceDocTitle || sourceFileName || 'Document'} {sourceDocRev ? `· Rev ${sourceDocRev}` : ''}
                </div>
                <div className="text-[11px] text-teal-700 mt-0.5">
                  Attached automatically as a Source reference. It&apos;ll appear on the ticket once you submit.
                </div>
              </div>
            </div>
          )}

          {/* Section 1: Details */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide mb-4 flex items-center">
              <FileText className="w-4 h-4 mr-2 text-orange-500" />
              Job Details
            </h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              
              {/* DYNAMIC REQUEST TYPE */}
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">
                  {config.requestTypes.label} <span className="text-red-500">*</span>
                </label>
                <select 
                  className="w-full p-3 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all font-medium text-sm"
                  value={requestType}
                  onChange={(e) => setRequestType(e.target.value)}
                >
                  {config.requestTypes.options.map((opt, idx) => (
                    <option key={idx} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              
              {/* DYNAMIC UNIT / AREA */}
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">
                  {config.units.label} <span className="text-red-500">*</span>
                </label>
                {config.units.options.length > 0 ? (
                  <select 
                    className="w-full p-3 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all font-medium text-sm"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  >
                    {config.units.options.map((opt, idx) => (
                      <option key={idx} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <input 
                    type="text"
                    placeholder="e.g. 20-CRUDE"
                    className="w-full p-3 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all text-sm"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value.toUpperCase())}
                    required
                  />
                )}
              </div>
            </div>

            {/* DYNAMIC PRIORITY + TARGET DATE */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">
                  {config.priorities.label} <span className="text-red-500">*</span>
                </label>
                <select
                  className="w-full p-3 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all font-medium text-sm"
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                >
                  {config.priorities.options.map((opt, idx) => (
                    <option key={idx} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">
                  Target Completion <span className="text-slate-400 font-normal text-xs">(optional)</span>
                </label>
                <input
                  type="date"
                  className="w-full p-3 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all font-medium text-sm"
                  value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                />
                <p className="text-[10px] text-slate-500 mt-1">
                  Leave blank to use the org default for this request type. Past-due tickets get flagged on the list.
                </p>
              </div>
            </div>

            <div className="mb-6">
              <label className="block text-sm font-bold text-slate-700 mb-2">
                Title / Subject <span className="text-red-500">*</span>
              </label>
              <input 
                type="text"
                placeholder="Brief summary of the work..."
                className="w-full p-3 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all text-sm font-bold text-slate-900"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2">
                Detailed Scope <span className="text-red-500">*</span>
              </label>
              <textarea 
                className="w-full p-3 h-32 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none resize-none transition-all text-sm"
                placeholder="Describe the work required in detail..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>
          </div>

          {/* Admin-defined custom category sections */}
          {(config.customCategories ?? []).filter((c) => c.enabled).map((cat) => (
            <CustomCategoryCard
              key={cat.id}
              category={cat}
              values={customValues[cat.id] ?? {}}
              onChange={(next) => setCustomValues((prev) => ({ ...prev, [cat.id]: next }))}
            />
          ))}

          {/* Section 2: Files */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide mb-4 flex items-center">
              <UploadCloud className="w-4 h-4 mr-2 text-orange-500" />
              Attachments
            </h2>
            
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer relative group">
              <input 
                type="file" 
                multiple 
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={handleFileSelect}
              />
              <div className="flex flex-col items-center">
                <div className="p-3 bg-white rounded-full shadow-sm mb-3 group-hover:scale-110 transition-transform">
                  <UploadCloud className="w-6 h-6 text-orange-500" />
                </div>
                <p className="text-sm font-bold text-slate-700">Click to upload files</p>
                <p className="text-xs text-slate-400 mt-1">PDF, JPG, PNG, DWG support</p>
              </div>
            </div>

            {files.length > 0 && (
              <div className="mt-4 space-y-2">
                {files.map((file, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 bg-white border border-slate-200 rounded-lg shadow-sm">
                    <div className="flex items-center">
                      <div className="p-2 bg-slate-100 rounded mr-3">
                        <FileText className="w-4 h-4 text-slate-500" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-900 truncate max-w-[200px]">{file.name}</p>
                        <p className="text-xs text-slate-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                      </div>
                    </div>
                    <button 
                      type="button"
                      onClick={() => removeFile(idx)}
                      className="p-1 hover:bg-red-50 text-slate-400 hover:text-red-500 rounded transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end pt-4">
            <button 
              type="submit" 
              disabled={isSubmitting}
              className={`
                flex items-center px-8 py-3 rounded-xl font-bold text-white shadow-lg shadow-orange-900/20 transition-all
                ${isSubmitting ? 'bg-slate-400 cursor-not-allowed' : 'bg-orange-600 hover:bg-orange-700 hover:scale-105'}
              `}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  {uploadStatus}
                </>
              ) : (
                <>
                  <Save className="w-5 h-5 mr-2" />
                  Submit Request
                </>
              )}
            </button>
          </div>

        </form>
      </div>
    </div>
  );
}

// ─── Custom Category Card ─────────────────────────────────────────────
// Renders one admin-defined category as a form card. Each field type
// (text / textarea / number / select / multiselect / date / boolean)
// has its own input. Values flow up via the `onChange(next)` callback
// where `next` is the whole map for this category.

import type { CustomCategoryConfig, CustomFieldDef } from '@/types/schema';

function CustomCategoryCard({
  category, values, onChange,
}: {
  category: CustomCategoryConfig;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const setField = (key: string, value: unknown) => onChange({ ...values, [key]: value });
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
      <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide mb-1 flex items-center">
        <Info className="w-4 h-4 mr-2 text-violet-500" />
        {category.label}
      </h2>
      {category.description && <p className="text-xs text-slate-500 mb-4">{category.description}</p>}
      <div className="space-y-3">
        {category.fields.map((f) => (
          <CustomFieldRenderer key={f.key} field={f} value={values[f.key]} onChange={(v) => setField(f.key, v)} />
        ))}
      </div>
    </div>
  );
}

function CustomFieldRenderer({
  field, value, onChange,
}: {
  field: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const baseLabel = (
    <label className="block text-xs font-bold text-slate-700 mb-1">
      {field.label}{field.required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
  const helpText = field.description && <div className="text-[10px] text-slate-500 mt-1">{field.description}</div>;

  switch (field.type) {
    case "text":
      return (
        <div>
          {baseLabel}
          <input
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
          />
          {helpText}
        </div>
      );
    case "textarea":
      return (
        <div>
          {baseLabel}
          <textarea
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            rows={3}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-y"
          />
          {helpText}
        </div>
      );
    case "number":
      return (
        <div>
          {baseLabel}
          <input
            type="number"
            value={value == null ? "" : Number(value)}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            placeholder={field.placeholder}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
          />
          {helpText}
        </div>
      );
    case "date":
      return (
        <div>
          {baseLabel}
          <input
            type="date"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
          />
          {helpText}
        </div>
      );
    case "boolean":
      return (
        <div>
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
              className="accent-violet-600"
            />
            <span className="font-bold">{field.label}{field.required && <span className="text-red-500 ml-1">*</span>}</span>
          </label>
          {helpText}
        </div>
      );
    case "select":
      return (
        <div>
          {baseLabel}
          <select
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
          >
            <option value="">— pick one —</option>
            {(field.options ?? []).map((o, i) => (
              <option key={i} value={String(o.value)}>{o.label}</option>
            ))}
          </select>
          {helpText}
        </div>
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div>
          {baseLabel}
          <div className="flex flex-wrap gap-1.5">
            {(field.options ?? []).map((o, i) => {
              const v = String(o.value);
              const on = selected.includes(v);
              return (
                <button
                  type="button"
                  key={i}
                  onClick={() => onChange(on ? selected.filter((x) => x !== v) : [...selected, v])}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${on ? "bg-violet-100 border-violet-400 text-violet-900" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                >
                  {on ? "✓ " : ""}{o.label}
                </button>
              );
            })}
          </div>
          {helpText}
        </div>
      );
    }
    default:
      return null;
  }
}
