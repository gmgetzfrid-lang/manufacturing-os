"use client";

// /control-tower — the document-flow board. Instead of libraries-as-a-
// spreadsheet, this shows every controlled document as a card in its
// LIFECYCLE column (Draft → In Review → IFC → As-Built → Superseded). Cards
// "age" — the longer a document sits in a state, the hotter its age chip —
// so bottlenecks (a pile of stale IFC drawings, say) are visible at a glance.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw, LayoutGrid, Lock, AlertTriangle, Search } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { MiniBars } from "@/components/ui/Sparkline";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";

// Aging-distribution colors (cool → hot) for the per-column trail.
const AGE_BUCKET_COLORS = ["#34d399", "#fde047", "#fbbf24", "#fb7185"]; // new, 7d, 30d, 90d+

function agingBuckets(items: { updatedAt: string | null }[]) {
  const b = [0, 0, 0, 0]; // <7d, 7-30d, 30-90d, 90d+
  for (const it of items) {
    const d = it.updatedAt ? Math.max(0, Math.floor((Date.now() - new Date(it.updatedAt).getTime()) / 86400000)) : 0;
    if (d >= 90) b[3]++; else if (d >= 30) b[2]++; else if (d >= 7) b[1]++; else b[0]++;
  }
  return b;
}

interface BoardDoc {
  id: string;
  number: string;
  title: string;
  rev: string | null;
  status: string | null;
  issueType: string | null;
  libraryId: string | null;
  updatedAt: string | null;
  checkedOutByName: string | null;
}

const COLUMNS = ["Draft", "In Review", "IFC", "As-Built", "Superseded"] as const;
type Column = (typeof COLUMNS)[number];

const COLUMN_TONE: Record<Column, string> = {
  "Draft": "border-slate-300 bg-slate-50",
  "In Review": "border-violet-300 bg-violet-50/60",
  "IFC": "border-blue-300 bg-blue-50/60",
  "As-Built": "border-emerald-300 bg-emerald-50/60",
  "Superseded": "border-rose-300 bg-rose-50/60",
};
const COLUMN_DOT: Record<Column, string> = {
  "Draft": "bg-slate-400",
  "In Review": "bg-violet-500",
  "IFC": "bg-blue-500",
  "As-Built": "bg-emerald-500",
  "Superseded": "bg-rose-500",
};

function lifecycleOf(d: BoardDoc): Column {
  if (d.status === "Superseded" || d.issueType === "Void") return "Superseded";
  if (d.issueType === "As-Built") return "As-Built";
  if (d.issueType === "Issued for Construction") return "IFC";
  if (d.issueType === "Internal Review") return "In Review";
  if (d.status === "Issued") return "IFC"; // issued, finer type unknown → construction-ready
  return "Draft";
}

