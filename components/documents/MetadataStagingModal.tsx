"use client";

// MetadataStagingModal — pre-upload metadata staging grid.
//
// Drop / pick files → this modal opens BEFORE any bytes get uploaded.
// User reviews / edits metadata for each file in a table, then clicks
// "Upload All" which kicks off the actual R2 upload + document inserts.
//
// Filename hints are pre-populated by lib/filenameParser so most files
// only need a quick review, not field-by-field entry.
//
// Bulk-apply controls at the top let the user set status / type / unit
// for every selected row at once — critical when uploading 50 files
// at the same time.

import React, { useEffect, useMemo, useState } from "react";
import {
  X, Upload, AlertTriangle, CheckCircle2, Loader2, Wand2,
  FileText, Copy, Trash2, Info, KeyRound, FolderTree, ChevronDown, ChevronRight,
} from "lucide-react";
import { parseFilename, detectBulkHints, withHints, type ParsedFilename } from "@/lib/filenameParser";
import { readBatch, type NameRole } from "@/lib/filenameRoles";
import NameReadingStrip from "@/components/documents/NameReadingStrip";
import { computeUniquenessKey } from "@/lib/uniqueness";
import { hashFile, findExistingCopies, type ExistingCopy } from "@/lib/duplicateFiles";

export interface CustomColumnDef {
  key: string;
  label: string;
  type: "text" | "select" | "number" | "date";
  required?: boolean;
  options?: string[];
}

/** What a submit achieved. The files that landed leave the list, so a
 *  second click can only ever send what's left — never the batch again. */
export interface UploadOutcome {
  landed: File[];
  message: string;
  /** Files that still failed, each with the reason — shown in the window. */
  failed?: Array<{ file: File; reason: string }>;
}

export interface StagedItem {
  id: string;
  file: File;
  documentNumber: string;
  title: string;
  rev: string;
  status: string;
  customFields: Record<string, string>;
  hints: ParsedFilename["hints"];
  /** What the file name gave, so a re-read of the names only replaces
   *  fields nobody has typed over. */
  parsed?: { documentNumber: string; title: string; rev: string };
  /** SHA-256 of the bytes, worked out while the person reviews. */
  fileHash?: string;
}

interface MetadataStagingModalProps {
  isOpen: boolean;
  files: File[];
  customColumns?: CustomColumnDef[];
  defaultStatus?: string;
  statusOptions?: string[];
  onCancel: () => void;
  /** `signal` aborts the in-flight transfers when the user presses Stop.
   *  Implementations should pass it to uploadToPath and treat
   *  UploadCancelledError as "the user stopped this", not as a failure. */
  onSubmit: (items: StagedItem[], signal?: AbortSignal) => Promise<void | UploadOutcome>;
  /** Opens the parent's column-add wizard. When this completes, the
   *  parent should refresh customColumns; the modal will pick up the
   *  new column via its prop. */
  onAddColumn?: () => void;
  /** Library's current uniqueness-tuple config. Default (undefined/[]) =
   *  ['documentNumber']. The modal uses this to warn when a batch would
   *  produce duplicate keys before the DB rejects on insert. */
  uniquenessKeys?: string[];
  /** One-click fix: add a "Sheet" column to the library and add it to
   *  the uniqueness tuple. Surfaced as a banner action when the modal
   *  detects same-doc-number-multiple-files. */
  onAddSheetAndUseForUniqueness?: () => Promise<void>;
  /** When set, each file is checked against what the org already holds. */
  orgId?: string;
  /** How this library's file names read (the person's answers) is
   *  remembered per library. */
  libraryId?: string;
  /** A folder upload: the batch keeps its subfolder tree. The window leads
   *  with a one-click "upload as-is" summary; per-file rows are optional. */
  folderUpload?: {
    destination: string;
    pathOf: (f: File) => string[] | undefined;
  };
  /** Live transfer count while submitting. */
  progress?: { done: number; total: number; phase?: string } | null;
}

const DEFAULT_STATUS_OPTIONS = ["Draft", "In Review", "Issued", "IFC", "Superseded"];

