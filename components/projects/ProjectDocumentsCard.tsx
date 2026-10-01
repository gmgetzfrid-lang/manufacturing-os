"use client";

// ProjectDocumentsCard — the project's REAL document register, and the
// Documents tab's primary list (UX-11). It reads the link table
// (project_documents: checkout-linked and hand-attached) plus the
// contractor intake documents that were APPROVED but not yet adopted, so an
// approved submission is visible here rather than only inside the Intake
// tab. Each row is a live reference (DEC-40): a superseded / voided /
// archived document is marked "not current". Documents the viewer's
// permissions hide are disclosed as a count, never silently dropped.
// Managers attach and detach; each writes a doc_added / doc_removed feed row
// whose author the database stamps from the session (PM-8 / PM-7), and a
// refused feed row is reported, not swallowed.
//
// Who may attach / detach: the project owner or an org controller — the
// 20261102 detach policy exactly, and narrower than its attach policy (which
// also admits the project's managers), so the `canManage` gate never offers
// a write the database refuses (SEC-17). Detaching removes the
// link from the register; the document's history up to that moment stays
// on the project's Activity tab (SAF-17) and the confirm says so.

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileStack, Search, Plus, X, Loader2, ExternalLink, EyeOff } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { writeActivity, listProjectDocuments, type ProjectDocumentRow, type ProjectDocumentRegister } from "@/lib/projects";
import { appConfirm } from "@/components/providers/DialogProvider";

type LinkedDoc = ProjectDocumentRow;

