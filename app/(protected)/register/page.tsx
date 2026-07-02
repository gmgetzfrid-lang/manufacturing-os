"use client";

// /register — the master document-control register. One org-wide, auditor-facing
// view of every controlled document with its owner, review-cycle status, read-&-
// understood completion, and any in-progress pre-publish review, plus KPI tiles
// and a CSV export (the artifact an auditor asks to be handed). Composes the
// existing per-feature data so every number matches the pills shown elsewhere.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ClipboardList, RefreshCw, Search, Download, AlertTriangle, ShieldCheck, User2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import ReviewPill from "@/components/documents/ReviewPill";
import AckPill from "@/components/documents/AckPill";
import EffectivePill from "@/components/documents/EffectivePill";
import RetentionPill from "@/components/documents/RetentionPill";
import {
  loadDocControlRegister, filterRegister, registerToCsv,
  type RegisterRow, type RegisterKpis, type RegisterFilter,
} from "@/lib/docControlRegister";

const FILTERS: { key: RegisterFilter; label: string; kpi?: keyof RegisterKpis }[] = [
  { key: "all", label: "All" },
  { key: "unowned", label: "Unowned", kpi: "unowned" },
  { key: "review_overdue", label: "Review overdue", kpi: "reviewsOverdue" },
  { key: "review_due", label: "Review due soon", kpi: "reviewsDueSoon" },
  { key: "acks_outstanding", label: "Acks outstanding", kpi: "acksOutstanding" },
  { key: "in_review", label: "In review", kpi: "inReview" },
  { key: "effective_pending", label: "Effective pending", kpi: "effectivePending" },
  { key: "legal_hold", label: "Legal hold", kpi: "legalHolds" },
  { key: "disposition_eligible", label: "Disposition due", kpi: "dispositionEligible" },
];

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

  return (
    <PageShell width="work">
      <ViewTabs title="Documents" tabs={DOCUMENT_VIEWS} />
      <PageHeaderBar
        icon={ClipboardList}
        title="Control Register"
        subtitle={<>Every controlled document with its owner, review status, acknowledgment, and pending sign-offs — the master register for an audit.</>}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={loading || filtered.length === 0}>
              <Download className="w-3.5 h-3.5" /> Export CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* KPI tiles — click to filter */}
      {kpis && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
          <Tile label="Controlled" value={kpis.totalControlled} active={filter === "all"} onClick={() => setFilter("all")} />
          <Tile label="Unowned" value={kpis.unowned} tone={kpis.unowned ? "amber" : "slate"} active={filter === "unowned"} onClick={() => setFilter("unowned")} />
          <Tile label="Review overdue" value={kpis.reviewsOverdue} tone={kpis.reviewsOverdue ? "rose" : "slate"} active={filter === "review_overdue"} onClick={() => setFilter("review_overdue")} />
          <Tile label="Review due soon" value={kpis.reviewsDueSoon} tone={kpis.reviewsDueSoon ? "amber" : "slate"} active={filter === "review_due"} onClick={() => setFilter("review_due")} />
          <Tile label="Acks outstanding" value={kpis.acksOutstanding} tone={kpis.acksOutstanding ? "amber" : "slate"} active={filter === "acks_outstanding"} onClick={() => setFilter("acks_outstanding")} />
          <Tile label="In review" value={kpis.inReview} tone={kpis.inReview ? "violet" : "slate"} active={filter === "in_review"} onClick={() => setFilter("in_review")} />
          <Tile label="Effective pending" value={kpis.effectivePending} tone={kpis.effectivePending ? "amber" : "slate"} active={filter === "effective_pending"} onClick={() => setFilter("effective_pending")} />
          <Tile label="Legal holds" value={kpis.legalHolds} tone={kpis.legalHolds ? "rose" : "slate"} active={filter === "legal_hold"} onClick={() => setFilter("legal_hold")} />
          <Tile label="Disposition due" value={kpis.dispositionEligible} tone={kpis.dispositionEligible ? "amber" : "slate"} active={filter === "disposition_eligible"} onClick={() => setFilter("disposition_eligible")} />
        </div>
      )}

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)]">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-2.5 h-8 rounded-lg text-xs font-bold transition-colors ${filter === f.key ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              {f.label}{f.kpi && kpis && kpis[f.kpi] > 0 ? ` (${kpis[f.kpi]})` : ""}
            </button>
          ))}
        </div>
        <select value={libraryId ?? ""} onChange={(e) => setLibraryId(e.target.value || null)} className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]">
          <option value="">All libraries</option>
          {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <div className="relative w-56 max-w-[60vw]">
          <Search className="w-3.5 h-3.5 text-[var(--color-text-faint)] absolute left-2.5 top-1/2 -translate-y-1/2" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number, title, owner…" className="pl-8 h-8" />
        </div>
        <span className="text-[11px] text-[var(--color-text-muted)] ml-auto">{filtered.length} of {rows.length}{capped ? " (capped)" : ""}</span>
      </div>

      {loading ? (
        <div className="py-16 flex items-center justify-center"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center text-sm text-[var(--color-text-muted)]">No documents match.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--color-surface-2)] text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <th className="text-left font-black px-3 py-2">Document</th>
                <th className="text-left font-black px-3 py-2 hidden md:table-cell">Library</th>
                <th className="text-left font-black px-3 py-2">Owner</th>
                <th className="text-left font-black px-3 py-2">Rev</th>
                <th className="text-left font-black px-3 py-2">Effective</th>
                <th className="text-left font-black px-3 py-2">Review</th>
                <th className="text-left font-black px-3 py-2">Ack</th>
                <th className="text-left font-black px-3 py-2">Gate</th>
                <th className="text-left font-black px-3 py-2">Records</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                  <td className="px-3 py-2">
                    <Link href={`/documents/${r.libraryId}?doc=${r.id}`} className="font-bold text-[var(--color-text)] hover:text-[var(--color-accent)]">{r.number}</Link>
                    {r.title && r.title !== r.number && <div className="text-[11px] text-[var(--color-text-muted)] truncate max-w-[280px]">{r.title}</div>}
                  </td>
                  <td className="px-3 py-2 text-[var(--color-text-muted)] hidden md:table-cell">{r.libraryName}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 text-xs ${r.owned ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`}>
                      <User2 className="w-3 h-3" /> {r.ownerName || "Admin/DocCtrl"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[var(--color-text-muted)]">{r.rev || "—"}</td>
                  <td className="px-3 py-2">{r.effectivePending ? <EffectivePill effectiveDate={r.effectiveDate} compact /> : <span className="text-[var(--color-text-faint)]">—</span>}</td>
                  <td className="px-3 py-2">{r.reviewStatus === "none" ? <span className="text-[var(--color-text-faint)]">—</span> : <ReviewPill nextReviewDate={r.nextReviewDate} compact />}</td>
                  <td className="px-3 py-2">{r.ack ? <AckPill summary={r.ack} compact /> : <span className="text-[var(--color-text-faint)]">—</span>}</td>
                  <td className="px-3 py-2">
                    {r.review?.inReview
                      ? <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${r.review.ready ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-violet-50 text-violet-700 border-violet-200"}`}><ShieldCheck className="w-3 h-3" /> {r.review.revisionLabel || "in review"} · {r.review.signed}/{r.review.requiredPrimaries}</span>
                      : <span className="text-[var(--color-text-faint)]">—</span>}
                  </td>
                  <td className="px-3 py-2">{(r.legalHold || r.dispositionEligible) ? <RetentionPill retentionUntil={r.retentionUntil} dispositionState={r.dispositionEligible ? "eligible" : null} legalHold={r.legalHold} compact /> : <span className="text-[var(--color-text-faint)]">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

function Tile({ label, value, tone = "slate", active, onClick }: {
  label: string; value: number; tone?: "slate" | "amber" | "rose" | "violet"; active?: boolean; onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    slate: "text-[var(--color-text)]",
    amber: "text-amber-700",
    rose: "text-rose-700",
    violet: "text-violet-700",
  };
  return (
    <button onClick={onClick} className={`text-left rounded-xl border p-3 transition-colors ${active ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]" : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"}`}>
      <div className={`text-2xl font-black ${tones[tone]}`}>{value}</div>
      <div className="text-[11px] font-bold text-[var(--color-text-muted)] mt-0.5">{label}</div>
    </button>
  );
}
