"use client";

import React, { useState, useEffect } from 'react';
import { useDraft } from "@/hooks/useDraft";
import FileThumb from "@/components/ui/FileThumb";
import { SkeletonText } from "@/components/ui/Skeleton";
import StepPath from "@/components/ui/StepPath";
import { Button } from "@/components/ui/Button";
import { friendlyError } from "@/lib/friendlyError";
import { field as kitField, label as kitLabel, fieldError } from "@/components/admin/kit";
import { CircleAlert, Pencil, RotateCcw } from "lucide-react";
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
import { PageHero, PageBody, heroQuiet } from '@/components/ui/PageHero';
import { sentence, fmtDay } from '@/components/requests/RequestBits';
import { appAlert } from '@/components/providers/DialogProvider';
import {
  UploadCloud,
  FileText,
  Loader2,
  X,
  Check,
} from 'lucide-react';

const DEFAULT_SETTINGS: OrgDraftingSettings = {
  requestTypes: {
    label: "Request type",
    enabled: true,
    options: [
      { label: "ISO (isometric)", value: "ISO" },
      { label: "RFI (information request)", value: "RFI" },
      { label: "MOC (management of change)", value: "MOC" },
      { label: "As-built", value: "ASBUILT" },
      { label: "Inspection", value: "INSPECTION" }
    ]
  },
  units: {
    label: "Unit or area",
    enabled: true,
    options: [
      { label: "Unit 100", value: "100" },
      { label: "Unit 200", value: "200" }
    ]
  },
  priorities: {
    label: "Priority",
    enabled: true,
    options: [
      { label: "P1 urgent (1 to 2 days)", value: 1 },
      { label: "P2 high (1 week)", value: 2 },
      { label: "P3 normal (2 weeks)", value: 3 },
      { label: "P4 low (3 weeks)", value: 4 },
      { label: "P5 planned (1 month)", value: 5 }
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

  // The step you're on lives in the address (?step=2), so the browser's
  // Back steps back and a reload opens the same step.
  const urlStep = Math.max(0, Number(searchParams.get('step') ?? 0) || 0);
  const goStep = React.useCallback((n: number, replace = false) => {
    try {
      const url = new URL(window.location.href);
      if (n > 0) url.searchParams.set('step', String(n)); else url.searchParams.delete('step');
      if (replace) window.history.replaceState(null, '', url.toString());
      else window.history.pushState(null, '', url.toString());
    } catch { /* address bar only */ }
    window.scrollTo({ top: 0 });
  }, []);
  // How many steps this visit moved forward (so Back can use the browser's own).
  const pushed = React.useRef(0);
  // Fields you've left: their problems show from then on (never while typing).
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const touch = (k: string) => setTouched((p) => (p.has(k) ? p : new Set(p).add(k)));

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

  // --- STEPS ---
  // Split by topic: what's needed, where and when, the admin's own
  // sections (when there are any), files, then a look over it all before
  // it's sent. Each step checks its own fields.
  const enabledCats = (config.customCategories ?? []).filter((c) => c.enabled);
  const steps: Array<{ key: 'what' | 'where' | 'details' | 'files' | 'review'; label: string }> = [
    { key: 'what', label: "What's needed" },
    { key: 'where', label: 'Unit and timing' },
    ...(enabledCats.length > 0 ? [{ key: 'details' as const, label: 'Details' }] : []),
    { key: 'files', label: 'Files' },
    { key: 'review', label: 'Check and send' },
  ];
  // What's missing on each step, in words, keyed by field.
  const problems = (key: (typeof steps)[number]['key']): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    if (key === 'what') {
      if (!title.trim()) out.push(['title', 'Give it a short title.']);
      if (!description.trim()) out.push(['description', 'Say what needs to change, on which drawings, and why.']);
    } else if (key === 'where') {
      if (!unit.trim()) out.push(['unit', `Pick the ${(config.units?.label || 'unit').toLowerCase()}.`]);
    } else if (key === 'details') {
      for (const cat of enabledCats) for (const f of cat.fields) {
        if (!f.required) continue;
        const v = (customValues[cat.id] ?? {})[f.key];
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) out.push([`cf:${cat.id}:${f.key}`, `Fill in ${f.label.toLowerCase()}.`]);
      }
    }
    return out;
  };
  // The first step with something missing (a reload can't skip past it).
  const firstOpen = steps.findIndex((s) => problems(s.key).length > 0);
  const step = Math.min(urlStep, steps.length - 1, firstOpen >= 0 ? firstOpen : steps.length - 1);

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
      markFile(file, { state: 'failed', error: friendlyError(e) });
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
            // The Details step says which; take them there.
            setIsSubmitting(false);
            setUploadStatus('');
            setTouched((p) => new Set([...p, `cf:${cat.id}:${f.key}`]));
            goStep(steps.findIndex((s) => s.key === 'details'));
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
          } catch {
            failedFiles.push(file.name);
          }
        }
        if (failedFiles.length) {
          await appAlert({ title: "Not sent yet", message: `${failedFiles.length} of ${files.length} file${files.length === 1 ? "" : "s"} didn't upload (${failedFiles.join(", ")}). The request isn't sent yet and everything you typed is still here. Tap Try again on ${failedFiles.length === 1 ? "that file" : "those files"}, then Send request; the ones that went up won't upload twice.`, tone: "danger" });
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

      setUploadStatus('Opening it');
      draft.clear();
      try { if (lastKey) localStorage.setItem(lastKey, JSON.stringify({ unit, requestType })); } catch { /* this device only */ }
      // Straight to the new request, not back to the list; it offers email
      // updates there, right after sending (?sent=1).
      router.push(inserted?.id ? `/requests/${inserted.id}?sent=1` : '/requests');

    } catch (error) {
      console.error("Creation failed:", error);
      await appAlert({ title: "The request wasn't sent", message: `${friendlyError(error)} Everything you typed is still here.`, tone: "danger" });
      setIsSubmitting(false);
      setUploadStatus('');
    }
  }

  if (loadingConfig) {
    return (
      <PageShell width="form">
        <PageHero back={{ onClick: () => router.back(), label: "Back" }} kicker="Drafting requests" title="New drafting request." size="md" />
        <PageBody>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6"><SkeletonText lines={5} /></div>
        </PageBody>
      </PageShell>
    );
  }

  const cur = steps[step];
  const missing = problems(cur.key);
  const stepOk = missing.length === 0;
  const isLast = cur.key === 'review';
  // A field's problem shows once you've left it (or pressed Next).
  const errOf = (k: string) => (touched.has(k) ? missing.find(([key]) => key === k)?.[1] : undefined);
  // Back a step: the browser's own Back when this visit stepped forward
  // (so its history stays true), else in place.
  const stepBack = () => { if (pushed.current > 0) { pushed.current -= 1; window.history.back(); } else goStep(step - 1, true); };
  const goNext = () => {
    if (!stepOk) { setTouched((p) => new Set([...p, ...missing.map(([k]) => k)])); return; }
    pushed.current += 1;
    goStep(step + 1);
  };
  const typeLabel = config.requestTypes.options.find((o) => String(o.value) === requestType)?.label ?? (requestType || 'None');
  const unitLabel = config.units.options.find((o) => String(o.value) === unit)?.label ?? (unit || 'None');
  const priorityLabel = config.priorities.options.find((o) => String(o.value) === String(priority))?.label ?? `P${priority}`;
  const usualDue = defaultSlaTargetDate(requestType);

  // Every picked file with its own state: uploading, up, or didn't go up
  // (with its own Try again); one failure never holds up the rest.
  const fileList = files.length > 0 && (
    <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
      {files.map((file, idx) => {
        const st = fileState.get(file);
        return (
          <li key={idx} className="relative flex items-center justify-between gap-2 px-3 py-2">
            {st?.state === 'failed' && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
            <div className="flex items-center gap-3 min-w-0">
              <FileThumb file={file} />
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-[var(--color-text)] truncate">{file.name}</p>
                <p className="text-[13px] text-[var(--color-text-muted)]" aria-live="polite">
                  {(file.name.split('.').pop() || 'file').toUpperCase()}, {(file.size / 1024 / 1024).toFixed(2)} MB
                  {st?.state === 'up' && <>, uploading</>}
                  {st?.state === 'done' && <>, uploaded</>}
                  {st?.state === 'failed' && <span className="text-[var(--state-overdue-text)]">, didn&apos;t upload. {st.error}</span>}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {st?.state === 'failed' && (
                <button type="button" onClick={() => void retryFile(file)} className={`${heroQuiet} h-8`}><RotateCcw aria-hidden className="w-3.5 h-3.5" /> Try again</button>
              )}
              {st?.state === 'up' ? <Loader2 aria-label="Uploading" className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" /> : (
                <button type="button" onClick={() => removeFile(idx)} aria-label={`Remove ${file.name}`} title="Remove" disabled={isSubmitting}
                  className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );

  // One answer on the review step, with a way back to its step.
  const reviewRow = (label: string, value: React.ReactNode, at: (typeof steps)[number]['key'], key: string = label) => (
    <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[180px_minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-4 sm:px-5 py-3">
      <dt className="text-[13px] sm:text-[14px] text-[var(--color-text-muted)] sm:pt-px">{label}</dt>
      <dd className="col-start-1 sm:col-start-2 text-[15px] text-[var(--color-text)] min-w-0 whitespace-pre-wrap break-words">{value}</dd>
      <button type="button" onClick={() => goStep(steps.findIndex((s) => s.key === at))} aria-label={`Change ${label.toLowerCase()}`}
        className="row-start-1 col-start-2 sm:col-start-3 self-start inline-flex items-center gap-1 min-h-8 pointer-coarse:min-h-11 -my-1.5 px-1 rounded-lg text-[14px] text-[var(--color-text-muted)] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">
        <Pencil aria-hidden className="w-3.5 h-3.5" /> Change
      </button>
    </div>
  );

  return (
    <PageShell width="form">

      <PageHero
        back={{ onClick: () => (step > 0 ? stepBack() : router.back()), label: step > 0 ? "Back a step" : "Back" }}
        kicker="Drafting requests"
        title={draft.restored ? "Your draft is back." : "New drafting request."}
        size="md"
        sub={
          <>
            {draft.restored
              ? <>Everything you typed is here. <button type="button" className="text-[var(--color-accent-text)] hover:underline underline-offset-2" onClick={() => { draft.clear(); setTitle(""); setDescription(""); setTargetDate(""); setCustomValues({}); setTouched(new Set()); goStep(0, true); }}>Start over</button>{" "}</>
              : <>What do you need drawn or changed?{" "}</>}
            <IsoGuidance topic="drafting_request_intent" />
          </>
        }
      >
        {/* Where you are: the steps by topic, joined by one line. A done step is a tap back. */}
        <StepPath steps={steps.map((s) => s.label)} current={step} onPick={(i) => goStep(i)} />
      </PageHero>

      <PageBody>
        <form id="new-request" noValidate onSubmit={(e) => { if (!isLast) { e.preventDefault(); goNext(); return; } void handleSubmit(e); }}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" aria-labelledby="req-step-title">

          {/* The document it came from, when it was sent here from the viewer. */}
          {sourceFileUrl && (
            <div className="flex items-center gap-3 px-5 sm:px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-t-xl">
              <FileText aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />
              <div className="min-w-0 text-[15px] text-[var(--color-text)]">
                <span className="text-[var(--color-text-muted)]">Source document </span>
                <span className="ui-id">{sourceDocNum || sourceDocTitle || sourceFileName || 'Document'}</span>
                {sourceDocRev ? <span className="text-[var(--color-text-muted)]">, Rev {sourceDocRev}</span> : null}
                <span className="text-[var(--color-text-muted)]">. Attached as the source file.</span>
              </div>
            </div>
          )}

          <div className="px-5 sm:px-6 pt-5 pb-6">
            <h2 id="req-step-title" className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)]">
              {cur.label}<span className="sr-only">, step {step + 1} of {steps.length}</span>
            </h2>

            {cur.key === 'what' && (
              <div className="mt-5 space-y-5">
                {/* A few choices: one tap each. Many: a list. */}
                {config.requestTypes.options.length <= 6 ? (
                  <QuickPick
                    label={sentence(config.requestTypes.label)}
                    value={requestType}
                    options={config.requestTypes.options.map((o) => ({ value: String(o.value), label: o.label }))}
                    onPick={setRequestType}
                  />
                ) : (
                  <div>
                    <label htmlFor="req-type" className={kitLabel}>{sentence(config.requestTypes.label)}</label>
                    <select id="req-type" className={kitField} value={requestType} onChange={(e) => setRequestType(e.target.value)}>
                      {config.requestTypes.options.map((opt, idx) => (
                        <option key={idx} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label htmlFor="req-title" className={kitLabel}>Title</label>
                  <input id="req-title" type="text" placeholder="e.g. Re-route the 6 inch line around E-104" className={kitField} autoComplete="off" enterKeyHint="next"
                    value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => touch('title')}
                    aria-invalid={!!errOf('title') || undefined} aria-describedby={errOf('title') ? 'req-title-err' : undefined} />
                  {errOf('title') && <p id="req-title-err" className={fieldError}><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" />{errOf('title')}</p>}
                </div>

                <div>
                  <label htmlFor="req-scope" className={kitLabel}>Scope of work</label>
                  <textarea id="req-scope" className={`${kitField} !h-auto min-h-36 py-2.5 resize-y [field-sizing:content]`}
                    placeholder="What needs to change, on which drawings, and why"
                    value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => touch('description')}
                    aria-invalid={!!errOf('description') || undefined} aria-describedby={errOf('description') ? 'req-scope-err' : undefined} />
                  {errOf('description') && <p id="req-scope-err" className={fieldError}><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" />{errOf('description')}</p>}
                </div>
              </div>
            )}

            {cur.key === 'where' && (
              <div className="mt-5 space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label htmlFor="req-unit" className={kitLabel}>{sentence(config.units.label)}</label>
                    {config.units.options.length > 0 ? (
                      <select id="req-unit" className={kitField} value={unit} onChange={(e) => setUnit(e.target.value)} onBlur={() => touch('unit')}>
                        {config.units.options.map((opt, idx) => (
                          <option key={idx} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input id="req-unit" type="text" placeholder="e.g. 20-CRUDE" className={kitField} autoComplete="off"
                        value={unit} onChange={(e) => setUnit(e.target.value.toUpperCase())} onBlur={() => touch('unit')}
                        aria-invalid={!!errOf('unit') || undefined} aria-describedby={errOf('unit') ? 'req-unit-err' : undefined} />
                    )}
                    {errOf('unit') && <p id="req-unit-err" className={fieldError}><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" />{errOf('unit')}</p>}
                  </div>
                  <div>
                    <label htmlFor="req-due" className={kitLabel}>Target completion <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></label>
                    <input id="req-due" type="date" className={kitField} value={targetDate} onChange={(e) => setTargetDate(e.target.value)} aria-describedby="req-due-hint" />
                    <p id="req-due-hint" className="text-[13px] text-[var(--color-text-muted)] mt-1.5">Blank uses the usual time for this type{usualDue ? `: ${fmtDay(usualDue)}` : ''}.</p>
                  </div>
                </div>

                {config.priorities.options.length <= 5 ? (
                  <QuickPick
                    label={sentence(config.priorities.label)}
                    value={String(priority)}
                    options={config.priorities.options.map((o) => ({ value: String(o.value), label: o.label }))}
                    onPick={(v) => setPriority(Number(v))}
                  />
                ) : (
                  <div>
                    <label htmlFor="req-priority" className={kitLabel}>{sentence(config.priorities.label)}</label>
                    <select id="req-priority" className={kitField} value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                      {config.priorities.options.map((opt, idx) => (
                        <option key={idx} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Admin-defined sections */}
            {cur.key === 'details' && enabledCats.map((cat) => (
              <CustomCategorySection
                key={cat.id}
                category={cat}
                values={customValues[cat.id] ?? {}}
                onChange={(next) => setCustomValues((prev) => ({ ...prev, [cat.id]: next }))}
                errorOf={(k) => errOf(`cf:${cat.id}:${k}`)}
                onLeave={(k) => touch(`cf:${cat.id}:${k}`)}
              />
            ))}

            {cur.key === 'files' && (
              <div className="mt-5 space-y-3">
                <p className="text-[15px] text-[var(--color-text-muted)]">Markups, photos, the drawings to change. Optional: you can add files to the request later too.</p>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Add files"
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
                  {...drag.bind}
                  className={`flex flex-col items-center justify-center text-center min-h-36 gap-2 rounded-xl border border-dashed border-[var(--color-border-control)] px-4 py-6 cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors ${drag.ring}`}
                >
                  <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
                  <UploadCloud aria-hidden className="w-6 h-6 shrink-0 text-[var(--color-text-faint)]" />
                  <div className="min-w-0 pointer-events-none">
                    <p className="text-[15px] text-[var(--color-text)]">{drag.over ? drag.say : <>Drop files here, or <span className="text-[var(--color-accent-text)]">pick them</span></>}</p>
                    <p className="text-[13px] text-[var(--color-text-muted)]">PDF, JPG, PNG or DWG. Several at once is fine.</p>
                  </div>
                </div>
                {fileList}
              </div>
            )}

            {cur.key === 'review' && (
              <div className="mt-4 space-y-4">
                <p className="text-[15px] text-[var(--color-text-muted)]">Check it over. Send request puts it in the queue for a drafter.</p>
                <dl className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                  {reviewRow("Type", typeLabel, "what")}
                  {reviewRow("Title", title, "what")}
                  {reviewRow("Scope of work", <span className="line-clamp-6">{description}</span>, "what")}
                  {reviewRow(sentence(config.units.label), unitLabel, "where")}
                  {reviewRow("Target completion", targetDate ? fmtDay(`${targetDate}T12:00:00`) : <span className="text-[var(--color-text-muted)]">The usual time{usualDue ? `, ${fmtDay(usualDue)}` : ''}</span>, "where")}
                  {reviewRow(sentence(config.priorities.label), priorityLabel, "where")}
                  {enabledCats.flatMap((cat) => cat.fields.map((f) => {
                    const v = (customValues[cat.id] ?? {})[f.key];
                    const shown = v == null || v === '' || (Array.isArray(v) && v.length === 0) ? null
                      : Array.isArray(v) ? v.map((x) => f.options?.find((o) => String(o.value) === x)?.label ?? x).join(', ')
                      : typeof v === 'boolean' ? (v ? 'Yes' : 'No')
                      : f.type === 'select' ? (f.options?.find((o) => String(o.value) === String(v))?.label ?? String(v))
                      : String(v);
                    return reviewRow(f.label, shown ?? <span className="text-[var(--color-text-muted)]">None</span>, "details", `${cat.id}:${f.key}`);
                  }))}
                  {reviewRow("Files", files.length === 0 && !sourceFileUrl ? <span className="text-[var(--color-text-muted)]">None</span> : `${files.length + (sourceFileUrl ? 1 : 0)} file${files.length + (sourceFileUrl ? 1 : 0) === 1 ? '' : 's'}${sourceFileUrl ? ', with the source document' : ''}`, "files")}
                </dl>
                {fileList}
              </div>
            )}
          </div>

          {/* Back, why the next step waits (if it does), and the one main button. On a phone it stays in reach at the bottom. */}
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 px-5 sm:px-6 py-3 pb-[calc(12px+env(safe-area-inset-bottom))] border-t border-[var(--color-border)] bg-[var(--color-surface)] rounded-b-xl">
            {step > 0
              ? <button type="button" onClick={stepBack} disabled={isSubmitting} className={heroQuiet}>Back</button>
              : <button type="button" onClick={() => router.back()} disabled={isSubmitting} className={heroQuiet}>Cancel</button>}
            <p id="req-next-why" aria-live="polite" className="min-w-0 flex-1 text-[13px] text-[var(--color-text-muted)] max-sm:order-first max-sm:basis-full">
              {!stepOk ? missing.map(([, m]) => m).join(' ') : isLast ? '' : `Step ${step + 1} of ${steps.length}`}
            </p>
            {isLast ? (
              <Button type="submit" loading={isSubmitting} className="max-sm:flex-1">{isSubmitting ? (uploadStatus || 'Sending') : 'Send request'}</Button>
            ) : (
              <Button type="submit" variant={stepOk ? 'primary' : 'secondary'} aria-describedby={!stepOk ? 'req-next-why' : undefined}
                className={`max-sm:flex-1 ${stepOk ? '' : 'opacity-60'}`}>
                Next: {steps[step + 1]?.label}
              </Button>
            )}
          </div>
        </form>
      </PageBody>
    </PageShell>
  );
}

// ─── Quick pick ───────────────────────────────────────────────────────
// A short list of choices as one-tap radio options, so the usual answer
// is a tap, not a dropdown. Each shows a radio dot, so it reads as a
// choice, not a button.
function QuickPick({ label, value, options, onPick }: {
  label: React.ReactNode;
  value: string;
  options: Array<{ value: string; label: string }>;
  onPick: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend className={kitLabel}>{label}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onPick(o.value)}
              className={`inline-flex items-center gap-2 h-10 pointer-coarse:h-11 pl-3 pr-3.5 rounded-lg border text-[14px] transition-colors ${on ? 'border-[var(--color-text)] shadow-[inset_0_0_0_1px_var(--color-text)] font-semibold text-[var(--color-text)]' : 'border-[var(--color-border-control)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]'}`}>
              <span aria-hidden className={`w-4 h-4 rounded-full border-2 grid place-items-center shrink-0 ${on ? 'border-[var(--color-text)]' : 'border-[var(--color-border-control)]'}`}>
                {on && <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text)]" />}
              </span>
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

// ─── Custom category section ──────────────────────────────────────────
// One admin-defined category as a section of the form. Each field type
// (text / textarea / number / select / multiselect / date / boolean)
// has its own input. Values flow up via the `onChange(next)` callback
// where `next` is the whole map for this category.

import type { CustomCategoryConfig, CustomFieldDef } from '@/types/schema';

function CustomCategorySection({
  category, values, onChange, errorOf, onLeave,
}: {
  category: CustomCategoryConfig;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** What's missing on a field, once the person has left it. */
  errorOf: (key: string) => string | undefined;
  onLeave: (key: string) => void;
}) {
  const setField = (key: string, value: unknown) => onChange({ ...values, [key]: value });
  return (
    <div className="mt-5 pt-5 border-t border-[var(--color-border)] first-of-type:border-t-0 first-of-type:pt-0">
      <h3 className="text-[16px] font-semibold text-[var(--color-text)]">{category.label}</h3>
      {category.description && <p className="text-[14px] text-[var(--color-text-muted)] mt-0.5">{category.description}</p>}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
        {category.fields.map((f) => (
          <div key={f.key} className={f.type === 'textarea' || f.type === 'multiselect' ? 'sm:col-span-2' : ''} onBlur={() => onLeave(f.key)}>
            <CustomFieldRenderer field={f} value={values[f.key]} onChange={(v) => setField(f.key, v)} />
            {errorOf(f.key) && <p role="alert" className={fieldError}><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" />{errorOf(f.key)}</p>}
          </div>
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
  const id = `cf-${field.key}`;
  const baseLabel = (
    <label htmlFor={id} className={kitLabel}>
      {field.label}{!field.required && <span className="font-normal text-[var(--color-text-muted)]"> (optional)</span>}
    </label>
  );
  const helpText = field.description && <div className="text-[13px] text-[var(--color-text-muted)] mt-1.5">{field.description}</div>;

  switch (field.type) {
    case "text":
      return (
        <>
          {baseLabel}
          <input id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} className={kitField} />
          {helpText}
        </>
      );
    case "textarea":
      return (
        <>
          {baseLabel}
          <textarea id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} rows={3} className={`${kitField} !h-auto py-2.5 resize-y [field-sizing:content]`} />
          {helpText}
        </>
      );
    case "number":
      return (
        <>
          {baseLabel}
          <input id={id} type="number" inputMode="decimal" value={value == null ? "" : Number(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} placeholder={field.placeholder} className={`${kitField} tabular-nums`} />
          {helpText}
        </>
      );
    case "date":
      return (
        <>
          {baseLabel}
          <input id={id} type="date" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} className={kitField} />
          {helpText}
        </>
      );
    case "boolean":
      return (
        <>
          <label className="inline-flex items-center gap-2 min-h-10 text-[15px] text-[var(--color-text)] cursor-pointer">
            <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 rounded border-[var(--color-border-strong)]" />
            {field.label}{!field.required && <span className="text-[var(--color-text-muted)]"> (optional)</span>}
          </label>
          {helpText}
        </>
      );
    case "select":
      return (
        <>
          {baseLabel}
          <select id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} className={kitField}>
            <option value="">Pick one</option>
            {(field.options ?? []).map((o, i) => (
              <option key={i} value={String(o.value)}>{o.label}</option>
            ))}
          </select>
          {helpText}
        </>
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset>
          <legend className={kitLabel}>{field.label}{!field.required && <span className="font-normal text-[var(--color-text-muted)]"> (optional)</span>}</legend>
          <div className="flex flex-wrap gap-2">
            {(field.options ?? []).map((o, i) => {
              const v = String(o.value);
              const on = selected.includes(v);
              return (
                <button type="button" key={i} role="checkbox" aria-checked={on}
                  onClick={() => onChange(on ? selected.filter((x) => x !== v) : [...selected, v])}
                  className={`inline-flex items-center gap-2 h-10 pointer-coarse:h-11 pl-2.5 pr-3 rounded-lg border text-[14px] text-[var(--color-text)] ${on ? "border-[var(--color-text)] shadow-[inset_0_0_0_1px_var(--color-text)] font-semibold" : "border-[var(--color-border-control)] hover:bg-[var(--color-surface-2)]"}`}
                >
                  <span aria-hidden className={`w-4 h-4 rounded-[4px] border-2 grid place-items-center ${on ? "border-[var(--color-text)] bg-[var(--color-text)] text-[var(--color-surface)]" : "border-[var(--color-border-strong)]"}`}>
                    {on && <Check className="w-3 h-3" strokeWidth={3} />}
                  </span>
                  {o.label}
                </button>
              );
            })}
          </div>
          {helpText}
        </fieldset>
      );
    }
    default:
      return null;
  }
}
