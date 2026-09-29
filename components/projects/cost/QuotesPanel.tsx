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
// the same read-review-post path as actuals.
//
// Trust rules on this screen (projects Round G): ONE number per bid —
// the human-visible total — feeds the table, the score and the award, with
// the model's original kept visible once corrected (BID-1 / GAP-407); every
// row opens its source PDF (BID-2); every figure renders in its own
// currency and a mixed-currency field is not ranked (BID-7); typed-total
// bids sit in the same table, price-normalised, "not scored" where they
// cannot be scored (BID-8); a read total can be corrected or voided (BID-9);
// the registry match is normalised, visible and overridable by an explicit
// company link (BID-12); a do-not-use company cannot be awarded without a
// typed, audited override (MON-12 UI half); a truncated read is said out
// loud and the award total must be typed back (COST-13).

import React, { useMemo, useState } from "react";
import {
  FileText, UploadCloud, Loader2, Sparkles, Trophy, Link2, Copy, AlertTriangle,
  CheckCircle2, ScanSearch, Ban, Receipt, ChevronDown, ChevronRight, ExternalLink, Pencil,
} from "lucide-react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { listCompanies, type Company } from "@/lib/companies";
import { fmtMoney, type CostAccount, type Actor } from "@/lib/costs";
import { getFileUrl } from "@/lib/storage";
import {
  type CostDocument, COST_DOC_STATUS_LABEL,
  uploadCostDoc, awardQuote, postInvoice, voidCostDoc, setManualTotal,
  parsedQuoteFrom, quoteGroups,
} from "@/lib/costDocs";
import {
  computeBidEconomics, scoreBids, effectiveWeights, MANPOWER_MAX_COMPOSITE_SWING,
  withHumanTotal, priceOnlyQuote, mergeQuoteGroups, snapRfqGroup, matchCompanyByName,
  quoteExpired, readExtent, fieldCurrency, type ParsedQuote, type BidEconomics,
} from "@/lib/bidTab";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";

/** Row columns that live beside CostDocument (landed by 20261096) — read
 *  here so the frozen lib/costDocs mapper does not need to change: the
 *  explicit registry link and the read extent. */
interface DocExtras { companyId: string | null; pagesTotal: number | null; pagesRead: number | null }
interface Party { id: string; name: string; companyId: string | null }

const QUOTE_LINK_DEFAULT_DAYS = 90;
const isoDateInDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

