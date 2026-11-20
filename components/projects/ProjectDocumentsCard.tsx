"use client";

// ProjectDocumentsCard — the project's REAL document register. The audit
// found the Documents tab only showed checkout history: documents adopted
// through intake transition-in (project_documents rows) never appeared,
// and there was no way to attach a document to a project by hand. This
// card reads the actual link table, badges where each link came from, and
// gives managers attach/remove — with doc_added / doc_removed activity
// (two enum values that existed since day one and were never written).

import HelpTooltip from "@/components/ui/HelpTooltip";
import { Card } from "@/components/ui/PageHero";
import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search, Plus, X, Loader2, FileText } from "lucide-react";

/** A document's status as a pill: issued green, in review amber, draft grey. */
function docPill(status: string): string {
  const s = status.toLowerCase();
  if (/issued|ifc|approved|released|current|effective/.test(s)) return "is-good";
  if (/review|pending|hold|check/.test(s)) return "is-warn";
  if (/superseded|obsolete|void|cancel|retired/.test(s)) return "is-muted";
  if (/draft|wip|work/.test(s)) return "is-muted";
  return "";
}
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
  checkout: { label: "via checkout", cls: "bg-[var(--color-surface-2)] text-[var(--color-text)] dark:text-[var(--color-text)] border-[var(--color-border-strong)]", hint: "Linked automatically when someone checked it out under this project" },
  manual: { label: "attached", cls: "bg-[var(--color-surface-2)] text-[var(--color-text)] dark:text-[var(--color-text)] border-[var(--color-border-strong)]", hint: "Attached by hand (or adopted from intake)" },
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
    <Card pad={false} className="overflow-hidden" label={<span className="inline-flex items-center gap-2"><span aria-hidden className="ui-icon-tile is-sm is-solid"><FileText className="w-4 h-4" /></span>Project documents <span className="ui-count is-solid">{rows.length}</span></span>}
      action={canManage ? (
        <button
          onClick={() => { setAttachOpen((v) => !v); setQ(""); setResults([]); }}
          aria-expanded={attachOpen}
          className={`inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md text-[14px] font-semibold whitespace-nowrap transition-colors ${attachOpen ? "border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[var(--color-text)]" : "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"}`}
        >
          <Plus className="w-3.5 h-3.5" /> Attach<span className="max-sm:hidden"> document</span>
        </button>
      ) : undefined}>

      {err && <div role="alert" className="mx-4 sm:mx-5 mt-3 text-[14px] font-semibold text-[var(--state-overdue)]">{err}</div>}

      {attachOpen && canManage && (
        <div className="px-4 sm:px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
            <input
              value={q}
              onChange={(e) => searchDocs(e.target.value)}
              placeholder="Search documents by number or title…"
              autoFocus
              aria-label="Search documents"
              className="h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] pl-8 pr-2 text-[15px] focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 outline-none"
            />
          </div>
          {searching && <div className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">Searching…</div>}
          {!searching && q.trim().length >= 2 && results.length === 0 && <div className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">No documents match &ldquo;{q.trim()}&rdquo;.</div>}
          {results.length > 0 && (
            <ul className="mt-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
              {results.filter((r) => !rows.some((x) => x.docId === r.id)).map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => void attach(r)}
                    disabled={busy === r.id}
                    className="w-full text-left px-3 py-2 text-[14px] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
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
        <div className="px-4 sm:px-5 py-4 flex items-center gap-2 text-[14px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Loading the project&apos;s documents…</div>
      ) : rows.length === 0 ? (
        <div className="px-4 sm:px-5 py-4 text-[15px] text-[var(--color-text-muted)]">
          None linked yet. <HelpTooltip>A document checked out under this project links itself here{canManage ? ". Attach document links one by hand" : ""}.</HelpTooltip>
        </div>
      ) : (
        <table className="w-full text-[15px]">
          <thead className="max-sm:hidden bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
            <tr className="border-y border-[var(--color-border)]">
              <th scope="col" className="font-semibold px-4 h-10">Document</th>
              <th scope="col" className="font-semibold px-4 w-[80px]">Rev</th>
              <th scope="col" className="font-semibold px-4 hidden md:table-cell">Status</th>
              <th scope="col" className="font-semibold px-4 hidden md:table-cell">Linked by</th>
              <th scope="col" className="font-semibold px-4 hidden lg:table-cell">Last activity</th>
              <th scope="col" className="px-4 w-[1%]"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map((r) => {
              const badge = SOURCE_BADGE[r.source] ?? SOURCE_BADGE.manual;
              const href = r.libraryId ? `/documents/${r.libraryId}?doc=${r.docId}` : null;
              return (
                <tr key={r.linkId} className="hover:bg-[var(--color-surface-2)] align-top max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:px-4 max-sm:py-2.5">
                  <td className="sm:px-4 sm:py-3 max-sm:flex-1 min-w-0">
                    {href ? <Link href={href} className="ui-id">{r.label}</Link>
                      : <span className="ui-id">{r.label}</span>}
                    {r.status && <div className="md:hidden mt-1"><span className={`ui-pill ${docPill(r.status)}`}>{r.status}</span></div>}
                  </td>
                  <td className="sm:px-4 sm:py-3">{r.rev ? <span className="ui-tag">Rev {r.rev}</span> : <span className="text-[var(--color-text-faint)]">-</span>}</td>
                  <td className="px-4 py-3 hidden md:table-cell">{r.status ? <span className={`ui-pill ${docPill(r.status)}`}>{r.status}</span> : <span className="text-[var(--color-text-faint)]">-</span>}</td>
                  <td className="px-4 py-3 hidden md:table-cell" title={badge.hint}><span className="ui-tag is-more">{badge.label}</span></td>
                  <td className="px-4 py-3 hidden lg:table-cell text-[14px] text-[var(--color-text-muted)] whitespace-nowrap">{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "-"}</td>
                  <td className="sm:px-4 sm:py-2 whitespace-nowrap">
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => void detach(r)}
                        disabled={busy === r.linkId}
                        title={r.source === "checkout" ? "Remove (it will re-link on the next checkout under this project)" : "Remove from project"}
                        aria-label={`Remove ${r.label} from the project`}
                        className="w-9 h-9 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)] transition-colors disabled:opacity-40"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
