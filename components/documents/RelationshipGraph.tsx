"use client";

// RelationshipGraph — turns "N other docs reference this" from a warning into a
// navigable map. A radial graph centered on one document with its related docs
// arranged by relationship (supersedes / superseded-by / same-scope). Click any
// node to jump to that document. Makes the blast radius of a change visible.

import React from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, Network, ArrowRight } from "lucide-react";
import { findRelatedDocuments, type RelatedDocument, type RelatedReason, type DocumentRow } from "@/lib/search";

const REASON_META: Record<RelatedReason, { label: string; hex: string }> = {
  supersedes:    { label: "Supersedes (older)", hex: "#94a3b8" },
  superseded_by: { label: "Superseded by (newer)", hex: "#7c3aed" },
  scope_sibling: { label: "Same scope", hex: "#2563eb" },
};

interface Node {
  id: string;
  label: string;
  sub: string;
  href: string;
  reason: RelatedReason | "center";
  x: number;
  y: number;
}

function hrefFor(d: DocumentRow): string {
  return d.library_id ? `/documents/${d.library_id}?doc=${d.id}` : "/documents";
}

const W = 720, H = 460, CX = W / 2, CY = H / 2, R = 165;

export default function RelationshipGraph({
  documentId, onClose,
}: {
  documentId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [related, setRelated] = React.useState<RelatedDocument[] | null>(null);
  const [center, setCenter] = React.useState<DocumentRow | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  React.useEffect(() => {
    let alive = true;
    setRelated(null); setError(null);
    (async () => {
      try {
        const { supabase } = await import("@/lib/supabase");
        const { data } = await supabase.from("documents").select("*").eq("id", documentId).maybeSingle();
        const rel = await findRelatedDocuments(documentId, { limit: 24 });
        if (!alive) return;
        setCenter((data as DocumentRow) ?? null);
        setRelated(rel);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [documentId]);

  const nodes: Node[] = React.useMemo(() => {
    if (!related) return [];
    const list = related.slice(0, 16);
    const out: Node[] = list.map((rd, i) => {
      const angle = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2;
      return {
        id: rd.document.id,
        label: rd.document.document_number || rd.document.title || rd.document.id.slice(0, 6),
        sub: rd.detail || REASON_META[rd.reason].label,
        href: hrefFor(rd.document),
        reason: rd.reason,
        x: CX + Math.cos(angle) * R,
        y: CY + Math.sin(angle) * R,
      };
    });
    return out;
  }, [related]);

  const go = (href: string) => { onClose(); router.push(href); };

  return (
    <div className="fixed inset-0 z-[400] bg-slate-900/75 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-3xl bg-[var(--color-surface)] rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--color-border)]">
          <Network className="w-4 h-4 text-[var(--color-accent)]" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-black text-[var(--color-text)]">Relationship map</h2>
            <p className="text-[11px] text-[var(--color-text-muted)]">Supersession lineage and same-scope documents. Click any node to open it.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4">
          {error ? (
            <div className="text-sm text-rose-600 p-8 text-center">{error}</div>
          ) : !related ? (
            <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
          ) : nodes.length === 0 ? (
            <div className="text-center text-sm text-[var(--color-text-muted)] py-16">
              No related documents found — this drawing stands alone (no supersession lineage or shared scope).
            </div>
          ) : (
            <>
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
                {/* edges */}
                {nodes.map((n) => (
                  <line key={`e-${n.id}`} x1={CX} y1={CY} x2={n.x} y2={n.y} stroke={REASON_META[n.reason as RelatedReason].hex} strokeWidth={1.5} strokeOpacity={0.4} />
                ))}
                {/* related nodes */}
                {nodes.map((n) => (
                  <g key={n.id} className="cursor-pointer" onClick={() => go(n.href)}>
                    <circle cx={n.x} cy={n.y} r={7} fill={REASON_META[n.reason as RelatedReason].hex} stroke="#fff" strokeWidth={2} />
                    <text x={n.x} y={n.y - 12} textAnchor="middle" className="fill-[var(--color-text)] text-[10px] font-bold" style={{ fontFamily: "monospace" }}>{n.label.slice(0, 18)}</text>
                  </g>
                ))}
                {/* center node */}
                <circle cx={CX} cy={CY} r={13} fill="var(--color-accent)" stroke="#fff" strokeWidth={3} />
                <text x={CX} y={CY + 30} textAnchor="middle" className="fill-[var(--color-text)] text-[11px] font-black" style={{ fontFamily: "monospace" }}>
                  {center?.document_number || center?.title || "This document"}
                </text>
              </svg>

              {/* legend */}
              <div className="flex flex-wrap items-center justify-center gap-4 mt-2">
                {(Object.keys(REASON_META) as RelatedReason[]).map((r) => (
                  <span key={r} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-muted)]">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: REASON_META[r].hex }} /> {REASON_META[r].label}
                  </span>
                ))}
              </div>

              {/* list fallback for accessibility / long labels */}
              <div className="mt-4 max-h-40 overflow-y-auto space-y-1 border-t border-[var(--color-border)] pt-3">
                {nodes.map((n) => (
                  <button key={`row-${n.id}`} onClick={() => go(n.href)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-left">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: REASON_META[n.reason as RelatedReason].hex }} />
                    <span className="font-mono text-xs font-bold text-[var(--color-text)] truncate">{n.label}</span>
                    <span className="text-[11px] text-[var(--color-text-muted)] truncate flex-1">{n.sub}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
