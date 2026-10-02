"use client";

// Generate flow — data in, finished documents out, with a review stop in
// between. Drop the spreadsheet, the AI drafts each document's prose in your
// example's voice, you read and edit anything you want, then it renders into
// your template file and downloads (one .docx, or a zip of the batch).
//
// The review screen is the point: this replaces work someone used to do one
// document at a time, so they get to see the words before they exist as
// files, not after.
//
// PR-6: when the server stops a batch early it says why (`stopped`: the cap,
// or a draft it could not read) and names every row it left out
// (`skippedRows`) — both are shown here, so a left-out row is never silent.
// A drafted document whose AI-written field came back genuinely empty is
// marked on its row, and nothing is made from it — downloaded or filed —
// until that field is filled in or explicitly left blank, field by field.
// The server never refuses an empty field: some AI fields are optional, and
// only the person reviewing can say which. A field the AI left empty in
// several documents can be left blank in all of them at once — one tick per
// field, covering the documents drafted when it is ticked (I-20 fix pass 4);
// there is no tick that releases every field. A tick lasts only while its
// field is empty: typing into the field ends it, so a field cleared again is
// refused until it is ticked again; unticking a field's batch tick takes the
// tick off that field in every document where it is still empty, a tick set
// on one document included (I-20 fix pass 5).

import React, { useState } from "react";
import {
  X, Loader2, Upload, Sparkles, Download, FileText, ChevronDown, ChevronRight,
  AlertTriangle, Table2,
} from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { useRole } from "@/components/providers/RoleContext";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Select } from "@/components/ui/Field";
import { supabase } from "@/lib/supabase";
import {
  uploadTemplateFile, draftDocuments, renderDocuments, fileDocumentsToLibrary,
  type OutputTemplate, type DraftedDocument, type Placeholder, type DraftResult,
} from "@/lib/outputTemplates";

/** PR-6: the AI-written fields of a drafted document that are genuinely
 *  empty (missing, or nothing but whitespace) — in the template's order. */
export function emptyAiFields(doc: DraftedDocument, aiTags: readonly string[]): string[] {
  return aiTags.filter((t) => !String(doc.values[t] ?? "").trim());
}

/** PR-6: the documents that cannot be made yet — each one's empty AI fields
 *  not explicitly left blank. `keepBlank` holds `${docIndex}|${tag}`. */
export function documentsBlockedByEmptyAi(
  docs: readonly DraftedDocument[], aiTags: readonly string[], keepBlank: Readonly<Record<string, boolean>>,
): Array<{ index: number; tags: string[] }> {
  return docs
    .map((d, index) => ({ index, tags: emptyAiFields(d, aiTags).filter((t) => !keepBlank[`${index}|${t}`]) }))
    .filter((b) => b.tags.length > 0);
}

/** PR-6 (I-20 fix pass 4): per AI field, the documents where the AI wrote
 *  nothing — what that field's batch override reaches. Only fields empty in
 *  two or more documents (with one, the per-document tick is the same). */
export function emptyAiFieldsAcrossBatch(
  docs: readonly DraftedDocument[], aiTags: readonly string[],
): Array<{ tag: string; indexes: number[] }> {
  return aiTags
    .map((tag) => ({ tag, indexes: docs.flatMap((d, i) => (emptyAiFields(d, [tag]).length > 0 ? [i] : [])) }))
    .filter((f) => f.indexes.length > 1);
}

/** PR-6 (I-20 fix pass 4): the batch override for ONE field — tick (or
 *  untick) "leave it blank" on every document where `tag` is empty now, and
 *  on no other field. It writes the per-document overrides, so it reaches
 *  only the documents drafted now: a later batch's empty field is ticked
 *  again, and each document's own tick still works. Unticking clears every
 *  override of that field on the documents where it is still empty — one
 *  set there by hand too, as the checkbox reads them all (it is checked
 *  only while every one of them is overridden) and the dialog says so. A
 *  document where the field was filled in holds no override for it
 *  (keepBlankAfterEdit, fix pass 5), so nothing is left behind there. */
