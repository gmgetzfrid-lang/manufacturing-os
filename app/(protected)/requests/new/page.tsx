"use client";

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { uploadTicketAttachment } from '@/lib/storage';
import { useRole } from '@/components/providers/RoleContext';
import { OrgDraftingSettings } from '@/types/schema';
import { readDraft, discardDraft } from '@/lib/draftHandoff';
// DF-P2: the request is filed by /api/tickets/create — it validates, numbers,
// inserts and notifies server-side. This page stages the files and posts.
import { capSourceDocuments, contractLimitRefusal, droppedSourceDocumentsWarning, missingRequiredCustomField, ticketStagingFolder, unitOptionsFor, UNIT_UNKNOWN_LABEL, type TicketCreateAttachment, type TicketCreateSourceDoc } from '@/lib/ticketCreate';
import { submitTicketCreate, discardStagedFiles, loadCodebookUnitList, queueNotNotifiedLine } from '@/lib/ticketCreateClient';
import { linkableDocumentQuery, linkableDocumentFilter } from '@/lib/ticketLibrary';
import IsoGuidance from '@/components/ui/IsoGuidance';
// UI-2 (drafting-flow DF-P9): the workflow map, before someone commits to the process.
import WorkflowDiagramModal from '@/components/requests/WorkflowDiagramModal';
import LikeInKindField, { parseEquipmentTags } from '@/components/requests/LikeInKindField';
import SignatureCeremony from '@/components/signatures/SignatureCeremony';
import { recordSignature, type SigningCredential } from '@/lib/eSignatures';
import { checkDeclarationStatement, declarationSignatureStatement, DECLARATION_SIGNATURE_INTENT } from '@/lib/reviewModel';
import { tagKey } from '@/lib/codebook';
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
  GitBranch,
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
  // No built-in units: the list is the workspace's own — its saved units,
  // else its Site Codebook's, else none (lib/ticketCreate.ts unitOptionsFor,
  // the resolver the create route runs too). A built-in list here was offered
  // to a workspace that never saved its settings, and the route refused it.
  units: {
    label: "Unit / Area",
    enabled: true,
    options: []
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
  const { activeRole, roles, activeOrgId, uid, member, userEmail } = useRole();

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
  // The workspace's settings could not be read: the form shows the built-in
  // lists, which the server may refuse — said on the page, with a retry.
  const [configError, setConfigError] = useState(false);
  // DCW-7 / FRIC-3: the Site Codebook's unit list exists but could not be
  // read — the form offers no unit (the request files as "Unit unknown") and
  // says so, as the route does when ITS read fails: never a free-text box
  // the route would check against a list this page could not show.
  const [unitListError, setUnitListError] = useState(false);
  const [configAttempt, setConfigAttempt] = useState(0);

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
  // DF-P6 (GAP-110 / DEC-34): the optional like-in-kind declaration, and the
  // signing ceremony it runs at submit (resolved with the signature id, or
  // null when the requester backs out).
  const [declaration, setDeclaration] = useState('');
  const [signing, setSigning] = useState<{ statement: string; ticketKey: string; resolve: (id: string | null) => void } | null>(null);
  const [signBusy, setSignBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  // DF-P6 (GAP-312): the equipment the request names (optional).
  const [equipmentText, setEquipmentText] = useState('');
  const [showWorkflowMap, setShowWorkflowMap] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  // LIFE-4: the book-viewer hand-off stashes the marked-up sheet's document id
  // next to the blob. Keep it, so the ticket carries metadata.source_document
  // in the marked-up case too — that link is what the Impact panel and the
  // drafting-intent bridge key on. The first sheet is the singular
  // source_document; GAP-8 lists every sheet in source_documents beside it.
  const [stashedDoc, setStashedDoc] = useState<{ id: string; number: string } | null>(null);
  // GAP-8: every marked-up sheet the hand-off carried, in order — the first
  // is the primary (`stashedDoc`), the rest ride in metadata.source_documents.
  const [stashedDocs, setStashedDocs] = useState<Array<{ id: string; number: string }>>([]);
  const srcDocId = sourceDocId || stashedDoc?.id || '';
  const srcDocNum = sourceDocNum || stashedDoc?.number || '';
  // DCW-5 (DF-P4): with no hand-off, the requester may still NAME the
  // document the request is about — by number, through their own session
  // (the database returns a document they may at least discover, never its
  // file). The route reads it again as the requester (DEC-101 item 5) and
  // derives the request's library from it (GAP-105).
  const [linkedDoc, setLinkedDoc] = useState<{ id: string; number: string | null; title: string | null; rev: string | null } | null>(null);
  const [docQuery, setDocQuery] = useState('');
  const [docResults, setDocResults] = useState<Array<{ id: string; number: string | null; title: string | null; rev: string | null }>>([]);
  const [docSearch, setDocSearch] = useState<'idle' | 'searching' | 'error'>('idle');
  const findDocuments = async () => {
    const q = linkableDocumentQuery(docQuery);
    if (!q || !activeOrgId) { setDocResults([]); setDocSearch('idle'); return; }
    setDocSearch('searching');
    const { data, error } = await supabase
      .from('documents').select('id, document_number, title, rev')
      .eq('org_id', activeOrgId).or(linkableDocumentFilter(q)).limit(8);
    if (error) { setDocResults([]); setDocSearch('error'); return; }
    setDocResults(((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id), number: (r.document_number as string | null) ?? null, title: (r.title as string | null) ?? null, rev: (r.rev as string | null) ?? null,
    })));
    setDocSearch('idle');
  };

  // Pull in marked-up PDFs handed off from the book viewer (stashed in
  // IndexedDB) and attach them as files, so they upload with the request.
  // The stash is read, not consumed (LIFE-3): it is discarded on submit, so a
  // refresh before submitting still yields the file.
  useEffect(() => {
    if (!draftKey) return;
    let alive = true;
    readDraft(draftKey)
      .then((d) => {
        if (!alive || !d || d.files.length === 0) return;
        const fs = d.files.map((f) => new File([f.blob], f.name, { type: f.blob.type || 'application/pdf' }));
        setFiles((prev) => {
          const have = new Set(prev.map((f) => f.name));
          return [...prev, ...fs.filter((f) => !have.has(f.name))];
        });
        const withDoc = d.files.find((f) => f.docId);
        if (withDoc?.docId) setStashedDoc({ id: withDoc.docId, number: withDoc.docNumber ?? '' });
        const seenDocs = new Set<string>();
        setStashedDocs(d.files.flatMap((f) => {
          if (!f.docId || seenDocs.has(f.docId)) return [];
          seenDocs.add(f.docId);
          return [{ id: f.docId, number: f.docNumber ?? '' }];
        }));
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

  // --- FETCH CONFIG ---
  useEffect(() => {
    if (!activeOrgId) return;
    const loadConfig = async () => {
      setLoadingConfig(true);
      try {
        const { data, error } = await supabase
          .from('org_configurations')
          .select('data')
          .eq('org_id', activeOrgId)
          .eq('key', 'drafting')
          .maybeSingle();
        setConfigError(!!error);
        // The SAVED settings — null when this workspace never saved any (no
        // row), which is not an error.
        const saved = error ? null : ((data?.data as OrgDraftingSettings | null | undefined) ?? null);
        const cfg: OrgDraftingSettings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
        // A saved request-type list an admin emptied (Admin → Requests allows
        // it) would leave nothing to pick, and the route needs a type: the
        // built-in list stands in — the route takes any type when the
        // workspace configures none (20261038's rule, requestTypeAllowed).
        if (!((cfg.requestTypes?.options?.length ?? 0) > 0)) {
          cfg.requestTypes = { ...DEFAULT_SETTINGS.requestTypes, label: cfg.requestTypes?.label || DEFAULT_SETTINGS.requestTypes.label };
        }
        // DCW-7: the unit list is the one the create route checks against —
        // unitOptionsFor(saved settings, Site Codebook units): the saved units,
        // else the codebook's (taught once in Admin → Site Codebook, spoken
        // here too), else none (free text).
        // The codebook read is classed as the route classes its own
        // (unitListReadFailure): not there yet → no list (free text); there
        // but unreadable → no unit offered, said on the page.
        let codebookUnits: Array<{ code: string; label: string | null }> = [];
        let unitsUnreadable = false;
        if (!((saved?.units?.options?.length ?? 0) > 0)) {
          const read = await loadCodebookUnitList(activeOrgId);
          codebookUnits = read.units;
          unitsUnreadable = read.failure === 'unreadable';
        }
        setUnitListError(unitsUnreadable);
        if (unitsUnreadable) setUnit('');
        cfg.units = {
          label: saved?.units?.label ?? DEFAULT_SETTINGS.units.label,
          enabled: saved?.units?.enabled ?? true,
          options: unitOptionsFor(saved, codebookUnits).map((o) => ({ label: o.label, value: o.value })),
        };
        setConfig(cfg);
        if (cfg.requestTypes?.options?.length > 0) setRequestType(String(cfg.requestTypes.options[0].value));
        // FRIC-3 / DCW-7: unit is optional, and "unknown" is an explicit
        // answer. A one-unit workspace has only one honest answer and gets it;
        // with several, nothing is silently pre-selected (the first unit in the
        // list filed requests against the wrong area).
        if (cfg.units?.options?.length === 1) setUnit(String(cfg.units.options[0].value));
        if (cfg.priorities?.options?.length > 0) {
          const mid = Math.floor(cfg.priorities.options.length / 2);
          setPriority(Number(cfg.priorities.options[mid].value));
        }
      } catch (e) {
        console.error("Config Load Failed", e);
        setConfigError(true);
      } finally {
        setLoadingConfig(false);
      }
    };
    loadConfig();
  }, [activeOrgId, configAttempt]);

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

  // FRIC-3 done-when 1: a refused submit says which field and puts the
  // cursor there. Field names are the contract's (lib/ticketCreate.ts).
  const focusField = (field: string) => {
    const id = field.startsWith('custom:') ? `custom-${field.slice(7).replace('.', '-')}` : `request-${field}`;
    const el = document.getElementById(id) as HTMLElement | null;
    el?.focus();
    el?.scrollIntoView?.({ block: 'center' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The inputs are `required`, so the browser normally stops this first;
    // a value of only spaces gets here and is named, never a silent return.
    if (!title.trim() || !description.trim()) {
      const field = !title.trim() ? 'title' : 'description';
      await appAlert(field === 'title' ? 'A title is required.' : 'A description of the work is required.');
      focusField(field);
      return;
    }
    if (!activeOrgId) {
      await appAlert("No active workspace selected.");
      return;
    }
    if (!uid) {
      await appAlert({ message: "Failed to create ticket: Not authenticated", tone: "danger" });
      return;
    }
    // EDGE-13: every check the form can make runs BEFORE any file is uploaded
    // and before the request has a number — the server repeats them, and
    // allocates the number only once they pass.
    const missing = missingRequiredCustomField(config, customValues);
    if (missing) {
      await appAlert(missing.error);
      focusField(missing.field);
      return;
    }
    // The contract's size limits too (the route applies the same rule).
    const tooBig = contractLimitRefusal({ title, description, attachmentCount: files.length + (sourceFileUrl ? 1 : 0) });
    if (tooBig) {
      await appAlert(tooBig.error);
      focusField(tooBig.field);
      return;
    }

    // DF-P6 (GAP-110 / DEC-33 / DEC-34): a declaration, when written, is
    // checked and SIGNED before anything is uploaded or numbered — blank is
    // the safe answer and asks nothing. The signature is minted against the
    // id the request will be filed under.
    let declarationBody: { statement: string; signatureId: string; ticketKey: string } | null = null;
    if (declaration.trim()) {
      const checked = checkDeclarationStatement(declaration);
      if (!checked.ok) {
        await appAlert(checked.error);
        focusField('declaration');
        return;
      }
      const ticketKey = crypto.randomUUID();
      setSignError(null);
      const signatureId = await new Promise<string | null>((resolve) => setSigning({ statement: checked.statement, ticketKey, resolve }));
      setSigning(null);
      if (!signatureId) {
        await appAlert('The request was not filed: the like-in-kind declaration was not signed. Sign it, or clear it to file the request for engineering.');
        focusField('declaration');
        return;
      }
      declarationBody = { statement: checked.statement, signatureId, ticketKey };
    }

    setIsSubmitting(true);
    setUploadStatus('Initializing Request...');

    // DF-P6 (GAP-312): each equipment tag resolved against the registry by
    // its tag alone (the registry's normalised tag, no document links, no AI
    // call) — a tag it does not find is sent as typed (the route keeps it,
    // flagged). DF-P6 fix pass (minor 14): a read that FAILS is sent as
    // "lookup failed", never as "not found".
    const equipment: Array<{ tag: string; assetId: string | null; lookupFailed?: boolean }> = [];
    for (const tag of parseEquipmentTags(equipmentText)) {
      const key = tagKey(tag);
      if (key.length < 2) { equipment.push({ tag, assetId: null }); continue; }
      try {
        const { data, error } = await supabase.from('assets').select('id, archived')
          .eq('org_id', activeOrgId).eq('tag_normalized', key).limit(5);
        if (error) { equipment.push({ tag, assetId: null, lookupFailed: true }); continue; }
        const live = ((data ?? []) as Array<{ id: string; archived?: boolean | null }>).filter((a) => !a.archived);
        equipment.push({ tag, assetId: live.length === 1 ? live[0].id : null });
      } catch {
        equipment.push({ tag, assetId: null, lookupFailed: true });
      }
    }

    // Files are staged under this requester's pending prefix; the route moves
    // them under the request's own number once the row exists.
    const staged: Array<{ key: string; name: string }> = [];
    try {
      if (files.length > 0) {
        setUploadStatus(`Uploading ${files.length} files...`);
        const batch = crypto.randomUUID();
        for (const file of files) {
          const result = await uploadTicketAttachment({ file, orgId: activeOrgId, ticketId: ticketStagingFolder(uid, batch) });
          staged.push({ key: result.url, name: file.name });
        }
      }
    } catch (error) {
      console.error("Attachment upload failed:", error);
      void discardStagedFiles(activeOrgId, staged.map((f) => f.key));
      const msg = error instanceof Error ? error.message : String(error);
      await appAlert({ message: `Failed to create ticket: ${msg}`, tone: "danger" });
      setIsSubmitting(false);
      setUploadStatus('');
      return;
    }

    setUploadStatus('Finalizing Ticket...');
    // If we arrived via "Send to Drafting" with a source file URL, attach it
    // as a Source reference (the R2 storage path — FileViewerModal resolves
    // it to a presigned URL on view).
    const attachments: TicketCreateAttachment[] = [
      ...(sourceFileUrl ? [{ kind: 'source_reference' as const, key: sourceFileUrl, name: sourceFileName || sourceDocNum || 'source.pdf' }] : []),
      ...staged.map((f) => ({ kind: 'staged' as const, key: f.key, name: f.name })),
    ];
    // The source documents, primary first (LIFE-4: the stashed sheet when
    // no document came by URL; GAP-8: every other stashed sheet after it).
    const sourceDocuments: TicketCreateSourceDoc[] = [];
    if (srcDocId) {
      sourceDocuments.push({ id: srcDocId, documentNumber: srcDocNum || null, title: sourceDocTitle || null, rev: sourceDocRev || null, versionId: null });
    } else if (linkedDoc) {
      // DCW-5: a document named by number (no file attached).
      sourceDocuments.push({ id: linkedDoc.id, documentNumber: linkedDoc.number, title: linkedDoc.title, rev: linkedDoc.rev, versionId: null });
    }
    for (const d of stashedDocs) {
      if (d.id !== srcDocId) sourceDocuments.push({ id: d.id, documentNumber: d.number || null, title: null, rev: null, versionId: null });
    }
    // GAP-8 / DEC-101 item 5: the sheet list is advisory — the same
    // cap the route keeps, applied here; the sheets past it are named after
    // filing, never a refusal.
    const cappedDocs = capSourceDocuments(sourceDocuments);
    const formWarnings = cappedDocs.dropped > 0 ? [droppedSourceDocumentsWarning(cappedDocs.dropped)] : [];

    const res = await submitTicketCreate({
      orgId: activeOrgId,
      title, description,
      requestType,
      priority,
      unit: unitListError ? null : (unit || null),
      targetCompletionAt: targetDate ? new Date(targetDate).toISOString() : null,
      // ADD-3: the role that decides approval routing is chosen by
      // relevance (an engineer tier held anywhere waives the engineer
      // route), not by the headline's rank — and kept only if held.
      requesterRole: relevantRequesterRole(roles, activeRole),
      customCategories: Object.keys(customValues).length > 0 ? customValues : null,
      sourceDocuments: cappedDocs.kept,
      attachments,
      origin: { kind: 'portal' },
      ...(declarationBody ? { declaration: declarationBody } : {}),
      ...(equipment.length > 0 ? { equipment } : {}),
    });
    if (!res.ok) {
      console.error("Creation failed:", res.error);
      await appAlert({ message: `Failed to create ticket: ${res.error}`, tone: "danger" });
      if (res.field) focusField(res.field);
      setIsSubmitting(false);
      setUploadStatus('');
      return;
    }
    // The hand-off stash has done its job (LIFE-3): drop it now, not on read.
    if (draftKey) void discardDraft(draftKey).catch(() => { /* best-effort */ });
    // A hand-off the route could not use (a source document since removed or
    // not visible to you, a file outside this workspace, sheets past the
    // cap) was dropped, not refused — say what.
    // EDGE-8: the route filed the request but could not tell the assignment
    // queue (the notice failed, or nobody holds the queue) — said here, never
    // a 'Done!' that looks told.
    const notTold = queueNotNotifiedLine(res);
    const warnings = [...formWarnings, ...(res.warnings ?? []), ...(notTold ? [notTold] : [])];
    if (warnings.length > 0) {
      await appAlert({ title: `Filed ${res.ticketNumber}`, message: warnings.join(' ') });
    }

    // EDGE-8: the route filed (and notified, or said it could not) before it
    // answered — nothing is left for this tab to finish, so the redirect
    // waits on nothing.
    setUploadStatus('Done!');
    router.push('/requests');
  };

  if (loadingConfig) {
    return (
      <div className="min-h-full flex items-center justify-center">
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
              <IsoGuidance topic="drafting_request_intent" />{" "}
              <button
                type="button"
                onClick={() => setShowWorkflowMap(true)}
                className="inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-800 hover:underline"
              >
                <GitBranch className="w-3.5 h-3.5" /> See how a request flows
              </button>
            </>
          }
        />
      </div>
      {showWorkflowMap && <WorkflowDiagramModal onClose={() => setShowWorkflowMap(false)} />}

        <form onSubmit={handleSubmit} className="space-y-6">

          {configError && (
            <div role="alert" className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-3 text-xs text-amber-900">
              <span className="flex-1">
                Couldn&apos;t load this workspace&apos;s request settings — the lists below are the built-in ones, and the
                request may be refused for a type or unit this workspace doesn&apos;t use.
              </span>
              <button
                type="button"
                onClick={() => setConfigAttempt((n) => n + 1)}
                className="px-3 py-1.5 rounded-lg border border-amber-300 bg-[var(--color-surface)] font-bold hover:bg-amber-100"
              >
                Try again
              </button>
            </div>
          )}

          {/* Source-document chip when arriving via "Send to Drafting" */}
          {(srcDocId || sourceFileUrl) && (
            <div id="request-sourceDocuments" tabIndex={-1} className="bg-teal-50 border border-teal-200 rounded-xl p-3 flex items-start gap-3">
              <FileText className="w-5 h-5 text-teal-700 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-black text-teal-800 uppercase tracking-widest">Source document</div>
                <div className="text-sm font-bold text-[var(--color-text)] truncate mt-0.5">
                  {srcDocNum || sourceDocTitle || sourceFileName || 'Document'} {sourceDocRev ? `· Rev ${sourceDocRev}` : ''}
                </div>
                <div className="text-[11px] text-teal-700 mt-0.5">
                  {sourceFileUrl
                    ? <>Attached automatically as a Source reference. It&apos;ll appear on the ticket once you submit.</>
                    : <>Your marked-up sheet is attached. The ticket will link back to this document once you submit.</>}
                </div>
              </div>
            </div>
          )}

          {/* DCW-5 (DF-P4): name the document without opening it */}
          {!srcDocId && !sourceFileUrl && (
            <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4" data-testid="link-document">
              <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">Document this request is about (optional)</div>
              {linkedDoc ? (
                <div className="mt-2 flex items-start gap-3">
                  <FileText className="w-5 h-5 text-teal-700 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-[var(--color-text)] truncate">{linkedDoc.number || linkedDoc.title || 'Document'}{linkedDoc.rev ? ` · Rev ${linkedDoc.rev}` : ''}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">Linked by number only — no file is attached and none of the document&apos;s content is copied into the request; triage opens it with their own access.</div>
                  </div>
                  <button type="button" className="text-xs font-bold text-[var(--color-text-muted)] underline" onClick={() => setLinkedDoc(null)}>Remove</button>
                </div>
              ) : (
                <div className="mt-2">
                  <div className="flex gap-2">
                    <Input
                      value={docQuery}
                      onChange={(e) => setDocQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void findDocuments(); } }}
                      placeholder="Type a document number or title"
                      aria-label="Find the document by number"
                    />
                    <button type="button" className="text-xs font-bold px-3 rounded-lg border border-[var(--color-border)]"
                      disabled={docSearch === 'searching' || !linkableDocumentQuery(docQuery)} onClick={() => { void findDocuments(); }}>
                      {docSearch === 'searching' ? 'Finding…' : 'Find'}
                    </button>
                  </div>
                  {docSearch === 'error' && <div role="alert" className="text-[11px] text-amber-700 mt-1">Couldn&apos;t search the documents right now — you can still file the request and name the document in the description.</div>}
                  {docResults.length > 0 && (
                    <ul className="mt-2 border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)]">
                      {docResults.map((d) => (
                        <li key={d.id}>
                          <button type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-surface-2)]"
                            onClick={() => { setLinkedDoc(d); setDocQuery(''); setDocResults([]); }}>
                            <span className="font-bold">{d.number || 'Document'}</span>{d.title ? ` — ${d.title}` : ''}{d.rev ? ` · Rev ${d.rev}` : ''}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
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
                  id="request-requestType"
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
                  {config.units.label} <span className="text-[var(--color-text-faint)] font-normal text-xs">(optional)</span>
                </label>
                {unitListError ? (
                  <div role="alert" id="request-unit-unreadable" className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-3 text-xs text-amber-900">
                    <span className="flex-1">
                      Couldn&apos;t load this workspace&apos;s unit list — retry, or file the request with no unit
                      (&ldquo;{UNIT_UNKNOWN_LABEL}&rdquo;).
                    </span>
                    <button
                      type="button"
                      onClick={() => setConfigAttempt((n) => n + 1)}
                      className="px-3 py-1.5 rounded-lg border border-amber-300 bg-[var(--color-surface)] font-bold hover:bg-amber-100"
                    >
                      Try again
                    </button>
                  </div>
                ) : config.units.options.length > 0 ? (
                  <Select
                    id="request-unit"
                    className="font-medium"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  >
                    {/* FRIC-3: not knowing the unit is an answer, never a dead end. */}
                    <option value="">{UNIT_UNKNOWN_LABEL}</option>
                    {config.units.options.map((opt, idx) => (
                      <option key={idx} value={opt.value}>{opt.label}</option>
                    ))}
                  </Select>
                ) : (
                  <>
                    <Input
                      id="request-unit"
                      type="text"
                      placeholder="e.g. 20-CRUDE — or leave blank"
                      value={unit}
                      onChange={(e) => setUnit(e.target.value.toUpperCase())}
                    />
                    {/* DCW-7: the free-text box is a setup gap, and says so. */}
                    <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                      This workspace has no unit list yet — an admin can add one in Admin → Site Codebook.
                      Leave it blank if you don&apos;t know: {UNIT_UNKNOWN_LABEL.toLowerCase()}.
                    </p>
                  </>
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
                id="request-title"
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
                id="request-description"
                className="w-full p-3 h-32 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-orange-500 outline-none resize-none transition-all text-sm"
                placeholder="Describe the work required in detail..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>
          </div>

          {/* DF-P6: the like-in-kind declaration and the equipment (both optional) */}
          <LikeInKindField
            declaration={declaration}
            onDeclarationChange={setDeclaration}
            equipment={equipmentText}
            onEquipmentChange={setEquipmentText}
            disabled={isSubmitting}
          />
          {signing && (
            <SignatureCeremony
              signerName={(member?.displayName ?? '').trim() || (userEmail?.split('@')[0] ?? '').trim() || 'user'}
              resourceLabel="this request's like-in-kind declaration"
              defaultIntent={DECLARATION_SIGNATURE_INTENT}
              defaultStatement={declarationSignatureStatement(signing.statement)}
              lockIntent
              busy={signBusy}
              error={signError}
              onCancel={() => { if (!signBusy) signing.resolve(null); }}
              onSign={async (_intent, statement, signatureImage, reauth?: SigningCredential) => {
                if (!activeOrgId || !uid) { signing.resolve(null); return; }
                setSignBusy(true);
                try {
                  const sig = await recordSignature({
                    orgId: activeOrgId, resourceType: 'ticket', resourceId: signing.ticketKey,
                    intent: DECLARATION_SIGNATURE_INTENT, statement,
                    signerUserId: uid, signerName: (member?.displayName ?? '').trim() || (userEmail?.split('@')[0] ?? ''),
                    signatureImage: signatureImage ?? null, reauth: reauth ?? null,
                  });
                  signing.resolve(sig.id);
                } catch (err) {
                  setSignError((err as Error)?.message || 'The signature could not be recorded.');
                } finally {
                  setSignBusy(false);
                }
              }}
            />
          )}

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
              id="request-attachments"
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
import { relevantRequesterRole } from '@/lib/roleCapabilities';

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
          <CustomFieldRenderer key={f.key} domId={`custom-${category.id}-${f.key}`} field={f} value={values[f.key]} onChange={(v) => setField(f.key, v)} />
        ))}
      </div>
    </div>
  );
}

function CustomFieldRenderer({
  domId, field, value, onChange,
}: {
  /** FRIC-3: the id a refused submit focuses. */
  domId: string;
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
            id={domId}
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
            id={domId}
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
            id={domId}
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
            id={domId}
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
              id={domId}
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
            id={domId}
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
          <div id={domId} tabIndex={-1} className="flex flex-wrap gap-1.5">
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
