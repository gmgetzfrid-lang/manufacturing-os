"use client";

// CostDocumentIngestModal — upload a quote / PO / invoice, let the AI read it
// (multimodal), then REVIEW + EDIT every line and where it maps before anything
// posts. This is the "add a quote and the app parses it and auto-configures,
// with a confirm before post" flow — applied to the cost ledger.
//
//   pick file + kind + contractor → AI extracts → editable line-item table
//   with per-line cost type + account mapping → confirm → posts entries.
//
// Nothing is auto-posted. The AI only proposes; the human commits.

import React, { useMemo, useState } from "react";
import {
  FileText, Loader2, UploadCloud, Sparkles, AlertTriangle, Check, ArrowRight, Trash2, Plus,
} from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { Field, Select } from "@/components/ui/Field";
import { formatMoney } from "@/lib/evm";
import { COST_TYPE_LABEL } from "@/lib/costControls";
import {
  extractCostFromFile, planFromExtraction, postIngestPlan, KIND_TO_ENTRY_TYPE,
} from "@/lib/costIngestion";
import { uploadToPath } from "@/lib/storage";
import type {
  ProjectParty, CostAccount, CostExtraction, CostType, CostDocumentKind, CostEntryType,
} from "@/types/schema";

const KINDS: CostDocumentKind[] = ["afe", "quote", "estimate", "po", "subcontract", "invoice", "change_order", "other"];
const COST_TYPES: CostType[] = ["labor", "material", "equipment", "subcontract", "odc"];
const ENTRY_LABEL: Record<CostEntryType, string> = { budget: "Budget", commitment: "Commitment (PO)", actual: "Actual (invoice)", change: "Change order" };

interface Row {
  description: string;
  amount: number;
  costType: CostType;
  /** Contractor: an existing party id, "new:<name>", or "" for none. */
  party: string;
  /** Existing account id, or "new" to create one. */
  accountId: string;
}

interface Props {
  orgId: string;
  projectId: string;
  parties: ProjectParty[];
  accounts: CostAccount[];
  currency: string;
  userId: string;
  userEmail?: string;
  onClose: () => void;
  onPosted: () => void;
}

