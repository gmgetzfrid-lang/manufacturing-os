"use client";

// ProjectDocumentsCard — the project's REAL document register. The audit
// found the Documents tab only showed checkout history: documents adopted
// through intake transition-in (project_documents rows) never appeared,
// and there was no way to attach a document to a project by hand. This
// card reads the actual link table, badges where each link came from, and
// gives managers attach/remove — with doc_added / doc_removed activity
// (two enum values that existed since day one and were never written).

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileStack, Search, Plus, X, Loader2, ExternalLink } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface LinkedDoc {
  linkId: string;
  docId: string;
  label: string;
  rev: string | null;
  status: string | null;
  libraryId: string | null;
  source: string;
  lastSeenAt: string | null;
}

const SOURCE_BADGE: Record<string, { label: string; cls: string; hint: string }> = {
  checkout: { label: "via checkout", cls: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30", hint: "Linked automatically when someone checked it out under this project" },
  manual: { label: "attached", cls: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30", hint: "Attached by hand (or adopted from intake)" },
};

export default function ProjectDocumentsCard({ orgId, projectId, canManage, uid, userEmail }: {
  orgId: string; projectId: string; canManage: boolean; uid: string; userEmail?: string | null;
}) {
  const [rows, setRows] = useState<LinkedDoc[]>([]);
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
      const { data: links, error } = await supabase
        .from("project_documents")
        .select("id, document_id, source, last_seen_at")
        .eq("project_id", projectId)
        .order("last_seen_at", { ascending: false });
      if (error) throw new Error(error.message);
      const linkRows = ((links ?? []) as Array<Record<string, unknown>>);
      const docIds = [...new Set(linkRows.map((l) => String(l.document_id)))];
      const { data: docs } = docIds.length
        ? await supabase.from("documents")
            .select("id, document_number, title, name, rev, status, library_id")
            .in("id", docIds)
        : { data: [] };
      const dMap = new Map((((docs ?? []) as Array<Record<string, unknown>>)).map((d) => [String(d.id), d]));
      setRows(linkRows
        .filter((l) => dMap.has(String(l.document_id)))
        .map((l) => {
          const d = dMap.get(String(l.document_id))!;
          return {
            linkId: String(l.id),
            docId: String(l.document_id),
            label: String(d.document_number || d.title || d.name || "Document"),
            rev: (d.rev as string | null) ?? null,
            status: (d.status as string | null) ?? null,
            libraryId: (d.library_id as string | null) ?? null,
            source: String(l.source ?? "checkout"),
            lastSeenAt: (l.last_seen_at as string | null) ?? null,
          };
        }));
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
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

  const activity = async (type: "doc_added" | "doc_removed", body: string, docId: string) => {
    await supabase.from("project_activity").insert({
      project_id: projectId, org_id: orgId,
      user_id: uid, user_name: userEmail ?? null,
      type, body, metadata: { documentId: docId },
    }).then(() => undefined, () => undefined);
  };

  const attach = async (doc: { id: string; label: string }) => {
    setBusy(doc.id); setErr(null);
    try {
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("project_documents").upsert(
        { org_id: orgId, project_id: projectId, document_id: doc.id, source: "manual", last_seen_at: nowIso },
        { onConflict: "project_id,document_id", ignoreDuplicates: false },
      );
      if (error) throw new Error(error.message);
      await activity("doc_added", `${doc.label} attached to the project`, doc.id);
      setQ(""); setResults([]);
      await refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const detach = async (r: LinkedDoc) => {
    setBusy(r.linkId); setErr(null);
    try {
      const { error } = await supabase.from("project_documents").delete().eq("id", r.linkId);
      if (error) throw new Error(error.message);
      await activity("doc_removed", `${r.label} removed from the project`, r.docId);
      await refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <FileStack className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Project documents</span>
        <span className="text-[10px] font-mono text-[var(--color-text-muted)]">{rows.length}</span>
        {canManage && (
          <button
            onClick={() => { setAttachOpen((v) => !v); setQ(""); setResults([]); }}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-black hover:bg-[var(--color-accent-hover)] transition-colors"
          >
            <Plus className="w-3 h-3" /> Attach document
          </button>
        )}
      </div>

      {err && <div className="px-4 py-2 text-[11px] font-bold text-rose-700 bg-rose-500/[0.07] border-b border-rose-500/30">{err}</div>}

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
          No documents linked yet. Checking a document out under this project links it automatically{canManage ? ", or use Attach document above" : ""}.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => {
            const badge = SOURCE_BADGE[r.source] ?? SOURCE_BADGE.manual;
            return (
              <li key={r.linkId} className="px-4 py-2.5 flex items-center gap-3 hover:bg-[var(--color-surface-2)]/40 transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-[var(--color-text)] truncate">{r.label}</span>
                    {r.rev && <span className="text-[10px] font-mono text-[var(--color-text-muted)]">Rev {r.rev}</span>}
                    {r.status && <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{r.status}</span>}
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${badge.cls}`} title={badge.hint}>{badge.label}</span>
                  </div>
                  {r.lastSeenAt && <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">last activity {new Date(r.lastSeenAt).toLocaleDateString()}</div>}
                </div>
                {r.libraryId && (
                  <Link href={`/documents/${r.libraryId}?doc=${r.docId}`} className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-accent)] hover:underline">
                    <ExternalLink className="w-3 h-3" /> Open
                  </Link>
                )}
                {canManage && (
                  <button
                    onClick={() => void detach(r)}
                    disabled={busy === r.linkId}
                    title={r.source === "checkout" ? "Remove (it will re-link on the next checkout under this project)" : "Remove from project"}
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
