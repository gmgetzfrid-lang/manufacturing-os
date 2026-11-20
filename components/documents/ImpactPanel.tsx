"use client";

// ImpactPanel — "if I change this, what else does it touch?"
//
// Collapsed to a one-line summary chip row by default; expands to the full
// blast radius. Quiet when there's nothing to say. Siblings that are
// mid-change (checked out) surface first with an amber dot — those are the
// coordination risks.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Network, ChevronDown, ChevronUp, Lock, Ticket as TicketIcon, Briefcase, GitBranch, ShieldAlert } from "lucide-react";
import { getDocumentImpact, type DocumentImpact } from "@/lib/impact";

interface ImpactPanelProps {
  documentId: string;
  orgId: string;
}

export default function ImpactPanel({ documentId, orgId }: ImpactPanelProps) {
  const [impact, setImpact] = useState<DocumentImpact | null>(null);
  const [open, setOpen] = useState(false);
  // Downstream by CONNECTION — continuation sheets, shared equipment,
  // curated links. The same walk the publish-time impact notice makes, shown
  // BEFORE you publish so the blast radius is a decision input, not a
  // surprise afterwards.
  const [impactFailed, setImpactFailed] = useState(false);
  const [connected, setConnected] = useState<Array<{
    id: string; library_id: string; document_number: string | null;
    title: string | null; reason: string;
  }>>([]);

  useEffect(() => {
    let alive = true;
    // All state mutations inside the async IIFE so render stays pure.
    (async () => {
      setImpact(null);
      setOpen(false);
      setConnected([]);
      setImpactFailed(false);
      try {
        const result = await getDocumentImpact(documentId, orgId);
        if (alive) setImpact(result);
      } catch { if (alive) setImpactFailed(true); }
      try {
        const { findConnectedDocuments } = await import("@/lib/revisionImpact");
        const rows = await findConnectedDocuments(documentId, { limit: 12 });
        if (alive) setConnected(rows);
      } catch { /* quiet */ }
    })();
    return () => { alive = false; };
  }, [documentId, orgId]);

  // Loading and failure each say so; "nothing touches this" stays silent.
  if (impactFailed) return <p className="px-4 pt-2 text-[11px] text-rose-700 dark:text-rose-300">Couldn&apos;t check what this document touches.</p>;
  if (!impact) return <p className="px-4 pt-2 text-[11px] text-[var(--color-text-muted)]">Checking what this document touches…</p>;
  const total =
    impact.siblingDocs.length + impact.openTickets.length + impact.projects.length +
    impact.activeHoldCount + impact.openBranchCount +
    impact.workPackages.length + impact.pendingDistributionAcks + connected.length;
  if (total === 0) return null;

  const midChangeSiblings = impact.siblingDocs.filter((d) => d.checkedOutByName).length;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3.5 py-2.5 flex items-center gap-2 hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <Network className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
        <span className="text-xs font-bold text-[var(--color-text)]">Changing this touches</span>
        <span className="flex items-center gap-1.5 flex-wrap justify-end flex-1">
          {impact.siblingDocs.length > 0 && (
            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${midChangeSiblings > 0 ? "bg-amber-100 text-amber-800" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
              {impact.siblingDocs.length} related doc{impact.siblingDocs.length === 1 ? "" : "s"}
              {midChangeSiblings > 0 && ` · ${midChangeSiblings} mid-change`}
            </span>
          )}
          {impact.openTickets.length > 0 && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text)]">
              {impact.openTickets.length} open ticket{impact.openTickets.length === 1 ? "" : "s"}
            </span>
          )}
          {impact.projects.length > 0 && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
              {impact.projects.length} project{impact.projects.length === 1 ? "" : "s"}
            </span>
          )}
          {impact.activeHoldCount > 0 && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700">
              {impact.activeHoldCount} hold{impact.activeHoldCount === 1 ? "" : "s"}
            </span>
          )}
          {impact.openBranchCount > 0 && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text)]">
              {impact.openBranchCount} branch{impact.openBranchCount === 1 ? "" : "es"}
            </span>
          )}
          {impact.workPackages.length > 0 && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text)]">
              {impact.workPackages.length} work pack{impact.workPackages.length === 1 ? "" : "s"}
            </span>
          )}
          {impact.pendingDistributionAcks > 0 && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
              {impact.pendingDistributionAcks} unconfirmed cop{impact.pendingDistributionAcks === 1 ? "y" : "ies"}
            </span>
          )}
          {connected.length > 0 && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text)] dark:bg-[var(--color-surface-2)] dark:text-[var(--color-text)]">
              {connected.length} downstream
            </span>
          )}
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
      </button>

      {open && (
        <div className="px-3.5 pb-3 space-y-3 border-t border-[var(--color-border)] pt-3 animate-in fade-in slide-in-from-top-1 duration-150">
          {connected.length > 0 && (
            <div>
              <div className="text-[13px] font-semibold text-[var(--color-text-faint)] mb-1.5">
                Downstream of a revision
              </div>
              <div className="space-y-1">
                {connected.map((d) => (
                  <Link key={d.id} href={`/documents/${d.library_id}?doc=${d.id}`}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] group">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--color-text-muted)]" />
                    <span className="text-xs font-bold text-[var(--color-text)] group-hover:text-[var(--color-text)] truncate">
                      {d.document_number || d.title || "Document"}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-[var(--color-text-faint)]">{d.reason}</span>
                  </Link>
                ))}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-1.5">
                Anyone with these checked out is told automatically when you publish.
              </div>
            </div>
          )}
          {impact.siblingDocs.length > 0 && (
            <div>
              <div className="text-[13px] font-semibold text-[var(--color-text-faint)] mb-1.5">
                Same equipment appears on
              </div>
              <div className="space-y-1">
                {impact.siblingDocs.slice(0, 8).map((d) => (
                  <Link
                    key={d.id}
                    href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.id}` : "#"}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] group"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.checkedOutByName ? "bg-amber-500" : "bg-slate-300"}`} />
                    <span className="text-xs font-bold text-[var(--color-text)] group-hover:text-[var(--color-text)] truncate">{d.label}</span>
                    <span className="text-[11px] text-[var(--color-text-faint)] shrink-0">Rev {d.rev ?? "-"}</span>
                    <span className="text-[11px] text-[var(--color-text-faint)] truncate">({d.sharedTags.slice(0, 3).join(", ")})</span>
                    {d.checkedOutByName && (
                      <span className="ml-auto shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-amber-700">
                        <Lock className="w-2.5 h-2.5" /> {d.checkedOutByName}
                      </span>
                    )}
                  </Link>
                ))}
                {impact.siblingDocs.length > 8 && (
                  <div className="text-[11px] text-[var(--color-text-faint)] px-2">…and {impact.siblingDocs.length - 8} more</div>
                )}
              </div>
            </div>
          )}

          {impact.openTickets.length > 0 && (
            <div>
              <div className="text-[13px] font-semibold text-[var(--color-text-faint)] mb-1.5">
                Open drafting work on this document
              </div>
              {impact.openTickets.map((t) => (
                <Link key={t.id} href={`/requests/${t.id}`} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] group">
                  <TicketIcon className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
                  <span className="text-xs text-[var(--color-text)] group-hover:text-[var(--color-text)] truncate">{t.ticketId ? `${t.ticketId} - ` : ""}{t.title}</span>
                  <span className="ml-auto text-[11px] font-bold uppercase text-[var(--color-text-faint)] shrink-0">{t.status.replace(/_/g, " ")}</span>
                </Link>
              ))}
            </div>
          )}

          {impact.projects.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Briefcase className="w-3 h-3 text-[var(--color-text-faint)]" />
              {impact.projects.map((p) => (
                <Link key={p.id} href={`/projects/${p.id}`} className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                  {p.name}
                </Link>
              ))}
            </div>
          )}

          {(impact.activeHoldCount > 0 || impact.openBranchCount > 0) && (
            <div className="flex items-center gap-3 text-[11px] font-bold">
              {impact.activeHoldCount > 0 && (
                <span className="inline-flex items-center gap-1 text-red-700"><ShieldAlert className="w-3 h-3" /> {impact.activeHoldCount} active hold{impact.activeHoldCount === 1 ? "" : "s"} - publishing is blocked</span>
              )}
              {impact.openBranchCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[var(--color-text)]"><GitBranch className="w-3 h-3" /> unreconciled branch open</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
