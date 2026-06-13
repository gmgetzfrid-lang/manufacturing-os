"use client";

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { uploadTicketAttachment } from '@/lib/storage';
import { useRole } from '@/components/providers/RoleContext';
import { TicketAttachment, TicketStatus, OrgDraftingSettings } from '@/types/schema';
import { defaultSlaTargetDate } from '@/lib/notifications';
import { notifyMany } from '@/lib/inAppNotifications';
import { resolveTicketRecipients } from '@/lib/ticketRouting';
import { generateTicketNumber } from '@/lib/ticketNumber';
import IsoGuidance from '@/components/ui/IsoGuidance';
import { PageShell, PageHeaderBar } from '@/components/ui/PageShell';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { appAlert } from '@/components/providers/DialogProvider';
import {
  ArrowLeft,
  UploadCloud,
  FileText,
  Loader2,
  X,
  Save,
  Info,
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

  // Dropzone state (visual feedback while a file is being dragged)
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Snapshot the picked files synchronously. The setFiles updater runs
    // during render — after the value reset below — so reading e.target.files
    // inside the updater would see an already-cleared FileList and silently
    // drop the selection. (This is why drag-drop worked but click-to-browse
    // didn't.) Capture to a local first, mirroring every other upload handler.
    const picked = Array.from(e.target.files ?? []);
    if (picked.length > 0) {
      setFiles(prev => [...prev, ...picked]);
    }
    // Reset so re-picking the same file fires onChange again
    e.target.value = '';
  };

  const onDropFiles = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files ?? []);
    if (dropped.length === 0) return;
    setFiles((prev) => [...prev, ...dropped]);
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !description || !unit) return;
    if (!activeOrgId) {
      await appAlert("No active workspace selected.");
      return;
    }
    
    setIsSubmitting(true);
    setUploadStatus('Initializing Request...');

    try {
      if (!uid) throw new Error("Not authenticated");

      if (!activeOrgId) throw new Error("No active workspace selected.");
      // Atomic, collision-proof, human request number (e.g. KE-DDRT-26-0001).
      const ticketNumber = await generateTicketNumber(activeOrgId);
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
          const result = await uploadTicketAttachment({ file, orgId: activeOrgId, ticketId: ticketNumber });
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
      // Every request enters the assignment queue (Admin / DraftingSupervisor).
      // Engineering review is a manual branch from there, not an auto-gate.
      const initialStatus: TicketStatus = 'PENDING_ASSIGNMENT';

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
            await appAlert(`"${f.label}" (${cat.label}) is required.`);
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

      const ticketRow: Record<string, unknown> = {
        org_id: activeOrgId,
        ticket_id: ticketNumber,
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
        created_at: now, last_modified: now,
      };
      // Only attach metadata when there's actually something to store
      // (custom-category values or a linked source document). Avoids sending
      // an empty blob for the common case.
      if (Object.keys(metadata).length > 0) ticketRow.metadata = metadata;

      // IMPORTANT: supabase-js does NOT throw on a failed insert — it returns
      // { error }. Check it explicitly. Skipping this is what let a rejected
      // insert (e.g. a missing column or RLS denial) look like success and
      // redirect to an empty queue.
      const { data: inserted, error: insertError } = await supabase
        .from('tickets')
        .insert(ticketRow)
        .select('id')
        .single();
      if (insertError) throw insertError;

      // Notify the right people. Fire-and-forget — the redirect
      // shouldn't wait. resolveTicketRecipients picks the role pool
      // (DraftingSupervisor → fallback Admin for assignment,
      // engineers for initial review) so we never spam every admin.
      void (async () => {
        try {
          const recipients = await resolveTicketRecipients(activeOrgId, initialStatus, uid ?? undefined);
          if (recipients.length === 0) return;
          await notifyMany({
            orgId: activeOrgId,
            userIds: recipients.map((m) => m.uid),
            actorUserId: uid ?? undefined,
            actorName: userEmail?.split('@')[0],
            kind: 'request_pending_approval',
            title: `New drafting request: ${title}`,
            body: 'Ready for a drafter to be assigned.',
            link: `/requests/${inserted?.id ?? ''}`,
            resourceType: 'ticket',
            resourceId: inserted?.id,
            metadata: { request_type: requestType, priority, unit },
          });
        } catch (e) {
          console.warn('[requests] notify failed (non-blocking)', e);
        }
      })();

      setUploadStatus('Done!');
      setTimeout(() => {
        router.push('/requests'); // Redirect to new route
      }, 500);

    } catch (error) {
      console.error("Creation failed:", error);
      const msg = error instanceof Error ? error.message : String(error);
      await appAlert({ message: `Failed to create ticket: ${msg}`, tone: "danger" });
      setIsSubmitting(false);
      setUploadStatus('');
    }
  };

  if (loadingConfig) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <PageShell width="form">

      {/* Header */}
      <div className="flex items-start gap-3">
        <button
          onClick={() => router.back()}
          className="p-2 mt-1 hover:bg-[var(--color-surface-2)] rounded-full text-[var(--color-text-muted)] transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <PageHeaderBar
          className="flex-1 min-w-0"
          title="New Request"
          subtitle={
            <>
              Submit a new job ticket.{" "}
              <IsoGuidance topic="drafting_request_intent" />
            </>
          }
        />
      </div>

        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Source-document chip when arriving via "Send to Drafting" */}
          {sourceFileUrl && (
            <div className="bg-teal-50 border border-teal-200 rounded-xl p-3 flex items-start gap-3">
              <FileText className="w-5 h-5 text-teal-700 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-black text-teal-800 uppercase tracking-widest">Source document</div>
                <div className="text-sm font-bold text-[var(--color-text)] truncate mt-0.5">
                  {sourceDocNum || sourceDocTitle || sourceFileName || 'Document'} {sourceDocRev ? `· Rev ${sourceDocRev}` : ''}
                </div>
                <div className="text-[11px] text-teal-700 mt-0.5">
                  Attached automatically as a Source reference. It&apos;ll appear on the ticket once you submit.
                </div>
              </div>
            </div>
          )}

          {/* Section 1: Details */}
          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 shadow-sm">
            <h2 className="text-sm font-bold text-[var(--color-text)] uppercase tracking-wide mb-4 flex items-center">
              <FileText className="w-4 h-4 mr-2 text-orange-500" />
              Job Details
            </h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              
              {/* DYNAMIC REQUEST TYPE */}
              <div>
                <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                  {config.requestTypes.label} <span className="text-red-500">*</span>
                </label>
                <Select
                  className="font-medium"
                  value={requestType}
                  onChange={(e) => setRequestType(e.target.value)}
                >
                  {config.requestTypes.options.map((opt, idx) => (
                    <option key={idx} value={opt.value}>{opt.label}</option>
                  ))}
                </Select>
              </div>

              {/* DYNAMIC UNIT / AREA */}
              <div>
                <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                  {config.units.label} <span className="text-red-500">*</span>
                </label>
                {config.units.options.length > 0 ? (
                  <Select
                    className="font-medium"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  >
                    {config.units.options.map((opt, idx) => (
                      <option key={idx} value={opt.value}>{opt.label}</option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    type="text"
                    placeholder="e.g. 20-CRUDE"
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
                <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                  {config.priorities.label} <span className="text-red-500">*</span>
                </label>
                <select
                  className="w-full p-3 bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all font-medium text-sm"
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                >
                  {config.priorities.options.map((opt, idx) => (
                    <option key={idx} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                  Target Completion <span className="text-[var(--color-text-faint)] font-normal text-xs">(optional)</span>
                </label>
                <input
                  type="date"
                  className="w-full p-3 bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all font-medium text-sm"
                  value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                />
                <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                  Leave blank to use the org default for this request type. Past-due tickets get flagged on the list.
                </p>
              </div>
            </div>

            <div className="mb-6">
              <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                Title / Subject <span className="text-red-500">*</span>
              </label>
              <input 
                type="text"
                placeholder="Brief summary of the work..."
                className="w-full p-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all text-sm font-bold text-[var(--color-text)]"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                Detailed Scope <span className="text-red-500">*</span>
              </label>
              <textarea 
                className="w-full p-3 h-32 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-orange-500 outline-none resize-none transition-all text-sm"
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
          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 shadow-sm">
            <h2 className="text-sm font-bold text-[var(--color-text)] uppercase tracking-wide mb-4 flex items-center">
              <UploadCloud className="w-4 h-4 mr-2 text-orange-500" />
              Attachments
            </h2>
            
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
              onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDropFiles}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer group ${
                dragOver
                  ? 'border-orange-500 bg-orange-50 ring-2 ring-orange-300 scale-[1.01]'
                  : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)] hover:border-orange-400 hover:bg-orange-50/40'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              <div className="flex flex-col items-center pointer-events-none">
                <div className={`p-3 bg-[var(--color-surface)] rounded-full shadow-sm mb-3 transition-transform ${dragOver ? 'scale-110' : 'group-hover:scale-105'}`}>
                  <UploadCloud className={`w-6 h-6 ${dragOver ? 'text-orange-600' : 'text-orange-500'}`} />
                </div>
                <p className="text-sm font-bold text-[var(--color-text)]">{dragOver ? 'Drop to attach' : 'Drop files here, or click to browse'}</p>
                <p className="text-xs text-[var(--color-text-faint)] mt-1">PDF, JPG, PNG, DWG · multiple files OK</p>
              </div>
            </div>

            {files.length > 0 && (
              <div className="mt-4 space-y-2">
                {files.map((file, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-sm">
                    <div className="flex items-center">
                      <div className="p-2 bg-[var(--color-surface-2)] rounded mr-3">
                        <FileText className="w-4 h-4 text-[var(--color-text-muted)]" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-[var(--color-text)] truncate max-w-[200px]">{file.name}</p>
                        <p className="text-xs text-[var(--color-text-muted)]">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                      </div>
                    </div>
                    <button 
                      type="button"
                      onClick={() => removeFile(idx)}
                      className="p-1 hover:bg-red-50 text-[var(--color-text-faint)] hover:text-red-500 rounded transition-colors"
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
    </PageShell>
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
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 shadow-sm">
      <h2 className="text-sm font-bold text-[var(--color-text)] uppercase tracking-wide mb-1 flex items-center">
        <Info className="w-4 h-4 mr-2 text-violet-500" />
        {category.label}
      </h2>
      {category.description && <p className="text-xs text-[var(--color-text-muted)] mb-4">{category.description}</p>}
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
    <label className="block text-xs font-bold text-[var(--color-text)] mb-1">
      {field.label}{field.required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
  const helpText = field.description && <div className="text-[10px] text-[var(--color-text-muted)] mt-1">{field.description}</div>;

  switch (field.type) {
    case "text":
      return (
        <div>
          {baseLabel}
          <input
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm"
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
            className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm resize-y"
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
            className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm font-mono"
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
            className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm"
          />
          {helpText}
        </div>
      );
    case "boolean":
      return (
        <div>
          <label className="inline-flex items-center gap-2 text-sm text-[var(--color-text)]">
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
            className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm bg-[var(--color-surface)]"
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
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${on ? "bg-violet-100 border-violet-400 text-violet-900" : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}
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