export default function MetadataStagingModal({
  isOpen, files, customColumns = [], defaultStatus = "Issued",
  statusOptions = DEFAULT_STATUS_OPTIONS,
  onCancel, onSubmit, onAddColumn,
  uniquenessKeys, onAddSheetAndUseForUniqueness, orgId, libraryId, folderUpload, progress,
}: MetadataStagingModalProps) {
  // ── How the file names read ───────────────────────────────────────
  // Any convention, any order (lib/filenameRoles). The person's answers —
  // "this piece is the revision" — are kept per library on this device.
  const rolesKey = `filenameRoles:${libraryId ?? "any"}`;
  const loadRoles = (): Record<string, NameRole[]> => {
    try { return JSON.parse(window.localStorage.getItem(rolesKey) ?? "{}") as Record<string, NameRole[]>; } catch { return {}; }
  };
  const [nameRoles, setNameRoles] = useState<Record<string, NameRole[]>>({});
  const nameReadings = useMemo(
    () => (isOpen ? readBatch(files.map((f) => f.name), nameRoles).map((r, i) => ({ ...r, file: files[i].name })) : []),
    [isOpen, files, nameRoles],
  );
  const [showDetails, setShowDetails] = useState(false);
  // The folder tree, summarised: top-level folders with file counts.
  const folderSummary = useMemo(() => {
    if (!folderUpload) return null;
    const all = new Set<string>();
    const top = new Map<string, number>();
    let loose = 0;
    for (const f of files) {
      const rel = folderUpload.pathOf(f) ?? [];
      if (rel.length === 0) { loose++; continue; }
      for (let i = 1; i <= rel.length; i++) all.add(rel.slice(0, i).join("/").toLowerCase());
      const key = rel.length > 1 ? `${rel[0]}/${rel[1]}` : rel[0];
      top.set(key, (top.get(key) ?? 0) + 1);
    }
    return { folders: all.size, top: [...top.entries()].sort((a, b) => a[0].localeCompare(b[0])), loose };
  }, [folderUpload, files]);
  const detailed = !folderUpload || showDetails;
  // Big batches skip the browser-side extras below (they read every file in
  // full before you've clicked anything); the upload fingerprints each file
  // as it sends it instead, so nothing is lost.
  const heavyBatch = files.length > 150;
  // ── Same bytes already here? ──────────────────────────────────────
  // Hashed in the browser while the person reviews; nothing waits on it.
  const [hashes, setHashes] = useState<Map<File, string>>(new Map());
  const [copies, setCopies] = useState<Map<string, ExistingCopy[]>>(new Map());
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!isOpen || files.length === 0 || heavyBatch) { setHashes(new Map()); setCopies(new Map()); setChecking(false); return; }
    let live = true;
    setChecking(true);
    (async () => {
      const h = new Map<File, string>();
      for (const f of files) {
        const x = await hashFile(f);
        if (!live) return;
        if (x) h.set(f, x);
      }
      setHashes(h);
      const found = orgId ? await findExistingCopies(orgId, [...h.values()]) : new Map<string, ExistingCopy[]>();
      if (live) { setCopies(found); setChecking(false); }
    })().catch(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [isOpen, files, orgId, heavyBatch]);

  const [fixingUniqueness, setFixingUniqueness] = useState(false);
  const [items, setItems] = useState<StagedItem[]>([]);
  // Count of fields auto-filled by reading page-1 title-block text.
  const [tbFilled, setTbFilled] = useState(0);
  const [bulkType, setBulkType] = useState("");
  const [bulkUnit, setBulkUnit] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a partial run: what happened, in the window (not behind it).
  const [outcome, setOutcome] = useState<string | null>(null);
  // A 1,000-row grid of inputs takes seconds to draw; the first 200 are
  // enough to review, the rest are a click away (bulk-apply covers all).
  const [showAllRows, setShowAllRows] = useState(false);
  const [failedWhy, setFailedWhy] = useState<Array<{ file: File; reason: string }>>([]);
  // Held for the life of one submit so Stop can abort the transfers that are
  // actually on the wire, not merely stop rendering a spinner over them.
  const abortRef = React.useRef<AbortController | null>(null);

  // Detect when the user has defined library columns that map to the
  // canonical document fields (number / title / rev). When they exist,
  // we hide the hardcoded column and route the user's custom column's
  // input straight to the canonical field — so they only see ONE input
  // per concept (e.g. their "No." column instead of "No." + "Document #").
  const canonical = useMemo(() => {
    const find = (re: RegExp) =>
      customColumns.find((c) => re.test((c.label || "").trim()) || re.test((c.key || "").trim()));
    return {
      docNumber: find(/^(doc(ument)?[\s_-]*(#|number|no\.?|num)?|number|no\.?|#|num)$/i),
      title: find(/^(title|name|description|desc)$/i),
      rev: find(/^(rev(ision)?)$/i),
      status: find(/^status$/i),
    };
  }, [customColumns]);
  const canonicalKeys = useMemo(() => new Set(
    [canonical.docNumber?.key, canonical.title?.key, canonical.rev?.key, canonical.status?.key].filter(Boolean) as string[]
  ), [canonical]);

  // Initialize staged items when the modal opens. After that the rows
  // are user-editable; we don't blow them away when customColumns
  // changes (e.g. user clicks "Add Sheet" mid-staging — that should
  // ADD the column to existing rows, not reset them).
  useEffect(() => {
    if (!isOpen) return;
    const roles = loadRoles();
    setNameRoles(roles);
    const batch = readBatch(files.map((f) => f.name), roles);
    const next: StagedItem[] = files.map((file, idx) => {
      const parsed = withHints(file.name.replace(/\.[^.]+$/, ""), batch[idx].fields);
      const customFields: Record<string, string> = {};
      if (parsed.hints.type) {
        const typeCol = customColumns.find((c) =>
          (/type/i.test(c.key) || /type/i.test(c.label)) && !canonicalKeys.has(c.key)
        );
        if (typeCol) customFields[typeCol.key] = parsed.hints.type;
      }
      if (parsed.hints.unit) {
        const unitCol = customColumns.find((c) =>
          (/unit/i.test(c.key) || /area/i.test(c.key)) && !canonicalKeys.has(c.key)
        );
        if (unitCol) customFields[unitCol.key] = parsed.hints.unit;
      }
      if (parsed.hints.sheet) {
        const sheetCol = customColumns.find((c) =>
          /sheet/i.test(c.key) && !canonicalKeys.has(c.key)
        );
        if (sheetCol) customFields[sheetCol.key] = parsed.hints.sheet;
      }
      return {
        id: `staged-${idx}-${file.name}`,
        file,
        documentNumber: parsed.documentNumber,
        title: parsed.title,
        rev: parsed.rev,
        status: defaultStatus,
        customFields,
        hints: parsed.hints,
        parsed: { documentNumber: parsed.documentNumber, title: parsed.title, rev: parsed.rev },
      };
    });
    setItems(next);

    const detected = detectBulkHints(next.map((it) => parseFilename(it.file.name)));
    if (detected.commonUnit) setBulkUnit(detected.commonUnit);
    if (detected.commonType) setBulkType(detected.commonType);
    setError(null);
    // Every open starts from a clean submit state. Without this, a modal
    // instance that stayed mounted after a previous batch (this component is
    // rendered unconditionally and hides itself with `isOpen`) reopens still
    // holding submitting=true from that batch — which disables Upload All,
    // disables Cancel, disables the X, and renders "Uploading…" over a batch
    // that never started. That is exactly "the second batch gets stuck and I
    // can't even close it".
    abortRef.current?.abort();
    abortRef.current = null;
    setSubmitting(false);
    setStopping(false);

    // SECOND PASS — read the drawings themselves. Page-1 text often carries
    // the real drawing number + revision from the title block. Applied only
    // where the filename parse left the default (never over user edits),
    // small concurrency, totally best-effort.
    setTbFilled(0);
    setOutcome(null);
    setFailedWhy([]);
    const cancel = new AbortController();
    void (async () => {
      // Enrichment is a convenience; an upload is someone waiting. Reading N
      // drawings means N whole files in memory and N pdf.js parses on this
      // thread — run that alongside a batch that is already transferring and
      // both crawl. Skip; the filename parse still fills these rows.
      if (next.length > 40) return; // a folder of hundreds: filenames are enough
      const { isUploading } = await import("@/lib/uploadActivity");
      if (cancel.signal.aborted || isUploading()) return;
      const { readTitleBlock } = await import("@/lib/titleBlock");
      const CONCURRENCY = 3;
      let filled = 0;
      for (let i = 0; i < next.length; i += CONCURRENCY) {
        // Re-checked every chunk: the modal may have closed, a new batch may
        // have replaced this one, or the user may have hit Upload All while
        // we were still reading. Any of those and this pass is now waste
        // competing with work that matters.
        if (cancel.signal.aborted || isUploading()) return;
        const chunk = next.slice(i, i + CONCURRENCY);
        // allSettled: readTitleBlock swallows its own failures, but a rejected
        // promise here would abandon every remaining file silently.
        const guesses = await Promise.allSettled(
          chunk.map((staged) => readTitleBlock(staged.file, cancel.signal)),
        );
        if (cancel.signal.aborted) return;
        // Applied in ONE update per chunk, and the counter is computed here
        // rather than mutated inside the updater — a state updater must be
        // pure, or StrictMode's double-invoke double-counts it.
        setItems((prev) => prev.map((it) => {
          const idx = chunk.findIndex((c) => c.id === it.id);
          if (idx < 0) return it;
          const settled = guesses[idx];
          if (settled.status !== "fulfilled") return it;
          const guess = settled.value;
          if (guess.confidence < 0.4) return it;
          const parsed = it.parsed ?? parseFilename(it.file.name);
          const patch: Partial<StagedItem> = {};
          // Only replace values still equal to the filename default —
          // the user's typing always wins.
          if (guess.docNumber && it.documentNumber === parsed.documentNumber && guess.docNumber !== it.documentNumber) {
            patch.documentNumber = guess.docNumber;
          }
          if (guess.rev && it.rev === parsed.rev && guess.rev !== it.rev) {
            patch.rev = guess.rev;
          }
          return Object.keys(patch).length > 0 ? { ...it, ...patch } : it;
        }));
        filled += guesses.filter((g) => g.status === "fulfilled" && g.value.confidence >= 0.4).length;
        setTbFilled(filled);
      }
    })();
    return () => { cancel.abort(); };
    // Intentionally ONLY runs on open. Adding customColumns to the
    // deps would wipe in-progress user edits whenever a column was
    // added mid-staging. See secondary effect below for the
    // post-add fill.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, files, defaultStatus]);

  // The person says what a piece of the name is: every file with that
  // pattern is re-read, and fields nobody has typed over follow.
  const setNameRole = (shape: string, roles: NameRole[]) => {
    const next = { ...nameRoles, [shape]: roles };
    setNameRoles(next);
    try { window.localStorage.setItem(rolesKey, JSON.stringify(next)); } catch { /* remembered for this window only */ }
    const batch = readBatch(files.map((f) => f.name), next);
    const byFile = new Map(files.map((f, i) => [f, batch[i]]));
    setItems((prev) => prev.map((it) => {
      const b = byFile.get(it.file);
      if (!b || b.shape !== shape) return it;
      const fresh = withHints(it.file.name.replace(/\.[^.]+$/, ""), b.fields);
      const was = it.parsed;
      const keep = (k: "documentNumber" | "title" | "rev") => was && it[k] !== was[k];
      return {
        ...it,
        documentNumber: keep("documentNumber") ? it.documentNumber : fresh.documentNumber,
        title: keep("title") ? it.title : fresh.title,
        rev: keep("rev") ? it.rev : fresh.rev,
        hints: { ...it.hints, ...fresh.hints },
        parsed: { documentNumber: fresh.documentNumber, title: fresh.title, rev: fresh.rev },
      };
    }));
  };

  // Secondary: when customColumns CHANGES mid-staging (e.g. user
  // clicked "Add Sheet + use for uniqueness"), back-fill the new
  // column's parsed hint into each existing row WITHOUT wiping any
  // other user edits.
  useEffect(() => {
    if (!isOpen || items.length === 0) return;
    setItems((prev) => prev.map((it) => {
      const parsed = parseFilename(it.file.name);
      const customFields = { ...it.customFields };
      let changed = false;
      if (parsed.hints.sheet) {
        const sheetCol = customColumns.find((c) =>
          /sheet/i.test(c.key) && !canonicalKeys.has(c.key)
        );
        if (sheetCol && !customFields[sheetCol.key]) {
          customFields[sheetCol.key] = parsed.hints.sheet;
          changed = true;
        }
      }
      if (parsed.hints.type) {
        const typeCol = customColumns.find((c) =>
          (/type/i.test(c.key) || /type/i.test(c.label)) && !canonicalKeys.has(c.key)
        );
        if (typeCol && !customFields[typeCol.key]) {
          customFields[typeCol.key] = parsed.hints.type;
          changed = true;
        }
      }
      if (parsed.hints.unit) {
        const unitCol = customColumns.find((c) =>
          (/unit/i.test(c.key) || /area/i.test(c.key)) && !canonicalKeys.has(c.key)
        );
        if (unitCol && !customFields[unitCol.key]) {
          customFields[unitCol.key] = parsed.hints.unit;
          changed = true;
        }
      }
      return changed ? { ...it, customFields } : it;
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customColumns]);

  // Modal is informational. Parser + filename fallback in the DB
  // write produces a valid row from any file, so there's nothing the
  // user has to type. No required-field blocking, no duplicate
  // blocking — if the user wants to edit a row, they can; otherwise
  // they hit Upload All and go.
  const validation: Array<{ rowId: string; field: string; msg: string }> = [];

  // ── Predictive uniqueness check ───────────────────────────────────
  // Compute the DB uniqueness_key each row WOULD produce. If two rows
  // share one, the DB will reject the insert. We surface that here
  // with a banner that suggests a one-click fix (add a Sheet column +
  // include it in the uniqueness tuple), so the user doesn't have to
  // play whack-a-mole with the constraint error.
  const collisionPreview = useMemo(() => {
    const seen = new Map<string, number>();
    for (const it of items) {
      const key = computeUniquenessKey(
        {
          documentNumber: it.documentNumber || undefined,
          title: it.title || undefined,
          rev: it.rev || undefined,
          status: it.status || undefined,
          customFields: it.customFields,
        },
        uniquenessKeys,
      );
      if (!key) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    let collidingRows = 0;
    let exampleKey: string | null = null;
    for (const [k, n] of seen) {
      if (n > 1) {
        collidingRows += n;
        if (!exampleKey) exampleKey = k;
      }
    }
    return { collidingRows, exampleKey };
  }, [items, uniquenessKeys]);

  const hasSheetColumn = customColumns.some(
    (c) => /sheet/i.test(c.key) || /sheet/i.test(c.label),
  );
  const sheetInUniqueness = (uniquenessKeys ?? []).some((k) => /sheet/i.test(k));

  // Last-resort disambiguator: when the parser produces the same
  // doc_number for files that are actually different (no sheet
  // pattern, no rev pattern, just similar names), suffix the
  // collisions with -2, -3, … so each row gets a unique key.
  const autoSuffixDuplicates = () => {
    setItems((prev) => {
      const counts = new Map<string, number>();
      return prev.map((it) => {
        const base = it.documentNumber.trim().toLowerCase();
        if (!base) return it;
        const n = (counts.get(base) ?? 0) + 1;
        counts.set(base, n);
        if (n === 1) return it; // first occurrence keeps its number
        return { ...it, documentNumber: `${it.documentNumber}-${n}` };
      });
    });
  };

  // ── Per-row mutators ───────────────────────────────────────────
  const updateRow = (id: string, patch: Partial<StagedItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };
  const updateCustomField = (id: string, key: string, value: string) => {
    setItems((prev) => prev.map((it) =>
      it.id === id ? { ...it, customFields: { ...it.customFields, [key]: value } } : it
    ));
  };
  const removeRow = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };
  const duplicateRow = (id: string) => {
    const src = items.find((it) => it.id === id);
    if (!src) return;
    const copyItem: StagedItem = { ...src, id: src.id + "-copy-" + Date.now(), customFields: { ...src.customFields } };
    setItems((prev) => [...prev, copyItem]);
  };

  // ── Bulk operations ────────────────────────────────────────────
  const applyBulkStatus = () => {
    if (!bulkStatus) return;
    setItems((prev) => prev.map((it) => ({ ...it, status: bulkStatus })));
  };
  const applyBulkType = () => {
    if (!bulkType) return;
    const typeCol = customColumns.find((c) =>
      (/type/i.test(c.key) || /type/i.test(c.label)) && !canonicalKeys.has(c.key)
    );
    if (!typeCol) return;
    setItems((prev) => prev.map((it) => ({
      ...it, customFields: { ...it.customFields, [typeCol.key]: bulkType }
    })));
  };
  const applyBulkUnit = () => {
    if (!bulkUnit) return;
    const unitCol = customColumns.find((c) =>
      (/unit/i.test(c.key) || /area/i.test(c.key)) && !canonicalKeys.has(c.key)
    );
    if (!unitCol) return;
    setItems((prev) => prev.map((it) => ({
      ...it, customFields: { ...it.customFields, [unitCol.key]: bulkUnit }
    })));
  };

  // ── Submit ─────────────────────────────────────────────────────
  const submit = async () => {
    setError(null);
    if (items.length === 0) {
      setError("No files to upload.");
      return;
    }
    setSubmitting(true);
    setStopping(false);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      // Strip canonical-mapped custom-field keys before handing off so
      // the parent doesn't save the same value into both the canonical
      // column AND the metadata JSONB.
      const cleaned = items.map((it) => {
        const fileHash = hashes.get(it.file);
        if (canonicalKeys.size === 0) return { ...it, fileHash };
        const customFields = { ...it.customFields };
        for (const k of canonicalKeys) delete customFields[k];
        return { ...it, customFields, fileHash };
      });
      const res = await onSubmit(cleaned, ctl.signal);
      if (res) {
        const landed = new Set(res.landed);
        setItems((prev) => prev.filter((it) => !landed.has(it.file)));
        setOutcome(res.message);
        setFailedWhy(res.failed ?? []);
      }
    } catch (e) {
      setError(ctl.signal.aborted ? "Upload stopped." : ((e as Error).message || "Upload failed."));
    } finally {
      // ALWAYS. The parent closes the modal on a clean run, but it keeps the
      // modal open when some files failed — and it resolves either way. Left
      // to the catch alone, a successful batch leaves this stuck true for the
      // life of the mounted component, so the NEXT batch opens already
      // "Uploading…" with every control, including the X, disabled.
      if (abortRef.current === ctl) abortRef.current = null;
      setSubmitting(false);
      setStopping(false);
    }
  };

  // Close means close. While a batch is transferring, this aborts the
  // transfers AND closes — the alternative (a disabled X) leaves the person
  // trapped behind a modal watching an upload they can no longer influence.
  // Whatever already landed is on the page behind; the parent reports it.
  const requestClose = () => {
    abortRef.current?.abort();
    onCancel();
  };

  // Stop but stay: abort the transfers and hold the rows, so the user can see
  // what landed and re-send just the rest without re-picking every file.
  const stopUpload = () => {
    setStopping(true);
    abortRef.current?.abort();
  };

  // Escape always gets you out, including mid-upload. A modal with no way out
  // is the worst failure mode this component has, so it gets two: the X and
  // the key every user already tries first.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't hijack Escape from a cell the user is editing.
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
        el.blur();
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  // requestClose is stable enough for this: it only reads a ref and a prop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const typeCol = customColumns.find((c) =>
    (/type/i.test(c.key) || /type/i.test(c.label)) && !canonicalKeys.has(c.key)
  );
  const unitCol = customColumns.find((c) =>
    (/unit/i.test(c.key) || /area/i.test(c.key)) && !canonicalKeys.has(c.key)
  );

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
      <div className="w-full max-w-6xl bg-[var(--color-surface)] rounded-t-2xl sm:rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden my-0 sm:my-8 flex flex-col max-h-[95dvh] sm:max-h-[90vh] animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg"><Upload className="w-5 h-5 text-blue-700" /></div>
            <div>
              <div className="text-sm font-black text-[var(--color-text)]">{folderUpload ? "Upload folder as-is" : "Review metadata before uploading"}</div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {folderUpload
                  ? `${items.length} file${items.length === 1 ? "" : "s"} in ${folderSummary?.folders ?? 0} folder${folderSummary?.folders === 1 ? "" : "s"} - the structure is recreated exactly.`
                  : `${items.length} file${items.length === 1 ? "" : "s"} ready. Confirm or edit each row, then upload.`}
              </div>
            </div>
          </div>
          {/* Never disabled. An upload the user can't get out of is worse than
              one they cancelled. */}
          <button
            onClick={requestClose}
            title={submitting ? "Stop the upload and close" : "Close"}
            className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {folderUpload && folderSummary && (
          <div className="px-4 sm:px-6 py-4 border-b border-[var(--color-border)] bg-emerald-50/60 dark:bg-emerald-950/20 shrink-0">
            <div className="flex items-start gap-3">
              <FolderTree className="w-5 h-5 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-black text-[var(--color-text)]">
                  Goes into <span className="text-emerald-700 dark:text-emerald-400">{folderUpload.destination}</span>, organized exactly as it is on your computer
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  Folders that already exist here are reused, not duplicated. Document numbers, titles and revisions are read from each filename - you can edit them after, or open the file details below first.
                </div>
                <ul className="mt-2 grid gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-2 max-h-36 overflow-auto">
                  {folderSummary.top.slice(0, 40).map(([path, n]) => (
                    <li key={path} className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate font-mono text-[var(--color-text)]" title={path}>{path}/</span>
                      <span className="shrink-0 text-[var(--color-text-faint)]">{n} file{n === 1 ? "" : "s"}</span>
                    </li>
                  ))}
                  {folderSummary.top.length > 40 && (
                    <li className="text-[var(--color-text-faint)]">+{folderSummary.top.length - 40} more folders</li>
                  )}
                  {folderSummary.loose > 0 && (
                    <li className="text-[var(--color-text-faint)]">{folderSummary.loose} file{folderSummary.loose === 1 ? "" : "s"} at the top level</li>
                  )}
                </ul>
                <button onClick={() => setShowDetails((v) => !v)}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                  {showDetails ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  {showDetails ? "Hide file details" : `Review file details (${items.length})`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* How the file names were read — one quiet line, or the one question. */}
        {!submitting && nameReadings.length > 0 && (
          <div className="px-4 sm:px-6 pt-3 shrink-0">
            <NameReadingStrip readings={nameReadings} onChange={setNameRole} />
          </div>
        )}

        {/* Predictive uniqueness banner — only when a collision will actually
            hit the DB constraint */}
        {collisionPreview.collidingRows >= 2 && (
          <div className="px-4 sm:px-6 py-3 bg-amber-50 border-b border-amber-200 shrink-0">
            <div className="flex items-start gap-2 flex-wrap sm:flex-nowrap">
              <KeyRound className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-black text-amber-900">
                  {collisionPreview.collidingRows} files share the same uniqueness key
                </div>
                <div className="text-[11px] text-amber-800 mt-0.5">
                  The library treats these as the same document, so the upload will fail. Two ways to fix it:
                  {" • "}
                  {sheetInUniqueness
                    ? "Fill in a different Sheet value on each row."
                    : hasSheetColumn
                    ? "Tick Sheet for uniqueness (button →)."
                    : "Add a Sheet column + uniqueness (button →) if your files are sheets of the same doc."}
                  {" • Or auto-suffix the colliding doc numbers (button →) if your files are genuinely different and just have similar numbers."}
                </div>
              </div>
              <div className="shrink-0 flex flex-col items-stretch gap-1.5">
                {onAddSheetAndUseForUniqueness && !sheetInUniqueness && (
                  <button
                    onClick={async () => {
                      setFixingUniqueness(true);
                      try { await onAddSheetAndUseForUniqueness(); }
                      finally { setFixingUniqueness(false); }
                    }}
                    disabled={fixingUniqueness}
                    className="inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-50"
                  >
                    {fixingUniqueness ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
                    {hasSheetColumn ? "Use Sheet for uniqueness" : "Add Sheet + use for uniqueness"}
                  </button>
                )}
                <button
                  onClick={autoSuffixDuplicates}
                  className="inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-[var(--color-surface)] border border-amber-300 text-amber-800 hover:bg-amber-50"
                  title="Append -2, -3, … to colliding doc numbers so each row is unique. Use when the files are genuinely different and just have similar parsed numbers."
                >
                  Auto-suffix duplicates
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Files whose exact bytes are already in the system. */}
        {(() => {
          const already = items.filter((it) => (copies.get(hashes.get(it.file) ?? "")?.length ?? 0) > 0);
          const seen = new Map<string, number>();
          for (const it of items) { const h = hashes.get(it.file); if (h) seen.set(h, (seen.get(h) ?? 0) + 1); }
          const twiceInBatch = [...new Set(items.filter((it) => (seen.get(hashes.get(it.file) ?? "") ?? 0) > 1).map((it) => it.file))];
          if (checking) return (
            <div className="px-4 sm:px-6 py-1.5 border-b border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] flex items-center gap-2 shrink-0">
              <Loader2 className="w-3 h-3 animate-spin" /> Checking whether these files are already in the system…
            </div>
          );
          if (!already.length && !twiceInBatch.length) return null;
          return (
            <div className="px-4 sm:px-6 py-3 bg-amber-50 border-b border-amber-200 shrink-0 text-[11px] text-amber-900">
              <div className="flex items-start gap-2 flex-wrap sm:flex-nowrap">
                <Copy className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  {already.length > 0 && (
                    <div className="text-xs font-black">
                      {already.length === 1 ? "1 file is" : `${already.length} files are`} already in the system - same bytes, maybe a different name. Each is marked below.
                    </div>
                  )}
                  {twiceInBatch.length > 0 && (
                    <div className={already.length ? "mt-0.5" : "text-xs font-black"}>
                      {twiceInBatch.length} file{twiceInBatch.length === 1 ? " is" : "s are"} identical to another file in this batch.
                    </div>
                  )}
                  <div className="mt-0.5 text-amber-800">Uploading them anyway makes another copy. To avoid that, take them out of this batch.</div>
                </div>
                {already.length > 0 && (
                  <button
                    onClick={() => setItems((prev) => prev.filter((it) => !(copies.get(hashes.get(it.file) ?? "")?.length)))}
                    className="shrink-0 inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-amber-700 hover:bg-amber-600 text-white"
                  >
                    <Trash2 className="w-3 h-3" /> Skip {already.length === 1 ? "it" : `these ${already.length}`}
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {/* Title-block reader result — quiet until it actually helped. */}
        {tbFilled > 0 && (
          <div className="px-4 sm:px-6 py-2 bg-indigo-50 border-b border-indigo-200 text-[11px] text-indigo-800 flex items-center gap-2 shrink-0 animate-in fade-in">
            <Wand2 className="w-3.5 h-3.5 shrink-0" />
            <span>
              Read the drawings&apos; title blocks and filled <b>{tbFilled}</b> field{tbFilled === 1 ? "" : "s"} from
              page-1 text (drawing numbers / revisions). Double-check anything that looks off - your edits always win.
            </span>
          </div>
        )}

        {/* Bulk-apply row */}
        {detailed && (<>
        <div className="px-4 sm:px-6 py-3 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] shrink-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest flex items-center gap-1">
              <Wand2 className="w-3 h-3" /> Apply to all:
            </span>
            <div className="inline-flex items-center gap-1.5">
              <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} className="text-xs border border-[var(--color-border-strong)] rounded-md px-2 py-1 bg-[var(--color-surface)]">
                <option value="">Status...</option>
                {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={applyBulkStatus} disabled={!bulkStatus} className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-200 hover:bg-slate-300 text-[var(--color-text)] disabled:opacity-40">Apply</button>
            </div>
            {typeCol && (
              <div className="inline-flex items-center gap-1.5">
                <input value={bulkType} onChange={(e) => setBulkType(e.target.value)} placeholder={typeCol.label} className="text-xs border border-[var(--color-border-strong)] rounded-md px-2 py-1 bg-[var(--color-surface)] w-32" />
                <button onClick={applyBulkType} disabled={!bulkType} className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-200 hover:bg-slate-300 text-[var(--color-text)] disabled:opacity-40">Apply</button>
              </div>
            )}
            {unitCol && (
              <div className="inline-flex items-center gap-1.5">
                <input value={bulkUnit} onChange={(e) => setBulkUnit(e.target.value)} placeholder={unitCol.label} className="text-xs border border-[var(--color-border-strong)] rounded-md px-2 py-1 bg-[var(--color-surface)] w-24" />
                <button onClick={applyBulkUnit} disabled={!bulkUnit} className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-200 hover:bg-slate-300 text-[var(--color-text)] disabled:opacity-40">Apply</button>
              </div>
            )}
            {onAddColumn && (
              <button
                onClick={onAddColumn}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-slate-900 text-white hover:bg-slate-800"
                title="Add a new column to this library - opens the column wizard without closing the upload."
              >
                + Add Column
              </button>
            )}
            <div className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
              <Info className="w-3 h-3" />
              <span>Filename hints auto-detected. Edit any cell directly.</span>
            </div>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--color-surface)] border-b border-[var(--color-border)] z-10">
              <tr>
                <th className="text-left px-3 py-2 text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-wider w-8"></th>
                <th className="text-left px-3 py-2 text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-wider">File</th>
                {!canonical.docNumber && (
                  <th className="text-left px-3 py-2 text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-wider">Document #</th>
                )}
                {!canonical.title && (
                  <th className="text-left px-3 py-2 text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-wider">Title</th>
                )}
                {!canonical.rev && (
                  <th className="text-left px-3 py-2 text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-wider w-16">Rev</th>
                )}
                {!canonical.status && (
                  <th className="text-left px-3 py-2 text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-wider w-32">Status</th>
                )}
                {customColumns.map((c) => (
                  <th key={c.key} className="text-left px-3 py-2 text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-wider">
                    {c.label}{c.required && " *"}
                  </th>
                ))}
                <th className="px-2 py-2 w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {(showAllRows ? items : items.slice(0, 200)).map((it) => {
                const rowErrors = validation.filter((e) => e.rowId === it.id);
                const errFor = (field: string) => rowErrors.find((e) => e.field === field)?.msg;
                return (
                  <tr key={it.id} className={rowErrors.length ? "bg-red-50/40" : "hover:bg-[var(--color-surface-2)]"}>
                    <td className="px-3 py-1.5">
                      <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                    </td>
                    <td className="px-3 py-1.5 max-w-[16ch]">
                      <div className="text-[11px] text-[var(--color-text)] font-mono truncate" title={it.file.name}>{it.file.name}</div>
                      {folderUpload && (folderUpload.pathOf(it.file)?.length ?? 0) > 0 && (
                        <div className="text-[9px] text-emerald-700 dark:text-emerald-400 font-mono truncate" title={folderUpload.pathOf(it.file)!.join("/")}>
                          {folderUpload.pathOf(it.file)!.join("/")}/
                        </div>
                      )}
                      <div className="text-[9px] text-[var(--color-text-faint)]">{formatBytes(it.file.size)}</div>
                      {(copies.get(hashes.get(it.file) ?? "") ?? []).map((c) => (
                        <a key={c.href} href={c.href} target="_blank" rel="noreferrer" title={`Already here: ${c.where}`} className="block text-[9px] font-bold text-amber-700 hover:underline truncate">
                          Already in {c.where}
                        </a>
                      ))}
                    </td>
                    {!canonical.docNumber && (
                      <td className="px-3 py-1.5">
                        <Cell
                          value={it.documentNumber}
                          onChange={(v) => updateRow(it.id, { documentNumber: v })}
                          error={errFor("documentNumber")}
                          widthClass="w-40"
                        />
                      </td>
                    )}
                    {!canonical.title && (
                      <td className="px-3 py-1.5">
                        <Cell
                          value={it.title}
                          onChange={(v) => updateRow(it.id, { title: v })}
                          error={errFor("title")}
                          widthClass="w-60"
                        />
                      </td>
                    )}
                    {!canonical.rev && (
                      <td className="px-3 py-1.5">
                        <Cell
                          value={it.rev}
                          onChange={(v) => updateRow(it.id, { rev: v })}
                          widthClass="w-12"
                          center
                        />
                      </td>
                    )}
                    {!canonical.status && (
                      <td className="px-3 py-1.5">
                        <select
                          value={it.status}
                          onChange={(e) => updateRow(it.id, { status: e.target.value })}
                          className="w-full text-[11px] border border-[var(--color-border)] rounded-md px-1.5 py-1 bg-[var(--color-surface)]"
                        >
                          {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                    )}
                    {customColumns.map((c) => {
                      // Canonical-mapped custom columns: route input to the
                      // canonical field instead of customFields so the value
                      // doesn't get saved in two places.
                      const isDocNum = canonical.docNumber?.key === c.key;
                      const isTitle = canonical.title?.key === c.key;
                      const isRev = canonical.rev?.key === c.key;
                      const isStatus = canonical.status?.key === c.key;
                      const value = isDocNum ? it.documentNumber
                        : isTitle ? it.title
                        : isRev ? it.rev
                        : isStatus ? it.status
                        : (it.customFields[c.key] || "");
                      const onChange = isDocNum ? (v: string) => updateRow(it.id, { documentNumber: v })
                        : isTitle ? (v: string) => updateRow(it.id, { title: v })
                        : isRev ? (v: string) => updateRow(it.id, { rev: v })
                        : isStatus ? (v: string) => updateRow(it.id, { status: v })
                        : (v: string) => updateCustomField(it.id, c.key, v);
                      // For the canonical Status column, ALWAYS render a
                      // select using the library's status options — even if
                      // the user defined the column as text. A status field
                      // should never be a free-form text box.
                      const renderAsStatusSelect = isStatus;
                      return (
                        <td key={c.key} className="px-3 py-1.5">
                          {renderAsStatusSelect ? (
                            <select
                              value={value}
                              onChange={(e) => onChange(e.target.value)}
                              className="w-full text-[11px] border border-[var(--color-border)] rounded-md px-1.5 py-1 bg-[var(--color-surface)]"
                            >
                              {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                          ) : c.type === "select" && c.options ? (
                            <select
                              value={value}
                              onChange={(e) => onChange(e.target.value)}
                              className={`w-full text-[11px] border rounded-md px-1.5 py-1 bg-[var(--color-surface)] ${errFor(c.key) ? "border-red-400" : "border-[var(--color-border)]"}`}
                            >
                              <option value=""></option>
                              {c.options.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <Cell
                              value={value}
                              onChange={onChange}
                              error={errFor(c.key)}
                              widthClass={isTitle ? "w-60" : isDocNum ? "w-40" : isRev ? "w-12" : "w-28"}
                              center={isRev}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <button onClick={() => duplicateRow(it.id)} title="Duplicate row" className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded">
                          <Copy className="w-3 h-3" />
                        </button>
                        <button onClick={() => removeRow(it.id)} title="Remove from batch" className="p-1 text-[var(--color-text-faint)] hover:text-red-600 hover:bg-red-50 rounded">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!showAllRows && items.length > 200 && (
                <tr>
                  <td colSpan={99} className="text-center py-3">
                    <button onClick={() => setShowAllRows(true)} className="text-xs font-bold text-blue-600 hover:underline">
                      Showing 200 of {items.length.toLocaleString()} - show all (slower)
                    </button>
                  </td>
                </tr>
              )}
              {items.length === 0 && (
                <tr>
                  <td
                    colSpan={
                      2 // icon + file
                      + (canonical.docNumber ? 0 : 1)
                      + (canonical.title ? 0 : 1)
                      + (canonical.rev ? 0 : 1)
                      + (canonical.status ? 0 : 1)
                      + customColumns.length
                      + 1 // actions
                    }
                    className="text-center text-[var(--color-text-faint)] py-12 text-xs"
                  >
                    No files staged.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </>)}

        {/* Error + actions */}
        {outcome && (
          <div className="px-4 sm:px-6 py-3 bg-amber-50 dark:bg-amber-950/30 border-t border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2 shrink-0">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <b>{outcome}</b> Only the {items.length} file{items.length === 1 ? "" : "s"} still listed will be sent if you try again - nothing that already uploaded is sent twice.
              {failedWhy.length > 0 && (
                <ul className="mt-2 max-h-40 overflow-auto rounded-md border border-amber-200 dark:border-amber-800 bg-[var(--color-surface)] divide-y divide-amber-100 dark:divide-amber-900">
                  {failedWhy.slice(0, 300).map((f, i) => (
                    <li key={i} className="px-2 py-1 flex gap-2 min-w-0">
                      <span className="font-mono truncate max-w-[45%] text-[var(--color-text)]" title={(folderUpload?.pathOf(f.file) ?? []).concat(f.file.name).join("/")}>
                        {(folderUpload?.pathOf(f.file) ?? []).concat(f.file.name).join("/")}
                      </span>
                      <span className="text-rose-700 dark:text-rose-300 truncate" title={f.reason}>{f.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </span>
          </div>
        )}
        {error && (
          <div className="px-4 sm:px-6 py-3 bg-red-50 border-t border-red-200 text-xs text-red-700 flex items-start gap-2 shrink-0">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}
        <div className="px-4 sm:px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between flex-wrap gap-2 shrink-0">
          <div className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-2 min-w-0">
            {submitting && progress?.phase ? (
              <span className="font-bold text-[var(--color-text)] inline-flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {progress.phase}{progress.total > 0 ? ` - ${progress.done} of ${progress.total}` : "…"}
              </span>
            ) : submitting && !progress ? (
              <span className="font-bold text-[var(--color-text)] inline-flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Getting ready…
              </span>
            ) : submitting && progress ? (
              <>
                <span className="font-bold text-[var(--color-text)]">Uploading {progress.done} of {progress.total}…</span>
                <span className="w-32 h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
                  <span className="block h-full bg-emerald-500 transition-all" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
                </span>
              </>
            ) : (
              <>{items.length} file{items.length === 1 ? "" : "s"} · {formatBytes(items.reduce((s, i) => s + i.file.size, 0))} total</>
            )}
          </div>
          <div className="flex items-center gap-2">
            {submitting ? (
              <button
                onClick={stopUpload}
                disabled={stopping}
                title="Stop the transfers and keep this list, so you can re-send what didn't land"
                className="px-3 py-2 rounded-lg text-xs font-bold text-red-700 bg-[var(--color-surface)] border border-red-300 hover:bg-red-50 disabled:opacity-50"
              >
                {stopping ? "Stopping…" : "Stop upload"}
              </button>
            ) : (
              <button onClick={onCancel} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">Cancel</button>
            )}
            <button onClick={submit} disabled={submitting || items.length === 0} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 shadow">
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {submitting ? "Uploading…"
                : outcome ? `Try the ${items.length} remaining again`
                : folderUpload ? `Upload folder (${items.length} files)` : "Upload All"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Editable cell with optional error highlight
function Cell({
  value, onChange, error, widthClass, center,
}: {
  value: string; onChange: (v: string) => void;
  error?: string; widthClass?: string; center?: boolean;
}) {
  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${widthClass || "w-full"} text-[11px] border rounded-md px-1.5 py-1 bg-[var(--color-surface)] ${error ? "border-red-400 ring-1 ring-red-200" : "border-[var(--color-border)]"} ${center ? "text-center" : ""}`}
      />
      {error && (
        <span className="absolute right-1 top-1 text-[8px] font-black text-red-600 uppercase">{error}</span>
      )}
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
