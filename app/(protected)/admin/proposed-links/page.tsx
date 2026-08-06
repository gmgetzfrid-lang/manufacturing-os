"use client";

// /admin/proposed-links — review what the system found.
//
// The engine reads what extraction already stored — off-page connector
// continuity, shared equipment tags, aliases — and files each discovered
// connection here WITH ITS EVIDENCE. Provable ones (an OPC reference that
// resolves to exactly one sheet) applied themselves and are listed as such;
// everything inferred waits for a human.
//
// Two rules this page exists to keep:
//   * a link with no visible reason is worse than no link, so every row
//     shows why the system thinks the two documents belong together
//   * a dismissed pair is remembered — the engine never nags twice

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Waypoints, Loader2, Check, X, RefreshCw, AlertTriangle, FileText,
  Sparkles, ShieldCheck, Info,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import {
  listProposals, approveProposal, dismissProposal,
  PROPOSER_LABELS, TIER_LABELS,
  type LinkProposal, type ProposalTier,
} from "@/lib/linkProposals";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";

const TIER_STYLE: Record<ProposalTier, string> = {
  provable: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  strong: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  inferred: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
};

interface RunResult {
  scanned: number; proposed: number; autoApplied: number;
  evidenceLost: number; more: boolean; notes: string[];
}

export default function ProposedLinksPage() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canDecide = ["Admin", "DocCtrl", "Manager", "Supervisor"].includes(activeRole ?? "");
  const canRun = activeRole === "Admin" || activeRole === "DocCtrl";

  const [rows, setRows] = useState<LinkProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { setRows(await listProposals(activeOrgId)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const runProposers = async () => {
    if (!activeOrgId) return;
    setRunning(true); setError(null);
    try {
      // Bounded slices: keep going while the server says there's more, so a
      // big library finishes without any single request running long.
      let last: RunResult | null = null as RunResult | null;
      for (let pass = 0; pass < 12; pass++) {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch("/api/links/propose", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token ?? ""}`,
          },
          body: JSON.stringify({ orgId: activeOrgId }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Run failed");
        last = {
          scanned: json.scanned ?? 0,
          proposed: (last?.proposed ?? 0) + (json.proposed ?? 0),
          autoApplied: (last?.autoApplied ?? 0) + (json.autoApplied ?? 0),
          evidenceLost: (last?.evidenceLost ?? 0) + (json.evidenceLost ?? 0),
          more: !!json.more,
          notes: json.notes ?? [],
        };
        if (!json.more) break;
      }
      setLastRun(last);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  };

  const decide = async (p: LinkProposal, approve: boolean) => {
    if (!uid) return;
    setBusyId(p.id);
    try {
      const actor = { userId: uid, userName: userEmail ?? undefined };
      if (approve) await approveProposal(p, actor);
      else await dismissProposal(p.id, actor);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== p.id));
    } catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };

  const docLink = (d: LinkProposal["doc"]) =>
    d ? `/documents/${d.library_id}?doc=${d.id}` : "/documents";
  const docLabel = (d: LinkProposal["doc"]) =>
    d?.document_number || d?.title || "Document";

  return (
    <PageShell>
      <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      <PageHeaderBar
        icon={Waypoints}
        eyebrow="Link discovery"
        title="Proposed connections"
        subtitle="What the system found in your own extracted data — each with the evidence behind it. Nothing here was applied without you."
        actions={canRun ? (
          <button onClick={() => void runProposers()} disabled={running}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-black text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-60">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {running ? "Scanning…" : "Find connections"}
          </button>
        ) : undefined}
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 p-3">
          <AlertTriangle className="w-4 h-4 text-rose-600 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>
        </div>
      )}

      {lastRun && (
        <div className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 p-3 space-y-1">
          <div className="text-xs font-bold text-[var(--color-text)]">
            Scanned {lastRun.scanned} documents · {lastRun.autoApplied} provable connection{lastRun.autoApplied === 1 ? "" : "s"} applied · {lastRun.proposed} queued for review
          </div>
          {lastRun.evidenceLost > 0 && (
            <div className="text-[11px] text-amber-700">
              {lastRun.evidenceLost} existing system link{lastRun.evidenceLost === 1 ? "" : "s"} no longer match their original evidence — marked, not removed.
            </div>
          )}
          {lastRun.notes.map((n) => (
            <div key={n} className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-1">
              <Info className="w-3 h-3" /> {n}
            </div>
          ))}
        </div>
      )}

      {rows === null ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" /></div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <Sparkles className="w-8 h-8 mx-auto text-[var(--color-text-faint)]" />
          <div className="text-sm font-bold text-[var(--color-text)]">Nothing waiting on you</div>
          <p className="text-xs text-[var(--color-text-muted)] max-w-md mx-auto">
            {canRun
              ? "Run “Find connections” to scan your off-page connectors, equipment tags and aliases. Provable links apply themselves; anything less certain lands here for review."
              : "When the system finds connections that need a human decision, they'll appear here."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <div key={p.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex-1 min-w-[16rem] space-y-1.5">
                  {/* The pair */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={docLink(p.doc)} className="inline-flex items-center gap-1.5 text-xs font-black text-[var(--color-text)] hover:text-[var(--color-accent)]">
                      <FileText className="w-3.5 h-3.5 text-blue-600" /> {docLabel(p.doc)}
                    </Link>
                    <span className="text-[var(--color-text-faint)] text-xs">↔</span>
                    <Link href={docLink(p.target)} className="inline-flex items-center gap-1.5 text-xs font-black text-[var(--color-text)] hover:text-[var(--color-accent)]">
                      <FileText className="w-3.5 h-3.5 text-blue-600" /> {docLabel(p.target)}
                    </Link>
                  </div>

                  {/* Why — never a bare confidence number */}
                  <div className="text-xs text-[var(--color-text)]">{p.evidence?.summary}</div>
                  {p.evidence?.detail && (
                    <div className="text-[11px] text-[var(--color-text-muted)]">{p.evidence.detail}</div>
                  )}

                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wide ${TIER_STYLE[p.tier]}`}>
                      {TIER_LABELS[p.tier]}
                    </span>
                    <span className="text-[10px] font-bold text-[var(--color-text-muted)]">
                      {PROPOSER_LABELS[p.proposer]}
                    </span>
                    {p.source_rev && (
                      <span className="text-[10px] text-[var(--color-text-faint)]">from rev {p.source_rev}</span>
                    )}
                  </div>
                </div>

                {canDecide && (
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => void decide(p, false)} disabled={busyId === p.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-rose-600 disabled:opacity-50">
                      <X className="w-3.5 h-3.5" /> Not related
                    </button>
                    <button onClick={() => void decide(p, true)} disabled={busyId === p.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50">
                      {busyId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Link them
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-1.5 pt-2 text-[11px] text-[var(--color-text-muted)]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            Dismissed pairs are remembered — the system won&apos;t propose them again unless a new revision brings new evidence.
          </div>
        </div>
      )}
    </PageShell>
  );
}
