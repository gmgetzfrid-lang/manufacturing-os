"use client";

// QuotesPanel — READING inbound money paper, then tabulating it.
//
// The direction the whole cost program runs on: vendors send US documents.
// Quotes arrive two ways — a member drops the PDF here, or the contractor
// submits through a tokened quote link (no account, same portal rails as
// drawings). One click has the AI read the printed pages into numbers;
// competing quotes in an RFQ group tabulate side by side — price, labor
// hours, $/hour, and the EXCLUSIONS that explain why the low bid is low —
// with a weighted best-value score whose math is always shown. Awarding
// posts the commitment to a budget line in the same click. Invoices follow
// the same read-review-post path as actuals — dropped in a stack, read on
// arrival, routed to their vendor's budget line, checked for duplicates,
// and the confident matches posted together after one confirmation.

import React, { useMemo, useState } from "react";
import {
  FileText, UploadCloud, Loader2, Sparkles, Trophy, Link2, Copy, AlertTriangle,
  CheckCircle2, ScanSearch, Ban, Receipt, ChevronDown, ChevronRight, Wand2, Copy as CopyIcon,
} from "lucide-react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { listCompanies, type Company } from "@/lib/companies";
import { fmtMoney, type CostAccount, type CostParty, type Actor } from "@/lib/costs";
import { suggestAccountForInvoice, findDuplicateInvoice, type AccountSuggestion } from "@/lib/budgetDoc";
import {
  type CostDocument, COST_DOC_STATUS_LABEL,
  uploadCostDoc, awardQuote, postInvoice, voidCostDoc, setManualTotal,
  parsedQuoteFrom, quoteGroups,
} from "@/lib/costDocs";
import { computeBidEconomics, scoreBids, DEFAULT_WEIGHTS, type ParsedQuote } from "@/lib/bidTab";
import { downloadStarterRfq } from "@/lib/rfqDocx";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

/** Have the AI read one stored quote/invoice. Throws the route's message. */
async function readCostDoc(orgId: string, projectId: string, costDocId: string): Promise<void> {
  const res = await fetch("/api/projects/cost-docs", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ orgId, projectId, costDocId }),
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
}

const INVOICE_ACCEPT = ".pdf,application/pdf,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";

