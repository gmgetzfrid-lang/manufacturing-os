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
// When "Create project" made the project but the link did not land (a
// conflict, a 503), the project is remembered and the Create button gives
// way to "Link to <project>" — the same link, retried — so a second click
// never makes a second project naming this request.
// Across page loads too (DEC-90 fix pass at the DF-P8 merge): before Create
// is offered — on mount, and again inside "Create project" right before the
// project is made — the projects the viewer can see that name this request
// (projects.linked_ticket_id) and are not closed are read, newest first. If
// one exists, "Link to <its name>" (converted: true) is offered in place of
// Create. If that read fails, Create stays (today's behaviour) and the page
// says it could not check. What this cannot see: a project naming the
// request that the viewer cannot read, or one that is closed — Create is
// still offered then.
// A link, unlink or create that lands is held locally (DF-P8 fix pass 3):
// the controls follow it at once, without waiting for the page's realtime
// refresh — Create and Link give way to Unlink the moment the link lands, so
// a second click cannot make a second project even while realtime is down.
// The page's own value takes over again as soon as it changes.
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
  /** A project "Create project" made whose link has not landed yet — or,
   *  `existing`, one an earlier page load made (it names this request). */
  const [created, setCreated] = useState<{ id: string; name: string; existing?: true } | null>(null);
  /** Whether the read for a project already naming this request failed. */
  const [originUnchecked, setOriginUnchecked] = useState(false);
  /** What this component's own successful change left the request linked
   *  to, and the page's value it was made against: it wins until the page's
   *  value moves (the realtime refresh carried the change, or a newer one). */
  const [landed, setLanded] = useState<{ basis: string | null; value: string | null } | null>(null);
  const currentProjectId = landed && landed.basis === linkedProjectId ? landed.value : linkedProjectId;

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

  // PROJ-13 across page loads: a project an earlier load created from this
  // request (whose link did not land) is offered as "Link to <project>",
  // never Create again.
  const hasProject = !!currentProjectId;
  useEffect(() => {
    if (!canAct || hasProject) return;
    let alive = true;
    void findProjectNamingRequest(ticketId, orgId).then((found) => {
      if (!alive) return;
      if (found === "failed") { setOriginUnchecked(true); return; }
      setOriginUnchecked(false);
      if (found) setCreated((c) => c ?? { ...found, existing: true });
    });
    return () => { alive = false; };
  }, [canAct, hasProject, ticketId, orgId]);

  if (!canAct) return null;

  const link = async (projectId: string | null) => {
    setBusy(true); setMsg(null);
    try {
      const res = await postProjectLink({ ticketId, projectId });
      if (!res.ok) { setMsg({ tone: "error", text: res.error }); return; }
      setLanded({ basis: linkedProjectId, value: projectId });
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
      // Asked again right before the project is made: another tab or an
      // earlier load may have made one since this page was opened.
      const found = await findProjectNamingRequest(ticketId, orgId);
      if (found && found !== "failed") {
        setCreated({ ...found, existing: true });
        setOriginUnchecked(false);
        setMsg({ tone: "warn", text: `A project was already created from this request: ${found.name} — use "Link to ${found.name}" (no second project was made).`, href: `/projects/${found.id}` });
        return;
      }
      const { convertTicketToProject } = await import("@/lib/projects");
      const r = await convertTicketToProject({ ticketId, orgId, actorUserId, actorEmail: actorEmail ?? undefined, actorRole: actorRole ?? undefined });
      const href = r.project.id ? `/projects/${r.project.id}` : undefined;
      if (r.linked && r.project.id) setLanded({ basis: linkedProjectId, value: r.project.id });
      if (!r.linked) {
        if (r.project.id) setCreated({ id: r.project.id, name: (r.project.name ?? "").trim() || "the new project" });
        setMsg({ tone: "warn", text: `The project was created, but this request could not be linked to it: ${r.linkError ?? "unknown error"} — use "Link to ${(r.project.name ?? "").trim() || "the new project"}" to retry (do not create it again).${r.linkWarning ? ` ${r.linkWarning}` : ""}`, href });
      } else setMsg(r.linkWarning ? { tone: "warn", text: r.linkWarning, href } : { tone: "ok", text: "Project created and linked.", href });
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error)?.message || "The project could not be created." });
    } finally { setBusy(false); }
  };

  /** Retry the link to the project "Create project" already made. */
  const linkCreated = async () => {
    if (!created) return;
    setBusy(true); setMsg(null);
    try {
      const res = await postProjectLink({ ticketId, projectId: created.id, converted: true });
      const href = `/projects/${created.id}`;
      if (!res.ok) { setMsg({ tone: "error", text: `${res.error} — the project exists; retry the link (do not create it again).`, href }); return; }
      setLanded({ basis: linkedProjectId, value: created.id });
      const existing = !!created.existing;
      setCreated(null);
      setMsg(res.warning ? { tone: "warn", text: res.warning, href } : { tone: "ok", text: existing ? "Linked to the project created from this request." : "Project created and linked.", href });
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="ticket-project-actions" className="mt-2 flex flex-wrap items-center gap-2">
      {currentProjectId ? (
        <button type="button" onClick={() => void unlink()} disabled={busy}
          className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-rose-600 border border-[var(--color-border)] rounded-md px-2 py-1 disabled:opacity-60">
          Unlink from project
        </button>
      ) : created && !created.existing ? (
        <button type="button" onClick={() => void linkCreated()} disabled={busy}
          className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-700 border border-blue-200 bg-blue-50 rounded-md px-2 py-1 disabled:opacity-60">
          <FolderKanban className="w-3 h-3" /> Link to {created.name}
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
          {created ? (
            // A project an earlier page load created from this request: its
            // link, retried — never a second project (PROJ-13).
            <button type="button" onClick={() => void linkCreated()} disabled={busy}
              className="text-[10px] font-bold text-[var(--color-text-muted)] border border-[var(--color-border)] rounded-md px-2 py-1 disabled:opacity-60">
              Link to {created.name}
            </button>
          ) : (
            <button type="button" onClick={() => void createProject()} disabled={busy}
              className="text-[10px] font-bold text-[var(--color-text-muted)] border border-[var(--color-border)] rounded-md px-2 py-1 disabled:opacity-60">
              Create project from this request
            </button>
          )}
          {originUnchecked && !msg && (
            <span role="status" className="text-[10px] font-bold text-amber-700">
              Could not check whether a project was already created from this request — check the Projects list before creating one.
            </span>
          )}
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

/** PROJ-13 (DEC-90 fix pass at the DF-P8 merge): the newest project the
 *  viewer can see (read through their own client, so RLS decides) that names
 *  this request as its origin and is not closed — or "failed" when the read
 *  failed, so the caller keeps today's behaviour and says it could not check. */
async function findProjectNamingRequest(ticketId: string, orgId: string): Promise<{ id: string; name: string } | null | "failed"> {
  try {
    const { data, error } = await supabase.from("projects").select("id, name, status, created_at")
      .eq("org_id", orgId).eq("linked_ticket_id", ticketId)
      .order("created_at", { ascending: false }).limit(20);
    if (error) return "failed";
    const open = ((data ?? []) as Array<{ id: string; name: string | null; status: string | null }>)
      .find((p) => typeof p.id === "string" && p.id && !PROJECT_LINK_CLOSED.has(String(p.status ?? "")));
    return open ? { id: open.id, name: (open.name ?? "").trim() || "the project created from this request" } : null;
  } catch {
    return "failed";
  }
}