function ageDays(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
function ageChip(days: number): { cls: string; label: string } {
  if (days >= 90) return { cls: "bg-rose-100 text-rose-800", label: `${Math.floor(days / 30)}mo` };
  if (days >= 30) return { cls: "bg-amber-100 text-amber-800", label: `${Math.floor(days / 7)}w` };
  if (days >= 7) return { cls: "bg-yellow-50 text-yellow-700", label: `${Math.floor(days / 7)}w` };
  return { cls: "bg-emerald-50 text-emerald-700", label: days <= 1 ? "new" : `${days}d` };
}

export default function ControlTowerPage() {
  const { activeOrgId } = useRole();
  const [docs, setDocs] = useState<BoardDoc[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true); setError(null);
    try {
      const { data, error: e } = await supabase
        .from("documents")
        .select("id, document_number, title, name, rev, status, library_id, current_version_id, updated_at, checked_out_by_name")
        .eq("org_id", activeOrgId)
        .neq("status", "Archived")
        .order("updated_at", { ascending: true })
        .limit(2000);
      if (e) throw new Error(e.message);
      const rows = (data ?? []) as Array<Record<string, unknown>>;

      // Pull the current version's issue_type for the finer lifecycle states.
      const versionIds = rows.map((r) => r.current_version_id).filter((v): v is string => !!v);
      const issueByVersion = new Map<string, string>();
      if (versionIds.length > 0) {
        const { data: vrows } = await supabase
          .from("document_versions").select("id, issue_type").in("id", versionIds);
        for (const v of (vrows ?? []) as Array<{ id: string; issue_type: string | null }>) {
          if (v.issue_type) issueByVersion.set(v.id, v.issue_type);
        }
      }

      setDocs(rows.map((r) => ({
        id: String(r.id),
        number: (r.document_number as string) || (r.title as string) || (r.name as string) || "—",
        title: (r.title as string) || "",
        rev: (r.rev as string) ?? null,
        status: (r.status as string) ?? null,
        issueType: r.current_version_id ? issueByVersion.get(r.current_version_id as string) ?? null : null,
        libraryId: (r.library_id as string) ?? null,
        updatedAt: (r.updated_at as string) ?? null,
        checkedOutByName: (r.checked_out_by_name as string) ?? null,
      })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const byColumn = useMemo(() => {
    const map: Record<Column, BoardDoc[]> = { "Draft": [], "In Review": [], "IFC": [], "As-Built": [], "Superseded": [] };
    const q = search.trim().toLowerCase();
    const list = q ? (docs ?? []).filter((d) => d.number.toLowerCase().includes(q) || d.title.toLowerCase().includes(q)) : (docs ?? []);
    for (const d of list) map[lifecycleOf(d)].push(d);
    // Hottest (oldest in state) first within each column.
    for (const c of COLUMNS) map[c].sort((a, b) => ageDays(b.updatedAt) - ageDays(a.updatedAt));
    return map;
  }, [docs, search]);

  if (loading && !docs) {
    return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>;
  }

  return (
    <PageShell width="work">
      <ViewTabs title="Documents" tabs={DOCUMENT_VIEWS} />
      <PageHeaderBar
        icon={LayoutGrid}
        title="Control Tower"
        subtitle={<>Every controlled document by lifecycle state. Hotter age chips = sitting longer — that&apos;s your bottleneck.</>}
        actions={
          <>
            <div className="relative w-56 max-w-[60vw]">
              <Search className="w-3.5 h-3.5 text-[var(--color-text-faint)] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by number or title…"
                className="pl-8"
              />
            </div>
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

      <div className="overflow-x-auto">
        <div className="flex gap-3 min-w-max">
          {COLUMNS.map((col) => {
            const items = byColumn[col];
            const oldest = items.length > 0 ? ageDays(items[0].updatedAt) : 0;
            const bottleneck = items.length >= 8 || oldest >= 60;
            return (
              <div key={col} className={`w-72 shrink-0 rounded-2xl border ${COLUMN_TONE[col]} flex flex-col h-[calc(100vh-180px)]`}>
                <div className="px-3 py-2.5 border-b border-black/5">
                  <div className="flex items-center gap-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${COLUMN_DOT[col]}`} />
                    <span className="text-sm font-black text-slate-800">{col}</span>
                    <span className="text-[11px] font-bold text-slate-500 bg-white/70 rounded-full px-1.5">{items.length}</span>
                    {bottleneck && <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-rose-700"><AlertTriangle className="w-3 h-3" /> bottleneck</span>}
                  </div>
                  {items.length > 0 && (
                    <div className="mt-2" title="Aging mix: green=fresh, red=90d+">
                      <MiniBars
                        height={6}
                        segments={agingBuckets(items).map((v, i) => ({
                          value: v,
                          color: AGE_BUCKET_COLORS[i],
                          label: ["<7d", "7–30d", "30–90d", "90d+"][i],
                        }))}
                      />
                    </div>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {items.length === 0 ? (
                    <div className="text-center text-[11px] text-slate-400 italic py-6">Empty</div>
                  ) : items.map((d) => {
                    const days = ageDays(d.updatedAt);
                    const chip = ageChip(days);
                    return (
                      <Link
                        key={d.id}
                        href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.id}` : "/documents"}
                        className="block bg-white border border-slate-200 rounded-xl p-2.5 shadow-sm hover:shadow-md hover:border-slate-300 transition-all"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs font-bold text-slate-900 truncate flex-1">{d.number}</span>
                          {d.rev && <span className="text-[9px] font-bold bg-slate-100 text-slate-600 px-1 py-0.5 rounded shrink-0">R{d.rev}</span>}
                        </div>
                        {d.title && d.number !== d.title && <div className="text-[11px] text-slate-500 truncate mt-0.5">{d.title}</div>}
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${chip.cls}`} title={`${days} days in this state`}>{chip.label}</span>
                          {d.checkedOutByName && <span className="text-[9px] font-bold text-blue-700 inline-flex items-center gap-0.5"><Lock className="w-2.5 h-2.5" />{d.checkedOutByName}</span>}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}
