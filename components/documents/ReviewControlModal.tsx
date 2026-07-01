"use client";

// ReviewControlModal — configure the pre-publish review policy on a LIBRARY or
// FOLDER (Admin/DocCtrl / delegated owner only). Sets the change-control mode,
// the primary reviewers + alternates, the alternate-activation timeout, and who
// may see an in-review draft. Per-document overrides live in the Inspector.

import React, { useEffect, useState } from "react";
import { ShieldCheck, X, Loader2, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { searchOrgUsers, type OrgUser } from "@/lib/notifications";
import { setReviewControlPolicy } from "@/lib/reviewControl";
import { ALL_ROLES, type ReviewControl, type ReviewControlMode, type Role } from "@/types/schema";

const MODES: { value: ReviewControlMode; label: string; hint: string }[] = [
  { value: "none", label: "No gate", hint: "Publish directly (drawings whose review is handled by the drafting workflow, or simple libraries)." },
  { value: "publisher_choice", label: "Publisher decides", hint: "The rev-up form asks 'route through review?' each time." },
  { value: "require", label: "Require review", hint: "Every non-minor, non-ticket rev must be signed off before it publishes." },
];

/** Compact people + roles picker used for reviewers / alternates / draft viewers. */
function PickRow({ orgId, label, people, setPeople, roles, setRoles }: {
  orgId: string; label: string;
  people: OrgUser[]; setPeople: (u: OrgUser[]) => void;
  roles: Role[]; setRoles: (r: Role[]) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<OrgUser[]>([]);
  useEffect(() => {
    const query = q.trim();
    let alive = true;
    (async () => {
      if (!query) { if (alive) setHits([]); return; }
      try { const u = await searchOrgUsers(orgId, query); if (alive) setHits(u); } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [q, orgId]);
  const inp = "text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 outline-none focus:border-[var(--color-accent)]";
  const toggleRole = (r: Role) => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r]);
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-bold text-[var(--color-text-muted)]">{label}</div>
      <div className="flex flex-wrap gap-1">
        {people.map((p) => (
          <span key={p.uid} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-text)]">{p.name || p.email}<button onClick={() => setPeople(people.filter((x) => x.uid !== p.uid))}><X className="w-3 h-3" /></button></span>
        ))}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" className={`${inp} w-full`} />
      {hits.length > 0 && (
        <div className="rounded-lg border border-[var(--color-border)] max-h-28 overflow-y-auto">
          {hits.filter((u) => !people.some((p) => p.uid === u.uid)).map((u) => (
            <button key={u.uid} onClick={() => { setPeople([...people, u]); setQ(""); setHits([]); }} className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-2)] flex items-center gap-1.5"><Plus className="w-3 h-3" /> {u.name || u.email}</button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {ALL_ROLES.map((r) => (
          <button key={r} onClick={() => toggleRole(r)} className={`px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors ${roles.includes(r) ? "bg-[var(--color-accent)] text-white border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>{r}</button>
        ))}
      </div>
    </div>
  );
}

export default function ReviewControlModal({ level, id, orgId, name, uid, userName, onClose, onSaved }: {
  level: "library" | "collection";
  id: string;
  orgId: string;
  name?: string;
  uid: string | null;
  userName?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<ReviewControl | null>(null);
  const [mode, setMode] = useState<ReviewControlMode>("require");
  const [reviewers, setReviewers] = useState<OrgUser[]>([]);
  const [reviewerRoles, setReviewerRoles] = useState<Role[]>([]);
  const [alternates, setAlternates] = useState<OrgUser[]>([]);
  const [alternateRoles, setAlternateRoles] = useState<Role[]>([]);
  const [viewers, setViewers] = useState<OrgUser[]>([]);
  const [viewerRoles, setViewerRoles] = useState<Role[]>([]);
  const [timeoutDays, setTimeoutDays] = useState(7);

  const table = level === "library" ? "libraries" : "collections";
  const scopeLabel = level === "library" ? "library" : "folder";

  const resolvePeople = async (ids?: string[]) => {
    if (!ids?.length) return [] as OrgUser[];
    const { data } = await supabase.from("org_members").select("uid, email, display_name").eq("org_id", orgId).in("uid", ids);
    return (data ?? []).map((u) => ({ uid: u.uid as string, name: (u.display_name as string) || (u.email as string) || "user", email: (u.email as string) || "", role: "" }));
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from(table).select("review_control").eq("id", id).maybeSingle();
      if (!alive) return;
      const c = (data?.review_control as ReviewControl) ?? null;
      setExisting(c);
      if (c) {
        setMode(c.mode);
        setReviewerRoles((c.reviewerRoles ?? []) as Role[]);
        setAlternateRoles((c.alternateRoles ?? []) as Role[]);
        setViewerRoles((c.draftViewerRoles ?? []) as Role[]);
        setTimeoutDays(c.timeoutDays ?? 7);
        const [rp, ap, vp] = await Promise.all([resolvePeople(c.reviewerIds), resolvePeople(c.alternateIds), resolvePeople(c.draftViewerIds)]);
        if (alive) { setReviewers(rp); setAlternates(ap); setViewers(vp); }
      }
      setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, id, orgId]);

  const save = async () => {
    setBusy(true);
    try {
      const control: ReviewControl = {
        mode,
        reviewerIds: reviewers.map((p) => p.uid), reviewerRoles,
        alternateIds: alternates.map((p) => p.uid), alternateRoles,
        draftViewerIds: viewers.map((p) => p.uid), draftViewerRoles: viewerRoles,
        timeoutDays,
      };
      await setReviewControlPolicy({ level, id, orgId, control, actorId: uid, actorName: userName });
      onSaved?.(); onClose();
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await setReviewControlPolicy({ level, id, orgId, control: null, actorId: uid, actorName: userName }); onSaved?.(); onClose(); }
    finally { setBusy(false); }
  };

  const gated = mode !== "none";
  const noReviewers = gated && reviewers.length === 0 && reviewerRoles.length === 0;

  return (
    <div className="fixed inset-0 z-[520] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-[var(--color-accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-[var(--color-text)]">Pre-publish review</div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">Change-control for this {scopeLabel}{name ? ` · ${name}` : ""}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-accent)]" /></div>
        ) : (
          <div className="p-5 space-y-3 overflow-y-auto">
            <div className="space-y-1.5">
              {MODES.map((m) => (
                <label key={m.value} className={`block rounded-lg border p-2.5 cursor-pointer ${mode === m.value ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]" : "border-[var(--color-border)]"}`}>
                  <div className="flex items-center gap-2">
                    <input type="radio" checked={mode === m.value} onChange={() => setMode(m.value)} className="accent-[var(--color-accent)]" />
                    <span className="text-sm font-bold text-[var(--color-text)]">{m.label}</span>
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 ml-6">{m.hint}</div>
                </label>
              ))}
            </div>

            {gated && (
              <>
                <div className="text-[10px] text-[var(--color-text-muted)] -mb-1">A Minor/Correction change and a rev from a drafting ticket always skip the gate.</div>
                <PickRow orgId={orgId} label="Primary reviewers (must sign off)" people={reviewers} setPeople={setReviewers} roles={reviewerRoles} setRoles={setReviewerRoles} />
                <PickRow orgId={orgId} label="Alternates (step in if a primary is slow / out)" people={alternates} setPeople={setAlternates} roles={alternateRoles} setRoles={setAlternateRoles} />
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--color-text-muted)]">Activate alternates after</span>
                  <input type="number" min={1} value={timeoutDays} onChange={(e) => setTimeoutDays(Math.max(1, parseInt(e.target.value) || 1))} className="text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 w-16 outline-none focus:border-[var(--color-accent)]" />
                  <span className="text-[11px] text-[var(--color-text-muted)]">days</span>
                </div>
                <PickRow orgId={orgId} label="Extra draft viewers (besides reviewers + owner + DocCtrl)" people={viewers} setPeople={setViewers} roles={viewerRoles} setRoles={setViewerRoles} />
                {noReviewers && <div className="text-[11px] text-amber-600">Add at least one primary reviewer, or a rev can never publish.</div>}
              </>
            )}

            <div className="flex justify-between gap-2 pt-2 border-t border-[var(--color-border)]">
              <button onClick={() => void remove()} disabled={busy || !existing} className="px-3 py-2 rounded-lg text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-40">Remove</button>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text-muted)]">Cancel</button>
                <button onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-xs font-bold disabled:opacity-50">{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
