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
import { copyText } from "@/lib/clipboard";

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
  const copyAll = async () => {
    if (!draft) return;
    const text = [`${draft.form.title}`, "", ...draft.form.fields.map((f) => `${f.label}:\n${values[f.name] || "(to be completed)"}\n`)].join("\n");
    if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1600); }
  };

  return (
    <Modal onClose={onClose} size="xl" dismissable={busy !== "download"}>
      <ModalHeader icon={FileText} title={draft?.form.title ?? formName}
        subtitle={draft
          ? `${draft.form.purpose} · ${draft.form.fillable ? "fillable PDF - filled in place, still editable" : "flat PDF - completed pages + the original form"}`
          : "Drafting from this answer…"}
        onClose={onClose} />
      <ModalBody className="max-h-[70vh] space-y-4">
        {busy === "draft" && (
          <div className="py-16 flex flex-col items-center gap-2.5 text-center text-[var(--color-text-muted)]" aria-busy="true" aria-live="polite">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-muted)]" />
            <div className="text-[15px] font-bold text-[var(--color-text)]">Drafting every field from the answer and its proof…</div>
            <div className="text-[13px]">Names, signatures and numbers are left for you, never made up.</div>
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 text-[14px] font-semibold text-[var(--state-overdue)]">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{draft ? "That didn't work: " : "Couldn't draft the form: "}{error}</span>
          </div>
        )}
        {draft && (
          <>
            {draft.notes && (
              <p className="flex items-start gap-2 text-[14px] leading-relaxed text-[var(--color-text-muted)]">
                <Sparkles className="w-4 h-4 mt-0.5 shrink-0" /> <span>{draft.notes}</span>
              </p>
            )}
            {missing.length > 0 && (
              <p className="flex items-start gap-2 text-[14px] text-[var(--state-held)]">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-held)]" />
                <span><b>{missing.length} field{missing.length === 1 ? "" : "s"} need you:</b> {missing.slice(0, 8).map((f) => f.label).join(", ")}{missing.length > 8 ? "…" : ""}</span>
              </p>
            )}
            <div className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
              {draft.form.fields.map((f) => (
                <FieldInput key={f.name} field={f} value={values[f.name] ?? ""} onChange={(v) => set(f.name, v)}
                  needsYou={!values[f.name]?.trim()} />
              ))}
            </div>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <span className="mr-auto text-[13px] text-[var(--color-text-muted)] max-sm:hidden">Check every field before you submit it.</span>
        {draft && (
          <button type="button" onClick={() => void copyAll()}
            className="inline-flex items-center gap-1.5 h-10 text-[13px] font-bold px-3.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)]">
            {copied ? <Check className="w-4 h-4 text-[var(--state-released)]" /> : <Copy className="w-4 h-4" />} {copied ? "Copied" : "Copy as text"}
          </button>
        )}
        <button type="button" onClick={() => void download()} disabled={!draft || busy !== null}
          className="inline-flex items-center gap-1.5 h-10 text-[14px] font-semibold px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] shadow-[0_10px_20px_-12px_var(--color-accent)] disabled:opacity-50 disabled:shadow-none">
          {busy === "download" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} {busy === "download" ? "Filling the PDF…" : "Download filled PDF"}
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
    ? "border-[var(--state-held)] bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)]"
    : "border-[var(--color-border)] bg-[var(--color-surface)]";
  const base = `w-full rounded-lg border px-3 py-2 text-[14px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-border-strong)] focus:ring-2 focus:ring-[var(--color-border)] ${ring}`;
  return (
    <div className="py-3">
      <label htmlFor={id} className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">
        {f.label}
        {needsYou && <span className="text-[13px] font-semibold text-[var(--state-held)]">· needs you</span>}
      </label>
      {f.kind === "long" ? (
        <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={Math.min(14, Math.max(4, Math.ceil(value.length / 90)))} className={`${base} leading-relaxed`} />
      ) : f.kind === "check" ? (
        <label className="inline-flex items-center gap-2 text-[14px] text-[var(--color-text)]">
          <input id={id} type="checkbox" checked={/^(y|yes|true|x|checked|on|1)$/i.test(value)} onChange={(e) => onChange(e.target.checked ? "Yes" : "")} className="w-4 h-4 accent-[var(--color-main)]" />
          {f.label}
        </label>
      ) : f.kind === "choice" && f.options && f.options.length > 0 ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={base}>
          <option value="">-</option>
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input id={id} type={f.kind === "date" ? "date" : "text"} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={f.kind === "signature" ? "Signed on the printed form" : ""} className={base} />
      )}
    </div>
  );
}
