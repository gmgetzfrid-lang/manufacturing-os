"use client";

// /register — the master document-control register. One org-wide, auditor-facing
// view of every controlled document with its owner, review-cycle status, read-&-
// understood completion, and any in-progress pre-publish review, plus KPI tiles
// and a CSV export (the artifact an auditor asks to be handed). Composes the
// existing per-feature data so every number matches the pills shown elsewhere.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw, Search, Download, AlertTriangle, ShieldCheck, User2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { bandInput, bandInputIcon, bandSelect, bandSeg, bandSegItem } from "@/components/admin/band";
import LoadingBlock from "@/components/ui/LoadingBlock";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import ReviewPill from "@/components/documents/ReviewPill";
import AckPill from "@/components/documents/AckPill";
import EffectivePill from "@/components/documents/EffectivePill";
import RetentionPill from "@/components/documents/RetentionPill";
import OriginBadge from "@/components/documents/OriginBadge";
import { StatusTag } from "@/components/documents/StatusTag";
import {
  loadDocControlRegister, filterRegister, registerToCsv,
  type RegisterRow, type RegisterKpis, type RegisterFilter,
} from "@/lib/docControlRegister";

const FILTERS: RegisterFilter[] = ["all", "unowned", "review_overdue", "review_due", "acks_outstanding", "in_review", "effective_pending", "legal_hold", "disposition_eligible", "external"];
// Short labels for the header's ruled cells (they sit four across on a phone).
const SHORT: Partial<Record<RegisterFilter, string>> = {
  review_overdue: "Overdue", legal_hold: "Legal hold", unowned: "No owner", review_due: "Due soon",
  acks_outstanding: "Acks open", effective_pending: "Not in effect", disposition_eligible: "Disposition",
  in_review: "In review", external: "External",
};
const asFilter = (v: string | null): RegisterFilter | null => (v && (FILTERS as string[]).includes(v) ? (v as RegisterFilter) : null);

