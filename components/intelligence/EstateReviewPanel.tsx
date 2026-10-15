"use client";

// EstateReviewPanel — the links the resolver was not sure enough to apply.
// Each row is one sentence of evidence, who proposed it, and two buttons.
// Approving an alias proposal teaches the alias; approving anything else
// makes the edge live. Dismissals are remembered.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Link2, Check, X, Loader2, RefreshCw, Factory, Briefcase, Cpu, FolderOpen, Quote } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { listPendingEdges, decideEdge, estatePost } from "@/lib/estate/client";
import { labelNodes, type NodeLabel } from "@/lib/estate/labels";
import { addFinderAlias } from "@/lib/fileFinder/stores";
import { loadCodebook } from "@/lib/codebook";
import type { EstateEdge } from "@/lib/estate/ids";

const TYPE_LABEL: Record<string, string> = {
  belongs_to_unit: "belongs to unit", in_project: "is in project", project_scope: "project covers", about_asset: "is the folder for",
  tagged_to: "is about", filed_under: "is also filed under", alias_of: "is a nickname for", related: "is related to",
};
const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  belongs_to_unit: Factory, in_project: Briefcase, project_scope: Briefcase, about_asset: Cpu, tagged_to: Cpu, filed_under: FolderOpen, alias_of: Quote, related: Link2,
};

export default function EstateReviewPanel() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canDecide = ["Admin", "DocCtrl", "Manager", "Supervisor"].includes(activeRole ?? "");
  const [rows, setRows] = useState<EstateEdge[] | null>(null);
  const [labels, setLabels] = useState<Map<string, NodeLabel>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    const list = await listPendingEdges(activeOrgId, 300);
    setRows(list);
    setLabels(await labelNodes(activeOrgId, list.flatMap((e) => [e.a, e.b])));
  }, [activeOrgId]);
  useEffect(() => { void load().catch((e) => setNote((e as Error).message)); }, [load]);

  const decide = async (e: EstateEdge, approve: boolean) => {
    if (!activeOrgId) return;
    setBusy(e.id);
    try {
      if (approve && e.type === "alias_of" && e.a.startsWith("term:")) {
        const code = e.b.replace(/^cbunit:/, "");
        const book = await loadCodebook(activeOrgId);
        const u = book.units.find((x) => x.code === code);
        await addFinderAlias({ orgId: activeOrgId, term: String(e.evidence.term ?? e.a.slice(5).toLowerCase()), means: u?.label ?? code, kind: "unit", origin: "ingest", userId: uid, userName: userEmail });
      }
      await decideEdge(e.id, approve ? "applied" : "dismissed", { userId: uid, name: userEmail });
      setRows((prev) => (prev ?? []).filter((x) => x.id !== e.id));
    } catch (err) { setNote((err as Error).message); }
    finally { setBusy(null); }
  };

  const run = async () => {
    if (!activeOrgId) return;
    setRunning(true); setNote(null);
    try {
      const r = await estatePost<{ folders: number; documents: number; applied: number; pending: number; unchanged: number; notes: string[] }>("/api/estate/resolve", { orgId: activeOrgId, all: true });
      setNote(`${r.folders} folders and ${r.documents} documents looked at — ${r.applied} links applied, ${r.pending} new here, ${r.unchanged} already decided.${r.notes.length ? " " + r.notes.join(" ") : ""}`);
      await load();
    } catch (err) { setNote((err as Error).message); }
    finally { setRunning(false); }
  };

  const L = (id: string) => labels.get(id) ?? { label: id };
  const Node = ({ id }: { id: string }) => {
    const l = L(id);
    const body = <span className="font-bold">{l.label}{l.sub ? <span className="font-normal text-[var(--color-text-muted)]"> · {l.sub}</span> : null}</span>;
    return l.href ? <Link href={l.href} className="hover:underline">{body}</Link> : body;
  };

  return (
    <section className="mb-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-black inline-flex items-center gap-2"><Link2 className="w-4 h-4 text-sky-600" /> Estate links waiting for you</div>
          <div className="text-xs text-[var(--color-text-muted)]">Folders, files, projects and equipment the resolver linked from names and ancestry. Provable ones applied themselves; these it wasn&apos;t sure about.</div>
        </div>
        {canDecide && (
          <button onClick={run} disabled={running} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-black text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-60">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} {running ? "Resolving…" : "Resolve the estate"}
          </button>
        )}
      </div>
      {note && <div className="px-4 py-2 text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)]">{note}</div>}
      {rows === null ? (
        <div className="p-6 text-xs text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-xs text-[var(--color-text-muted)] italic">Nothing waiting. Run &ldquo;Resolve the estate&rdquo; after teaching aliases or adding units to the codebook to find more.</div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {rows.map((e) => {
            const I = TYPE_ICON[e.type] ?? Link2;
            return (
              <li key={e.id} className="px-4 py-3 flex items-start gap-3">
                <I className="w-4 h-4 mt-0.5 text-[var(--color-text-muted)] shrink-0" />
                <div className="flex-1 min-w-0 text-sm">
                  <div className="flex flex-wrap items-center gap-x-1.5"><Node id={e.a} /> <span className="text-[var(--color-text-muted)]">{TYPE_LABEL[e.type] ?? e.type}</span> <Node id={e.b} /></div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{e.summary}</div>
                  <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">{e.tier} · {Math.round(e.confidence * 100)}% · {e.origin}{e.createdByName ? ` · ${e.createdByName}` : ""}</div>
                </div>
                {canDecide && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => decide(e, true)} disabled={busy === e.id} className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 px-2 py-1 text-xs font-bold hover:bg-emerald-100 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> {e.type === "alias_of" ? "Teach" : "Link"}</button>
                    <button onClick={() => decide(e, false)} disabled={busy === e.id} className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs font-bold hover:bg-[var(--color-canvas)] disabled:opacity-50"><X className="w-3.5 h-3.5" /> No</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
