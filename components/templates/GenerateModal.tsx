"use client";

// Generate flow — data in, finished documents out, with a review stop in
// between. Drop the spreadsheet, the AI drafts each document's prose in your
// example's voice, you read and edit anything you want, then it renders into
// your template file and downloads (one .docx, or a zip of the batch).
//
// The review screen is the point: this replaces work someone used to do one
// document at a time, so they get to see the words before they exist as
// files, not after.

import React, { useState } from "react";
import {
  X, Loader2, Upload, Sparkles, Download, FileText, ChevronRight, AlertTriangle, Table2,
} from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { friendlyError } from "@/lib/friendlyError";
import { useRole } from "@/components/providers/RoleContext";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Select } from "@/components/ui/Field";
import { supabase } from "@/lib/supabase";
import StepPath from "@/components/ui/StepPath";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import {
  uploadTemplateFile, draftDocuments, renderDocuments, fileDocumentsToLibrary,
  type OutputTemplate, type DraftedDocument, type Placeholder,
} from "@/lib/outputTemplates";

export default function GenerateModal({ orgId, template, onClose, onGenerated }: {
  orgId: string;
  template: OutputTemplate;
  onClose: () => void;
  onGenerated: () => void;
}) {
  const { showToast } = useToast();
  const { uid, userEmail } = useRole();
  const [source, setSource] = useState<{ key: string; name: string } | null>(null);
  // The spreadsheet as picked, so it shows (name, size, type) and a failed
  // upload can be tried again with the same file.
  const [picked, setPicked] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
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
    setBusy("render");
    setFiling({ done: 0, total: docs.length });
    try {
      const numberTag = template.placeholders.find((p) =>
        /number|no$|id$|tag/i.test(p.tag) && p.kind === "data")?.tag;
      const res = await fileDocumentsToLibrary({
        orgId, templateId: template.id, templateName: template.name,
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
      showToast({ type: "error", title: "That didn't work", message: friendlyError(e) });
    } finally { setBusy(null); setFiling(null); }
  };

  const onFilePicked = async (file: File | null) => {
    if (!file) return;
    setPicked(file);
    setUploadError(null);
    setBusy("upload");
    const landed = (up: { key: string; name: string }) => {
      setSource(up); setUploadError(null);
      setDocs([]); setMapping(null); setNextOffset(null); setCost(0);
    };
    try {
      // Safe to repeat: it only stores the file; nothing is drafted yet.
      landed(await tryUpload(file.name, () => uploadTemplateFile(orgId, file, "data"), { onRetried: landed }));
    } catch (e) {
      setUploadError((e as Error).message);
    } finally { setBusy(null); }
  };
  const dataDrag = useFileDrag((fs) => { if (fs[0]) void onFilePicked(fs[0]); }, busy !== null);

  // Escape closes, as the X does (not while something is running).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && busy === null) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const runDraft = async (offset = 0, columnMapOverride?: Record<string, string>) => {
    if (!source) return;
    setBusy("draft");
    try {
      const res = await draftDocuments({
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
      setNextOffset(res.nextOffset ?? null);
      setCost((c) => c + (res.estCostUsd ?? 0));
      setExpanded(0);
    } catch (e) {
      showToast({ type: "error", title: "That didn't work", message: friendlyError(e) });
    } finally { setBusy(null); }
  };

  const render = async () => {
    setBusy("render");
    try {
      await renderDocuments({
        orgId, templateId: template.id, sourceName: source?.name, mode,
        documents: docs.map((d) => ({ values: d.values, filename: d.filename })),
      });
      showToast({
        type: "success",
        title: `${docs.length} document${docs.length === 1 ? "" : "s"} generated and downloaded.`,
      });
      onGenerated();
    } catch (e) {
      showToast({ type: "error", title: "That didn't work", message: friendlyError(e) });
    } finally { setBusy(null); }
  };

  const updateValue = (docIndex: number, tag: string, value: string) => {
    setDocs((prev) => prev.map((d, i) =>
      i === docIndex ? { ...d, values: { ...d.values, [tag]: value } } : d));
  };
  const updateFilename = (docIndex: number, filename: string) => {
    setDocs((prev) => prev.map((d, i) => (i === docIndex ? { ...d, filename } : d)));
  };

  const aiTags = new Set(template.placeholders.filter((p) => p.kind === "ai").map((p) => p.tag));

  return (
    <div role="dialog" aria-modal="true" aria-label={`Generate: ${template.name}`} className="fixed inset-0 z-50 bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-3xl bg-[var(--color-surface)] rounded-xl shadow-2xl mt-8 mb-8"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between sticky top-0 bg-[var(--color-surface)] rounded-t-xl z-10">
          <div>
            <div className="text-body font-medium text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Generate documents</div>
            <h2 className="mt-1 font-display text-[24px] leading-tight font-semibold text-[var(--color-text)]">{template.name}</h2>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          <StepPath steps={["Add your data", "Check the wording", "Make the files"]} current={docs.length === 0 ? 0 : 1} />
          {/* ── 1. Data ─────────────────────────────────────────────────── */}
          <div {...dataDrag.bind} className={`rounded-xl border border-[var(--color-border)] p-3.5 ${dataDrag.ring}`}>
            <div className="text-body font-medium text-[var(--color-text)] mb-2">
              1 · Data {dataDrag.over && <span className="normal-case tracking-normal font-medium text-[var(--color-text)]"> · {dataDrag.say}</span>}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="inline-flex">
                <input type="file" accept=".xlsx,.xls,.csv" hidden disabled={busy !== null}
                  onChange={(e) => { void onFilePicked(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                <span className="inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] cursor-pointer">
                  {busy === "upload" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  {source ? "Replace spreadsheet" : "Upload or drop a spreadsheet (.xlsx / .csv)"}
                </span>
              </label>
              {picked ? (
                <span className="inline-flex items-center gap-2 text-body font-medium text-[var(--color-text)] min-w-0">
                  <FileThumb file={picked} size={32} />
                  <span className="min-w-0 flex flex-col leading-tight">
                    <span className="truncate">{picked.name}</span>
                    <span className="font-normal text-[var(--color-text-muted)]">
                      {(picked.size / 1024).toFixed(0)} KB
                      {busy === "upload" ? ", uploading" : source && rowCount !== null ? `, ${rowCount} rows` : ""}
                    </span>
                  </span>
                </span>
              ) : source && (
                <span className="inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-text)]">
                  <Table2 className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> {source.name}
                  {rowCount !== null && (
                    <span className="text-[var(--color-text-muted)] font-normal">· {rowCount} rows</span>
                  )}
                </span>
              )}
            </div>
            {uploadError && picked && (
              <p role="alert" className="mt-2 flex flex-wrap items-center gap-x-2 text-body font-medium text-[var(--state-overdue-text)]">
                The spreadsheet didn&apos;t upload. {friendlyError(uploadError)}
                <button type="button" onClick={() => void onFilePicked(picked)} disabled={busy !== null} className="text-[var(--color-accent-text)] hover:underline underline-offset-2">Try again</button>
              </p>
            )}
            {sheetNames.length > 1 && (
              <label className="block mt-2">
                <span className="block text-body font-medium text-[var(--color-text)] mb-1.5">Sheet</span>
                <Select value={sheet} onChange={(e) => setSheet(e.target.value)}>
                  {sheetNames.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </label>
            )}
            {template.mode === "both" && (
              <div className="mt-2 inline-flex rounded-xl border border-[var(--color-border)] p-0.5">
                <button onClick={() => setMode("per_row")}
                  className={`px-3 py-1.5 rounded-lg text-body font-medium ${mode === "per_row" ? "bg-[var(--color-surface)] text-[var(--color-text)] ring-1 ring-[var(--color-text-muted)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>
                  One per row
                </button>
                <button onClick={() => setMode("summary")}
                  className={`px-3 py-1.5 rounded-lg text-body font-medium ${mode === "summary" ? "bg-[var(--color-surface)] text-[var(--color-text)] ring-1 ring-[var(--color-text-muted)] shadow-sm" : "text-[var(--color-text-muted)]"}`}>
                  One summary document
                </button>
              </div>
            )}
            <div className="mt-2.5">
              <Button size="sm" variant={docs.length === 0 && !mapping ? "primary" : "secondary"} onClick={() => void runDraft(0)} disabled={!source || busy !== null}>
                {busy === "draft" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Draft documents
              </Button>
            </div>
          </div>

          {/* ── Column mapping (only when something's missing) ──────────── */}
          {mapping && (
            <div className="border-l-[3px] border-[var(--state-held)] pl-3.5 py-1">
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle aria-hidden className="w-4 h-4 text-[var(--state-held)] shrink-0 mt-0.5" />
                <div className="text-body text-[var(--color-text)]">
                  <b>This template needs a few values your sheet doesn&apos;t obviously have.</b> Point each
                  one at the right column. The choice is remembered for next time.
                </div>
              </div>
              <ul className="space-y-1.5">
                {mapping.missing.map((m) => (
                  <li key={m.tag} className="flex items-center gap-2 text-body">
                    <code className="font-mono font-medium text-[var(--color-text)] w-40 truncate">{`{${m.tag}}`}</code>
                    <Select className="flex-1"
                      value={mapping.columnMap[m.tag] ?? ""}
                      onChange={(e) => setMapping((prev) => prev && ({
                        ...prev, columnMap: { ...prev.columnMap, [m.tag]: e.target.value },
                      }))}>
                      <option value="">- pick a column -</option>
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

          {/* ── 2. Review ──────────────────────────────────────────────── */}
          {docs.length > 0 && (
            <div className="rounded-xl border border-[var(--color-border)] p-3.5">
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <div className="text-body font-medium text-[var(--color-text)]">
                  2 · Check: {docs.length} document{docs.length === 1 ? "" : "s"} drafted
                </div>
                {cost > 0 && (
                  <span className="text-body text-[var(--color-text-muted)]">
                    drafting cost ≈ ${cost.toFixed(2)} on your key
                  </span>
                )}
              </div>
              <ul className="space-y-1.5 max-h-96 overflow-y-auto">
                {docs.map((d, i) => (
                  <li key={i} className="rounded-lg border border-[var(--color-border)]">
                    <button onClick={() => setExpanded(expanded === i ? null : i)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-2)] rounded-lg">
                      <ChevronRight className={`w-3.5 h-3.5 shrink-0 ui-chevron${(expanded === i) ? " rotate-90" : ""}`} />
                      <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                      <span className="text-body font-medium text-[var(--color-text)] truncate">{d.filename}</span>
                      {d.sourceRow && (
                        <span className="ml-auto text-body text-[var(--color-text-muted)] shrink-0">row {d.sourceRow}</span>
                      )}
                    </button>
                    {expanded === i && (
                      <div className="px-3 pb-3 space-y-2 border-t border-[var(--color-border)] pt-2">
                        <label className="block">
                          <span className="block text-body font-medium text-[var(--color-text)] mb-1.5">File name</span>
                          <Input value={d.filename} onChange={(e) => updateFilename(i, e.target.value)} className="text-xs font-mono" />
                        </label>
                        {Object.entries(d.values).map(([tag, value]) => (
                          <label key={tag} className="block">
                            <span className="text-body font-medium text-[var(--color-text)] mb-1.5 flex items-center gap-1.5">
                              {tag}
                              {aiTags.has(tag) && (
                                <span className="inline-flex items-center gap-0.5 text-body px-1 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] dark:border-[var(--color-border)] text-[var(--color-text)] dark:text-[var(--color-text)]">
                                  <Sparkles className="w-2.5 h-2.5" /> AI
                                </span>
                              )}
                            </span>
                            {value.length > 80 || aiTags.has(tag) ? (
                              <Textarea rows={Math.min(8, Math.max(2, Math.ceil(value.length / 90)))}
                                value={value} onChange={(e) => updateValue(i, tag, e.target.value)} className="text-body" />
                            ) : (
                              <Input value={value} onChange={(e) => updateValue(i, tag, e.target.value)} className="text-body" />
                            )}
                          </label>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {nextOffset !== null && (
                <Button size="sm" variant="secondary" className="mt-2"
                  onClick={() => void runDraft(nextOffset)} disabled={busy !== null}>
                  {busy === "draft" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  Draft the next batch ({(rowCount ?? 0) - docs.length} rows left)
                </Button>
              )}
            </div>
          )}

          {/* ── 3. Generate ────────────────────────────────────────────── */}
          {docs.length > 0 && (
            <div className="rounded-xl border border-[var(--color-border)] p-3.5 space-y-2.5">
              <div className="text-body font-medium text-[var(--color-text)]">
                3 · Generate
              </div>
              <p className="text-body text-[var(--color-text-muted)]">
                Renders into <b>{template.templateFileName ?? "your template"}</b>. Fonts, colours,
                tables and headers stay as they are.
              </p>
              {libraries.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap text-body">
                  <span className="font-medium text-[var(--color-text)]">File into document control:</span>
                  <Select value={fileInto} onChange={(e) => setFileInto(e.target.value)} className="!w-56 text-body">
                    <option value="">- download only -</option>
                    {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </Select>
                  <span className="text-[var(--color-text-muted)]">as Draft rev 0</span>
                </div>
              )}
              {filing && (
                <div className="text-body font-medium text-[var(--color-text)] inline-flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Filing {filing.done} of {filing.total}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>Close</Button>
                {fileInto && (
                  <Button variant="secondary" onClick={() => void fileIntoControl()} disabled={busy !== null}>
                    {busy === "render" && filing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                    File {docs.length} into library
                  </Button>
                )}
                <Button onClick={() => void render()} disabled={busy !== null}>
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
