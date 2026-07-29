"use client";

// IntakePanel — the project's controlled drop point (internal door).
// Manage tokenized submit links for contracted companies (no site access:
// they get /submit/<token>), and review the submissions that arrive:
// approve (promotes via the same finalize pipeline as any reviewed
// revision — supersede notices, ack rosters, the works) or reject with the
// reason on the record. Trusted links (auto-supersede own work) are marked.

import React, { useCallback, useEffect, useState } from "react";
import {
  Link2, Loader2, Check, X, UploadCloud, Copy, Ban, ShieldCheck, Clock,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { finalizeReviewedRevision } from "@/lib/reviewControl";
import { appConfirm } from "@/components/providers/DialogProvider";

interface IntakeLink {
  id: string; token: string; companyName: string; contactEmail: string | null;
  allowAutoSupersede: boolean; expiresAt: string | null; revokedAt: string | null;
  submissionCount: number; lastUsedAt: string | null;
}
interface PendingSub {
  docId: string; label: string; pendingVersionId: string; revLabel: string | null;
  company: string | null; submittedAt: string | null; changeLog: string | null;
}

export default function IntakePanel({ orgId, projectId, canManage, uid, userEmail }: {
  orgId: string; projectId: string; canManage: boolean; uid: string; userEmail?: string | null;
}) {
  const [links, setLinks] = useState<IntakeLink[]>([]);
  const [pending, setPending] = useState<PendingSub[]>([]);
  const [libs, setLibs] = useState<Array<{ id: string; name: string }>>([]);
  const [intakeLibraryId, setIntakeLibraryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // New-link form
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [expires, setExpires] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [libPick, setLibPick] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: lk }, { data: proj }, { data: ls }] = await Promise.all([
        supabase.from("project_intake_links")
          .select("id, token, company_name, contact_email, allow_auto_supersede, expires_at, revoked_at, submission_count, last_used_at")
          .eq("project_id", projectId).order("created_at", { ascending: false }),
        supabase.from("projects").select("intake_library_id, intake_collection_id").eq("id", projectId).maybeSingle(),
        supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name"),
      ]);
      setLinks((((lk ?? []) as Array<Record<string, unknown>>)).map((r) => ({
        id: String(r.id), token: String(r.token), companyName: String(r.company_name),
        contactEmail: (r.contact_email as string | null) ?? null,
        allowAutoSupersede: !!r.allow_auto_supersede,
        expiresAt: (r.expires_at as string | null) ?? null,
        revokedAt: (r.revoked_at as string | null) ?? null,
        submissionCount: Number(r.submission_count ?? 0),
        lastUsedAt: (r.last_used_at as string | null) ?? null,
      })));
      setLibs((((ls ?? []) as Array<{ id: string; name: string }>)));
      const libId = (proj?.intake_library_id as string | null) ?? null;
      setIntakeLibraryId(libId);
      // Pending submissions: docs in the project's intake folder awaiting review.
      const colId = (proj?.intake_collection_id as string | null) ?? null;
      if (colId) {
        const { data: docs } = await supabase
          .from("documents")
          .select("id, document_number, title, name, pending_version_id")
          .eq("collection_id", colId).not("pending_version_id", "is", null);
        const rows = ((docs ?? []) as Array<Record<string, unknown>>);
        const verIds = rows.map((d) => String(d.pending_version_id));
        const { data: vers } = verIds.length
          ? await supabase.from("document_versions")
              .select("id, revision_label, created_by_name, created_at, change_log, intake_link_id")
              .in("id", verIds)
          : { data: [] };
        const vMap = new Map((((vers ?? []) as Array<Record<string, unknown>>)).map((v) => [String(v.id), v]));
        setPending(rows
          .filter((d) => vMap.get(String(d.pending_version_id))?.intake_link_id) // intake-authored only
          .map((d) => {
            const v = vMap.get(String(d.pending_version_id));
            return {
              docId: String(d.id),
              label: String(d.document_number || d.title || d.name || "Document"),
              pendingVersionId: String(d.pending_version_id),
              revLabel: (v?.revision_label as string | null) ?? null,
              company: (v?.created_by_name as string | null) ?? null,
              submittedAt: (v?.created_at as string | null) ?? null,
              changeLog: (v?.change_log as string | null) ?? null,
            };
          }));
      } else {
        setPending([]);
      }
    } finally { setLoading(false); }
  }, [orgId, projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const createLink = async () => {
    if (!company.trim()) { setMsg("Company name is required."); return; }
    const lib = intakeLibraryId ?? libPick;
    if (!lib) { setMsg("Pick the library where intake documents will live."); return; }
    setBusy("create"); setMsg(null);
    try {
      if (!intakeLibraryId) {
        await supabase.from("projects").update({ intake_library_id: lib }).eq("id", projectId);
      }
      const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 40);
      const { error } = await supabase.from("project_intake_links").insert({
        org_id: orgId, project_id: projectId, token,
        company_name: company.trim(), contact_email: email.trim() || null,
        allow_auto_supersede: trusted,
        expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        created_by: uid,
      });
      if (error) throw new Error(error.message);
      setCompany(""); setEmail(""); setExpires(""); setTrusted(false);
      await refresh();
      setMsg("Link created — copy it below and send it to the company.");
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  };

  const revoke = async (l: IntakeLink) => {
    if (!(await appConfirm({ message: `Revoke ${l.companyName}'s submit link? They lose access immediately.`, tone: "danger" }))) return;
    setBusy(l.id);
    try {
      await supabase.from("project_intake_links").update({ revoked_at: new Date().toISOString() }).eq("id", l.id);
      await refresh();
    } finally { setBusy(null); }
  };

  const approve = async (p: PendingSub) => {
    setBusy(p.docId); setMsg(null);
    try {
      const res = await finalizeReviewedRevision({
        orgId, documentId: p.docId, actorId: uid, actorName: userEmail ?? "Reviewer",
        requireRosterComplete: false,
      });
      if (!res.published) throw new Error(res.reason || "Couldn't approve");
      setMsg(`${p.label} Rev ${p.revLabel ?? ""} approved — it is now the current revision.`);
      await refresh();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  };

  const reject = async (p: PendingSub) => {
    if (!(await appConfirm({ message: `Reject ${p.label} Rev ${p.revLabel ?? ""}? The company will see it as not accepted.`, tone: "danger" }))) return;
    setBusy(p.docId);
    try {
      await supabase.from("documents").update({ pending_version_id: null, updated_at: new Date().toISOString() }).eq("id", p.docId);
      await supabase.from("document_versions").update({ review_state: "rejected" }).eq("id", p.pendingVersionId);
      await refresh();
    } finally { setBusy(null); }
  };

  const portalUrl = (token: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/submit/${token}`;

  if (loading) return <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" /></div>;

  return (
    <div className="space-y-4">
      {msg && <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-bold text-[var(--color-text)]">{msg}</div>}

      {/* Review queue — the point of the whole system. */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-center gap-2 mb-2">
          <UploadCloud className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-base font-bold text-[var(--color-text)]">Submissions awaiting review</span>
          <span className={`text-base font-black tabular-nums ${pending.length ? "text-amber-600" : "text-[var(--color-text-faint)]"}`}>{pending.length}</span>
        </div>
        {pending.length === 0 && <div className="text-xs italic text-[var(--color-text-faint)]">Nothing waiting. Approved intake revisions become the single current version automatically.</div>}
        <ul className="space-y-2">
          {pending.map((p) => (
            <li key={p.docId} className="rounded-xl border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="text-sm font-bold text-[var(--color-text)]">{p.label}</span>
                <span className="text-xs text-[var(--color-text-muted)]">Rev {p.revLabel ?? "—"} · {p.company ?? "external"}{p.submittedAt ? ` · ${new Date(p.submittedAt).toLocaleDateString()}` : ""}</span>
                {canManage && (
                  <span className="ml-auto flex items-center gap-1.5">
                    <button onClick={() => void approve(p)} disabled={busy === p.docId} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500 text-white text-[11px] font-black hover:bg-emerald-600 disabled:opacity-50">
                      {busy === p.docId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Approve
                    </button>
                    <button onClick={() => void reject(p)} disabled={busy === p.docId} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-500/40 text-rose-700 dark:text-rose-300 text-[11px] font-black hover:bg-rose-500/10 disabled:opacity-50">
                      <X className="w-3 h-3" /> Reject
                    </button>
                  </span>
                )}
              </div>
              {p.changeLog && <div className="mt-1 text-[11px] text-[var(--color-text-muted)] italic">&ldquo;{p.changeLog}&rdquo;</div>}
            </li>
          ))}
        </ul>
      </div>

      {/* Submit links */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-center gap-2 mb-2">
          <Link2 className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-base font-bold text-[var(--color-text)]">Contractor submit links</span>
          <span className="text-xs text-[var(--color-text-muted)]">no account needed — upload-only, own documents only, everything tracked</span>
        </div>
        <ul className="space-y-1.5 mb-3">
          {links.map((l) => (
            <li key={l.id} className={`flex items-center gap-2 text-xs flex-wrap rounded-lg border px-2.5 py-1.5 ${l.revokedAt ? "border-[var(--color-border)] opacity-60" : "border-[var(--color-border-strong)]"}`}>
              <span className="font-bold text-[var(--color-text)]">{l.companyName}</span>
              {l.allowAutoSupersede && <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-violet-700 dark:text-violet-300"><ShieldCheck className="w-3 h-3" /> trusted</span>}
              <span className="text-[var(--color-text-faint)]">{l.submissionCount} submission{l.submissionCount === 1 ? "" : "s"}{l.expiresAt ? ` · expires ${new Date(l.expiresAt).toLocaleDateString()}` : ""}{l.revokedAt ? " · REVOKED" : ""}</span>
              {!l.revokedAt && (
                <span className="ml-auto flex items-center gap-1">
                  <button onClick={() => { void navigator.clipboard.writeText(portalUrl(l.token)); setMsg(`Copied ${l.companyName}'s link.`); }} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] font-bold hover:border-[var(--color-accent-ring)]"><Copy className="w-3 h-3" /> Copy link</button>
                  {canManage && <button onClick={() => void revoke(l)} disabled={busy === l.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-rose-500/40 text-rose-700 dark:text-rose-300 font-bold hover:bg-rose-500/10"><Ban className="w-3 h-3" /> Revoke</button>}
                </span>
              )}
            </li>
          ))}
          {links.length === 0 && <li className="text-xs italic text-[var(--color-text-faint)]">No links yet.</li>}
        </ul>

        {canManage && (
          <div className="rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/40 p-3 space-y-2">
            <div className="text-[10px] font-bold text-[var(--color-text-muted)]">New submit link</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company name (stamped on every submission)" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Contact email (optional)" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
              {!intakeLibraryId && (
                <select value={libPick} onChange={(e) => setLibPick(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
                  <option value="">Intake documents live in library…</option>
                  {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              )}
              <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} min={new Date().toISOString().slice(0, 10)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" title="Expiry (optional)" />
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--color-text)]">
              <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
              Trusted: their revisions of <b>their own documents</b> publish immediately (skip review)
            </label>
            <button onClick={() => void createLink()} disabled={busy === "create"} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy === "create" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} Create link
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