export function setKeepBlankAcrossBatch(
  keepBlank: Readonly<Record<string, boolean>>, docs: readonly DraftedDocument[], tag: string, on: boolean,
): Record<string, boolean> {
  const next = { ...keepBlank };
  docs.forEach((d, i) => { if (emptyAiFields(d, [tag]).length > 0) next[`${i}|${tag}`] = on; });
  return next;
}

/** PR-6 (I-20 fix pass 5): an override says "this AI field is empty, and
 *  stays empty on purpose" — it lasts only while the field is empty. A
 *  value typed into the field ends that document's override for it, so a
 *  field filled in and cleared again is refused until it is ticked again
 *  (per document, or across the batch). Whitespace is still empty
 *  (emptyAiFields), so it ends nothing. Unchanged state is returned as is. */
export function keepBlankAfterEdit(
  keepBlank: Record<string, boolean>, docIndex: number, tag: string, value: string,
): Record<string, boolean> {
  const key = `${docIndex}|${tag}`;
  if (!value.trim() || !(key in keepBlank)) return keepBlank;
  const next = { ...keepBlank };
  delete next[key];
  return next;
}

/** What the draft action sends beyond DraftResult (PR-6). */
type DraftReply = DraftResult & {
  /** Why this slice stopped early — the cap, or a draft that could not be read. */
  stopped?: string;
  /** Rows whose draft could not be read: left out, never blanked. */
  skippedRows?: Array<{ row: number; reason: string }>;
};

