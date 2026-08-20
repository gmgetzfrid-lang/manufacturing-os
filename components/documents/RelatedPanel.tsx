"use client";

// RelatedPanel — the document's relationship web, in one inspector section.
//
// Three layers, clearly separated:
//   * CURATED — links a human pinned (another controlled document, or an
//     external URL such as a vendor manual). The manual layer.
//   * AUTOMATIC — what the system already knows is related (shared equipment
//     tags, drawing references) via findRelatedDocuments. Zero effort.
//   * The GRAPH — one click opens the interactive relationship graph.
//
// Also carries the document's short link: /d/<number> — typeable from a
// title block, pasteable anywhere, resolves org-wide.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Link2, Plus, X, Loader2, FileText, Globe, Waypoints, Copy, Check,
  CornerDownLeft, Briefcase, Sparkles, AlertTriangle,
} from "lucide-react";
import {
  listRelatedResources, addRelatedResource, removeRelatedResource, listBacklinks,
  type RelatedResource, type DocumentBacklinks,
} from "@/lib/relatedResources";
import {
  listProposalsForDocument, approveProposal, dismissProposal,
  proposerLabel, type LinkProposal,
} from "@/lib/linkProposals";
import { findRelatedDocuments, type RelatedDocument } from "@/lib/search";
import { openRelationshipGraph } from "@/components/documents/RelationshipGraphHost";
import DocumentLinkPicker from "@/components/documents/DocumentLinkPicker";
import { publicOrigin } from "@/lib/publicOrigin";