const SOURCE_BADGE: Record<string, { label: string; cls: string; hint: string }> = {
  checkout: { label: "via checkout", cls: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30", hint: "Linked automatically when someone checked it out under this project" },
  manual: { label: "attached", cls: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30", hint: "Attached by hand (or adopted from intake)" },
  intake: { label: "approved intake", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30", hint: "Submitted through a contractor intake link and approved — still in the project's intake folder (adopt it from the Intake tab to file it)" },
};

export default function ProjectDocumentsCard({ orgId, projectId, canManage, uid, userEmail, onLoaded }: {
  orgId: string; projectId: string; canManage: boolean; uid: string; userEmail?: string | null;
  /** UX-11: the page badges what this card shows. */
  onLoaded?: (register: ProjectDocumentRegister) => void;
}) {
  const [rows, setRows] = useState<LinkedDoc[]>([]);
  const [hidden, setHidden] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Attach picker
  const [attachOpen, setAttachOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ id: string; label: string }>>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const register = await listProjectDocuments(projectId);
      setRows(register.rows);
      setHidden(register.hiddenByPermissions);
      onLoaded?.(register);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
    // onLoaded is a parent callback; the register is keyed on the project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const searchDocs = (text: string) => {
    setQ(text);
    if (timer.current) clearTimeout(timer.current);
    const term = text.trim().replace(/[,().\\%]/g, " ").replace(/\s+/g, " ").trim();
    if (term.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const mySeq = ++seq.current;
    timer.current = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from("documents")
          .select("id, document_number, title, name")
          .eq("org_id", orgId)
          .or(`document_number.ilike.%${term}%,title.ilike.%${term}%,name.ilike.%${term}%`)
          .limit(8);
        if (mySeq !== seq.current) return;
        setResults((((data ?? []) as Array<Record<string, unknown>>)).map((d) => ({
          id: String(d.id), label: String(d.document_number || d.title || d.name || "Document"),
        })));
      } finally {
        if (mySeq === seq.current) setSearching(false);
      }
    }, 250);
  };

  /** The feed row for an attach / detach — checked (writeActivity returns
   *  the refusal as text, which is shown), and its author stamped by the
   *  database from the session (PM-8). The documentId in metadata is what
   *  keeps a detached document's history on the project timeline (SAF-17). */
  const activity = (type: "doc_added" | "doc_removed", body: string, docId: string): Promise<string | null> =>
    writeActivity({ projectId, orgId, userId: uid, userName: userEmail ?? undefined, type, body, metadata: { documentId: docId } });

  const attach = async (doc: { id: string; label: string }) => {
    setBusy(doc.id); setErr(null);
    try {
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("project_documents").upsert(
        { org_id: orgId, project_id: projectId, document_id: doc.id, source: "manual", last_seen_at: nowIso },
        { onConflict: "project_id,document_id", ignoreDuplicates: false },
      );
      if (error) throw new Error(error.message);
      const feedErr = await activity("doc_added", `${doc.label} attached to the project`, doc.id);
      setQ(""); setResults([]);
      await refresh();
      if (feedErr) setErr(`${doc.label} was attached, but ${feedErr.charAt(0).toLowerCase()}${feedErr.slice(1)}`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const detach = async (r: LinkedDoc) => {
    if (!r.linkId) return;
    // SAF-17: the consequence, stated before the click lands.
    const ok = await appConfirm({
      title: `Remove ${r.label} from this project?`,
      message: `It leaves the project's document register. Its history up to now stays on the project's Activity tab; anything that happens to it after this is not shown there.${r.source === "checkout" ? " It will re-link automatically the next time someone checks it out under this project." : ""}`,
      tone: "danger",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setBusy(r.linkId); setErr(null);
    try {
      const { data: gone, error } = await supabase.from("project_documents").delete().eq("id", r.linkId).select("id");
      if (error) throw new Error(error.message);
      if (!gone || (gone as unknown[]).length === 0) throw new Error("The document was not removed — only the project owner or an Admin / Document Control can change the register.");
      const feedErr = await activity("doc_removed", `${r.label} removed from the project`, r.docId);
      await refresh();
      if (feedErr) setErr(`${r.label} was removed, but ${feedErr.charAt(0).toLowerCase()}${feedErr.slice(1)}`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <FileStack className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Project documents</span>
        <span className="text-[10px] font-mono text-[var(--color-text-muted)]">{rows.length + hidden}</span>
        {canManage && (
          <button
            onClick={() => { setAttachOpen((v) => !v); setQ(""); setResults([]); }}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] transition-colors"
          >
            <Plus className="w-3 h-3" /> Attach document
          </button>
        )}
      </div>

      {err && <div role="alert" className="px-4 py-2 text-[11px] font-bold text-rose-700 dark:text-rose-300 bg-rose-500/[0.07] border-b border-rose-500/30">{err}</div>}
      {hidden > 0 && (
        <div className="px-4 py-2 text-[11px] text-[var(--color-text-muted)] border-b border-[var(--color-border)] inline-flex items-center gap-1.5 w-full">
          <EyeOff className="w-3.5 h-3.5 shrink-0" />
          {hidden} linked document{hidden === 1 ? " is" : "s are"} hidden by your permissions.
        </div>
      )}

      {attachOpen && canManage && (
        <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
            <input
              value={q}
              onChange={(e) => searchDocs(e.target.value)}
              placeholder="Search documents by number or title…"
              autoFocus
              className="h-8 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] pl-8 pr-2 text-xs focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
            />
          </div>
          {searching && <div className="mt-1.5 text-[10px] text-[var(--color-text-faint)]">Searching…</div>}
          {results.length > 0 && (
            <ul className="mt-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
              {results.filter((r) => !rows.some((x) => x.docId === r.id)).map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => void attach(r)}
                    disabled={busy === r.id}
                    className="w-full text-left px-2.5 py-1.5 text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
                  >
                    {r.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <div className="px-4 py-8 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" /></div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
          No documents on this project yet. Checking a document out under this project links it automatically; approved contractor submissions appear here too{canManage ? "; or use Attach document above" : ""}.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => {
            const badge = SOURCE_BADGE[r.source] ?? SOURCE_BADGE.manual;
            return (
              <li key={r.linkId ?? `intake:${r.docId}`} className="px-4 py-2.5 flex items-center gap-3 hover:bg-[var(--color-surface-2)]/40 transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-bold truncate ${r.isCurrent ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)] line-through"}`}>{r.label}</span>
                    {r.rev && <span className="text-[10px] font-mono text-[var(--color-text-muted)]">Rev {r.rev}</span>}
                    {r.status && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{r.status}</span>}
                    {/* DEC-40: a reference that is no longer the drawing in force says so. */}
                    {!r.isCurrent && (
                      <span className="text-[9px] font-black uppercase tracking-wider text-amber-800 dark:text-amber-200 bg-amber-500/15 border border-amber-500/40 px-1.5 py-0.5 rounded" title="This document is superseded, void or archived — it is not the current controlled revision.">
                        Not current
                      </span>
                    )}
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${badge.cls}`} title={badge.hint}>{badge.label}</span>
                  </div>
                  {r.lastSeenAt && <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">last activity {new Date(r.lastSeenAt).toLocaleDateString()}</div>}
                </div>
                {r.libraryId && (
                  <Link href={`/documents/${r.libraryId}?doc=${r.docId}`} className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-accent)] hover:underline">
                    <ExternalLink className="w-3 h-3" /> Open
                  </Link>
                )}
                {canManage && r.linkId && (
                  <button
                    onClick={() => void detach(r)}
                    disabled={busy === r.linkId}
                    aria-label={`Remove ${r.label} from the project`}
                    title={r.source === "checkout" ? "Remove from the register (its history stays on the Activity tab; it re-links on the next checkout under this project)" : "Remove from the register (its history stays on the Activity tab)"}
                    className="shrink-0 p-1 rounded text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-500/10 transition-colors disabled:opacity-40"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