export default function RegisterPage() {
  const { activeOrgId } = useRole();
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [kpis, setKpis] = useState<RegisterKpis | null>(null);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RegisterFilter>("all");
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Deep links: ?filter=legal_hold (any tile's key), ?library=<id>, ?q=<text>
  // open the register already narrowed. Choices made here are written back
  // to the address, so a copied link opens the same view.
  const [urlRead, setUrlRead] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const f = asFilter(sp.get("filter"));
    if (f) setFilter(f);
    const lib = sp.get("library");
    if (lib) setLibraryId(lib);
    const q = sp.get("q");
    if (q) setSearch(q);
    setUrlRead(true);
  }, []);
  useEffect(() => {
    if (!urlRead || typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (filter === "all") sp.delete("filter"); else sp.set("filter", filter);
    if (libraryId) sp.set("library", libraryId); else sp.delete("library");
    if (search.trim()) sp.set("q", search.trim()); else sp.delete("q");
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [urlRead, filter, libraryId, search]);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true); setError(null);
    try {
      const { rows, kpis, capped } = await loadDocControlRegister(activeOrgId);
      setRows(rows); setKpis(kpis); setCapped(capped);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const libraries = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (!m.has(r.libraryId)) m.set(r.libraryId, r.libraryName);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = useMemo(() => filterRegister(rows, filter, libraryId, search), [rows, filter, libraryId, search]);

  const exportCsv = () => {
    const csv = registerToCsv(filtered);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `document-control-register.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // The answer in one sentence: how many are controlled, and what's off.
  // Each count is also a filter, in one compact row of chips.
  const chips: Array<{ key: RegisterFilter; label: string; n: number; tone?: "bad" | "warn"; say: (n: number) => string }> = kpis ? [
    { key: "review_overdue", label: "Review overdue", n: kpis.reviewsOverdue, tone: "bad", say: (n) => `${n.toLocaleString()} review${n === 1 ? "" : "s"} overdue` },
    { key: "legal_hold", label: "Legal holds", n: kpis.legalHolds, tone: "bad", say: (n) => `${n.toLocaleString()} on legal hold` },
    { key: "unowned", label: "No owner", n: kpis.unowned, tone: "warn", say: (n) => `${n.toLocaleString()} with no owner` },
    { key: "review_due", label: "Review due soon", n: kpis.reviewsDueSoon, tone: "warn", say: (n) => `${n.toLocaleString()} due for review soon` },
    { key: "acks_outstanding", label: "Acks outstanding", n: kpis.acksOutstanding, tone: "warn", say: (n) => `${n.toLocaleString()} waiting on read-and-understood` },
    { key: "effective_pending", label: "Effective pending", n: kpis.effectivePending, tone: "warn", say: (n) => `${n.toLocaleString()} not in effect yet` },
    { key: "disposition_eligible", label: "Disposition due", n: kpis.dispositionEligible, tone: "warn", say: (n) => `${n.toLocaleString()} due for disposition` },
    { key: "in_review", label: "In review", n: kpis.inReview, say: (n) => `${n.toLocaleString()} in review` },
    { key: "external", label: "External origin", n: kpis.external, say: (n) => `${n.toLocaleString()} from outside` },
  ] : [];
  const answer = !kpis ? (error ? "The register didn't load." : "Control register")
    : kpis.totalControlled === 0 ? "No controlled documents yet."
    : `${kpis.totalControlled.toLocaleString()} controlled document${kpis.totalControlled === 1 ? "" : "s"}.`;
  const issues = chips.filter((c) => c.n > 0 && c.tone);
  const answerSub = !kpis ? "Every controlled document with its owner, review, sign-offs and records status."
    : issues.length === 0 ? "All owned, all in date, nothing on hold."
    : undefined;
  // The numbers behind it: the problems first, in ruled cells.
  const answerFacts = !kpis || kpis.totalControlled === 0 ? undefined
    : (issues.length > 0 ? issues : chips.filter((c) => c.key === "in_review" || c.key === "review_due")).slice(0, 4)
      .map((c) => ({ label: SHORT[c.key] ?? c.label, value: c.n.toLocaleString(), tone: c.n > 0 ? c.tone : undefined }));
  // Fewer choices up front: only the counts that aren't zero, plus the one in use.
  const shownChips = chips.filter((c) => c.n > 0 || c.key === filter);

  return (
    <PageShell width="work">
      <PageHero
        kicker="Document control"
        title={answer}
        sub={answerSub}
        facts={answerFacts}
        tools={
          <button type="button" onClick={() => void refresh()} disabled={loading} className={heroQuiet} aria-label="Refresh" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        }
        primary={
          <button type="button" onClick={exportCsv} disabled={loading || filtered.length === 0} className={heroPrimary}
            title="The register as a spreadsheet file, as filtered">
            <Download className="w-4 h-4" /> Export CSV
          </button>
        }
      >
        <ViewTabs tabs={DOCUMENT_VIEWS} />
        {/* One compact row: each count is a filter. */}
        {kpis && (
          <div className={`${bandSeg} mt-4`} role="group" aria-label="Show">
            <button type="button" onClick={() => setFilter("all")} aria-pressed={filter === "all"} className={bandSegItem(filter === "all")}>
              All <span className={`ui-count !h-5 !px-1.5 !text-[12px] ${filter === "all" ? "is-solid" : ""}`}>{kpis.totalControlled.toLocaleString()}</span>
            </button>
            {shownChips.map((c) => (
              <button key={c.key} type="button" onClick={() => setFilter(c.key)} aria-pressed={filter === c.key} className={bandSegItem(filter === c.key)}>
                {c.label} <span className={`ui-count !h-5 !px-1.5 !text-[12px] ${c.tone && c.n > 0 ? (c.tone === "bad" ? "is-bad" : "is-warn") : filter === c.key ? "is-solid" : ""}`}>{c.n.toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select value={libraryId ?? ""} onChange={(e) => setLibraryId(e.target.value || null)} aria-label="Library" className={bandSelect}>
            <option value="">All libraries</option>
            {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <div className="relative flex-1 min-w-[12rem] max-w-md">
            <Search className={bandInputIcon} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number, title, owner" aria-label="Search the register" className={`${bandInput} max-sm:text-base`} />
          </div>
          <span className="text-[14px] text-[var(--color-text-muted)] ml-auto tabular-nums">{filtered.length.toLocaleString()} of {rows.length.toLocaleString()}{capped ? " (first rows only)" : ""}</span>
        </div>
      </PageHero>

      <PageBody>
      {error && (
        <Card>
          <div role="alert" className="text-[15px] font-semibold text-[var(--state-overdue)] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" /> Couldn&apos;t load the register: {error}
          </div>
        </Card>
      )}

      {loading ? (
        <Card><LoadingBlock what="the register" rows={6} className="border-0 p-0" /></Card>
      ) : error ? null : filtered.length === 0 ? (
        <Card><p className="text-[15px] text-[var(--color-text-muted)]">No documents match.</p></Card>
      ) : (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead className="bg-[var(--color-surface-2)] max-sm:hidden">
              <tr className="text-[13px] text-[var(--color-text-muted)] h-10">
                <th className="text-left font-semibold px-3 max-sm:hidden">Document</th>
                <th className="text-left font-semibold px-3 hidden md:table-cell">Library</th>
                <th className="text-left font-semibold px-3 max-sm:hidden">Owner</th>
                <th className="text-left font-semibold px-3 max-sm:hidden">Rev</th>
                <th className="text-left font-semibold px-3 max-sm:hidden">Effective</th>
                <th className="text-left font-semibold px-3 max-sm:hidden">Review</th>
                <th className="text-left font-semibold px-3 max-sm:hidden">Ack</th>
                <th className="text-left font-semibold px-3 hidden lg:table-cell" title="Distribution confirmations outstanding">Dist.</th>
                <th className="text-left font-semibold px-3 max-sm:hidden">Gate</th>
                <th className="text-left font-semibold px-3 max-sm:hidden">Records</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <Link href={`/documents/${r.libraryId}?doc=${r.id}`} className="ui-id text-[15px]">{r.number}</Link>
                      {r.external && <OriginBadge origin="external" source={null} reference={null} />}
                    </div>
                    {r.title && r.title !== r.number && <div className="text-[13px] text-[var(--color-text-muted)] truncate max-w-[280px]">{r.title}</div>}
                    {/* Phone: the facts under the number. */}
                    <div className="sm:hidden mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--color-text-muted)]">
                      <span>Rev <span className="ui-id">{r.rev || "-"}</span></span>
                      <span className={r.owned ? "text-[var(--color-text)]" : ""}>{r.ownerName || "Admin/DocCtrl"}</span>
                      {r.reviewStatus !== "none" && <ReviewPill nextReviewDate={r.nextReviewDate} compact />}
                      {r.review?.inReview && <StatusTag tone={r.review.ready ? "good" : "warn"}>In review</StatusTag>}
                      {(r.legalHold || r.dispositionEligible) && <RetentionPill retentionUntil={r.retentionUntil} dispositionState={r.dispositionEligible ? "eligible" : null} legalHold={r.legalHold} compact />}
                    </div>
                  </td>
                  <td className="px-3 py-2 hidden md:table-cell">
                    {r.libraryName
                      ? <button type="button" onClick={() => setLibraryId(libraryId === r.libraryId ? null : r.libraryId)}
                          className={`ui-tag !font-sans ${libraryId === r.libraryId ? "!bg-[var(--color-main)] !text-white !border-[var(--color-main)]" : ""}`} aria-pressed={libraryId === r.libraryId}
                          title={libraryId === r.libraryId ? "Show every library" : `Show only ${r.libraryName}`}>
                          {r.libraryName}
                        </button>
                      : <span className="text-[var(--color-text-faint)]">-</span>}
                  </td>
                  <td className="px-3 py-2 max-sm:hidden">
                    <span className={`inline-flex items-center gap-1 text-[13px] whitespace-nowrap ${r.owned ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                      <User2 className="w-3 h-3" /> {r.ownerName || "Admin/DocCtrl"}
                    </span>
                  </td>
                  <td className="px-3 py-2 max-sm:hidden font-display text-[15px] font-semibold tabular-nums">{r.rev || "-"}</td>
                  <td className="px-3 py-2 max-sm:hidden">{r.effectivePending ? <EffectivePill effectiveDate={r.effectiveDate} compact /> : <span className="text-[var(--color-text-faint)]">-</span>}</td>
                  <td className="px-3 py-2 max-sm:hidden">{r.reviewStatus === "none" ? <span className="text-[var(--color-text-faint)]">-</span> : <ReviewPill nextReviewDate={r.nextReviewDate} compact />}</td>
                  <td className="px-3 py-2 max-sm:hidden">{r.ack ? <AckPill summary={r.ack} compact /> : <span className="text-[var(--color-text-faint)]">-</span>}</td>
                  <td className="px-3 py-2 hidden lg:table-cell">
                    {r.distributionAcksOutstanding > 0
                      ? <span title={`${r.distributionAcksOutstanding} distribution confirmation${r.distributionAcksOutstanding === 1 ? "" : "s"} outstanding`}><StatusTag tone="warn">{r.distributionAcksOutstanding} unconfirmed</StatusTag></span>
                      : <span className="text-[var(--color-text-faint)]">-</span>}
                  </td>
                  <td className="px-3 py-2 max-sm:hidden">
                    {r.review?.inReview
                      ? <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px]"><StatusTag tone={r.review.ready ? "good" : "warn"}><ShieldCheck className="w-3.5 h-3.5" /> {r.review.revisionLabel || "In review"}</StatusTag><span className="tabular-nums text-[var(--color-text-muted)]">{r.review.signed} of {r.review.requiredPrimaries} signed</span></span>
                      : <span className="text-[var(--color-text-faint)]">-</span>}
                  </td>
                  <td className="px-3 py-2 max-sm:hidden">{(r.legalHold || r.dispositionEligible) ? <RetentionPill retentionUntil={r.retentionUntil} dispositionState={r.dispositionEligible ? "eligible" : null} legalHold={r.legalHold} compact /> : <span className="text-[var(--color-text-faint)]">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
      )}
      </PageBody>
    </PageShell>
  );
}