export default function GenerateModal({ orgId, template, onClose, onGenerated }: {
  orgId: string;
  template: OutputTemplate;
  onClose: () => void;
  onGenerated: () => void;
}) {
  const { showToast } = useToast();
  const { uid, userEmail } = useRole();
  const [source, setSource] = useState<{ key: string; name: string } | null>(null);
  // Optional: land the finished documents in document control as Draft rev 0
  // instead of (or as well as) downloading them.
  const [libraries, setLibraries] = useState<Array<{ id: string; name: string }>>([]);
  const [fileInto, setFileInto] = useState<string>("");
  const [filing, setFiling] = useState<{ done: number; total: number } | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheet, setSheet] = useState<string>("");
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [mode, setMode] = useState<"per_row" | "summary">(
    template.mode === "summary" ? "summary" : "per_row",
  );
  const [docs, setDocs] = useState<DraftedDocument[]>([]);
  const [expanded, setExpanded] = useState<number | null>(0);
  const [busy, setBusy] = useState<"upload" | "draft" | "render" | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [stoppedNote, setStoppedNote] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Array<{ row: number; reason: string }>>([]);
  // PR-6: AI fields the reviewer chose to leave blank, `${docIndex}|${tag}`.
  const [keepBlank, setKeepBlank] = useState<Record<string, boolean>>({});
  const [cost, setCost] = useState(0);
  const [mapping, setMapping] = useState<{
    missing: Placeholder[]; headers: string[]; columnMap: Record<string, string>;
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name")
      .then(({ data }) => {
        if (!cancelled) setLibraries((data ?? []) as Array<{ id: string; name: string }>);
      });
    return () => { cancelled = true; };
  }, [orgId]);

  const fileIntoControl = async () => {
    if (!fileInto || !uid) return;
    if (refuseEmptyAi()) return;
    setBusy("render");
    setFiling({ done: 0, total: docs.length });
    try {
      const numberTag = template.placeholders.find((p) =>
        /number|no$|id$|tag/i.test(p.tag) && p.kind === "data")?.tag;
      const res = await fileDocumentsToLibrary({
        orgId, templateId: template.id, templateName: template.name, templateKind: template.kind,
        sourceName: source?.name, mode,
        documents: docs.map((d) => ({ values: d.values, filename: d.filename })),
        target: { libraryId: fileInto, numberTag },
        actorUserId: uid, actorEmail: userEmail ?? undefined,
        onProgress: (done, total) => setFiling({ done, total }),
      });
      if (res.errors.length > 0) {
        showToast({
          type: "error",
          title: `Filed ${res.filed} of ${docs.length}`,
          message: res.errors.slice(0, 3).join("; "),
        });
      } else {
        showToast({
          type: "success",
          title: `${res.filed} document${res.filed === 1 ? "" : "s"} filed into document control as Draft rev 0.`,
        });
      }
      onGenerated();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); setFiling(null); }
  };

  const onFilePicked = async (file: File | null) => {
    if (!file) return;
    setBusy("upload");
    try {
      const up = await uploadTemplateFile(orgId, file, "data");
      setSource(up);
      setDocs([]); setMapping(null); setNextOffset(null); setCost(0);
      setStoppedNote(null); setSkipped([]); setKeepBlank({});
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const runDraft = async (offset = 0, columnMapOverride?: Record<string, string>) => {
    if (!source) return;
    setBusy("draft");
    try {
      const res: DraftReply = await draftDocuments({
        orgId, templateId: template.id, sourceFileKey: source.key,
        sheet: sheet || undefined, mode, rowOffset: offset,
        columnMap: columnMapOverride ?? mapping?.columnMap,
      });
      if (res.sheetNames?.length) setSheetNames(res.sheetNames);
      if (typeof res.rowCount === "number") setRowCount(res.rowCount);
      if (res.needsMapping) {
        setMapping({
          missing: res.missing ?? [], headers: res.headers ?? [],
          columnMap: res.columnMap ?? {},
        });
        return;
      }
      setMapping(null);
      setDocs((prev) => (offset === 0 ? (res.documents ?? []) : [...prev, ...(res.documents ?? [])]));
      if (offset === 0) setKeepBlank({});
      setSkipped((prev) => (offset === 0 ? (res.skippedRows ?? []) : [...prev, ...(res.skippedRows ?? [])]));
      setStoppedNote(res.stopped ?? null);
      setNextOffset(res.nextOffset ?? null);
      setCost((c) => c + (res.estCostUsd ?? 0));
      setExpanded(0);
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const render = async () => {
    if (refuseEmptyAi()) return;
    setBusy("render");
    try {
      await renderDocuments({
        orgId, templateId: template.id, templateName: template.name, templateKind: template.kind,
        sourceName: source?.name, mode,
        documents: docs.map((d) => ({ values: d.values, filename: d.filename })),
      });
      showToast({
        type: "success",
        title: `${docs.length} document${docs.length === 1 ? "" : "s"} generated and downloaded.`,
      });
      onGenerated();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const updateValue = (docIndex: number, tag: string, value: string) => {
    setDocs((prev) => prev.map((d, i) =>
      i === docIndex ? { ...d, values: { ...d.values, [tag]: value } } : d));
    // PR-6 (fix pass 5): a field filled in no longer carries its "leave it
    // blank" — cleared again, it is refused until ticked again.
    setKeepBlank((prev) => keepBlankAfterEdit(prev, docIndex, tag, value));
  };
  const updateFilename = (docIndex: number, filename: string) => {
    setDocs((prev) => prev.map((d, i) => (i === docIndex ? { ...d, filename } : d)));
  };

  const aiTagList = template.placeholders.filter((p) => p.kind === "ai").map((p) => p.tag);
  const aiTags = new Set(aiTagList);
  // PR-6: documents with an empty AI field nobody chose to leave blank.
  const blocked = documentsBlockedByEmptyAi(docs, aiTagList, keepBlank);
  const blockedFields = blocked.reduce((n, b) => n + b.tags.length, 0);
  // PR-6 (fix pass 4): fields the AI left empty in more than one document.
  const acrossBatch = emptyAiFieldsAcrossBatch(docs, aiTagList);
  function refuseEmptyAi(): boolean {
    if (blocked.length === 0) return false;
    showToast({
      type: "error",
      title: `${blocked.length} document${blocked.length === 1 ? " has" : "s have"} an empty AI-written field — fill it in, or tick "Leave it blank" on it, first.`,
    });
    setExpanded(blocked[0].index);
    return true;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-3xl bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-xl mt-8 mb-8"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between sticky top-0 bg-[var(--color-surface)] rounded-t-2xl z-10">
          <div>
            <h2 className="text-base font-black text-[var(--color-text)] flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-orange-600" /> Generate — {template.name}
            </h2>
            <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              Drop your data, review the drafted wording, download finished files.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* ── 1. Data ─────────────────────────────────────────────────── */}
          <div className="rounded-xl border border-[var(--color-border)] p-3.5">
            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
              1 · Data
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="inline-flex">
                <input type="file" accept=".xlsx,.xls,.csv" hidden disabled={busy !== null}
                  onChange={(e) => { void onFilePicked(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] cursor-pointer">
                  {busy === "upload" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  {source ? "Replace spreadsheet" : "Upload spreadsheet (.xlsx / .csv)"}
                </span>
              </label>
              {source && (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--color-text)]">
                  <Table2 className="w-3.5 h-3.5 text-emerald-600" /> {source.name}
                  {rowCount !== null && (
                    <span className="text-[var(--color-text-muted)] font-normal">· {rowCount} rows</span>
                  )}
                </span>
              )}
            </div>
            {sheetNames.length > 1 && (
              <label className="block mt-2">
                <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Sheet</span>
                <Select value={sheet} onChange={(e) => setSheet(e.target.value)}>
                  {sheetNames.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </label>
            )}
            {template.mode === "both" && (
              <div className="mt-2 inline-flex rounded-xl border border-[var(--color-border)] p-0.5">
                <button onClick={() => setMode("per_row")}
                  className={`px-3 py-1.5 rounded-[10px] text-[11px] font-black ${mode === "per_row" ? "bg-orange-600 text-white" : "text-[var(--color-text-muted)]"}`}>
                  One per row
                </button>
                <button onClick={() => setMode("summary")}
                  className={`px-3 py-1.5 rounded-[10px] text-[11px] font-black ${mode === "summary" ? "bg-orange-600 text-white" : "text-[var(--color-text-muted)]"}`}>
                  One summary document
                </button>
              </div>
            )}
            <div className="mt-2.5">
              <Button size="sm" onClick={() => void runDraft(0)} disabled={!source || busy !== null}>
                {busy === "draft" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Draft documents
              </Button>
            </div>
          </div>

          {/* ── Column mapping (only when something's missing) ──────────── */}
          {mapping && (
            <div className="rounded-xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 p-3.5">
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-900 dark:text-amber-200">
                  <b>This template needs a few values your sheet doesn&apos;t obviously have.</b> Point each
                  one at the right column — the choice is remembered for next time.
                </div>
              </div>
              <ul className="space-y-1.5">
                {mapping.missing.map((m) => (
                  <li key={m.tag} className="flex items-center gap-2 text-xs">
                    <code className="font-mono font-black text-orange-600 w-40 truncate">{`{${m.tag}}`}</code>
                    <Select className="flex-1"
                      value={mapping.columnMap[m.tag] ?? ""}
                      onChange={(e) => setMapping((prev) => prev && ({
                        ...prev, columnMap: { ...prev.columnMap, [m.tag]: e.target.value },
                      }))}>
                      <option value="">— pick a column —</option>
                      {mapping.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </Select>
                  </li>
                ))}
              </ul>
              <Button size="sm" className="mt-2.5"
                onClick={() => void runDraft(0, mapping.columnMap)}
                disabled={busy !== null || mapping.missing.some((m) => !mapping.columnMap[m.tag])}>
                {busy === "draft" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Continue drafting
              </Button>
            </div>
          )}

          {/* ── PR-6: why the batch stopped, and every row left out ─────── */}
          {(stoppedNote || skipped.length > 0) && (
            <div role="status" className="rounded-xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 p-3.5 space-y-1.5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-900 dark:text-amber-200 space-y-1">
                  {stoppedNote && <p><b>Drafting stopped part-way.</b> {stoppedNote}</p>}
                  {skipped.length > 0 && (
                    <>
                      <p><b>Left out — no document was made for {skipped.length === 1 ? "this row" : "these rows"}:</b></p>
                      <ul className="list-disc pl-4">
                        {skipped.map((r) => <li key={r.row}>Row {r.row}: {r.reason}</li>)}
                      </ul>
                    </>
                  )}
                </div>
              </div>
              {docs.length === 0 && nextOffset !== null && (
                <Button size="sm" variant="secondary" onClick={() => void runDraft(nextOffset)} disabled={busy !== null}>
                  {busy === "draft" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  Draft the next batch ({Math.max(0, (rowCount ?? 0) - nextOffset)} rows left)
                </Button>
              )}
            </div>
          )}

          {/* ── 2. Review ──────────────────────────────────────────────── */}
          {docs.length > 0 && (
            <div className="rounded-xl border border-[var(--color-border)] p-3.5">
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                  2 · Review — {docs.length} document{docs.length === 1 ? "" : "s"} drafted
                </div>
                {cost > 0 && (
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    drafting cost ≈ ${cost.toFixed(2)} on your key
                  </span>
                )}
              </div>
              <ul className="space-y-1.5 max-h-96 overflow-y-auto">
                {docs.map((d, i) => (
                  <li key={i} className="rounded-lg border border-[var(--color-border)]">
                    <button onClick={() => setExpanded(expanded === i ? null : i)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-2)] rounded-lg">
                      {expanded === i ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
                      <FileText className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                      <span className="text-xs font-bold text-[var(--color-text)] truncate">{d.filename}</span>
                      {(() => {
                        const empty = emptyAiFields(d, aiTagList);
                        if (empty.length === 0) return null;
                        const open = empty.filter((t) => !keepBlank[`${i}|${t}`]).length;
                        return open > 0 ? (
                          <span data-empty-ai={open} className="inline-flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 shrink-0">
                            <AlertTriangle className="w-2.5 h-2.5" /> {open} empty AI field{open === 1 ? "" : "s"}
                          </span>
                        ) : (
                          <span data-empty-ai-kept="true" className="text-[9px] font-bold text-[var(--color-text-muted)] shrink-0">
                            left blank on purpose
                          </span>
                        );
                      })()}
                      {d.sourceRow && (
                        <span className="ml-auto text-[10px] text-[var(--color-text-muted)] shrink-0">row {d.sourceRow}</span>
                      )}
                    </button>
                    {expanded === i && (
                      <div className="px-3 pb-3 space-y-2 border-t border-[var(--color-border)] pt-2">
                        <label className="block">
                          <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">File name</span>
                          <Input value={d.filename} onChange={(e) => updateFilename(i, e.target.value)} className="text-xs font-mono" />
                        </label>
                        {[...Object.keys(d.values), ...aiTagList.filter((t) => !(t in d.values))].map((tag) => {
                          const value = d.values[tag] ?? "";
                          const emptyAi = aiTags.has(tag) && !value.trim();
                          return (
                          <div key={tag}>
                          <label className="block">
                            <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] flex items-center gap-1.5">
                              {tag}
                              {aiTags.has(tag) && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-orange-500/10 border border-orange-300 dark:border-orange-800 text-orange-700 dark:text-orange-400">
                                  <Sparkles className="w-2.5 h-2.5" /> AI
                                </span>
                              )}
                            </span>
                            {value.length > 80 || aiTags.has(tag) ? (
                              <Textarea rows={Math.min(8, Math.max(2, Math.ceil(value.length / 90)))}
                                value={value} onChange={(e) => updateValue(i, tag, e.target.value)} className="text-xs" />
                            ) : (
                              <Input value={value} onChange={(e) => updateValue(i, tag, e.target.value)} className="text-xs" />
                            )}
                          </label>
                          {emptyAi && (
                            <div data-empty-ai-field={tag} className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-amber-800 dark:text-amber-300">
                              <span className="inline-flex items-center gap-1 font-bold">
                                <AlertTriangle className="w-3 h-3" /> The AI wrote nothing here.
                              </span>
                              <label className="inline-flex items-center gap-1 cursor-pointer">
                                <input type="checkbox" checked={!!keepBlank[`${i}|${tag}`]}
                                  onChange={(e) => setKeepBlank((prev) => ({ ...prev, [`${i}|${tag}`]: e.target.checked }))} />
                                Leave it blank in the document
                              </label>
                            </div>
                          )}
                          </div>
                          );
                        })}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {nextOffset !== null && (
                <Button size="sm" variant="secondary" className="mt-2"
                  onClick={() => void runDraft(nextOffset)} disabled={busy !== null}>
                  {busy === "draft" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  Draft the next batch ({Math.max(0, (rowCount ?? 0) - nextOffset)} rows left)
                </Button>
              )}
            </div>
          )}

          {/* ── 3. Generate ────────────────────────────────────────────── */}
          {docs.length > 0 && (
            <div className="rounded-xl border border-[var(--color-border)] p-3.5 space-y-2.5">
              <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                3 · Generate
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Renders into <b>{template.templateFileName ?? "your template"}</b> — fonts, colours,
                tables and headers untouched.
              </p>
              {libraries.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap text-[11px]">
                  <span className="font-bold text-[var(--color-text)]">File into document control:</span>
                  <Select value={fileInto} onChange={(e) => setFileInto(e.target.value)} className="!w-56 text-xs">
                    <option value="">— download only —</option>
                    {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </Select>
                  <span className="text-[var(--color-text-muted)]">as Draft rev 0</span>
                </div>
              )}
              {acrossBatch.length > 0 && (
                <div data-empty-ai-batch="true"
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text)] space-y-1">
                  <p className="text-[var(--color-text-muted)]">
                    The AI wrote nothing for {acrossBatch.length === 1 ? "this field" : "these fields"} in more than one
                    document. If {acrossBatch.length === 1 ? "it is" : "one is"} optional, leave it blank in each of them
                    at once — one field at a time:
                  </p>
                  {acrossBatch.map((f) => (
                    <label key={f.tag} data-empty-ai-batch-field={f.tag} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox"
                        checked={f.indexes.every((i) => !!keepBlank[`${i}|${f.tag}`])}
                        onChange={(e) => setKeepBlank((prev) => setKeepBlankAcrossBatch(prev, docs, f.tag, e.target.checked))} />
                      <span>
                        Leave <code className="font-mono font-black text-orange-600">{`{${f.tag}}`}</code> blank in
                        all {f.indexes.length} documents where the AI wrote nothing
                      </span>
                    </label>
                  ))}
                  <p data-empty-ai-batch-untick="true" className="text-[10px] text-[var(--color-text-muted)]">
                    Unticking one takes &ldquo;Leave it blank&rdquo; off that field in every document where it is still
                    empty, a tick set on a single document included. Typing into a field ends its tick: cleared
                    again, it needs ticking again.
                  </p>
                </div>
              )}
              {blocked.length > 0 && (
                <div role="alert" data-empty-ai-blocked={blocked.length}
                  className="rounded-lg border-2 border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p>
                      <b>{blocked.length} document{blocked.length === 1 ? " has" : "s have"} {blockedFields === 1 ? "an empty AI-written field" : `${blockedFields} empty AI-written fields`}.</b>{" "}
                      Nothing is made until each one is filled in, or ticked &ldquo;Leave it blank&rdquo; — a blank section is
                      never put into a document unless you say so.
                    </p>
                    <button type="button" onClick={() => setExpanded(blocked[0].index)}
                      className="font-bold underline">
                      Show the first one ({docs[blocked[0].index]?.filename})
                    </button>
                  </div>
                </div>
              )}
              {filing && (
                <div className="text-[11px] font-bold text-orange-600 inline-flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Filing {filing.done} of {filing.total}…
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>Close</Button>
                {fileInto && (
                  <Button variant="secondary" onClick={() => void fileIntoControl()} disabled={busy !== null || blocked.length > 0}>
                    {busy === "render" && filing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                    File {docs.length} into library
                  </Button>
                )}
                <Button onClick={() => void render()} disabled={busy !== null || blocked.length > 0}>
                  {busy === "render" && !filing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  Download {docs.length} document{docs.length === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
