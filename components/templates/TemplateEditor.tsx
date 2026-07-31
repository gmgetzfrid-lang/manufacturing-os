"use client";

// Template editor — register a blank template, attach examples, and approve
// the fill points the system detected.
//
// The one-time prep this feature needs: a blank Word file doesn't inherently
// say "the scope narrative goes here". So the template carries {tags} typed
// once, and this dialog READS the uploaded file, shows what it found, and
// proposes what each tag is for — the author approves rather than authors.

import React, { useState } from "react";
import {
  X, Loader2, Upload, FileText, Save, Sparkles, Database, Type, AlertTriangle, Trash2,
} from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Select } from "@/components/ui/Field";
import {
  uploadTemplateFile, analyzeTemplateFile, saveOutputTemplate,
  type OutputTemplate, type Placeholder,
} from "@/lib/outputTemplates";

const KIND_LABEL: Record<string, string> = { docx: "Word (.docx)", xlsx: "Excel (.xlsx)" };

export default function TemplateEditor({ orgId, template, onClose, onSaved }: {
  orgId: string;
  template: OutputTemplate | null;          // null = new
  onClose: () => void;
  onSaved: () => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [kind, setKind] = useState<"docx" | "xlsx">(template?.kind ?? "docx");
  const [mode, setMode] = useState<OutputTemplate["mode"]>(template?.mode ?? "per_row");
  const [instructions, setInstructions] = useState(template?.instructions ?? "");
  const [filenamePattern, setFilenamePattern] = useState(template?.filenamePattern ?? "");
  const [templateFile, setTemplateFile] = useState<{ key: string; name: string } | null>(
    template?.templateFileKey ? { key: template.templateFileKey, name: template.templateFileName ?? "template" } : null,
  );
  const [examples, setExamples] = useState<Array<{ key: string; name: string }>>(template?.exampleFiles ?? []);
  const [exampleText, setExampleText] = useState(template?.exampleText ?? "");
  const [placeholders, setPlaceholders] = useState<Placeholder[]>(template?.placeholders ?? []);
  const [loops, setLoops] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [analysisNote, setAnalysisNote] = useState<string | null>(null);

  const onTemplatePicked = async (file: File | null) => {
    if (!file) return;
    const isXlsx = /\.xlsx?$/i.test(file.name);
    setBusy("template");
    try {
      const up = await uploadTemplateFile(orgId, file, "templates");
      setTemplateFile(up);
      const nextKind = isXlsx ? "xlsx" : "docx";
      setKind(nextKind);
      const analysis = await analyzeTemplateFile(orgId, up.key, nextKind);
      setLoops(analysis.loops);
      if (analysis.placeholders.length > 0) {
        // Keep any settings already tuned for tags that still exist.
        const prior = new Map(placeholders.map((p) => [p.tag, p]));
        setPlaceholders(analysis.placeholders.map((p) => prior.get(p.tag) ?? p));
        setAnalysisNote(
          `Found ${analysis.placeholders.length} fill point${analysis.placeholders.length === 1 ? "" : "s"}` +
          (analysis.loops.length ? ` and ${analysis.loops.length} repeating block(s)` : "") +
          " — check what each one should be filled with below.",
        );
      } else {
        setAnalysisNote(
          "No {placeholders} found in that file. Add tags where content belongs — type " +
          "{project_name}, {scope_description} etc. into the template in Word, re-upload, and " +
          "they'll appear here. (Repeating tables use {#rows}…{/rows}.)",
        );
      }
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const onExamplePicked = async (file: File | null) => {
    if (!file) return;
    setBusy("example");
    try {
      const up = await uploadTemplateFile(orgId, file, "examples");
      setExamples((prev) => [...prev, up]);
      // Read the example's text so the model can copy its voice. Word only:
      // an .xlsx example is stored but not distilled.
      if (/\.docx$/i.test(file.name)) {
        const analysis = await analyzeTemplateFile(orgId, up.key, "docx");
        setExampleText((prev) => (prev ? `${prev}\n\n---\n\n` : "") + analysis.preview);
      }
      showToast({ type: "success", title: `${file.name} attached as a style example.` });
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const updatePlaceholder = (tag: string, patch: Partial<Placeholder>) => {
    setPlaceholders((prev) => prev.map((p) => (p.tag === tag ? { ...p, ...patch } : p)));
  };

  const save = async () => {
    if (!name.trim()) { showToast({ type: "error", title: "Give the template a name." }); return; }
    if (!templateFile) { showToast({ type: "error", title: "Upload the blank template file." }); return; }
    setBusy("save");
    try {
      await saveOutputTemplate({
        orgId, id: template?.id, name: name.trim(), description: description.trim(),
        kind, templateFileKey: templateFile.key, templateFileName: templateFile.name,
        exampleFiles: examples, exampleText: exampleText.slice(0, 20000),
        placeholders, instructions: instructions.trim(), mode,
        filenamePattern: filenamePattern.trim(),
        columnMap: template?.columnMap ?? {},
      });
      showToast({ type: "success", title: "Template saved." });
      onSaved();
      onClose();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-xl mt-8 mb-8"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between sticky top-0 bg-[var(--color-surface)] rounded-t-2xl z-10">
          <div>
            <h2 className="text-base font-black text-[var(--color-text)]">
              {template ? "Edit template" : "New output template"}
            </h2>
            <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              Your file supplies every pixel of formatting — the AI only writes the words that go in
              the blanks.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Scope of Work" />
            </label>
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">One document per…</span>
              <Select value={mode} onChange={(e) => setMode(e.target.value as OutputTemplate["mode"])}>
                <option value="per_row">Row — one document per spreadsheet row</option>
                <option value="summary">Summary — one document covering all rows</option>
                <option value="both">Both — choose at generate time</option>
              </Select>
            </label>
          </div>
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Description</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Issued to contractors for turnaround work orders" />
          </label>

          {/* ── Blank template ─────────────────────────────────────────── */}
          <div className="rounded-xl border border-[var(--color-border)] p-3.5">
            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
              Blank template — owns all formatting
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="inline-flex">
                <input type="file" accept=".docx,.xlsx" hidden disabled={busy !== null}
                  onChange={(e) => { void onTemplatePicked(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] cursor-pointer">
                  {busy === "template" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  {templateFile ? "Replace file" : "Upload .docx / .xlsx"}
                </span>
              </label>
              {templateFile && (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--color-text)]">
                  <FileText className="w-3.5 h-3.5 text-orange-600" /> {templateFile.name}
                  <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                    {KIND_LABEL[kind]}
                  </span>
                </span>
              )}
            </div>
            {analysisNote && (
              <div className={`mt-2 rounded-lg px-3 py-2 text-[11px] flex items-start gap-2 ${
                placeholders.length > 0
                  ? "border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-900 dark:text-emerald-200"
                  : "border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200"}`}>
                {placeholders.length > 0 ? <Sparkles className="w-3.5 h-3.5 shrink-0 mt-px" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
                <span>{analysisNote}</span>
              </div>
            )}
            {loops.length > 0 && (
              <p className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
                Repeating blocks detected: {loops.map((l) => `{#${l}}`).join(", ")} — these fill from
                the data rows automatically.
              </p>
            )}
          </div>

          {/* ── Fill points ────────────────────────────────────────────── */}
          {placeholders.length > 0 && (
            <div className="rounded-xl border border-[var(--color-border)] p-3.5">
              <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                Fill points — what goes in each blank
              </div>
              <ul className="space-y-2">
                {placeholders.map((p) => (
                  <li key={p.tag} className="rounded-lg border border-[var(--color-border)] p-2.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-[11px] font-mono font-black text-orange-600">{`{${p.tag}}`}</code>
                      <div className="ml-auto inline-flex rounded-lg border border-[var(--color-border)] p-0.5">
                        {([
                          ["data", Database, "From data"],
                          ["ai", Sparkles, "AI writes"],
                          ["static", Type, "Fixed text"],
                        ] as const).map(([k, Icon, label]) => (
                          <button key={k} type="button" onClick={() => updatePlaceholder(p.tag, { kind: k })}
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-black transition-colors ${
                              p.kind === k ? "bg-orange-600 text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                            <Icon className="w-3 h-3" /> {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {p.kind === "ai" && (
                      <Input className="mt-1.5 text-xs" value={p.guidance ?? ""}
                        onChange={(e) => updatePlaceholder(p.tag, { guidance: e.target.value })}
                        placeholder="What should the AI write here? e.g. 'Two paragraphs describing the work, referencing the equipment tag.'" />
                    )}
                    {p.kind === "static" && (
                      <Input className="mt-1.5 text-xs" value={p.value ?? ""}
                        onChange={(e) => updatePlaceholder(p.tag, { value: e.target.value })}
                        placeholder="Fixed text used in every document" />
                    )}
                    {p.kind === "data" && (
                      <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                        Filled from the spreadsheet — the column is matched automatically at generate
                        time (you can correct it there).
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Examples ───────────────────────────────────────────────── */}
          <div className="rounded-xl border border-[var(--color-border)] p-3.5">
            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
              Example documents — the voice to copy
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] mb-2">
              Attach one or two finished documents. The AI reads them as a style guide — your phrasing,
              nomenclature, and level of detail — never as formatting (the template owns that).
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="inline-flex">
                <input type="file" accept=".docx" hidden disabled={busy !== null}
                  onChange={(e) => { void onExamplePicked(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] cursor-pointer">
                  {busy === "example" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  Add example
                </span>
              </label>
              {examples.map((ex) => (
                <span key={ex.key} className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2 py-1 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)]">
                  <FileText className="w-3 h-3" /> {ex.name}
                  <button onClick={() => setExamples((prev) => prev.filter((p) => p.key !== ex.key))}
                    className="text-[var(--color-text-muted)] hover:text-rose-600"><Trash2 className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Standing instructions</span>
            <Textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)}
              className="text-xs"
              placeholder="e.g. Written for contractors — never assume tools or scaffolding are provided. Always name the unit and equipment tag in the first sentence. Use our abbreviations (T/A, PSV, MOC)." />
          </label>

          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">File naming</span>
            <Input value={filenamePattern} onChange={(e) => setFilenamePattern(e.target.value)}
              placeholder="SOW-{wo_number}-{unit}" className="text-xs font-mono" />
            <span className="block mt-1 text-[10px] text-[var(--color-text-muted)]">
              Use any fill point in braces. Blank = the template name plus a number.
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void save()} disabled={busy !== null}>
              {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save template
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
