"use client";

import React, { useState, useEffect } from 'react';
import { useDraft } from "@/hooks/useDraft";
import FileThumb from "@/components/ui/FileThumb";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { uploadTicketAttachment } from '@/lib/storage';
import { useRole } from '@/components/providers/RoleContext';
import { TicketAttachment, TicketStatus, OrgDraftingSettings } from '@/types/schema';
import { defaultSlaTargetDate } from '@/lib/notifications';
import { emit } from '@/lib/notify/dispatch';
import { resolveTicketRecipients } from '@/lib/ticketRouting';
import { generateTicketNumber } from '@/lib/ticketNumber';
import { takeDraft } from '@/lib/draftHandoff';
import { loadCodebook } from '@/lib/codebook';
import IsoGuidance from '@/components/ui/IsoGuidance';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody, Card, heroPrimary } from '@/components/ui/PageHero';
import { Input, Select } from '@/components/ui/Field';
import { appAlert } from '@/components/providers/DialogProvider';
import {
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
  // One-time key for a batch of marked-up PDFs handed off from the book viewer.
  const draftKey = searchParams.get('draft') ?? '';
  const prefillUnit = searchParams.get('unit') ?? '';

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
  
  // What you've typed is kept on this device until it's sent (not when the
  // form was opened with values from a document).
  const draftPriority = React.useRef(false);
  type FormDraft = { title: string; description: string; targetDate: string; unit: string; requestType: string; priority: number; customValues: Record<string, Record<string, unknown>> };
  const prefilled = !!(prefillTitle || prefillDescription || sourceDocId || draftKey || prefillUnit);
  const formDraft: FormDraft = React.useMemo(() => ({ title, description, targetDate, unit, requestType, priority, customValues }), [title, description, targetDate, unit, requestType, priority, customValues]);
  const draft = useDraft<FormDraft>(
    !prefilled && activeOrgId ? `request:new:${activeOrgId}` : null,
    formDraft,
    (d) => { setTitle(d.title ?? ""); setDescription(d.description ?? ""); setTargetDate(d.targetDate ?? ""); if (d.unit) setUnit(d.unit); if (d.requestType) setRequestType(d.requestType); if (d.priority) { draftPriority.current = true; setPriority(d.priority); } setCustomValues(d.customValues ?? {}); },
    (d) => !d.title.trim() && !d.description.trim(),
  );

  // File State
  const [files, setFiles] = useState<File[]>([]);
  // Each picked file's own upload state, so one that fails shows its own
  // Try again and never holds up the others.
  const [fileState, setFileState] = useState<Map<File, { state: 'up' | 'done' | 'failed'; error?: string }>>(new Map());
  const markFile = (f: File, v: { state: 'up' | 'done' | 'failed'; error?: string } | null) =>
    setFileState((prev) => { const n = new Map(prev); if (v) n.set(f, v); else n.delete(f); return n; });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');

  // Pull in marked-up PDFs handed off from the book viewer (stashed in
  // IndexedDB) and attach them as files, so they upload with the request.
  useEffect(() => {
    if (!draftKey) return;
    let alive = true;
    takeDraft(draftKey)
      .then((d) => {
        if (!alive || !d || d.files.length === 0) return;
        const fs = d.files.map((f) => new File([f.blob], f.name, { type: f.blob.type || 'application/pdf' }));
        setFiles((prev) => [...prev, ...fs]);
      })
      .catch((e) => console.error('draft markup handoff failed', e));
    return () => { alive = false; };
  }, [draftKey]);

  // Prefill the Unit field when the handoff passed a unit that matches an option.
  useEffect(() => {
    if (!prefillUnit) return;
    const opts = config.units?.options ?? [];
    if (opts.some((o) => String(o.value) === prefillUnit)) setUnit((u) => u || prefillUnit);
  }, [prefillUnit, config]);

  // The unit and type used last time come back first, so a run of requests
  // for the same unit needs no picking.
  const lastKey = activeOrgId ? `request:last:${activeOrgId}` : null;
  const readLast = (): { unit?: string; requestType?: string } => {
    if (!lastKey) return {};
    try { return JSON.parse(localStorage.getItem(lastKey) || '{}') as { unit?: string; requestType?: string }; } catch { return {}; }
  };

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
        // No unit options configured on the form? Inherit the Site Codebook's
        // unit list — taught once in Admin → Site Codebook, spoken here too.
        if (!(cfg.units?.options?.length > 0)) {
          try {
            const book = await loadCodebook(activeOrgId);
            if (book.units.length > 0) {
              cfg.units = {
                label: cfg.units?.label ?? 'Unit',
                enabled: cfg.units?.enabled ?? true,
                options: book.units.map((u) => ({ label: `${u.code} - ${u.label}`, value: u.code })),
              };
            }
          } catch { /* codebook optional — free-text unit input remains */ }
        }
        setConfig(cfg);
        // Defaults fill only what a restored draft didn't: last time's
        // choice when it's still on the list, else the first option.
        const last = readLast();
        const has = (opts: { value: unknown }[] | undefined, v?: string) => !!v && (opts ?? []).some((o) => String(o.value) === v);
        if (cfg.requestTypes?.options?.length > 0) setRequestType((t) => t || (has(cfg.requestTypes.options, last.requestType) ? last.requestType! : String(cfg.requestTypes.options[0].value)));
        if (cfg.units?.options?.length > 0) setUnit((u) => u || (has(cfg.units.options, last.unit) ? last.unit! : String(cfg.units.options[0].value)));
        else if (last.unit) setUnit((u) => u || last.unit!);
        if (cfg.priorities?.options?.length > 0 && !draftPriority.current) {
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
    // readLast only reads this org's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId]);

  // --- HANDLERS ---

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  // Kept across a retry: the request's number, and the files already up
  // (a failed attachment never costs a new number or a second upload).
  const ticketNoRef = React.useRef<string | null>(null);
  const uploadedRef = React.useRef(new Map<File, TicketAttachment>());

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

  const drag = useFileDrag((dropped) => setFiles((prev) => [...prev, ...dropped]), isSubmitting);

  const removeFile = (index: number) => {
    const f = files[index];
    if (f) { uploadedRef.current.delete(f); markFile(f, null); }
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const toAttachment = (file: File, url: string): TicketAttachment => ({
    id: crypto.randomUUID(),
    name: file.name,
    url,
    type: 'Source',
    status: 'submitted',
    size: (file.size / 1024 / 1024).toFixed(2) + ' MB',
    uploadedBy: userEmail || 'Unknown',
    uploadedAt: new Date().toISOString()
  });

  // One file up, on its own. Safe to repeat: it only sends the file; the
  // request itself is saved once, by Submit.
  const uploadOne = async (file: File, ticketNumber: string): Promise<TicketAttachment> => {
    markFile(file, { state: 'up' });
    try {
      const att = await tryUpload(file.name, async () => {
        const result = await uploadTicketAttachment({ file, orgId: activeOrgId!, ticketId: ticketNumber });
        return toAttachment(file, result.url);
      }, { onRetried: (a) => { uploadedRef.current.set(file, a); markFile(file, { state: 'done' }); } });
      uploadedRef.current.set(file, att);
      markFile(file, { state: 'done' });
      return att;
    } catch (e) {
      markFile(file, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };

  // Try one failed file again right from its row.
  const retryFile = async (file: File) => {
    if (!activeOrgId) return;
    const ticketNumber = ticketNoRef.current ?? await generateTicketNumber(activeOrgId);
    ticketNoRef.current = ticketNumber;
    try { await uploadOne(file, ticketNumber); } catch { /* the row shows why */ }
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !description || !unit) return;
    if (!activeOrgId) {
      await appAlert("No active workspace selected.");
      return;
    }
    
    setIsSubmitting(true);
    setUploadStatus('Starting…');

    try {
      if (!uid) throw new Error("Not authenticated");

      if (!activeOrgId) throw new Error("No active workspace selected.");
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

      // Atomic, collision-proof, human request number (e.g. KE-DDRT-26-0001),
      // taken once: a retry after a failed attachment keeps it.
      const ticketNumber = ticketNoRef.current ?? await generateTicketNumber(activeOrgId);
      ticketNoRef.current = ticketNumber;
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
          size: '-',
          uploadedBy: userEmail || 'Unknown',
          uploadedAt: new Date().toISOString(),
        } as TicketAttachment);
      }

      if (files.length > 0) {
        // Each file on its own: one that fails doesn't stop the rest, and
        // the ones already up aren't sent again on a retry.
        const failedFiles: string[] = [];
        let n = 0;
        for (const file of files) {
          n++;
          const had = uploadedRef.current.get(file);
          if (had) { uploadedAttachments.push(had); continue; }
          setUploadStatus(`Uploading ${n} of ${files.length}: ${file.name}`);
          try {
            uploadedAttachments.push(await uploadOne(file, ticketNumber));
          } catch (e) {
            failedFiles.push(`${file.name} (${e instanceof Error ? e.message : String(e)})`);
          }
        }
        if (failedFiles.length) {
          await appAlert({ title: "Not sent yet", message: `${failedFiles.length} of ${files.length} file${files.length === 1 ? "" : "s"} didn't upload: ${failedFiles.join("; ")}. The request isn't sent yet and everything you typed is still here. Tap Try again on ${failedFiles.length === 1 ? "that file" : "those files"}, then Submit; the ones that went up won't upload twice.`, tone: "danger" });
          setIsSubmitting(false);
          setUploadStatus('');
          return;
        }
      }

      setUploadStatus('Saving the request…');
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
          await emit({
            orgId: activeOrgId,
            category: 'assignment',
            kind: 'request_pending_approval',
            title: `New drafting request: ${title}`,
            body: 'Ready for a drafter to be assigned.',
            link: `/requests/${inserted?.id ?? ''}`,
            resource: { type: 'ticket', id: String(inserted?.id ?? '') },
            actorUserId: uid ?? undefined,
            actorName: userEmail?.split('@')[0],
            audience: { involved: recipients.map((m) => m.uid) },
            metadata: { request_type: requestType, priority, unit },
          });
        } catch (e) {
          console.warn('[requests] notify failed (non-blocking)', e);
        }
      })();

      setUploadStatus('Opening it…');
      draft.clear();
      try { if (lastKey) localStorage.setItem(lastKey, JSON.stringify({ unit, requestType })); } catch { /* this device only */ }
      // Straight to the new request, not back to the list.
      router.push(inserted?.id ? `/requests/${inserted.id}` : '/requests');

    } catch (error) {
      console.error("Creation failed:", error);
      const msg = error instanceof Error ? error.message : String(error);
      await appAlert({ message: `The request wasn't sent: ${msg}. Everything you typed is still here.`, tone: "danger" });
      setIsSubmitting(false);
      setUploadStatus('');
    }
  }

  if (loadingConfig) {
    return (
      <PageShell width="form">
        <PageHero back={{ onClick: () => router.back(), label: "Back" }} kicker="Drafting requests · New" title="New drafting request." size="md" />
        <PageBody>
          <Card><LoadingBlock what="the request form" rows={6} className="border-0 p-0" /></Card>
        </PageBody>
      </PageShell>
    );
  }

  const submitLabel = isSubmitting
    ? <><Loader2 className="w-4 h-4 animate-spin" />{uploadStatus || 'Sending…'}</>
    : <><Save className="w-4 h-4" />Submit request</>;

  return (
    <PageShell width="form">

      <PageHero
        back={{ onClick: () => router.back(), label: "Back" }}
        kicker="Drafting requests · New"
        title={draft.restored ? "Your draft is back." : "New drafting request."}
        size="md"
        sub={
          <>
            {draft.restored ? <>Your unsent draft is back. <button type="button" className="font-bold text-white underline" onClick={() => { draft.clear(); setTitle(""); setDescription(""); setTargetDate(""); setCustomValues({}); }}>Start over</button>{" "}</> : <>What do you need drawn or changed?{" "}</>}
            <IsoGuidance topic="drafting_request_intent" />
          </>
        }
        primary={<button type="submit" form="new-request" disabled={isSubmitting} className={heroPrimary}>{submitLabel}</button>}
      />

      <PageBody>
        <form id="new-request" onSubmit={handleSubmit} className="space-y-4">

          {/* Source-document chip when arriving via "Send to Drafting" */}
          {sourceFileUrl && (
            <Card className="flex items-start gap-3">
              <FileText className="w-5 h-5 text-[var(--color-text-muted)] mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-extrabold text-[var(--color-text-muted)] uppercase tracking-[0.14em]">Source document</div>
                <div className="text-[14px] font-bold text-[var(--color-text)] truncate mt-1">
                  {sourceDocNum || sourceDocTitle || sourceFileName || 'Document'} {sourceDocRev ? `· Rev ${sourceDocRev}` : ''}
                </div>
                <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">
                  Attached as the source file.
                </div>
              </div>
            </Card>
          )}

          {/* Section 1: Details */}
          <Card label="Job details">
            <div className="space-y-5 mb-5">
              {/* DYNAMIC REQUEST TYPE */}
              <div>
                {/* A few choices: one tap each. Many: a list. */}
                {config.requestTypes.options.length <= 6 ? (
                  <QuickPick
                    label={<>{config.requestTypes.label} <span className="text-red-500">*</span></>}
                    value={requestType}
                    options={config.requestTypes.options.map((o) => ({ value: String(o.value), label: o.label }))}
                    onPick={setRequestType}
                  />
                ) : (
                  <>
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
                  </>
                )}
              </div>


              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
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
              <div>
                <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                  Target Completion <span className="text-[var(--color-text-faint)] font-normal text-xs">(optional)</span>
                </label>
                <input
                  type="date"
                  className="w-full h-11 px-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none transition-all font-medium text-[14px]"
                  value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                />
                <p className="text-[12px] text-[var(--color-text-muted)] mt-1">
                  Blank uses the usual time for this type.
                </p>
              </div>
              </div>

              {/* DYNAMIC PRIORITY */}
              <div>
                {config.priorities.options.length <= 5 ? (
                  <QuickPick
                    label={<>{config.priorities.label} <span className="text-red-500">*</span></>}
                    value={String(priority)}
                    options={config.priorities.options.map((o) => ({ value: String(o.value), label: o.label }))}
                    onPick={(v) => setPriority(Number(v))}
                  />
                ) : (
                  <>
                    <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                      {config.priorities.label} <span className="text-red-500">*</span>
                    </label>
                    <select
                      className="w-full h-11 px-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none transition-all font-medium text-[14px]"
                      value={priority}
                      onChange={(e) => setPriority(Number(e.target.value))}
                    >
                      {config.priorities.options.map((opt, idx) => (
                        <option key={idx} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </div>

            <div className="mb-5">
              <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                Title <span className="text-red-500">*</span>
              </label>
              <input 
                type="text"
                placeholder="A short summary of the work"
                className="w-full h-11 px-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none transition-all text-[15px] font-semibold text-[var(--color-text)]"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                Scope of work <span className="text-red-500">*</span>
              </label>
              <textarea 
                className="w-full p-3 h-32 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none resize-y transition-all text-[14px]"
                placeholder="What needs to change, on which drawings, and why"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>
          </Card>

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
          <Card label="Attachments">

            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
              {...drag.bind}
              className={`border-2 border-dashed rounded-xl p-7 text-center transition-all cursor-pointer group border-[var(--color-border-strong)] hover:border-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] ${drag.ring}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              <div className="flex flex-col items-center pointer-events-none">
                <UploadCloud className={`w-6 h-6 mb-2 ${drag.over ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`} />
                <p className="text-[14px] font-bold text-[var(--color-text)]">{drag.over ? drag.say : 'Drop files here, or tap to pick'}</p>
                <p className="text-[12px] text-[var(--color-text-muted)] mt-1">PDF, JPG, PNG, DWG · multiple files OK</p>
              </div>
            </div>

            {files.length > 0 && (
              <div className="mt-3 divide-y divide-[var(--color-border)]">
                {files.map((file, idx) => {
                  const st = fileState.get(file);
                  return (
                  <div key={idx} className={`flex items-center justify-between gap-2 py-2.5 ${st?.state === 'failed' ? 'border-l-2 border-l-red-500 pl-2' : ''}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <FileThumb file={file} />
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[var(--color-text)] truncate max-w-[200px] sm:max-w-sm">{file.name}</p>
                        <p className="text-xs text-[var(--color-text-muted)]">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                          {st?.state === 'up' && <> · Uploading…</>}
                          {st?.state === 'done' && <span className="text-emerald-700 dark:text-emerald-400 font-semibold"> · Uploaded</span>}
                          {st?.state === 'failed' && <span className="text-red-700 dark:text-red-400 font-semibold"> · Didn&apos;t upload: {st.error}</span>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {st?.state === 'failed' && (
                        <button type="button" onClick={() => void retryFile(file)} className="h-8 px-2.5 rounded-lg border border-[var(--color-border)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                          Try again
                        </button>
                      )}
                      {st?.state === 'up' ? <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" /> : (
                        <button
                          type="button"
                          onClick={() => removeFile(idx)}
                          aria-label={`Remove ${file.name}`}
                          disabled={isSubmitting}
                          className="p-1 hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)] rounded transition-colors disabled:opacity-40"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* At the end of the form, for whoever filled it top to bottom (the
              orange one is in the band; on a phone it rides at the bottom). */}
          <div className="max-sm:hidden flex justify-end pt-1">
            <button type="submit" disabled={isSubmitting}
              className="inline-flex items-center gap-2 h-11 px-5 rounded-xl text-[14px] font-bold bg-[var(--color-text)] text-[var(--color-surface)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity">
              {submitLabel}
            </button>
          </div>

        </form>
      </PageBody>
    </PageShell>
  );
}

// ─── Quick pick ───────────────────────────────────────────────────────
// A short list of choices as one-tap chips (a radio group), so the usual
// answer is a tap, not a dropdown.
function QuickPick({ label, value, options, onPick }: {
  label: React.ReactNode;
  value: string;
  options: Array<{ value: string; label: string }>;
  onPick: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend className="block text-sm font-bold text-[var(--color-text)] mb-2">{label}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onPick(o.value)}
              className={`h-10 px-3.5 rounded-lg border text-[13.5px] font-semibold transition-colors ${on ? 'bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]' : 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]'}`}>
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
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
    <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] p-4 sm:p-5">
      <h2 className="text-[11px] font-extrabold text-[var(--color-text-muted)] uppercase tracking-[0.14em] mb-1 flex items-center">
        <Info className="w-3.5 h-3.5 mr-1.5" />
        {category.label}
      </h2>
      {category.description && <p className="text-[13px] text-[var(--color-text-muted)] mb-4">{category.description}</p>}
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
  const helpText = field.description && <div className="text-[11px] text-[var(--color-text-muted)] mt-1">{field.description}</div>;

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
              className="accent-[var(--color-text)]"
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
            <option value="">- pick one -</option>
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
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${on ? "bg-[var(--color-text)] border-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}
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
