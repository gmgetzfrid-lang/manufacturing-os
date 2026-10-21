"use client";

// ProjectRequestsCard — the drafting requests that belong to this project
// (drafting-flow Round G, DF-P8; GAP-114 / DEC-40). A request names its
// project BY REFERENCE (tickets.project_id, 20261256); this list is a query
// over that column, never a stored set. Each request shows its status, who
// it waits on (by role, from its status — requestHolderLabel), and its deliverable as a LIVE reference to the controlled
// document: current, or marked superseded / not current — never a copy. A
// member who cannot read the deliverable's library sees that a deliverable
// exists and cannot open it (lib/ticketProject.ts deliverableReference).
// Read as the viewer: requests they cannot read are not listed, and the
// card says nothing about them. Before 20261256 is pasted the column is not
// there (42703 / PGRST204) and the card renders nothing — today's page.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardList, Loader2, ExternalLink, Lock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { deliverableStateOf } from "@/lib/ticketHandback";
import { deliverableReference, requestHolderLabel, type DeliverableReference } from "@/lib/ticketProject";
import { ticketStatusLabel } from "@/lib/ticketStatusLabels";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { TERMINAL_TICKET_STATUSES } from "@/lib/ticketShed";

type RequestRow = {
  id: string; ticketNumber: string | null; title: string | null; status: string;
  holder: string | null; open: boolean; deliverable: DeliverableReference;
};

const MISSING_COLUMN = new Set(["42703", "PGRST204"]);
/** The newest requests the card reads (the project page is not a queue). */
export const PROJECT_REQUESTS_LIMIT = 200;

export default function ProjectRequestsCard({ orgId, projectId }: { orgId: string; projectId: string }) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error } = await supabase.from("tickets")
        .select("id, ticket_id, title, status, assigned_drafter_name, assigned_engineer_name, requester_name, metadata, created_at")
        .eq("org_id", orgId).eq("project_id", projectId).is("archived_at", null)
        .order("created_at", { ascending: false }).limit(PROJECT_REQUESTS_LIMIT);
      if (!alive) return;
      if (error) {
        if (error.code && MISSING_COLUMN.has(error.code)) { setNotMigrated(true); return; }
        setErr("The project's drafting requests could not be read — try again in a moment.");
        return;
      }
      const tickets = (data ?? []) as Array<Record<string, unknown>>;
      const states = tickets.map((t) => deliverableStateOf((t.metadata as Record<string, unknown> | null) ?? null));
      const docIds = [...new Set(states.flatMap((s) => (s?.state === "published" && typeof s.document_id === "string" ? [s.document_id] : [])))];
      // Read AS THE VIEWER: a document whose library they cannot read is not
      // returned — the card then says the deliverable exists and cannot be opened.
      const docs = new Map<string, Record<string, unknown>>();
      if (docIds.length > 0) {
        const { data: d, error: dErr } = await supabase.from("documents")
          .select("id, document_number, rev, status, library_id, current_version_id, archived_at").in("id", docIds);
        if (!alive) return;
        if (dErr) { setErr("The deliverables of the project's requests could not be read — try again in a moment."); return; }
        for (const r of (d ?? []) as Array<Record<string, unknown>>) docs.set(String(r.id), r);
      }
      setRows(tickets.map((t, i) => {
        const s = states[i];
        const docId = s?.state === "published" && typeof s.document_id === "string" ? s.document_id : null;
        const status = String(t.status ?? "");
        return {
          id: String(t.id), ticketNumber: (t.ticket_id as string | null) ?? null, title: (t.title as string | null) ?? null, status,
          // DF-P8 fix pass 3: who it waits on follows its status, named by role
          holder: requestHolderLabel(status, {
            drafter: (t.assigned_drafter_name as string | null) ?? null,
            engineer: (t.assigned_engineer_name as string | null) ?? null,
            requester: (t.requester_name as string | null) ?? null,
          }),
          open: !(TERMINAL_TICKET_STATUSES as readonly string[]).includes(status),
          deliverable: deliverableReference(s as unknown as Record<string, unknown> | null, docId ? ((docs.get(docId) as Parameters<typeof deliverableReference>[1]) ?? null) : null, NOT_CURRENT_STATUSES),
        };
      }));
    })();
    return () => { alive = false; };
  }, [orgId, projectId]);

  if (notMigrated) return null;
  const open = (rows ?? []).filter((r) => r.open).length;

  return (
    <div data-testid="project-requests" className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <ClipboardList className="w-4 h-4 text-[var(--color-accent)]" />
        <span className="text-sm font-bold text-[var(--color-text)]">Drafting requests</span>
        {rows && <span className="text-[10px] font-mono text-[var(--color-text-muted)]">{open} open · {rows.length - open} closed</span>}
      </div>
      {err && <div role="alert" className="px-4 py-2 text-[11px] font-bold text-rose-700 dark:text-rose-300 bg-rose-500/[0.07]">{err}</div>}
      {!rows && !err ? (
        <div className="px-4 py-6 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" /></div>
      ) : rows && rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          No drafting requests belong to this project yet. A request filed from a checkout under this project, an intake collision here, or one linked from its own page appears here.
        </div>
      ) : rows ? (
        <ul className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => (
            <li key={r.id} className="px-4 py-2.5 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link href={`/requests/${r.id}`} className="text-xs font-bold text-[var(--color-accent)] hover:underline">{r.ticketNumber ?? "Request"}</Link>
                  <span className="text-xs text-[var(--color-text)] truncate">{r.title}</span>
                  <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${r.open ? "bg-sky-500/10 text-sky-700 dark:text-sky-300" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>{ticketStatusLabel(r.status)}</span>
                  {r.open && r.holder && <span data-testid="request-holder" className="text-[10px] text-[var(--color-text-muted)]">{r.holder}</span>}
                </div>
                {r.deliverable.kind === "published" && (
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px]">
                    {r.deliverable.canOpen ? (
                      <>
                        <span className={`font-bold ${r.deliverable.current ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)] line-through"}`}>{r.deliverable.label}</span>
                        <span className={r.deliverable.current ? "text-emerald-700 dark:text-emerald-300" : "font-black uppercase tracking-wider text-amber-800 dark:text-amber-200 bg-amber-500/15 border border-amber-500/40 px-1.5 py-0.5 rounded"}>{r.deliverable.note}</span>
                        {r.deliverable.libraryId && (
                          <Link href={`/documents/${r.deliverable.libraryId}?doc=${r.deliverable.documentId}`} className="inline-flex items-center gap-1 font-bold text-[var(--color-accent)] hover:underline"><ExternalLink className="w-3 h-3" /> Open</Link>
                        )}
                      </>
                    ) : (
                      <span data-testid="deliverable-locked" className="inline-flex items-center gap-1 text-[var(--color-text-muted)]"><Lock className="w-3 h-3" /> {r.deliverable.label} — {r.deliverable.note}</span>
                    )}
                  </div>
                )}
                {r.deliverable.kind === "not_in_register" && (
                  <div className="mt-1 text-[10px] font-bold text-amber-700 dark:text-amber-300">Closed — its deliverable is not in the register.</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
