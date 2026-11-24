"use client";

// RevisionChainStrip — horizontal visualization of the document's
// revision lineage. Reads getRevisionChain (lib/timeline.ts).
// Each node = one document_versions row, in release order, with
// a connector arrow between consecutive rows. Reverts and the
// current revision get distinct styling.
//
// Designed as a strip (one line, horizontally scrollable) so it
// embeds cleanly above a Timeline tab without dominating the
// drawer's vertical real estate.

import React, { useEffect, useState } from "react";
import { GitBranch, Rewind, CheckCircle2, ChevronRight, Loader2 } from "lucide-react";
import { getRevisionChain, type RevisionChainNode } from "@/lib/timeline";

import { friendlyError } from "@/lib/friendlyError";
interface RevisionChainStripProps {
  documentId: string;
  /** Bump to force a refetch from outside. */
  refreshKey?: number;
}

export default function RevisionChainStrip({ documentId, refreshKey }: RevisionChainStripProps) {
  const [chain, setChain] = useState<RevisionChainNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // All state mutations go inside the async callback so render
    // stays pure (React 19: no setState synchronously in effect body).
    getRevisionChain(documentId)
      .then((c) => {
        if (!alive) return;
        setChain(c); setError(null); setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(friendlyError(e)); setLoading(false);
      });
    return () => { alive = false; };
  }, [documentId, refreshKey]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-body text-[var(--color-text-muted)] px-2 py-3">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading revision chain…
      </div>
    );
  }
  if (error) return <div className="text-body text-[var(--state-overdue)] px-2 py-2">{error}</div>;
  if (chain.length === 0) return null;

  return (
    <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl p-3">
      <div className="text-body font-medium text-[var(--color-text)] mb-2">
        Revision chain
      </div>
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {chain.map((node, idx) => (
          <React.Fragment key={node.versionId}>
            <ChainNode node={node} />
            {idx < chain.length - 1 && (
              <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" aria-hidden="true" />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function ChainNode({ node }: { node: RevisionChainNode }) {
  const isRevert = !!node.revertedFromVersionId;
  const Icon = node.isCurrent ? CheckCircle2 : isRevert ? Rewind : GitBranch;

  const wrapper = node.isCurrent
    ? "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-text-muted)] ring-1 ring-[var(--color-text-muted)]"
    : isRevert
      ? "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]"
      : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)]";

  return (
    <div
      className={`shrink-0 inline-flex items-center gap-1.5 border ${wrapper} rounded-md px-2 py-1 text-body font-display font-semibold tabular-nums`}
      title={tooltipFor(node)}
    >
      <Icon className="w-3 h-3" />
      <span>Rev {node.revisionLabel}</span>
    </div>
  );
}

function tooltipFor(n: RevisionChainNode): string {
  const parts: string[] = [];
  if (n.isCurrent) parts.push("Current revision");
  if (n.revertedFromVersionId) parts.push("Revert");
  if (n.changeType) parts.push(n.changeType);
  if (n.createdByName) parts.push(`by ${n.createdByName}`);
  if (n.releasedAt) {
    try { parts.push(new Date(n.releasedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })); } catch { /* ignore */ }
  }
  if (n.mocReference) parts.push(`MOC ${n.mocReference}`);
  if (n.changeLog) parts.push(n.changeLog);
  return parts.join(" · ");
}