export default function CostDocumentIngestModal({
  orgId, projectId, parties, accounts, currency, userId, userEmail, onClose, onPosted,
}: Props) {
  const [step, setStep] = useState<"pick" | "review" | "done">("pick");
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<CostDocumentKind>("invoice");
  const [partyId, setPartyId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [extraction, setExtraction] = useState<CostExtraction | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<{ createdParties: number; createdAccounts: number; postedEntries: number; postedTotal: number } | null>(null);

  const entryType = KIND_TO_ENTRY_TYPE[kind];
  const total = useMemo(() => rows.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0), [rows]);

  // Contractor dropdown options = existing parties + any new ones the AI found
  // in the rows (so a brand-new contractor on an AFE is selectable / editable).
  const partyOptions = useMemo(() => {
    const opts = parties.map((p) => ({ value: p.id!, label: p.name }));
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.party.startsWith("new:")) {
        const name = r.party.slice(4);
        if (!seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); opts.push({ value: r.party, label: `${name} (new)` }); }
      }
    }
    return opts;
  }, [parties, rows]);

  const onExtract = async () => {
    if (!file) { setError("Choose a document first."); return; }
    setBusy(true); setError(null);
    try {
      const ext = await extractCostFromFile(file, {
        kindHint: kind,
        accountHints: accounts.map((a) => `${a.name} (${a.costType})`),
      });
      // Honour the model's classification if it found one, else keep the user's.
      const effectiveKind = ext.kind && ext.kind !== "other" ? ext.kind : kind;
      const plan = planFromExtraction({ ...ext, kind: effectiveKind }, accounts, { partyId: partyId || null, parties });
      setExtraction({ ...ext, kind: effectiveKind });
      setKind(effectiveKind);
      setRows(plan.lines.map((l) => ({
        description: l.line.description,
        amount: l.line.amount,
        costType: l.line.costType ?? "odc",
        party: l.partyId ?? (l.newPartyName ? `new:${l.newPartyName}` : (partyId || "")),
        accountId: l.accountId ?? "new",
      })));
      setStep("review");
    } catch (e) {
      setError((e as Error).message || "Couldn't read the document.");
    } finally { setBusy(false); }
  };

  const onPost = async () => {
    if (rows.length === 0) { setError("Nothing to post."); return; }
    setBusy(true); setError(null);
    try {
      // Best-effort: retain the source file in storage for traceability.
      let fileUrl: string | null = null;
      if (file) {
        try {
          const path = `orgs/${orgId}/projects/${projectId}/cost-docs/${Date.now()}-${sanitize(file.name)}`;
          await uploadToPath(file, path, { contentType: file.type });
          fileUrl = path;
        } catch { /* retention is a bonus; never block the post */ }
      }

      const res = await postIngestPlan({
        orgId, projectId, partyId: partyId || null, kind,
        fileUrl, fileName: file?.name ?? null, mimeType: file?.type ?? null,
        extraction: extraction ?? { kind, lineItems: [] },
        accounts,
        plan: {
          entryType,
          total,
          lines: rows.map((r) => ({
            line: { description: r.description, amount: r.amount, costType: r.costType, party: r.party.startsWith("new:") ? r.party.slice(4) : null },
            partyId: r.party && !r.party.startsWith("new:") ? r.party : null,
            newPartyName: r.party.startsWith("new:") ? r.party.slice(4) : null,
            accountId: r.accountId === "new" ? null : r.accountId,
            newAccount: r.accountId === "new" ? { name: r.description || COST_TYPE_LABEL[r.costType], costType: r.costType } : undefined,
          })),
        },
        actorUserId: userId, actorEmail: userEmail,
      });
      setResult(res);
      setStep("done");
    } catch (e) {
      setError((e as Error).message || "Failed to post.");
    } finally { setBusy(false); }
  };

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <Modal onClose={busy ? () => {} : onClose} size="2xl" dismissable={!busy}>
      <ModalHeader
        icon={Sparkles}
        title="Ingest a cost document"
        subtitle="Upload a quote, PO or invoice — the AI reads it; you confirm before anything posts."
        onClose={busy ? undefined : onClose}
      />

      <ModalBody className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
          </div>
        )}

        {step === "pick" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Document type">
                <Select value={kind} onChange={(e) => setKind(e.target.value as CostDocumentKind)}>
                  {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </Select>
              </Field>
              <Field label="Contractor / vendor" hint="Optional — ties the doc to a party.">
                <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                  <option value="">— none —</option>
                  {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </Field>
            </div>

            <label className={`block rounded-2xl border-2 border-dashed ${file ? "border-[var(--color-accent-ring)] bg-[var(--color-accent-soft)]/40" : "border-[var(--color-border-strong)]"} p-6 text-center cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors`}>
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }}
              />
              {file ? (
                <div className="flex items-center justify-center gap-2 text-sm font-bold text-[var(--color-text)]">
                  <FileText className="w-4 h-4 text-[var(--color-accent)]" /> {file.name}
                </div>
              ) : (
                <div className="text-sm text-[var(--color-text-muted)]">
                  <UploadCloud className="w-7 h-7 mx-auto mb-2 text-[var(--color-text-faint)]" />
                  Drop a PDF or photo of the document, or click to choose.
                </div>
              )}
            </label>
            <p className="text-[11px] text-[var(--color-text-faint)]">
              The file goes straight to the model (PDFs and photos both work — scanned docs are OCR&rsquo;d). You&rsquo;ll review every line before it posts.
            </p>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
              {extraction?.vendorName && <span><b className="text-[var(--color-text)]">{extraction.vendorName}</b></span>}
              {extraction?.docNumber && <span>#{extraction.docNumber}</span>}
              {extraction?.docDate && <span>{extraction.docDate}</span>}
              <span className="inline-flex items-center gap-1 font-bold text-[var(--color-accent)]">
                <ArrowRight className="w-3 h-3" /> Posts as {ENTRY_LABEL[entryType]}
              </span>
              <span className="ml-auto font-black text-sm text-[var(--color-text)]">{formatMoney(total, currency)}</span>
            </div>

            {extraction?.notes && (
              <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                {extraction.notes}
              </div>
            )}

            <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
              <div className="grid grid-cols-[1.4fr_84px_92px_1fr_1fr_24px] gap-1.5 px-3 py-2 bg-[var(--color-surface-2)] text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">
                <span>Scope / line</span><span className="text-right">Amount</span><span>Type</span><span>Contractor</span><span>{entryType === "budget" ? "Budget account" : "Maps to account"}</span><span />
              </div>
              <div className="divide-y divide-[var(--color-border)] max-h-72 overflow-auto">
                {rows.map((r, i) => {
                  const matching = accounts.filter((a) => a.costType === r.costType);
                  return (
                    <div key={i} className="grid grid-cols-[1.4fr_84px_92px_1fr_1fr_24px] gap-1.5 px-3 py-2 items-center">
                      <input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })}
                        className="text-xs px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)]" />
                      <input inputMode="decimal" value={String(r.amount)} onChange={(e) => setRow(i, { amount: Number(e.target.value.replace(/[,$]/g, "")) || 0 })}
                        className="text-xs px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] font-mono text-right" />
                      <select value={r.costType} onChange={(e) => setRow(i, { costType: e.target.value as CostType, accountId: "new" })}
                        className="text-xs px-1 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                        {COST_TYPES.map((c) => <option key={c} value={c}>{COST_TYPE_LABEL[c]}</option>)}
                      </select>
                      <select value={r.party} onChange={(e) => setRow(i, { party: e.target.value })}
                        className="text-xs px-1 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                        <option value="">— none —</option>
                        {partyOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <select value={r.accountId} onChange={(e) => setRow(i, { accountId: e.target.value })}
                        className="text-xs px-1 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                        {matching.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        <option value="new">{entryType === "budget" ? "➕ New budget account" : `➕ New ${COST_TYPE_LABEL[r.costType]} account`}</option>
                      </select>
                      <button onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))} title="Remove line"
                        className="p-1 rounded text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-50">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
                {rows.length === 0 && (
                  <div className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">No line items. Add one below or go back.</div>
                )}
              </div>
              <button onClick={() => setRows((rs) => [...rs, { description: "", amount: 0, costType: "odc", party: partyId || "", accountId: "new" }])}
                className="w-full px-3 py-2 text-[11px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-surface-2)] inline-flex items-center justify-center gap-1 border-t border-[var(--color-border)]">
                <Plus className="w-3.5 h-3.5" /> Add line
              </button>
            </div>
            <p className="text-[11px] text-[var(--color-text-faint)]">
              New accounts are created at $0 budget and the lines post against them. Edit budgets afterward in the cost structure.
            </p>
          </div>
        )}

        {step === "done" && result && (
          <div className="text-center py-6">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-3">
              <Check className="w-6 h-6" />
            </div>
            <div className="text-sm font-black text-[var(--color-text)]">Posted {formatMoney(result.postedTotal, currency)}</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1">
              {result.postedEntries} {ENTRY_LABEL[entryType].toLowerCase()} entr{result.postedEntries === 1 ? "y" : "ies"}
              {result.createdParties > 0 && ` · ${result.createdParties} new contractor${result.createdParties === 1 ? "" : "s"}`}
              {result.createdAccounts > 0 && ` · ${result.createdAccounts} new cost account${result.createdAccounts === 1 ? "" : "s"}`}.
            </div>
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        {step === "pick" && (
          <>
            <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">Cancel</button>
            <button onClick={onExtract} disabled={!file || busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Read document
            </button>
          </>
        )}
        {step === "review" && (
          <>
            <button onClick={() => setStep("pick")} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Back</button>
            <button onClick={onPost} disabled={busy || rows.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Post {formatMoney(total, currency)}
            </button>
          </>
        )}
        {step === "done" && (
          <button onClick={() => { onPosted(); onClose(); }} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]">Done</button>
        )}
      </ModalFooter>
    </Modal>
  );
}

const KIND_LABEL: Record<CostDocumentKind, string> = {
  afe: "AFE (Authorization for Expenditure)", quote: "Quote", estimate: "Estimate",
  po: "Purchase order", subcontract: "Subcontract",
  invoice: "Invoice", change_order: "Change order", other: "Other",
};

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}