export default function QuotesPanel({ orgId, projectId, canManage, actor, accounts, docs, onChanged, setErr }: {
  orgId: string; projectId: string; canManage: boolean; actor: Actor;
  accounts: CostAccount[];
  docs: CostDocument[];
  onChanged: () => void;
  setErr: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(false);
  // Known Companies registry — matched to bidders by normalised name (or
  // an explicit link) so their record (quality-manual coverage, do-not-use
  // flags) sits beside every price. A FAILED load is said out loud: an
  // empty list would silently remove the do-not-use flag from every bidder.
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesState, setCompaniesState] = useState<"loading" | "ready" | "failed">("loading");
  React.useEffect(() => {
    let cancelled = false;
    setCompaniesState("loading");
    listCompanies(orgId)
      .then((list) => { if (!cancelled) { setCompanies(list); setCompaniesState("ready"); } })
      .catch(() => { if (!cancelled) { setCompanies([]); setCompaniesState("failed"); } });
    return () => { cancelled = true; };
  }, [orgId]);
  // Explicit registry links + read extent per row (20261096 columns). One
  // bounded query; pre-migration the columns are absent and every row
  // reads "unknown", never "complete".
  const [extras, setExtras] = useState<Map<string, DocExtras>>(new Map());
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.from("cost_documents")
        .select("id, company_id, pages_total, pages_read").eq("org_id", orgId).eq("project_id", projectId).limit(500);
      if (cancelled || error) return;
      setExtras(new Map((((data ?? []) as Array<Record<string, unknown>>)).map((r) => [String(r.id), {
        companyId: (r.company_id as string | null) ?? null,
        pagesTotal: r.pages_total == null ? null : Number(r.pages_total),
        pagesRead: r.pages_read == null ? null : Number(r.pages_read),
      }])));
    })();
    return () => { cancelled = true; };
  }, [orgId, projectId, docs]);
  // Project parties, so an upload can name the party it came from (the
  // link the company scorecard hangs off — COST-12).
  const [parties, setParties] = useState<Party[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.from("project_parties").select("id, name, company_id")
        .eq("project_id", projectId).order("name").limit(200);
      if (cancelled || error) return;
      setParties((((data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id), name: String(r.name ?? ""), companyId: (r.company_id as string | null) ?? null,
      })));
    })();
    return () => { cancelled = true; };
  }, [projectId, docs]);
  // Case/whitespace variants of a group name are ONE bid field here (BID-10
  // client half); lib/costDocs still keys the award's rival-decline on the
  // exact string — its one-line limb is P3's.
  const groups = useMemo(() => mergeQuoteGroups(quoteGroups(docs)), [docs]);
  const invoices = useMemo(() => docs.filter((d) => d.kind !== "quote" && d.status !== "void"), [docs]);
  const existingGroups = useMemo(
    () => [...new Set(docs.map((d) => d.rfqGroup).filter((g): g is string => !!g))], [docs]);

  const linkCompany = async (doc: CostDocument, companyId: string | null) => {
    setErr(null);
    const { error } = await supabase.from("cost_documents").update({ company_id: companyId }).eq("id", doc.id).eq("org_id", orgId);
    if (error) {
      setErr(error.code === "42703" || error.code === "PGRST204"
        ? "Linking a bidder to the registry needs migration 20261096 applied."
        : `Couldn't link the company: ${error.message}`);
      return;
    }
    await supabase.from("audit_logs").insert({
      action: "COST_DOC_COMPANY_LINKED", resource_type: "cost", resource_id: doc.id,
      org_id: orgId, user_id: actor.uid, user_email: actor.email,
      details: { companyId, vendor: doc.vendorName },
    }).then(() => undefined, () => undefined);
    setExtras((prev) => new Map(prev).set(doc.id, { ...(prev.get(doc.id) ?? { pagesTotal: null, pagesRead: null }), companyId }));
  };

  const readDoc = async (doc: CostDocument) => {
    setBusy(doc.id); setErr(null);
    try {
      const res = await fetch("/api/projects/cost-docs", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, projectId, costDocId: doc.id }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  // Works for an unread scan AND a read quote whose AI total is wrong
  // (BID-9): the typed number becomes the one authoritative total; the
  // model's original stays visible on the row.
  const typeTotal = async (doc: CostDocument) => {
    const extracted = parsedQuoteFrom(doc)?.total ?? null;
    const v = await appPrompt({
      title: extracted != null ? "Correct the total" : "Type the total from the paper",
      message: extracted != null
        ? `The AI read ${fmtMoney(extracted, doc.currency ?? "USD")} from ${doc.fileName ?? "this document"}. Enter the bottom-line total printed on the paper; it becomes the number the table scores and the award posts, and the AI's reading stays on the row for the record.`
        : `The AI couldn't read (or hasn't read) ${doc.fileName ?? "this document"}. Enter its bottom-line total and it becomes the awardable number.`,
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

      {companiesState === "failed" && (
        <div role="alert" className="px-4 py-2 border-b border-amber-500/40 bg-amber-500/[0.07] text-[11px] font-bold text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          The Known Companies registry couldn&apos;t be loaded — &quot;known&quot; and &quot;do not use&quot; flags are NOT shown on this table. Reload before awarding.
        </div>
      )}

      {canManage && (
        <UploadRow orgId={orgId} projectId={projectId} actor={actor} kind="quote"
          existingGroups={existingGroups} parties={parties} onDone={onChanged} setErr={setErr} />
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
              accounts={accounts} companies={companies} companiesState={companiesState} extras={extras}
              canManage={canManage} actor={actor} orgId={orgId}
              busy={busy} setBusy={setBusy} readDoc={readDoc} typeTotal={typeTotal} linkCompany={linkCompany}
              onChanged={onChanged} setErr={setErr} />
          ))}
        </div>
      )}

      {/* ── Invoices ── */}
      <div className="border-t border-[var(--color-border)]">
        <div className="px-4 py-2.5 flex items-center gap-2">
          <Receipt className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-bold text-[var(--color-text)]">Invoices</span>
          <span className="text-[10px] text-[var(--color-text-muted)]">Read → review → post as actual spend.</span>
        </div>
        {canManage && (
          <UploadRow orgId={orgId} projectId={projectId} actor={actor} kind="invoice"
            existingGroups={[]} parties={parties} onDone={onChanged} setErr={setErr} />
        )}
        {invoices.length === 0 ? (
          <div className="px-4 pb-4 text-[11px] italic text-[var(--color-text-faint)]">No invoices uploaded yet.</div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {invoices.map((doc) => (
              <li key={doc.id} className="px-4 py-2.5 flex items-center gap-2 flex-wrap text-xs">
                <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                <span className="font-bold text-[var(--color-text)] truncate">{doc.vendorName ?? doc.fileName ?? "Invoice"}</span>
                {doc.docNumber && <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{doc.docNumber}</span>}
                {doc.totalAmount != null && <span className="font-black tabular-nums text-[var(--color-text)]">{fmtMoney(doc.totalAmount, doc.currency ?? "USD")}</span>}
                <OpenPdfButton doc={doc} setErr={setErr} />
                <ReadExtentChip extras={extras.get(doc.id) ?? null} status={doc.status} />
                <StatusChip status={doc.status} />
                {canManage && doc.status === "draft" && (
                  <>
                    <ReadButton busy={busy === doc.id} onClick={() => void readDoc(doc)} />
                    <button onClick={() => void typeTotal(doc)}
                      className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">type total</button>
                  </>
                )}
                {canManage && doc.status === "parsed" && (
                  <PostControls accounts={accounts} busy={busy === doc.id}
                    onPost={async (accountId) => {
                      // COST-13: an actual posted from a truncated (or
                      // unknown-extent) read needs the amount typed back.
                      const ext = readExtent(extras.get(doc.id)?.pagesRead, extras.get(doc.id)?.pagesTotal);
                      const total = doc.totalAmount ?? 0;
                      if (ext.truncated || !ext.known) {
                        const typed = await appPrompt({
                          title: `Confirm the amount for ${doc.vendorName ?? "this invoice"}`,
                          message: `${ext.truncated ? `The AI ${ext.label}` : "The read extent of this invoice is unknown"} — the amount may come from an incomplete read. Type the amount due exactly as printed (${Math.round(total).toLocaleString()}) to post ${fmtMoney(total, doc.currency ?? "USD")} as an actual.`,
                          placeholder: String(Math.round(total)),
                        });
                        if (typed == null) return;
                        const n = Number(String(typed).replace(/[^0-9.]/g, ""));
                        if (!Number.isFinite(n) || Math.round(n) !== Math.round(total)) {
                          setErr(`The typed amount (${typed}) doesn't match ${fmtMoney(total, doc.currency ?? "USD")} — use "type total" first if the paper says something else.`);
                          return;
                        }
                      }
                      setBusy(doc.id);
                      const res = await postInvoice({ doc, costAccountId: accountId, actor });
                      setBusy(null);
                      if (!res.ok) setErr(res.error ?? "Couldn't post."); else onChanged();
                    }} label="Post as actual" />
                )}
                {canManage && doc.status === "parsed" && (
                  <button onClick={() => void typeTotal(doc)} title="Correct the amount by hand"
                    className="inline-flex items-center gap-0.5 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                    <Pencil className="w-3 h-3" /> correct total
                  </button>
                )}
                {canManage && (doc.status === "draft" || doc.status === "parsed") && (
                  <VoidButton doc={doc} actor={actor} busy={busy === doc.id} setBusy={setBusy} onChanged={onChanged} setErr={setErr} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── One RFQ group: the tabulation ────────────────────────────────────────

function BidGroup({ group, docs: groupDocs, allDocs, accounts, companies, companiesState, extras, canManage, actor, orgId, busy, setBusy, readDoc, typeTotal, linkCompany, onChanged, setErr }: {
  group: string; docs: CostDocument[]; allDocs: CostDocument[];
  accounts: CostAccount[]; companies: Company[]; companiesState: "loading" | "ready" | "failed";
  extras: Map<string, DocExtras>;
  canManage: boolean; actor: Actor; orgId: string;
  busy: string | null; setBusy: (v: string | null) => void;
  readDoc: (d: CostDocument) => Promise<void>;
  typeTotal: (d: CostDocument) => Promise<void>;
  linkCompany: (d: CostDocument, companyId: string | null) => Promise<void>;
  onChanged: () => void; setErr: (m: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  // ONE number per bid: the row's human-visible total overlays the
  // extraction (BID-1). Typed-total bids with no readable detail join the
  // same field as price-only rows (BID-8).
  const entries = useMemo(() => {
    const out: Array<{ doc: CostDocument; quote: ParsedQuote }> = [];
    for (const d of groupDocs) {
      if (d.status === "void" || d.status === "draft") continue;
      const q = parsedQuoteFrom(d);
      if (q) out.push({ doc: d, quote: withHumanTotal(q, d.totalAmount) });
      else if ((d.totalAmount ?? 0) > 0) {
        out.push({ doc: d, quote: priceOnlyQuote({ id: d.id, vendorName: d.vendorName ?? d.fileName ?? "Bid", total: d.totalAmount!, currency: d.currency }) });
      }
    }
    return out;
  }, [groupDocs]);
  const econ = useMemo(() => computeBidEconomics(entries.map((p) => p.quote)), [entries]);
  const scores = useMemo(() => new Map(scoreBids(econ).map((s) => [s.quoteId, s])), [econ]);
  const currency = useMemo(() => fieldCurrency(econ), [econ]);
  const awarded = groupDocs.find((d) => d.status === "awarded");
  const unread = groupDocs.filter((d) => d.status === "draft");
  const weights = effectiveWeights();
  const scoredCount = [...scores.values()].filter((s) => s.score != null).length;

  /** The registry row for a bid: the explicit link wins; otherwise a
   *  normalised-name match, shown as a suggestion the human can change. */
  const registryFor = (doc: CostDocument, e: BidEconomics): { known: Company | null; bound: boolean } => {
    const boundId = extras.get(doc.id)?.companyId ?? null;
    if (boundId) return { known: companies.find((c) => c.id === boundId) ?? null, bound: true };
    return { known: matchCompanyByName(e.vendorName, companies), bound: false };
  };

  const award = async (doc: CostDocument, accountId: string) => {
    const e = econ.find((x) => x.quoteId === doc.id);
    const total = e?.total ?? doc.totalAmount ?? parsedQuoteFrom(doc)?.total ?? 0;
    const cur = e?.currency ?? doc.currency ?? "USD";
    const account = accounts.find((a) => a.id === accountId);
    const { known } = e ? registryFor(doc, e) : { known: null };
    const quote = entries.find((p) => p.doc.id === doc.id)?.quote ?? null;
    const extent = readExtent(extras.get(doc.id)?.pagesRead, extras.get(doc.id)?.pagesTotal);
    const expired = quoteExpired(quote?.validUntil);

    // MON-12 / COST-3: a barred company is not awardable without a typed,
    // audited reason. The posting-side refusal is lib/costDocs' (PC-7).
    if (known?.status === "do_not_use") {
      const reason = await appPrompt({
        title: `${known.name} is flagged DO NOT USE`,
        message: "The registry bars this company. To award anyway, state the reason — it is recorded against this award and the company's record.",
        placeholder: "Override reason (required)",
      });
      if (!reason || !reason.trim()) { setErr(`Award stopped — ${known.name} is flagged do-not-use and no override reason was given.`); return; }
      const { error } = await supabase.from("audit_logs").insert({
        action: "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE", resource_type: "cost", resource_id: doc.id,
        org_id: orgId, user_id: actor.uid, user_email: actor.email,
        details: { companyId: known.id, company: known.name, reason: reason.trim(), total, currency: cur, rfqGroup: group },
      });
      if (error) { setErr(`The override could not be recorded (${error.message}) — award stopped.`); return; }
    }

    const warnings = [
      expired ? `This quote's validity date (${quote?.validUntil}) has PASSED — confirm the price with the vendor.` : null,
      extent.truncated ? `The AI ${extent.label} — the total may come from an incomplete read.` : null,
      !extent.known && quote && !quote.priceOnly ? "The read extent of this document is unknown — the total may come from an incomplete read." : null,
      quote?.totalSource === "human" && quote.extractedTotal != null ? `Total corrected by hand from the AI's ${fmtMoney(quote.extractedTotal, cur)}.` : null,
    ].filter((w): w is string => !!w);

    // COST-13: a truncated (or unknown-extent) read requires the total to
    // be typed back, not just clicked through.
    if (extent.truncated || (!extent.known && quote && !quote.priceOnly)) {
      const typed = await appPrompt({
        title: `Confirm the award total for ${doc.vendorName ?? "this vendor"}`,
        message: `${warnings.join(" ")} Type the total exactly as it appears on the paper (${Math.round(total).toLocaleString()}) to award "${group}" for ${fmtMoney(total, cur)} on "${account?.name ?? "the budget line"}".`,
        placeholder: String(Math.round(total)),
      });
      if (typed == null) return;
      const n = Number(String(typed).replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(n) || Math.round(n) !== Math.round(total)) {
        setErr(`The typed total (${typed}) doesn't match ${fmtMoney(total, cur)} — correct the total first if the paper says something else.`);
        return;
      }
    } else if (!(await appConfirm({
      message: `${warnings.length ? warnings.join(" ") + " " : ""}Award "${group}" to ${doc.vendorName ?? "this vendor"} for ${fmtMoney(total, cur)}? This posts a commitment on "${account?.name ?? "the budget line"}" and marks the other bids not selected.`,
      tone: warnings.length ? "danger" : undefined,
    }))) return;

    setBusy(doc.id);
    try {
      const res = await awardQuote({ doc, siblings: allDocs, costAccountId: accountId, actor });
      if (!res.ok) setErr(res.error ?? "Couldn't award."); else onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  const colCount = 7 + (canManage && !awarded ? 1 : 0);

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
                  <OpenPdfButton doc={d} setErr={setErr} />
                  {canManage && <ReadButton busy={busy === d.id} onClick={() => void readDoc(d)} />}
                  {canManage && <button onClick={() => void typeTotal(d)} className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">type total</button>}
                </span>
              ))}
            </div>
          )}

          {currency.mixed && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2 text-[11px] font-bold text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>This field mixes {currency.currencies.join(" and ")}. Each price is shown in its own currency and the bids are NOT ranked against each other — restate a foreign total in the budget&apos;s currency (correct total) before awarding.</span>
            </div>
          )}

          {econ.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                    <th className="px-3 py-2">Bidder</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right" title="Labor hours the bid offers — vendor-stated, AI-extracted">Labor hrs</th>
                    <th className="px-3 py-2 text-right" title="Total price ÷ labor hours — lower buys more hands">Price / hr</th>
                    <th className="px-3 py-2 text-right" title="Largest crew size stated">Peak crew</th>
                    <th className="px-3 py-2" title="Quote validity date as printed">Valid until</th>
                    <th className="px-3 py-2 text-right" title={`Value score = ${Math.round(weights.price * 100)}% price + ${Math.round(weights.manpower * 100)}% manpower (hours can move it by at most ${MANPOWER_MAX_COMPOSITE_SWING} points). Scope coverage is not scored — exclusions and check prompts are shown for your judgement.`}>Value score</th>
                    {canManage && !awarded && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {econ.map((e) => {
                    const s = scores.get(e.quoteId);
                    const doc = groupDocs.find((d) => d.id === e.quoteId);
                    const quote = entries.find((p) => p.doc.id === e.quoteId)?.quote;
                    const isAwarded = doc?.status === "awarded";
                    const isDeclined = doc?.status === "declined";
                    const cur = e.currency ?? doc?.currency ?? "USD";
                    const { known, bound } = doc ? registryFor(doc, e) : { known: null, bound: false };
                    const ext = doc ? extras.get(doc.id) ?? null : null;
                    const expired = quoteExpired(quote?.validUntil);
                    const rowActions = doc && canManage && !awarded && (doc.status === "parsed" || doc.status === "draft");
                    return (
                      <React.Fragment key={e.quoteId}>
                        <tr className={isAwarded ? "bg-emerald-500/[0.05]" : isDeclined ? "opacity-55" : undefined}>
                          <td className="px-3 py-2">
                            <span className="font-bold text-[var(--color-text)]">{e.vendorName}</span>
                            {doc && <OpenPdfButton doc={doc} setErr={setErr} />}
                            {known && (
                              <Link href={`/companies/${known.id}`}
                                className="ml-1.5 inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent-ring)] transition-colors"
                                title={bound ? "Linked to this Known Companies record — open it" : `Matched to "${known.name}" by name — use "change" if that is wrong`}
                                onClick={(ev) => ev.stopPropagation()}>
                                {bound ? "known" : `matched to ${known.name}`}{known.qualityManualScore != null ? ` · QM ${Math.round(known.qualityManualScore)}%` : ""}
                              </Link>
                            )}
                            {known?.status === "do_not_use" && (
                              <span className="ml-1.5 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300" title="Flagged in the registry — an award needs a typed, recorded override">do not use</span>
                            )}
                            {known?.status === "inactive" && (
                              <span className="ml-1.5 text-[9px] font-bold uppercase text-[var(--color-text-faint)]">inactive</span>
                            )}
                            {!known && companiesState === "failed" && (
                              <span className="ml-1.5 text-[9px] font-bold text-amber-700 dark:text-amber-300" title="The registry failed to load — flags unknown">registry unavailable</span>
                            )}
                            {doc && canManage && companiesState === "ready" && (
                              <CompanyPicker companies={companies} value={ext?.companyId ?? null} suggestion={!bound ? known : null}
                                onChange={(id) => void linkCompany(doc, id)} />
                            )}
                            {s?.best && !awarded && (
                              <span className="ml-1.5 text-[9px] font-black uppercase text-[var(--color-accent)]"
                                title={`Highest value score on price and manpower — not automatically the winner; you decide.${e.exclusionCount > 0 ? ` This bid EXCLUDES ${e.exclusionCount} item${e.exclusionCount === 1 ? "" : "s"} — scope you must buy elsewhere is not priced into the score.` : ""}`}>best value</span>
                            )}
                            {s?.tied && !awarded && (
                              <span className="ml-1.5 text-[9px] font-black uppercase text-[var(--color-text-muted)]" title="Shares the top value score — no bid is badged; you decide.">tied</span>
                            )}
                            {isAwarded && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-black uppercase text-emerald-700 dark:text-emerald-300"><Trophy className="w-2.5 h-2.5" /> awarded</span>}
                            {isDeclined && <span className="ml-1.5 text-[9px] font-bold uppercase text-[var(--color-text-faint)]">not selected</span>}
                          </td>
                          <td className="px-3 py-2 text-right font-black tabular-nums text-[var(--color-text)]">
                            {fmtMoney(e.total, cur)}
                            {e.totalSource === "human" && (
                              <div className="text-[9px] font-bold text-amber-700 dark:text-amber-300" title="A human corrected this total; the AI's reading is kept for the record">
                                corrected{e.extractedTotal != null ? ` · AI read ${fmtMoney(e.extractedTotal, cur)}` : ""}
                              </div>
                            )}
                            {e.priceOnly && (
                              <div className="text-[9px] font-bold text-[var(--color-text-muted)]" title="The AI couldn't read line detail from this file — it competes on price only, with no manpower or coverage score.">typed total — price only</div>
                            )}
                            <ReadExtentChip extras={ext} status={doc?.status ?? "parsed"} />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {e.priceOnly ? <span className="text-[var(--color-text-faint)]">not scored</span>
                              : e.laborHours > 0 ? <span title="Vendor-stated, AI-extracted">{e.laborHours.toLocaleString()}</span>
                              : <span className="text-[var(--color-text-faint)]" title="This bid doesn't state labor hours — undisclosed manpower scores at the field's floor.">not stated</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{e.priceOnly ? <span className="text-[var(--color-text-faint)]">not scored</span> : e.dollarsPerHour != null ? fmtMoney(e.dollarsPerHour, cur) : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{e.priceOnly ? <span className="text-[var(--color-text-faint)]">—</span> : e.peakHeadcount ?? "—"}</td>
                          <td className="px-3 py-2 tabular-nums">
                            {quote?.validUntil
                              ? <span className={expired ? "font-black text-rose-700 dark:text-rose-300" : ""} title={expired ? "This quote's validity date has passed" : "Vendor-stated validity date"}>{quote.validUntil}{expired ? " · expired" : ""}</span>
                              : <span className="text-[var(--color-text-faint)]">—</span>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {s && s.score != null && (
                              <span className="font-black tabular-nums text-[var(--color-text)]" title={`Price ${s.parts.price} · Manpower ${s.parts.manpower} (each 0–100 vs the field) · Coverage not scored`}>
                                {s.score}
                              </span>
                            )}
                            {s && s.score == null && (
                              <span className="text-[10px] text-[var(--color-text-faint)]" title={s.unscored === "mixed-currency" ? "Mixed-currency field — not ranked" : "Price only — no manpower or coverage detail to score"}>
                                {s.unscored === "mixed-currency" ? "not ranked" : "not scored"}
                              </span>
                            )}
                          </td>
                          {canManage && !awarded && (
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {rowActions && !currency.mixed && (
                                <PostControls accounts={accounts} busy={busy === doc.id}
                                  onPost={(accountId) => award(doc, accountId)} label="Award" />
                              )}
                              {rowActions && currency.mixed && (
                                <span className="text-[10px] text-[var(--color-text-muted)]" title="Restate the foreign total in the budget's currency first">not awardable — mixed currency</span>
                              )}
                              {rowActions && (
                                <>
                                  <button onClick={() => void typeTotal(doc)} title="Correct the total by hand — the AI's reading stays on the record"
                                    className="ml-1 inline-flex items-center gap-0.5 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                                    <Pencil className="w-3 h-3" /> correct total
                                  </button>
                                  <VoidButton doc={doc} actor={actor} busy={busy === doc.id} setBusy={setBusy} onChanged={onChanged} setErr={setErr} />
                                </>
                              )}
                            </td>
                          )}
                        </tr>
                        {((quote?.exclusions.length ?? 0) > 0 || e.missingScope.length > 0 || quote?.notes) && (
                          <tr className={isDeclined ? "opacity-55" : undefined}>
                            <td colSpan={colCount} className="px-3 pb-2 pt-0">
                              <div className="flex flex-wrap gap-1">
                                {quote?.notes && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-sky-500/40 bg-sky-500/[0.07] text-sky-800 dark:text-sky-300" title="Vendor note printed on the quote">
                                    note: {quote.notes}
                                  </span>
                                )}
                                {quote?.exclusions.map((x) => (
                                  <span key={x} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/[0.07] text-amber-800 dark:text-amber-300" title="Scope this bid explicitly does NOT include — declared, so it never lowers the score; it is scope you must buy elsewhere">
                                    excludes: {x}
                                  </span>
                                ))}
                                {e.missingScope.slice(0, 4).map((x) => (
                                  <span key={x} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-[var(--color-border-strong)] text-[var(--color-text-muted)]" title="Another bidder priced this and this bid's wording doesn't obviously cover it — check the PDF. A prompt, not a finding; it does not affect the score.">
                                    check: {x}
                                  </span>
                                ))}
                                {e.missingScope.length > 4 && (
                                  <span className="text-[9px] font-bold text-[var(--color-text-muted)]">+{e.missingScope.length - 4} more to check</span>
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
          {econ.length > 0 && (
            <div className="text-[10px] text-[var(--color-text-muted)]">
              Value score = {Math.round(weights.price * 100)}% price + {Math.round(weights.manpower * 100)}% manpower-for-the-money, each measured against this field; labor hours are vendor-stated and AI-extracted and can move the score by at most {MANPOWER_MAX_COMPOSITE_SWING} points.
              Scope coverage is not scored: declared exclusions never lower a score (as the RFQ letter promises) and &quot;check&quot; prompts are for you to verify against the PDF.
              {scoredCount < 2 ? " With fewer than two scored bids there is no field to rank, so no bid is badged." : " The cheapest bid doesn't automatically win — exclusions are why. You make the call."}
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

/** Every row opens its source PDF (BID-2) through the existing presigned
 *  download path — no new egress. Works for read and typed-total rows. */
function OpenPdfButton({ doc, setErr }: { doc: CostDocument; setErr: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  if (!doc.fileUrl) return <span className="ml-1.5 text-[9px] text-[var(--color-text-faint)]" title="No stored file on this row">no file</span>;
  return (
    <button type="button" disabled={busy}
      onClick={async (ev) => {
        ev.stopPropagation();
        setBusy(true);
        try {
          const url = await getFileUrl(doc.fileUrl!);
          window.open(url, "_blank", "noopener,noreferrer");
        } catch (e) {
          setErr(`Couldn't open ${doc.fileName ?? "the PDF"}: ${(e as Error).message}`);
        } finally { setBusy(false); }
      }}
      title={`Open ${doc.fileName ?? "the source PDF"} — review the paper before you award on the number`}
      className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-bold text-[var(--color-accent)] hover:underline disabled:opacity-50">
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />} PDF
    </button>
  );
}

/** "read pages 1–8 of N" beside a partially read document (COST-13). */
function ReadExtentChip({ extras, status }: { extras: DocExtras | null; status: CostDocument["status"] }) {
  if (status === "draft") return null;
  const ext = readExtent(extras?.pagesRead, extras?.pagesTotal);
  if (ext.known && !ext.truncated) return null;
  return (
    <span className={`ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-bold ${ext.truncated ? "text-amber-700 dark:text-amber-300" : "text-[var(--color-text-faint)]"}`}
      title={ext.truncated ? "The AI did not see every page — the total may be incomplete. Open the PDF and check the last pages." : "Recorded before the read extent was tracked — how many pages the AI saw is unknown."}>
      <AlertTriangle className="w-3 h-3" /> {ext.label}
    </span>
  );
}

/** Bind a bidder to a registry company explicitly (BID-12 / COST-3). The
 *  suggestion (normalised-name match) is shown as the default and can be
 *  changed; nothing binds on its own. */
function CompanyPicker({ companies, value, suggestion, onChange }: {
  companies: Company[]; value: string | null; suggestion: Company | null; onChange: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button type="button" onClick={(ev) => { ev.stopPropagation(); setEditing(true); }}
        className="ml-1 text-[9px] font-bold text-[var(--color-text-faint)] hover:text-[var(--color-accent)]"
        title="Link this bidder to a Known Companies record">
        {value ? "change" : suggestion ? "change" : "link to registry"}
      </button>
    );
  }
  return (
    <select autoFocus value={value ?? ""} aria-label="Registry company for this bidder"
      onChange={(ev) => { onChange(ev.target.value || null); setEditing(false); }}
      onBlur={() => setEditing(false)}
      onClick={(ev) => ev.stopPropagation()}
      className="ml-1 h-5 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 text-[10px] max-w-44">
      <option value="">— not linked —</option>
      {companies.map((c) => (
        <option key={c.id} value={c.id}>{c.name}{c.status === "do_not_use" ? " (do not use)" : ""}{suggestion?.id === c.id ? " (name match)" : ""}</option>
      ))}
    </select>
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

function PostControls({ accounts, busy, onPost, label }: {
  accounts: CostAccount[]; busy: boolean;
  onPost: (accountId: string) => void | Promise<void>; label: string;
}) {
  const [accountId, setAccountId] = useState(accounts.length === 1 ? accounts[0].id : "");
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

function UploadRow({ orgId, projectId, actor, kind, existingGroups, parties, onDone, setErr }: {
  orgId: string; projectId: string; actor: Actor;
  kind: "quote" | "invoice";
  existingGroups: string[];
  parties: Party[];
  onDone: () => void; setErr: (m: string | null) => void;
}) {
  const [vendor, setVendor] = useState("");
  const [group, setGroup] = useState("");
  const [partyId, setPartyId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!file) { setErr("Choose the PDF first."); return; }
    setSaving(true); setErr(null);
    const party = parties.find((p) => p.id === partyId) ?? null;
    const res = await uploadCostDoc({
      orgId, projectId, kind, file,
      vendorName: vendor || party?.name || null,
      // Case/whitespace variants snap onto the existing spelling (BID-10).
      rfqGroup: kind === "quote" ? (snapRfqGroup(group, existingGroups) || null) : null,
      partyId: party?.id ?? null,
      actor,
    });
    setSaving(false);
    if (!res.ok) { setErr(res.error ?? "Upload failed."); return; }
    setVendor(""); setGroup(""); setPartyId(""); setFile(null);
    onDone();
  };

  return (
    <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]/30 flex items-center gap-2 flex-wrap">
      <label className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border-strong)] px-2.5 py-1.5 cursor-pointer hover:border-[var(--color-accent-ring)] text-xs">
        <UploadCloud className="w-3.5 h-3.5 text-[var(--color-accent)]" />
        <span className="text-[var(--color-text-muted)] max-w-48 truncate">{file ? file.name : `${kind === "quote" ? "Quote" : "Invoice"} PDF…`}</span>
        <input type="file" accept=".pdf,application/pdf" className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor (or let the AI read it)"
        className="h-8 w-52 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
      {parties.length > 0 && (
        <select value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Project party this document came from"
          title="Which project party sent this — the link that lets it reach their company scorecard"
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs max-w-48">
          <option value="">Party (optional)…</option>
          {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
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
  revokedAt: string | null; expiresAt: string | null; submissionCount: number;
}

function QuoteLinksSection({ orgId, projectId, actor, existingGroups, setErr }: {
  orgId: string; projectId: string; actor: Actor;
  existingGroups: string[]; setErr: (m: string | null) => void;
}) {
  const [links, setLinks] = useState<QuoteLink[] | null>(null);
  const [company, setCompany] = useState("");
  const [group, setGroup] = useState("");
  // A quote link is a bearer credential: it always expires (SEC-5 /
  // INTK-12) — 90 days by default, editable, never blank.
  const [expires, setExpires] = useState(() => isoDateInDays(QUOTE_LINK_DEFAULT_DAYS));
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const { data, error } = await supabase.from("project_intake_links")
      .select("id, token, company_name, rfq_group, revoked_at, expires_at, submission_count, purpose")
      .eq("project_id", projectId).eq("purpose", "quote")
      .order("created_at", { ascending: false });
    if (error) { setLinks([]); return; } // pre-migration: purpose column absent
    setLinks((((data ?? []) as Array<Record<string, unknown>>)).map((r) => ({
      id: String(r.id), token: String(r.token),
      companyName: String(r.company_name ?? ""),
      rfqGroup: (r.rfq_group as string | null) ?? null,
      revokedAt: (r.revoked_at as string | null) ?? null,
      expiresAt: (r.expires_at as string | null) ?? null,
      submissionCount: Number(r.submission_count ?? 0),
    })));
  }, [projectId]);
  React.useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!company.trim()) { setErr("Name the company the link is for."); return; }
    const expiresAt = expires ? new Date(`${expires}T23:59:59`) : null;
    if (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      setErr("Give the link an expiry date in the future — a quote link never lives forever."); return;
    }
    setSaving(true); setErr(null);
    try {
      const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 40);
      const { data: created, error } = await supabase.from("project_intake_links").insert({
        org_id: orgId, project_id: projectId, token,
        company_name: company.trim(),
        purpose: "quote", rfq_group: snapRfqGroup(group, existingGroups) || null,
        expires_at: expiresAt.toISOString(),
        created_by: actor.uid,
      }).select("id").single();
      if (error) throw new Error(/purpose/.test(error.message) ? "Quote links need the latest database migration (20261013) applied." : error.message);
      // The audit row names the LINK (its id) — never token material — and
      // a failed audit of minting an external credential is visible.
      const { error: auditErr } = await supabase.from("audit_logs").insert({
        action: "INTAKE_QUOTE_LINK_CREATED", resource_type: "project_intake_link", resource_id: String((created as { id: string }).id),
        org_id: orgId, user_id: actor.uid, user_email: actor.email,
        details: { company: company.trim(), rfqGroup: snapRfqGroup(group, existingGroups) || null, projectId, expiresAt: expiresAt.toISOString() },
      });
      if (auditErr) setErr(`The link was created but its audit record failed: ${auditErr.message}`);
      setCompany(""); setGroup(""); setExpires(isoDateInDays(QUOTE_LINK_DEFAULT_DAYS));
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setSaving(false); }
  };

  const revoke = async (l: QuoteLink) => {
    if (!(await appConfirm({ message: `Revoke ${l.companyName}'s quote link? They lose access immediately; quotes already submitted stay.`, tone: "danger" }))) return;
    setRevoking(l.id); setErr(null);
    try {
      const { error } = await supabase.from("project_intake_links").update({ revoked_at: new Date().toISOString() }).eq("id", l.id);
      if (error) { setErr(`Couldn't revoke: ${error.message}`); return; }
      const { error: auditErr } = await supabase.from("audit_logs").insert({
        action: "INTAKE_QUOTE_LINK_REVOKED", resource_type: "project_intake_link", resource_id: l.id,
        org_id: orgId, user_id: actor.uid, user_email: actor.email,
        details: { company: l.companyName, rfqGroup: l.rfqGroup, projectId },
      });
      if (auditErr) setErr(`The link was revoked but its audit record failed: ${auditErr.message}`);
      await refresh();
    } finally { setRevoking(null); }
  };

  const copy = async (l: QuoteLink) => {
    const url = `${window.location.origin}/submit/${l.token}`;
    try { await navigator.clipboard.writeText(url); setCopied(l.id); setTimeout(() => setCopied(null), 1500); }
    catch { setErr("Couldn't copy — your browser blocked clipboard access."); }
  };

  // Starter RFQ: a real .docx assembled from the project's own data — the
  // outbound ask that makes inbound quotes comparable. The zip library
  // loads at the click (PERF-9), never in the project route's bundle.
  const makeRfq = async (l: QuoteLink) => {
    try {
      const { downloadStarterRfq } = await import("@/lib/rfqDocx");
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
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]" title="The link stops accepting quotes after this date. Default 90 days.">
          expires
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} required aria-label="Quote link expiry date"
            className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" />
        </label>
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
              {l.expiresAt
                ? <span className={`text-[10px] ${Date.parse(l.expiresAt) < Date.now() ? "font-bold text-rose-700 dark:text-rose-300" : "text-[var(--color-text-faint)]"}`}>
                    {Date.parse(l.expiresAt) < Date.now() ? "expired" : "expires"} {new Date(l.expiresAt).toLocaleDateString()}
                  </span>
                : <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300" title="Created before expiry was required — revoke it when the bidding closes">no expiry</span>}
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
                <button onClick={() => void revoke(l)} disabled={revoking === l.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-rose-500/40 text-[10px] font-bold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 transition-colors disabled:opacity-50">
                  {revoking === l.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />} Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
