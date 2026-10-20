"use client";

// FormFillModal — a library form, drafted from the answer, edited field by
// field, downloaded as a PDF.
//
// The draft is a starting point the engineer owns: every field is editable,
// fields only a person can supply (names, signatures, numbers) are flagged
// instead of invented, and nothing is filed anywhere — the download is the
// output. Fillable PDFs come back filled and still editable; flat forms come
// back as completed pages followed by the original form.

import React, { useEffect, useState } from "react";
import { FileText, Download, Loader2, AlertTriangle, Copy, Check, Sparkles } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import {
  draftLibraryForm, downloadLibraryForm,
  type DraftedForm, type DraftedFormField, type KnowledgeCitation,
} from "@/lib/knowledge";

export default function FormFillModal({ orgId, documentId, formName, question, answer, citations, goal, onClose }: {
  orgId: string;
  documentId: string;
  formName: string;
  question: string;
  answer: string;
  citations: KnowledgeCitation[];
  goal?: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DraftedForm | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"draft" | "download" | null>("draft");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void draftLibraryForm({ orgId, documentId, question, answer, citations, goal }).then(
      (d) => {
        if (cancelled) return;
        setDraft(d);
        setValues(Object.fromEntries(d.form.fields.map((f) => [f.name, f.value])));
        setBusy(null);
      },
      (e) => { if (!cancelled) { setError((e as Error).message); setBusy(null); } },
    );
    return () => { cancelled = true; };
    // One draft per opening — the inputs are fixed for the modal's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (name: string, v: string) => setValues((cur) => ({ ...cur, [name]: v }));
  const missing = draft ? draft.form.fields.filter((f) => !values[f.name]?.trim()) : [];
  const download = async () => {
    if (!draft) return;
    setBusy("download");
    try { await downloadLibraryForm(orgId, documentId, values); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const copyText = async () => {
    if (!draft) return;
    const text = [`${draft.form.title}`, "", ...draft.form.fields.map((f) => `${f.label}:\n${values[f.name] || "(to be completed)"}\n`)].join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };

  return (
    <Modal onClose={onClose} size="xl" dismissable={busy !== "download"}>
      <ModalHeader icon={FileText} title={draft?.form.title ?? formName}
        subtitle={draft
          ? `${draft.form.purpose} · ${draft.form.fillable ? "fillable PDF — filled in place, still editable" : "flat PDF — completed pages + the original form"}`
          : "Drafting from this answer…"}
        onClose={onClose} />
      <ModalBody className="max-h-[70vh] space-y-4">
        {busy === "draft" && (
          <div className="py-16 flex flex-col items-center gap-3 text-[var(--color-text-muted)]">
            <Loader2 className="w-6 h-6 animate-spin text-orange-600" />
            <div className="text-sm font-bold text-[var(--color-text)]">Drafting every field from the answer and its proof</div>
            <div className="text-xs">Names, signatures and numbers are left for you — never invented.</div>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3 py-2.5 text-sm text-rose-800 dark:text-rose-300">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {draft && (
          <>
            {draft.notes && (
              <div className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2.5 text-[13px] text-[var(--color-text)]">
                <Sparkles className="w-4 h-4 mt-0.5 shrink-0 text-orange-600" /> {draft.notes}
              </div>
            )}
            {missing.length > 0 && (
              <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-[13px] text-amber-900 dark:text-amber-200">
                <b>{missing.length} field{missing.length === 1 ? "" : "s"} need you:</b> {missing.slice(0, 8).map((f) => f.label).join(", ")}{missing.length > 8 ? "…" : ""}
              </div>
            )}
            <div className="space-y-3">
              {draft.form.fields.map((f) => (
                <FieldInput key={f.name} field={f} value={values[f.name] ?? ""} onChange={(v) => set(f.name, v)}
                  needsYou={!values[f.name]?.trim()} />
              ))}
            </div>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">Review every field before you submit — you own what&apos;s on this form.</span>
        {draft && (
          <button type="button" onClick={() => void copyText()}
            className="inline-flex items-center gap-1.5 text-[13px] font-bold px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-orange-400">
            {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />} {copied ? "Copied" : "Copy as text"}
          </button>
        )}
        <button type="button" onClick={() => void download()} disabled={!draft || busy !== null}
          className="inline-flex items-center gap-1.5 text-[13px] font-bold px-4 py-2 rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50">
          {busy === "download" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download filled PDF
        </button>
      </ModalFooter>
    </Modal>
  );
}

function FieldInput({ field: f, value, onChange, needsYou }: {
  field: DraftedFormField; value: string; onChange: (v: string) => void; needsYou: boolean;
}) {
  const id = `form-field-${f.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const ring = needsYou
    ? "border-amber-400 dark:border-amber-700 bg-amber-50/40 dark:bg-amber-950/10"
    : "border-[var(--color-border)] bg-[var(--color-surface)]";
  const base = `w-full rounded-lg border px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-orange-400 ${ring}`;
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-2 text-[12px] font-bold text-[var(--color-text-muted)] mb-1">
        {f.label}
        {needsYou && <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">needs you</span>}
      </label>
      {f.kind === "long" ? (
        <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={Math.min(14, Math.max(4, Math.ceil(value.length / 90)))} className={`${base} leading-relaxed`} />
      ) : f.kind === "check" ? (
        <label className="inline-flex items-center gap-2 text-sm text-[var(--color-text)]">
          <input id={id} type="checkbox" checked={/^(y|yes|true|x|checked|on|1)$/i.test(value)} onChange={(e) => onChange(e.target.checked ? "Yes" : "")} className="w-4 h-4 accent-orange-600" />
          {f.label}
        </label>
      ) : f.kind === "choice" && f.options && f.options.length > 0 ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={base}>
          <option value="">—</option>
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input id={id} type={f.kind === "date" ? "date" : "text"} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={f.kind === "signature" ? "Signed on the printed form" : ""} className={base} />
      )}
    </div>
  );
}