export default function RelatedPanel({
  documentId, orgId, documentNumber, userId, userName, canManage,
}: {
  documentId: string;
  orgId: string;
  documentNumber?: string | null;
  userId?: string;
  userName?: string;
  canManage: boolean;
}) {
  const [curated, setCurated] = useState<RelatedResource[] | null>(null);
  const [auto, setAuto] = useState<RelatedDocument[] | null>(null);
  const [backlinks, setBacklinks] = useState<DocumentBacklinks | null>(null);
  const [proposals, setProposals] = useState<LinkProposal[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState<{ url: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try { setCurated(await listRelatedResources(documentId)); }
    catch { setCurated([]); }
  }, [documentId]);

  useEffect(() => {
    let alive = true;
    void refresh();
    findRelatedDocuments(documentId, { limit: 6 })
      .then((r) => { if (alive) setAuto(r); })
      .catch(() => { if (alive) setAuto([]); });
    listBacklinks(documentId)
      .then((b) => { if (alive) setBacklinks(b); })
      .catch(() => { if (alive) setBacklinks(null); });
    listProposalsForDocument(documentId)
      .then((p) => { if (alive) setProposals(p); })
      .catch(() => { if (alive) setProposals([]); });
    return () => { alive = false; };
  }, [documentId, refresh]);

  const decideProposal = async (p: LinkProposal, approve: boolean) => {
    if (!userId) return;
    setDecidingId(p.id);
    try {
      const actor = { userId, userName };
      if (approve) await approveProposal(p, actor); else await dismissProposal(p.id, actor);
      setProposals((prev) => prev.filter((r) => r.id !== p.id));
      if (approve) await refresh();
    } finally { setDecidingId(null); }
  };

  const addDoc = async (targetId: string) => {
    if (!userId) return;
    await addRelatedResource({
      orgId, documentId, kind: "document", targetDocumentId: targetId,
      userId, userName, sortOrder: (curated?.length ?? 0),
    });
    setPickerOpen(false);
    await refresh();
  };

  const addUrl = async () => {
    if (!userId || !urlDraft?.url.trim()) return;
    setBusy(true);
    try {
      let url = urlDraft.url.trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      await addRelatedResource({
        orgId, documentId, kind: "url", url,
        label: urlDraft.label.trim() || url.replace(/^https?:\/\//, "").slice(0, 60),
        userId, userName, sortOrder: (curated?.length ?? 0),
      });
      setUrlDraft(null);
      await refresh();
    } finally { setBusy(false); }
  };

  const shortLink = documentNumber
    ? `${publicOrigin()}/d/${encodeURIComponent(documentNumber)}`
    : null;

  // Curated targets shouldn't repeat in the automatic list.
  const curatedTargetIds = new Set((curated ?? []).map((c) => c.target_document_id).filter(Boolean));
  const autoShown = (auto ?? [])
    .filter((a) => !curatedTargetIds.has(a.document.id) && a.document.id !== documentId);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Waypoints className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
        <span className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest flex-1">Related</span>
        <button onClick={() => openRelationshipGraph(documentId)}
          className="text-[10px] font-bold text-violet-700 hover:underline">Open graph</button>
        {shortLink && (
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(shortLink).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            title={`Short link anyone in the org can use: ${shortLink}`}
            className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
            /d/{documentNumber}
          </button>
        )}
      </div>

      {/* Curated pins */}
      {curated === null ? (
        <div className="text-[11px] text-[var(--color-text-faint)] italic">Loading…</div>
      ) : (
        <div className="space-y-1">
          {curated.map((r) => (
            <div key={r.id} className="group flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5">
              {r.kind === "document" ? (
                <>
                  <FileText className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                  {r.target ? (
                    <Link href={`/documents/${r.target.library_id}?doc=${r.target_document_id}`}
                      className="flex-1 min-w-0 text-xs font-bold text-[var(--color-text)] hover:text-[var(--color-accent)] truncate">
                      {r.target.document_number || r.target.title || "Document"}
                      {r.label && <span className="font-normal text-[var(--color-text-muted)]"> · {r.label}</span>}
                    </Link>
                  ) : (
                    <span className="flex-1 text-xs text-[var(--color-text-faint)] italic">missing document</span>
                  )}
                </>
              ) : (
                <>
                  <Globe className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <a href={r.url ?? "#"} target="_blank" rel="noreferrer"
                    className="flex-1 min-w-0 text-xs font-bold text-[var(--color-text)] hover:text-[var(--color-accent)] truncate">
                    {r.label || r.url}
                  </a>
                </>
              )}
              {r.origin && r.origin !== "human" && (
                <span
                  title={[
                    r.origin === "system" ? "Applied automatically — provable connection" : "Approved from a proposal",
                    r.evidence?.summary,
                    r.approved_by_name ? `Approved by ${r.approved_by_name}` : null,
                  ].filter(Boolean).join(" · ")}
                  className="shrink-0 inline-flex items-center gap-0.5 text-[8px] font-black uppercase tracking-wide text-violet-700 bg-violet-100 dark:bg-violet-950/60 rounded px-1 py-0.5"
                >
                  <Sparkles className="w-2.5 h-2.5" /> {r.origin === "system" ? "auto" : "approved"}
                </span>
              )}
              {r.evidence_lost_at && (
                <span title="A later revision removed the evidence this link was based on — still linked, worth a look."
                  className="shrink-0 text-amber-600"><AlertTriangle className="w-3 h-3" /></span>
              )}
              {canManage && (
                <button onClick={() => void removeRelatedResource(r.id).then(refresh)}
                  title="Unpin" className="p-0.5 rounded text-[var(--color-text-faint)] hover:text-rose-600 opacity-60 group-hover:opacity-100">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          {canManage && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-violet-700 border border-dashed border-[var(--color-border-strong)] rounded-lg px-2 py-1">
                <Plus className="w-3 h-3" /> Pin document
              </button>
              <button onClick={() => setUrlDraft({ url: "", label: "" })}
                className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-emerald-700 border border-dashed border-[var(--color-border-strong)] rounded-lg px-2 py-1">
                <Link2 className="w-3 h-3" /> Pin external link
              </button>
            </div>
          )}
        </div>
      )}

      {urlDraft && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-2 space-y-1.5">
          <input value={urlDraft.url} onChange={(e) => setUrlDraft({ ...urlDraft, url: e.target.value })}
            placeholder="https:// … (vendor manual, datasheet, portal)"
            className="w-full px-2 py-1.5 border border-[var(--color-border-strong)] rounded-lg text-xs" />
          <input value={urlDraft.label} onChange={(e) => setUrlDraft({ ...urlDraft, label: e.target.value })}
            placeholder="Label (optional)"
            className="w-full px-2 py-1.5 border border-[var(--color-border-strong)] rounded-lg text-xs" />
          <div className="flex items-center gap-1.5 justify-end">
            <button onClick={() => setUrlDraft(null)} className="text-[10px] font-bold text-[var(--color-text-muted)] px-2 py-1">Cancel</button>
            <button onClick={() => void addUrl()} disabled={busy || !urlDraft.url.trim()}
              className="inline-flex items-center gap-1 text-[10px] font-black text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-2 py-1 disabled:opacity-50">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Pin it
            </button>
          </div>
        </div>
      )}

      {/* Automatic layer — what the system already knows. */}
      {autoShown.length > 0 && (
        <div>
          <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-1">
            Found automatically
          </div>
          <div className="space-y-0.5">
            {autoShown.map((r) => (
              <Link key={r.document.id}
                href={r.document.library_id ? `/documents/${r.document.library_id}?doc=${r.document.id}` : "/documents"}
                className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-[var(--color-surface-2)] transition-colors">
                <FileText className="w-3 h-3 text-[var(--color-text-faint)] shrink-0" />
                <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">
                  {r.document.document_number || r.document.title || "Document"}
                </span>
                <span className="shrink-0 text-[9px] text-[var(--color-text-faint)]">{r.detail ?? r.reason}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Found, awaiting a decision — review where the document is. */}
      {proposals.length > 0 && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 p-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3 h-3 text-amber-600" />
            <span className="text-[9px] font-black uppercase tracking-widest text-amber-800 dark:text-amber-300">
              Found · needs review
            </span>
          </div>
          {proposals.map((p) => (
            <div key={p.id} className="space-y-1">
              <Link href={p.target ? `/documents/${p.target.library_id}?doc=${p.target.id}` : "#"}
                className="block text-[11px] font-bold text-[var(--color-text)] hover:text-[var(--color-accent)] truncate">
                {p.target?.document_number || p.target?.title || "Document"}
              </Link>
              <div className="text-[10px] text-[var(--color-text-muted)]">
                {p.evidence?.summary} · {proposerLabel(p.proposer, p.evidence)}
              </div>
              {canManage && (
                <div className="flex items-center gap-1.5">
                  <button onClick={() => void decideProposal(p, true)} disabled={decidingId === p.id}
                    className="inline-flex items-center gap-1 text-[10px] font-black text-white bg-emerald-600 hover:bg-emerald-500 rounded px-1.5 py-0.5 disabled:opacity-50">
                    {decidingId === p.id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5" />} Link
                  </button>
                  <button onClick={() => void decideProposal(p, false)} disabled={decidingId === p.id}
                    className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-rose-600 px-1 disabled:opacity-50">
                    Not related
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Linked from — the other direction of the web. What points HERE. */}
      {backlinks && (backlinks.docs.length > 0 || backlinks.projects.length > 0) && (
        <div>
          <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-1">
            Linked from
          </div>
          <div className="space-y-0.5">
            {backlinks.docs.map((d) => (
              <Link key={d.id} href={`/documents/${d.library_id}?doc=${d.id}`}
                className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-[var(--color-surface-2)] transition-colors">
                <CornerDownLeft className="w-3 h-3 text-violet-500 shrink-0" />
                <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">
                  {d.document_number || d.title || "Document"}
                </span>
                {d.pinned_by && <span className="shrink-0 text-[9px] text-[var(--color-text-faint)]">pinned by {d.pinned_by}</span>}
              </Link>
            ))}
            {backlinks.projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`}
                className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-[var(--color-surface-2)] transition-colors">
                <Briefcase className="w-3 h-3 text-rose-500 shrink-0" />
                <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">{p.name}</span>
                <span className="shrink-0 text-[9px] text-[var(--color-text-faint)]">project</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {pickerOpen && userId && (
        <DocumentLinkPicker
          orgId={orgId}
          userId={userId}
          excludeIds={[documentId, ...(curated ?? []).map((c) => c.target_document_id ?? "")]}
          onPick={addDoc}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