export default function QuotesPanel({ orgId, projectId, canManage, actor, accounts, docs, onChanged, setErr, section, parties = [] }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  accounts: CostAccount[];
  /** Render only one half (the Costs sub-tabs); omitted = both. */
  section?: "quotes" | "invoices";
  /** Project companies — invoices route to their vendor's budget line. */
  parties?: CostParty[];
  docs: CostDocument[];
  onChanged: () => void;
  setErr: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(false);
  // Known Companies registry — matched to bidders by name so their record
  // (quality-manual coverage, do-not-use flags) sits beside every price.
  const [companies, setCompanies] = useState<Company[]>([]);
  React.useEffect(() => {
    listCompanies(orgId).then(setCompanies).catch(() => setCompanies([]));
  }, [orgId]);
  const groups = useMemo(() => quoteGroups(docs), [docs]);
  const invoices = useMemo(() => docs.filter((d) => (d.kind === "invoice" || d.kind === "po") && d.status !== "void"), [docs]);
  const existingGroups = useMemo(
    () => [...new Set(docs.map((d) => d.rfqGroup).filter((g): g is string => !!g))], [docs]);

  const readDoc = async (doc: CostDocument) => {
    setBusy(doc.id); setErr(null);
    try {
      await readCostDoc(orgId, projectId, doc.id);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  const typeTotal = async (doc: CostDocument) => {
    const v = await appPrompt({
      title: "Type the total from the paper",
      message: `The AI couldn't read (or hasn't read) ${doc.fileName ?? "this document"}. Enter its bottom-line total and it becomes the awardable number.`,
      placeholder: "e.g. 182000",
    });
    if (!v) return;
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(n) || n <= 0) { setErr("That didn't read as a positive number."); return; }
    setBusy(doc.id);
    const res = await setManualTotal({ doc, total: n, actor });
    setBusy(null);
    if (!res.ok) setErr(res.error ?? "Couldn't save the total."); else onChanged();
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      {section !== "invoices" && (<>
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
        <ScanSearch className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Quotes &amp; bid tabulation</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          Drop vendor quote PDFs — the system reads them and compares price, manpower, and scope.
        </span>
        {canManage && (
          <button onClick={() => setShowLinks((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
            <Link2 className="w-3 h-3" /> Quote links for contractors
          </button>
        )}
      </div>

      {showLinks && canManage && (
        <QuoteLinksSection orgId={orgId} projectId={projectId} actor={actor} existingGroups={existingGroups} setErr={setErr} />
      )}

      {canManage && (
        <UploadRow orgId={orgId} projectId={projectId} actor={actor} kind="quote"
          existingGroups={existingGroups} onDone={onChanged} setErr={setErr} />
      )}

      {groups.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <FileText className="w-7 h-7 mx-auto text-[var(--color-text-faint)] mb-2" />
          <div className="text-sm font-bold text-[var(--color-text)]">No quotes yet</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-1 max-w-lg mx-auto">
            Upload the PDFs vendors sent you (same RFQ group name = compared side by side), or send
            contractors a quote link and their submissions land here on their own.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {groups.map(({ group, docs: groupDocs }) => (
            <BidGroup key={group} group={group} docs={groupDocs} allDocs={docs}
              accounts={accounts} parties={parties} companies={companies} canManage={canManage} actor={actor}
              busy={busy} setBusy={setBusy} readDoc={readDoc} typeTotal={typeTotal}
              onChanged={onChanged} setErr={setErr} />
          ))}
        </div>
      )}

      </>)}

      {/* ── Invoices ── */}
      {section !== "quotes" && (
        <InvoicesSection orgId={orgId} projectId={projectId} canManage={canManage} actor={actor}
          accounts={accounts} parties={parties} docs={docs} invoices={invoices}
          framed={section !== "invoices"} busy={busy} setBusy={setBusy}
          readDoc={readDoc} typeTotal={typeTotal} onChanged={onChanged} setErr={setErr} />
      )}
    </div>
  );
}

// ── Invoices: drop a stack, they read and route themselves ──────────────

function invoiceLines(doc: CostDocument): Array<{ description: string; total: number | null }> {
  const items = (doc.parsed as { lineItems?: unknown } | null)?.lineItems;
  if (!Array.isArray(items)) return [];
  return items
    .map((x) => (x && typeof x === "object" ? x as Record<string, unknown> : null))
    .filter((x): x is Record<string, unknown> => !!x && typeof x.description === "string")
    .map((x) => ({ description: String(x.description), total: typeof x.total === "number" ? x.total : null }));
}

function InvoicesSection({ orgId, projectId, canManage, actor, accounts, parties, docs, invoices, framed, busy, setBusy, readDoc, typeTotal, onChanged, setErr }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  accounts: CostAccount[]; parties: CostParty[]; docs: CostDocument[]; invoices: CostDocument[];
  framed: boolean; busy: string | null; setBusy: (v: string | null) => void;
  readDoc: (d: CostDocument) => Promise<void>;
  typeTotal: (d: CostDocument) => Promise<void>;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [batch, setBatch] = useState<string | null>(null);

  const rows = useMemo(() => invoices.map((doc) => ({
    doc,
    lines: invoiceLines(doc),
    suggestion: doc.status === "parsed" ? suggestAccountForInvoice({
      vendorName: doc.vendorName, partyId: doc.partyId,
      lineDescriptions: invoiceLines(doc).map((l) => l.description),
    }, accounts, parties) : null,
    duplicate: findDuplicateInvoice(doc, docs),
  })), [invoices, accounts, parties, docs]);

  const ready = rows.filter((r) => r.doc.status === "parsed" && r.suggestion?.confidence === "high"
    && !r.duplicate && (r.doc.totalAmount ?? 0) > 0);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "budget line";

  const postReady = async () => {
    if (!(await appConfirm({
      title: `Post ${ready.length} invoice${ready.length === 1 ? "" : "s"} as actual spend?`,
      message: (
        <ul className="mt-1 space-y-0.5 text-xs">
          {ready.map((r) => (
            <li key={r.doc.id}>
              <span className="font-bold text-[var(--color-text)]">{r.doc.vendorName ?? "Vendor"}</span>
              {r.doc.docNumber ? ` ${r.doc.docNumber}` : ""} — {fmtMoney(r.doc.totalAmount ?? 0)} → {accountName(r.suggestion!.accountId)}
            </li>
          ))}
        </ul>
      ),
    }))) return;
    let failed = 0;
    for (const [i, r] of ready.entries()) {
      setBatch(`Posting ${i + 1} of ${ready.length}…`);
      const res = await postInvoice({ doc: r.doc, costAccountId: r.suggestion!.accountId, actor });
      if (!res.ok) failed++;
    }
    setBatch(null);
    if (failed) setErr(`${failed} invoice${failed === 1 ? "" : "s"} couldn't post — someone may have acted on them already. Refreshed.`);
    onChanged();
  };

  return (
    <div className={framed ? "border-t border-[var(--color-border)]" : undefined}>
      <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
        <Receipt className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Invoices</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">Drop them in — each is read, matched to its vendor&apos;s budget line, and checked for duplicates. You confirm before money posts.</span>
        {canManage && ready.length > 0 && (
          <button onClick={() => void postReady()} disabled={!!batch}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors"
            title="Invoices whose vendor maps to exactly one budget line, with a readable total and no duplicate on file.">
            {batch ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
            {batch ?? `Post ${ready.length} matched`}
          </button>
        )}
      </div>
      {canManage && (
        <InvoiceDrop orgId={orgId} projectId={projectId} actor={actor} onDone={onChanged} setErr={setErr} />
      )}
      {rows.length === 0 ? (
        <div className="px-4 pb-4 text-[11px] italic text-[var(--color-text-faint)]">No invoices uploaded yet.</div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          {rows.map(({ doc, lines, suggestion, duplicate }) => {
            const isOpen = open === doc.id;
            const p = (doc.parsed ?? {}) as { poNumber?: unknown; dueDate?: unknown; subtotal?: unknown; tax?: unknown };
            return (
              <li key={doc.id} className="px-4 py-2.5 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => setOpen(isOpen ? null : doc.id)} className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title="What the AI read">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </button>
                  <span className="font-bold text-[var(--color-text)] truncate">{doc.vendorName ?? doc.fileName ?? "Invoice"}</span>
                  {doc.docNumber && <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{doc.docNumber}</span>}
                  {doc.docDate && <span className="text-[10px] text-[var(--color-text-muted)]">{doc.docDate}</span>}
                  {doc.totalAmount != null && <span className="font-black tabular-nums text-[var(--color-text)]">{fmtMoney(doc.totalAmount, doc.currency ?? "USD")}</span>}
                  <StatusChip status={doc.status} />
                  {duplicate && (doc.status === "draft" || doc.status === "parsed") && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                      title={`Same vendor and ${duplicate.docNumber ? "invoice number" : "amount and date"} as ${duplicate.fileName ?? "another invoice"} (${COST_DOC_STATUS_LABEL[duplicate.status as CostDocument["status"]]?.toLowerCase() ?? duplicate.status}).`}>
                      <CopyIcon className="w-2.5 h-2.5" /> possible duplicate
                    </span>
                  )}
                  {canManage && doc.status === "draft" && (
                    <>
                      <ReadButton busy={busy === doc.id} onClick={() => void readDoc(doc)} />
                      <button onClick={() => void typeTotal(doc)}
                        className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">type total</button>
                    </>
                  )}
                  {canManage && doc.status === "parsed" && (
                    <PostControls accounts={accounts} busy={busy === doc.id} suggested={suggestion}
                      onPost={async (accountId) => {
                        if (duplicate && !(await appConfirm({ message: `This looks like a duplicate of ${duplicate.fileName ?? "another invoice"} from the same vendor. Post it anyway?`, tone: "danger" }))) return;
                        setBusy(doc.id);
                        const res = await postInvoice({ doc, costAccountId: accountId, actor });
                        setBusy(null);
                        if (!res.ok) setErr(res.error ?? "Couldn't post."); else onChanged();
                      }} label="Post as actual" />
                  )}
                  {canManage && (doc.status === "draft" || doc.status === "parsed") && (
                    <VoidButton doc={doc} actor={actor} busy={busy === doc.id} setBusy={setBusy} onChanged={onChanged} setErr={setErr} />
                  )}
                </div>
                {isOpen && (
                  <div className="mt-2 ml-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 px-3 py-2 space-y-1">
                    <div className="text-[10px] text-[var(--color-text-muted)] flex flex-wrap gap-x-3">
                      <span>File: {doc.fileName ?? "—"}</span>
                      {typeof p.poNumber === "string" && p.poNumber && <span>PO {p.poNumber}</span>}
                      {typeof p.dueDate === "string" && p.dueDate && <span>Due {p.dueDate}</span>}
                      {typeof p.subtotal === "number" && <span>Subtotal {fmtMoney(p.subtotal)}</span>}
                      {typeof p.tax === "number" && <span>Tax {fmtMoney(p.tax)}</span>}
                    </div>
                    {lines.length > 0 ? (
                      <ul className="text-[11px]">
                        {lines.map((l, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="flex-1 text-[var(--color-text)]">{l.description}</span>
                            {l.total != null && <span className="tabular-nums font-bold">{fmtMoney(l.total)}</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-[11px] italic text-[var(--color-text-faint)]">{doc.status === "draft" ? "Not read yet." : "No line detail was printed (or readable)."}</div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Many invoices at once: upload each, then read it straight away. */
function InvoiceDrop({ orgId, projectId, actor, onDone, setErr }: {
  orgId: string; projectId: string; actor: Actor;
  onDone: () => void; setErr: (m: string | null) => void;
}) {
  const [progress, setProgress] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = React.useRef<HTMLInputElement>(null);

  const run = async (files: File[]) => {
    if (files.length === 0) return;
    setErr(null);
    const problems: string[] = [];
    for (const [i, file] of files.entries()) {
      setProgress(`${files.length > 1 ? `${i + 1} of ${files.length}: ` : ""}uploading ${file.name}…`);
      const up = await uploadCostDoc({ orgId, projectId, kind: "invoice", file, actor });
      if (!up.ok || !up.doc) { problems.push(`${file.name}: ${up.error ?? "upload failed"}`); continue; }
      setProgress(`${files.length > 1 ? `${i + 1} of ${files.length}: ` : ""}reading ${file.name}…`);
      try { await readCostDoc(orgId, projectId, up.doc.id); }
      catch (e) { problems.push(`${file.name}: uploaded, but not read — ${(e as Error).message}`); }
    }
    setProgress(null);
    if (problems.length) setErr(problems.join(" · "));
    onDone();
  };

  return (
    <div className="px-4 pb-2.5">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!progress) void run([...(e.dataTransfer.files ?? [])]); }}
        onClick={() => !progress && input.current?.click()}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !progress) input.current?.click(); }}
        className={`rounded-lg border border-dashed px-3 py-2 flex items-center gap-2 text-xs cursor-pointer transition-colors ${
          over ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/60" : "border-[var(--color-border-strong)] hover:border-[var(--color-accent-ring)] bg-[var(--color-surface-2)]/30"}`}>
        {progress ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-accent)]" /> : <UploadCloud className="w-3.5 h-3.5 text-[var(--color-accent)]" />}
        <span className="text-[var(--color-text-muted)] truncate">
          {progress ?? "Drop invoices here (PDF or photo — several at once is fine), or click to choose"}
        </span>
        <input ref={input} type="file" multiple accept={INVOICE_ACCEPT} className="hidden"
          onChange={(e) => { void run([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>
    </div>
  );
}

// ── One RFQ group: the tabulation ────────────────────────────────────────

function BidGroup({ group, docs: groupDocs, allDocs, accounts, parties, companies, canManage, actor, busy, setBusy, readDoc, typeTotal, onChanged, setErr }: {
  group: string; docs: CostDocument[]; allDocs: CostDocument[];
  accounts: CostAccount[]; parties: CostParty[]; companies: Company[]; canManage: boolean; actor: Actor;
  busy: string | null; setBusy: (v: string | null) => void;
  readDoc: (d: CostDocument) => Promise<void>;
  typeTotal: (d: CostDocument) => Promise<void>;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const parsed = useMemo(() => {
    const out: Array<{ doc: CostDocument; quote: ParsedQuote }> = [];
    for (const d of groupDocs) {
      const q = parsedQuoteFrom(d);
      if (q) out.push({ doc: d, quote: q });
    }
    return out;
  }, [groupDocs]);
  const econ = useMemo(() => computeBidEconomics(parsed.map((p) => p.quote)), [parsed]);
  const scores = useMemo(() => new Map(scoreBids(econ).map((s) => [s.quoteId, s])), [econ]);
  const awarded = groupDocs.find((d) => d.status === "awarded");
  const unread = groupDocs.filter((d) => d.status === "draft");
  // Bids with a human-typed total but no readable extraction (unreadable
  // scans) — comparable on price only, but fully awardable.
  const manualBids = useMemo(
    () => groupDocs.filter((d) =>
      d.status !== "void" && d.status !== "draft" && !parsedQuoteFrom(d) && (d.totalAmount ?? 0) > 0),
    [groupDocs]);

  // The budget line a bid belongs on: its vendor's line, else the line
  // whose name matches the RFQ group / priced scope ("Scaffolding").
  const suggestFor = (doc: CostDocument) => suggestAccountForInvoice({
    vendorName: doc.vendorName, partyId: doc.partyId,
    lineDescriptions: [group.replace(/^Ungrouped — /, ""), ...(parsedQuoteFrom(doc)?.lineItems.map((l) => l.description) ?? [])],
  }, accounts, parties);

  const award = async (doc: CostDocument, accountId: string) => {
    const total = doc.totalAmount ?? parsedQuoteFrom(doc)?.total ?? 0;
    const account = accounts.find((a) => a.id === accountId);
    if (!(await appConfirm({
      message: `Award "${group}" to ${doc.vendorName ?? "this vendor"} for ${fmtMoney(total)}? This posts a commitment on "${account?.name ?? "the budget line"}" and marks the other bids not selected.`,
    }))) return;
    setBusy(doc.id);
    const res = await awardQuote({ doc, siblings: allDocs, costAccountId: accountId, actor });
    setBusy(null);
    if (!res.ok) setErr(res.error ?? "Couldn't award."); else onChanged();
  };

  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
        {open ? <ChevronDown className="w-4 h-4 text-[var(--color-text-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />}
        <span className="text-xs font-black text-[var(--color-text)]">{group}</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">{groupDocs.length} bid{groupDocs.length === 1 ? "" : "s"}</span>
        {awarded && (
          <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700 dark:text-emerald-300">
            <Trophy className="w-3 h-3" /> Awarded to {awarded.vendorName ?? "vendor"}
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2">
          {unread.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--color-text-muted)]">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              {unread.length} quote{unread.length === 1 ? "" : "s"} not read yet:
              {unread.map((d) => (
                <span key={d.id} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-2 py-1">
                  <span className="font-bold text-[var(--color-text)] max-w-40 truncate">{d.vendorName ?? d.fileName}</span>
                  {canManage && <ReadButton busy={busy === d.id} onClick={() => void readDoc(d)} />}
                  {canManage && <button onClick={() => void typeTotal(d)} className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">type total</button>}
                </span>
              ))}
            </div>
          )}

          {econ.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                    <th className="px-3 py-2">Bidder</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right" title="Labor hours the bid offers">Labor hrs</th>
                    <th className="px-3 py-2 text-right" title="Total price ÷ labor hours — lower buys more hands">$ / hr</th>
                    <th className="px-3 py-2 text-right" title="Largest crew size stated">Peak crew</th>
                    <th className="px-3 py-2 text-right" title={`Best value = ${Math.round(DEFAULT_WEIGHTS.price * 100)}% price + ${Math.round(DEFAULT_WEIGHTS.manpower * 100)}% manpower + ${Math.round(DEFAULT_WEIGHTS.coverage * 100)}% scope coverage`}>Value score</th>
                    {canManage && !awarded && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {econ.map((e) => {
                    const s = scores.get(e.quoteId);
                    const doc = groupDocs.find((d) => d.id === e.quoteId);
                    const isAwarded = doc?.status === "awarded";
                    const isDeclined = doc?.status === "declined";
                    const known = companies.find((c) => c.name.toLowerCase() === e.vendorName.toLowerCase()) ?? null;
                    return (
                      <React.Fragment key={e.quoteId}>
                        <tr className={isAwarded ? "bg-emerald-500/[0.05]" : isDeclined ? "opacity-55" : undefined}>
                          <td className="px-3 py-2">
                            <span className="font-bold text-[var(--color-text)]">{e.vendorName}</span>
                            {known && (
                              <Link href={`/companies/${known.id}`}
                                className="ml-1.5 inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent-ring)] transition-colors"
                                title="In your Known Companies registry — open their full record"
                                onClick={(ev) => ev.stopPropagation()}>
                                known{known.qualityManualScore != null ? ` · QM ${Math.round(known.qualityManualScore)}%` : ""}
                              </Link>
                            )}
                            {known?.status === "do_not_use" && (
                              <span className="ml-1.5 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300">do not use</span>
                            )}
                            {s?.best && !awarded && (
                              <span className="ml-1.5 text-[9px] font-black uppercase text-[var(--color-accent)]" title="Highest weighted value score — not automatically the winner; you decide.">best value</span>
                            )}
                            {isAwarded && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-black uppercase text-emerald-700 dark:text-emerald-300"><Trophy className="w-2.5 h-2.5" /> awarded</span>}
                            {isDeclined && <span className="ml-1.5 text-[9px] font-bold uppercase text-[var(--color-text-faint)]">not selected</span>}
                          </td>
                          <td className="px-3 py-2 text-right font-black tabular-nums text-[var(--color-text)]">{fmtMoney(e.total)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{e.laborHours > 0 ? e.laborHours.toLocaleString() : <span className="text-[var(--color-text-faint)]" title="This bid doesn't state labor hours — undisclosed manpower scores at the field's floor.">not stated</span>}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{e.dollarsPerHour != null ? fmtMoney(e.dollarsPerHour) : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{e.peakHeadcount ?? "—"}</td>
                          <td className="px-3 py-2 text-right">
                            {s && (
                              <span className="font-black tabular-nums text-[var(--color-text)]" title={`Price ${s.parts.price} · Manpower ${s.parts.manpower} · Coverage ${s.parts.coverage} (each 0–100 vs the field)`}>
                                {s.score}
                              </span>
                            )}
                          </td>
                          {canManage && !awarded && (
                            <td className="px-3 py-2 text-right">
                              {doc && (doc.status === "parsed" || doc.status === "draft") && (
                                <PostControls accounts={accounts} busy={busy === doc.id} suggested={suggestFor(doc)}
                                  onPost={(accountId) => award(doc, accountId)} label="Award" />
                              )}
                            </td>
                          )}
                        </tr>
                        {(e.exclusionCount > 0 || e.missingScope.length > 0) && (
                          <tr className={isDeclined ? "opacity-55" : undefined}>
                            <td colSpan={canManage && !awarded ? 7 : 6} className="px-3 pb-2 pt-0">
                              <div className="flex flex-wrap gap-1">
                                {parsed.find((p) => p.doc.id === e.quoteId)?.quote.exclusions.map((x) => (
                                  <span key={x} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/[0.07] text-amber-800 dark:text-amber-300" title="Scope this bid explicitly does NOT include">
                                    excludes: {x}
                                  </span>
                                ))}
                                {e.missingScope.slice(0, 4).map((x) => (
                                  <span key={x} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-rose-500/40 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300" title="Other bidders priced this — this bid neither priced nor excluded it">
                                    silent gap: {x}
                                  </span>
                                ))}
                                {e.missingScope.length > 4 && (
                                  <span className="text-[9px] font-bold text-[var(--color-text-muted)]">+{e.missingScope.length - 4} more gaps</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {manualBids.length > 0 && (
            <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
              {manualBids.map((d) => (
                <li key={d.id} className={`px-3 py-2 flex items-center gap-2 flex-wrap text-xs ${d.status === "declined" ? "opacity-55" : ""}`}>
                  <span className="font-bold text-[var(--color-text)]">{d.vendorName ?? d.fileName ?? "Bid"}</span>
                  <span className="font-black tabular-nums text-[var(--color-text)]">{fmtMoney(d.totalAmount ?? 0)}</span>
                  <span className="text-[10px] text-[var(--color-text-muted)]" title="The AI couldn't read line detail from this file — it competes on price only, with no manpower or coverage score.">
                    typed total — price only
                  </span>
                  <StatusChip status={d.status} />
                  {canManage && !awarded && d.status === "parsed" && (
                    <PostControls accounts={accounts} busy={busy === d.id} suggested={suggestFor(d)}
                      onPost={(accountId) => award(d, accountId)} label="Award" />
                  )}
                  {canManage && d.status === "parsed" && (
                    <VoidButton doc={d} actor={actor} busy={busy === d.id} setBusy={setBusy} onChanged={onChanged} setErr={setErr} />
                  )}
                </li>
              ))}
            </ul>
          )}
          {econ.length > 1 && (
            <div className="text-[10px] text-[var(--color-text-muted)]">
              Value score = {Math.round(DEFAULT_WEIGHTS.price * 100)}% price + {Math.round(DEFAULT_WEIGHTS.manpower * 100)}% manpower-for-the-money + {Math.round(DEFAULT_WEIGHTS.coverage * 100)}% scope coverage, each measured against this field.
              The cheapest bid doesn&apos;t automatically win — exclusions and silent gaps are why. You make the call.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────

function StatusChip({ status }: { status: CostDocument["status"] }) {
  const tone = status === "awarded" || status === "posted"
    ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
    : status === "parsed" ? "border-sky-500/40 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300"
    : status === "declined" || status === "void" ? "border-[var(--color-border)] text-[var(--color-text-faint)]"
    : "border-amber-500/40 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300";
  return (
    <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${tone}`}>
      {COST_DOC_STATUS_LABEL[status]}
    </span>
  );
}

function ReadButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={busy}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[10px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors"
      title="AI reads the printed pages into numbers — on your own AI key. You review before anything posts.">
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Read
    </button>
  );
}

function PostControls({ accounts, busy, onPost, label, suggested }: {
  accounts: CostAccount[]; busy: boolean;
  onPost: (accountId: string) => void | Promise<void>; label: string;
  /** Pre-picked budget line (invoices) — shown with why. */
  suggested?: AccountSuggestion | null;
}) {
  const [accountId, setAccountId] = useState(suggested?.accountId ?? (accounts.length === 1 ? accounts[0].id : ""));
  if (accounts.length === 0) {
    return <span className="text-[10px] text-[var(--color-text-muted)]" title="Create a budget line first — money always posts somewhere.">needs a budget line</span>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
        className="h-6 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-[10px] max-w-36">
        <option value="">Budget line…</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} ` : ""}{a.name}</option>)}
      </select>
      <button onClick={() => accountId && void onPost(accountId)} disabled={busy || !accountId}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[10px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors">
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} {label}
      </button>
      {suggested && accountId === suggested.accountId && (
        <span className={`text-[9px] font-bold ${suggested.confidence === "high" ? "text-emerald-600" : "text-[var(--color-text-muted)]"}`}
          title={`Suggested: ${suggested.reason}`}>
          <Sparkles className="w-2.5 h-2.5 inline -mt-0.5" /> {suggested.confidence === "high" ? "matched" : "suggested"}
        </span>
      )}
    </span>
  );
}

function VoidButton({ doc, actor, busy, setBusy, onChanged, setErr }: {
  doc: CostDocument; actor: Actor; busy: boolean;
  setBusy: (v: string | null) => void; onChanged: () => void; setErr: (m: string | null) => void;
}) {
  return (
    <button
      onClick={async () => {
        if (!(await appConfirm({ message: `Void ${doc.fileName ?? "this document"}? It stays on the record but leaves every list.`, tone: "danger" }))) return;
        setBusy(doc.id);
        const res = await voidCostDoc({ doc, actor });
        setBusy(null);
        if (!res.ok) setErr(res.error ?? "Couldn't void."); else onChanged();
      }}
      disabled={busy}
      className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-500/10 transition-colors">
      <Ban className="w-3 h-3" /> Void
    </button>
  );
}

function UploadRow({ orgId, projectId, actor, kind, existingGroups, onDone, setErr }: {
  orgId: string; projectId: string; actor: Actor;
  kind: "quote" | "invoice";
  existingGroups: string[];
  onDone: () => void; setErr: (m: string | null) => void;
}) {
  const [vendor, setVendor] = useState("");
  const [group, setGroup] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!file) { setErr("Choose the PDF first."); return; }
    setSaving(true); setErr(null);
    const res = await uploadCostDoc({
      orgId, projectId, kind, file,
      vendorName: vendor || null,
      rfqGroup: kind === "quote" ? (group || null) : null,
      actor,
    });
    setSaving(false);
    if (!res.ok) { setErr(res.error ?? "Upload failed."); return; }
    setVendor(""); setGroup(""); setFile(null);
    onDone();
  };

  return (
    <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]/30 flex items-center gap-2 flex-wrap">
      <label className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border-strong)] px-2.5 py-1.5 cursor-pointer hover:border-[var(--color-accent-ring)] text-xs">
        <UploadCloud className="w-3.5 h-3.5 text-[var(--color-accent)]" />
        <span className="text-[var(--color-text-muted)] max-w-48 truncate">{file ? file.name : `${kind === "quote" ? "Quote" : "Invoice"} PDF or photo…`}</span>
        <input type="file" accept={INVOICE_ACCEPT} className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor (or let the AI read it)"
        className="h-8 w-52 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
      {kind === "quote" && (
        <>
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="RFQ group — the scope being bid" list="rfq-groups"
            className="h-8 w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs"
            title="Quotes sharing a group name tabulate side by side." />
          <datalist id="rfq-groups">
            {existingGroups.map((g) => <option key={g} value={g} />)}
          </datalist>
        </>
      )}
      <button onClick={() => void submit()} disabled={saving || !file}
        className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors">
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3" />} Upload
      </button>
    </div>
  );
}

// ── Quote links: the contractor door for prices ──────────────────────────

interface QuoteLink {
  id: string; token: string; companyName: string; rfqGroup: string | null;
  revokedAt: string | null; submissionCount: number;
}

function QuoteLinksSection({ orgId, projectId, actor, existingGroups, setErr }: {
  orgId: string; projectId: string; actor: Actor;
  existingGroups: string[]; setErr: (m: string | null) => void;
}) {
  const [links, setLinks] = useState<QuoteLink[] | null>(null);
  const [company, setCompany] = useState("");
  const [group, setGroup] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const { data, error } = await supabase.from("project_intake_links")
      .select("id, token, company_name, rfq_group, revoked_at, submission_count, purpose")
      .eq("project_id", projectId).eq("purpose", "quote")
      .order("created_at", { ascending: false });
    if (error) { setLinks([]); return; } // pre-migration: purpose column absent
    setLinks((((data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
      id: String(r.id), token: String(r.token),
      companyName: String(r.company_name ?? ""),
      rfqGroup: (r.rfq_group as string | null) ?? null,
      revokedAt: (r.revoked_at as string | null) ?? null,
      submissionCount: Number(r.submission_count ?? 0),
    })));
  }, [projectId]);
  React.useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!company.trim()) { setErr("Name the company the link is for."); return; }
    setSaving(true); setErr(null);
    try {
      const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 40);
      const { error } = await supabase.from("project_intake_links").insert({
        org_id: orgId, project_id: projectId, token,
        company_name: company.trim(),
        purpose: "quote", rfq_group: group.trim() || null,
        created_by: actor.uid,
      });
      if (error) throw new Error(/purpose/.test(error.message) ? "Quote links need the latest database migration (20261013) applied." : error.message);
      await supabase.from("audit_logs").insert({
        action: "INTAKE_QUOTE_LINK_CREATED", resource_type: "project_intake_link", resource_id: token.slice(0, 8),
        org_id: orgId, user_id: actor.uid, user_email: actor.email,
        details: { company: company.trim(), rfqGroup: group.trim() || null, projectId },
      }).then(() => undefined, () => undefined);
      setCompany(""); setGroup("");
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setSaving(false); }
  };

  const copy = async (l: QuoteLink) => {
    const url = `${window.location.origin}/submit/${l.token}`;
    try { await navigator.clipboard.writeText(url); setCopied(l.id); setTimeout(() => setCopied(null), 1500); }
    catch { setErr("Couldn't copy — your browser blocked clipboard access."); }
  };

  // Starter RFQ: a real .docx assembled from the project's own data — the
  // outbound ask that makes inbound quotes comparable.
  const makeRfq = async (l: QuoteLink) => {
    try {
      const { data: proj } = await supabase
        .from("projects").select("*").eq("id", projectId).maybeSingle();
      const p = (proj ?? {}) as Record<string, unknown>;
      let sowLabel: string | null = null;
      if (p.sow_document_id) {
        const { data: d } = await supabase.from("documents").select("document_number, title, name")
          .eq("id", String(p.sow_document_id)).maybeSingle();
        if (d) sowLabel = String((d as Record<string, unknown>).document_number || (d as Record<string, unknown>).title || (d as Record<string, unknown>).name || "") || null;
      }
      const { data: to } = await supabase.from("turnover_items")
        .select("name").eq("project_id", projectId).eq("required", true).limit(30);
      const { data: org } = await supabase.from("orgs").select("name").eq("id", orgId).maybeSingle();
      downloadStarterRfq({
        projectName: String(p.name ?? "Project"),
        orgName: (org?.name as string | null) ?? null,
        companyName: l.companyName,
        rfqGroup: l.rfqGroup,
        purpose: (p.purpose as string | null) ?? null,
        sowLabel,
        quoteUrl: `${window.location.origin}/submit/${l.token}`,
        dueDate: null,
        turnoverItems: (((to ?? []) as Array<{ name: string }>)).map((t) => t.name),
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/30 space-y-2">
      <div className="text-[11px] text-[var(--color-text-muted)]">
        Send a contractor their own tokened link — no account needed. Their quote PDF lands here, the
        system reads it, and it joins the tabulation on its own.
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company name"
          className="h-8 w-48 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
        <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="RFQ group (optional)" list="rfq-groups-link"
          className="h-8 w-56 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
        <datalist id="rfq-groups-link">
          {existingGroups.map((g) => <option key={g} value={g} />)}
        </datalist>
        <button onClick={() => void create()} disabled={saving}
          className="h-8 inline-flex items-center gap-1 px-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />} Create link
        </button>
      </div>
      {(links ?? []).filter((l) => !l.revokedAt).length > 0 && (
        <ul className="space-y-1">
          {(links ?? []).filter((l) => !l.revokedAt).map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-[11px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5">
              <span className="font-bold text-[var(--color-text)]">{l.companyName}</span>
              {l.rfqGroup && <span className="text-[var(--color-text-muted)]">· {l.rfqGroup}</span>}
              <span className="text-[10px] text-[var(--color-text-faint)]">{l.submissionCount} submission{l.submissionCount === 1 ? "" : "s"}</span>
              <span className="ml-auto flex items-center gap-1">
                <button onClick={() => void makeRfq(l)}
                  title="Download a ready-to-send Request For Quote (.docx) built from this project's scope, purpose, and turnover requirements — with this company's submission link inside."
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
                  <FileText className="w-3 h-3" /> RFQ (.docx)
                </button>
                <button onClick={() => void copy(l)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
                  <Copy className="w-3 h-3" /> {copied === l.id ? "Copied!" : "Copy link"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
