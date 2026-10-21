"use client";

// TicketProjectActions — the request page's project controls (drafting-flow
// Round G, DF-P8; GAP-114 / DEC-40 / PROJ-13). Offered to the request's
// requester and to a member who manages requests (DEC-90 ruling (3)):
//   * Link to a project — one the viewer can see in this workspace, not
//     closed. One reference (tickets.project_id) and one history line,
//     written by /api/tickets/project-link as the service role.
//   * Create project from this request — the project inherits the request's
//     title and description and names it (projects.linked_ticket_id, the
//     project header's "Linked ticket" chip); the request is then linked to
//     it through the same route (lib/projects.ts convertTicketToProject).
//   * Unlink — the reference is removed; the request and its documents are
//     untouched.
// Nothing here copies a file. A request with no project and a viewer who may
// not change it render nothing new.

import React, { useEffect, useState } from "react";
import { FolderKanban, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { postProjectLink } from "@/lib/ticketProjectClient";
import { PROJECT_LINK_CLOSED } from "@/lib/ticketProject";
import { appConfirm } from "@/components/providers/DialogProvider";

export default function TicketProjectActions({ ticketId, orgId, linkedProjectId, canAct, actorUserId, actorEmail, actorRole }: {
  ticketId: string;
  orgId: string;
  /** The project the request names now (null: none). */
  linkedProjectId: string | null;
  /** The requester, or a member who manages requests. */
  canAct: boolean;
  actorUserId: string;
  actorEmail?: string | null;
  actorRole?: string | null;
}) {
  const [choosing, setChoosing] = useState(false);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }> | null>(null);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "error"; text: string; href?: string } | null>(null);

  useEffect(() => {
    if (!choosing || projects) return;
    let alive = true;
    void supabase.from("projects").select("id, name, status").eq("org_id", orgId).order("name").limit(500)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { setMsg({ tone: "error", text: "The projects could not be read — try again in a moment." }); setProjects([]); return; }
        setProjects(((data ?? []) as Array<{ id: string; name: string | null; status: string | null }>)
          .filter((p) => !PROJECT_LINK_CLOSED.has(String(p.status ?? "")))
          .map((p) => ({ id: p.id, name: (p.name ?? "").trim() || "Untitled project" })));
      });
    return () => { alive = false; };
  }, [choosing, projects, orgId]);

  if (!canAct) return null;

  const link = async (projectId: string | null) => {
    setBusy(true); setMsg(null);
    try {
      const res = await postProjectLink({ ticketId, projectId });
      if (!res.ok) { setMsg({ tone: "error", text: res.error }); return; }
      setChoosing(false); setPicked("");
      setMsg(res.warning ? { tone: "warn", text: res.warning } : { tone: "ok", text: projectId ? "Linked to the project." : "Unlinked from the project." });
    } finally { setBusy(false); }
  };

  const unlink = async () => {
    const ok = await appConfirm({
      title: "Unlink this request from its project?",
      message: "The request stops appearing on the project. The request, its files and its documents are not changed.",
      tone: "danger", confirmLabel: "Unlink",
    });
    if (ok) await link(null);
  };

  const createProject = async () => {
    const ok = await appConfirm({
      title: "Create a project from this request?",
      message: "A new project is created with this request's title and description, and the request is linked to it. You become the project's owner.",
      confirmLabel: "Create project",
    });
    if (!ok) return;
    setBusy(true); setMsg(null);
    try {
      const { convertTicketToProject } = await import("@/lib/projects");
      const r = await convertTicketToProject({ ticketId, orgId, actorUserId, actorEmail: actorEmail ?? undefined, actorRole: actorRole ?? undefined });
      const href = r.project.id ? `/projects/${r.project.id}` : undefined;
      if (!r.linked) setMsg({ tone: "warn", text: `The project was created, but this request could not be linked to it: ${r.linkError ?? "unknown error"} — link it from here (do not create it again).`, href });
      else setMsg(r.linkWarning ? { tone: "warn", text: r.linkWarning, href } : { tone: "ok", text: "Project created and linked.", href });
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error)?.message || "The project could not be created." });
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="ticket-project-actions" className="mt-2 flex flex-wrap items-center gap-2">
      {linkedProjectId ? (
        <button type="button" onClick={() => void unlink()} disabled={busy}
          className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-rose-600 border border-[var(--color-border)] rounded-md px-2 py-1 disabled:opacity-60">
          Unlink from project
        </button>
      ) : choosing ? (
        <>
          {projects === null ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (
            <select aria-label="Project" value={picked} onChange={(e) => setPicked(e.target.value)}
              className="h-7 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
              <option value="">Choose a project…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <button type="button" onClick={() => void link(picked)} disabled={busy || !picked}
            className="text-[10px] font-bold text-white bg-[var(--color-accent)] rounded-md px-2 py-1 disabled:opacity-60">Link</button>
          <button type="button" onClick={() => { setChoosing(false); setPicked(""); }} disabled={busy}
            className="text-[10px] font-bold text-[var(--color-text-muted)] px-2 py-1">Cancel</button>
        </>
      ) : (
        <>
          <button type="button" onClick={() => setChoosing(true)} disabled={busy}
            className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-700 border border-blue-200 bg-blue-50 rounded-md px-2 py-1 disabled:opacity-60">
            <FolderKanban className="w-3 h-3" /> Link to a project
          </button>
          <button type="button" onClick={() => void createProject()} disabled={busy}
            className="text-[10px] font-bold text-[var(--color-text-muted)] border border-[var(--color-border)] rounded-md px-2 py-1 disabled:opacity-60">
            Create project from this request
          </button>
        </>
      )}
      {msg && (
        <span role={msg.tone === "error" ? "alert" : "status"}
          className={`text-[10px] font-bold ${msg.tone === "error" ? "text-rose-700" : msg.tone === "warn" ? "text-amber-700" : "text-emerald-700"}`}>
          {msg.text}{msg.href && <> <a href={msg.href} className="underline">Open the project</a></>}
        </span>
      )}
    </div>
  );
}
