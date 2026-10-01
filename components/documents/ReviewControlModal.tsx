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
import { setDocClass as saveDocClass, type DocClass } from "@/lib/docClass";
import { appAlert } from "@/components/providers/DialogProvider";
import { listTeams, type Team } from "@/lib/teams";
import { ALL_ROLES, type ReviewControl, type ReviewControlMode, type Role } from "@/types/schema";

const MODES: { value: ReviewControlMode; label: string; hint: string }[] = [
  { value: "none", label: "No gate", hint: "Publish directly (drawings whose review is handled by the drafting workflow, or simple libraries)." },
  { value: "publisher_choice", label: "Publisher decides", hint: "The rev-up form asks 'route through review?' each time." },
  { value: "require", label: "Require review", hint: "Every non-minor, non-ticket rev must be signed off before it publishes." },
];

/** Compact people + roles + departments picker used for reviewers / alternates /
 *  draft viewers. */
function PickRow({ orgId, label, people, setPeople, roles, setRoles, allTeams, teamIds, setTeamIds }: {
  orgId: string; label: string;
  people: OrgUser[]; setPeople: (u: OrgUser[]) => void;
  roles: Role[]; setRoles: (r: Role[]) => void;
  allTeams?: Team[]; teamIds?: string[]; setTeamIds?: (t: string[]) => void;
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
      {allTeams && teamIds && setTeamIds && allTeams.length > 0 && (
        <>
          <div className="text-[10px] font-bold text-[var(--color-text-muted)]">Departments</div>
          <div className="flex flex-wrap gap-1">
            {allTeams.map((t) => (
              <button key={t.id} onClick={() => setTeamIds(teamIds.includes(t.id) ? teamIds.filter((x) => x !== t.id) : [...teamIds, t.id])}
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors ${teamIds.includes(t.id) ? "bg-[var(--color-accent)] text-white border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>{t.name}</button>
            ))}
          </div>
        </>
      )}
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
  const [reviewerTeams, setReviewerTeams] = useState<string[]>([]);
  const [alternates, setAlternates] = useState<OrgUser[]>([]);
  const [alternateRoles, setAlternateRoles] = useState<Role[]>([]);
  const [alternateTeams, setAlternateTeams] = useState<string[]>([]);
  const [viewers, setViewers] = useState<OrgUser[]>([]);
  const [viewerRoles, setViewerRoles] = useState<Role[]>([]);
  const [viewerTeams, setViewerTeams] = useState<string[]>([]);
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [timeoutDays, setTimeoutDays] = useState(7);
  const [requireIndependent, setRequireIndependent] = useState(true);
  // GAP-4: the effective owner must sign every revision submitted from now on.
  const [ownerMustApprove, setOwnerMustApprove] = useState(false);
  // RG-4: which slot each NAMED alternate stands in for (alternate uid → slot
  // group key). Role / department alternates are paired by construction.
  const [alternateBacks, setAlternateBacks] = useState<Record<string, string>>({});

  // Document class declaration (20261012) — 'drawing' makes MOC mandatory on
  // non-minor publishes and routes check-in changes through drafting;
  // 'procedure' hands release to the effective owner / publishers. "inherit"
  // clears this level so the parent's declaration applies.
  const [docClass, setDocClassState] = useState<DocClass | "inherit">("inherit");
  const [loadedDocClass, setLoadedDocClass] = useState<DocClass | "inherit">("inherit");

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
      // select("*") — doc_class may predate the 20261012 migration; naming it
      // in the projection would fail the whole modal load.
      const [{ data }, orgTeams] = await Promise.all([
        supabase.from(table).select("*").eq("id", id).maybeSingle(),
        listTeams(orgId).catch(() => [] as Team[]),
      ]);
      if (!alive) return;
      setAllTeams(orgTeams);
      const declared = ((data as Record<string, unknown> | null)?.doc_class as string | null) ?? null;
      const dc: DocClass | "inherit" = declared === "drawing" || declared === "procedure" ? declared : "inherit";
      setDocClassState(dc);
      setLoadedDocClass(dc);
      const c = (data?.review_control as ReviewControl) ?? null;
      setExisting(c);
      if (c) {
        setMode(c.mode);
        setReviewerRoles((c.reviewerRoles ?? []) as Role[]);
        setAlternateRoles((c.alternateRoles ?? []) as Role[]);
        setViewerRoles((c.draftViewerRoles ?? []) as Role[]);
        setReviewerTeams(c.reviewerTeamIds ?? []);
        setAlternateTeams(c.alternateTeamIds ?? []);
        setViewerTeams(c.draftViewerTeamIds ?? []);
        setTimeoutDays(c.timeoutDays ?? 7);
        setRequireIndependent(c.requireIndependentReviewer !== false);
        setOwnerMustApprove(c.ownerMustApprove === true);
        setAlternateBacks(c.alternateBacks ?? {});
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
      // Pairings survive only for alternates still named AND slots still configured.
      const validKeys = new Set(slotOptions.map((o) => o.key));
      const backs: Record<string, string> = {};
      for (const a of alternates) {
        const k = alternateBacks[a.uid];
        if (k && validKeys.has(k)) backs[a.uid] = k;
      }
      const control: ReviewControl = {
        mode,
        reviewerIds: reviewers.map((p) => p.uid), reviewerRoles, reviewerTeamIds: reviewerTeams,
        alternateIds: alternates.map((p) => p.uid), alternateRoles, alternateTeamIds: alternateTeams,
        alternateBacks: backs,
        draftViewerIds: viewers.map((p) => p.uid), draftViewerRoles: viewerRoles, draftViewerTeamIds: viewerTeams,
        timeoutDays,
        ...(level === "library" ? { requireIndependentReviewer: requireIndependent } : {}),
        ...(ownerMustApprove ? { ownerMustApprove: true } : {}),
      };
      await setReviewControlPolicy({ level, id, orgId, control, actorId: uid, actorName: userName });
      // Doc-class declaration rides the same Save — written only when it
      // actually changed, and a pre-migration failure never eats the policy.
      if (docClass !== loadedDocClass) {
        try {
          await saveDocClass({ level, id, docClass: docClass === "inherit" ? null : docClass });
        } catch (e) {
          void appAlert({ title: "Review policy saved — document class was not", message: (e as Error).message });
        }
      }
      onSaved?.(); onClose();
    } catch (e) {
      // OWN-13: a refused policy write throws — surface it (a bare finally
      // left it an unhandled rejection and the modal silently stayed open).
      await appAlert({ message: (e as Error).message, tone: "danger" });
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await setReviewControlPolicy({ level, id, orgId, control: null, actorId: uid, actorName: userName }); onSaved?.(); onClose(); }
    catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
    finally { setBusy(false); }
  };

  const gated = mode !== "none";
  const noReviewers = gated && !ownerMustApprove && reviewers.length === 0 && reviewerRoles.length === 0 && reviewerTeams.length === 0;
  // The slots a named alternate can stand in for: each named primary, each
  // primary role, each primary department (the keys lib/reviewControl.ts
  // stamps on roster rows as slot_group).
  const slotOptions: Array<{ key: string; label: string }> = [
    ...reviewers.map((p) => ({ key: `person:${p.uid}`, label: p.name || p.email })),
    ...reviewerRoles.map((r) => ({ key: `role:${r}`, label: `everyone holding ${r}` })),
    ...reviewerTeams.map((t) => ({ key: `team:${t}`, label: `the ${allTeams.find((x) => x.id === t)?.name ?? "department"} department` })),
  ];
  const unpairedAlternates = alternates.filter((a) => !alternateBacks[a.uid] || !slotOptions.some((o) => o.key === alternateBacks[a.uid]));

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
            {/* DOCUMENT CLASS — the declaration that drives change-control
                routing everywhere: drawings demand MOC on non-minor publishes
                and send check-in changes through drafting; procedures release
                through the owner/publishers. Inherit defers to the parent. */}
            <div>
              <div className="text-[11px] font-bold text-[var(--color-text-muted)] mb-1">Document class of this {scopeLabel}</div>
              <div className="flex bg-[var(--color-surface-2)] p-1 rounded-lg">
                {([
                  { v: "inherit", label: level === "library" ? "Unclassified" : "Inherit" },
                  { v: "drawing", label: "Drawings / CAD" },
                  { v: "procedure", label: "Procedures / text" },
                ] as const).map((o) => (
                  <button key={o.v} type="button" onClick={() => setDocClassState(o.v)}
                    className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all ${docClass === o.v ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-[var(--color-text-muted)] mt-1">
                {docClass === "drawing"
                  ? "PSM applies: a non-minor revision requires its MOC number, and check-in routes redlines to drafting."
                  : docClass === "procedure"
                    ? "The effective owner (or granted publishers) releases revisions directly — through the review gate below if one is set."
                    : "No class-specific rules. Declare a class so the right change process applies automatically."}
              </div>
            </div>

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
                <div className="text-[10px] text-[var(--color-text-muted)] -mb-1">A Minor/Correction change skips the gate (and is recorded as skipping it). A rev raised from a drafting ticket never skips it (DEC-23).</div>
                <PickRow orgId={orgId} label="Primary reviewers (every resolved primary is a slot that must be signed)" people={reviewers} setPeople={setReviewers} roles={reviewerRoles} setRoles={setReviewerRoles} allTeams={allTeams} teamIds={reviewerTeams} setTeamIds={setReviewerTeams} />
                <label className="flex items-start gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer select-none" title="GAP-4: ownership means being the approver of revision and supersession.">
                  <input type="checkbox" checked={ownerMustApprove} onChange={(e) => setOwnerMustApprove(e.target.checked)} className="mt-0.5" />
                  <span><span className="font-bold text-[var(--color-text)]">The owner must approve.</span> Every revision submitted from now on also needs the document&apos;s effective owner to sign it themselves — a slot of their own that no alternate can fill. Reviews already in progress keep the roster they opened with.</span>
                </label>
                {(level !== "library" || requireIndependent) && (
                  <div className="text-[10px] text-[var(--color-text-muted)]">A reviewer who authors a revision is skipped on that revision&apos;s roster and cannot sign it — a reviewer never signs their own work (DEC-21).</div>
                )}
                <PickRow orgId={orgId} label="Alternates (step in if a primary is slow / out)" people={alternates} setPeople={setAlternates} roles={alternateRoles} setRoles={setAlternateRoles} allTeams={allTeams} teamIds={alternateTeams} setTeamIds={setAlternateTeams} />
                <div className="text-[10px] text-[var(--color-text-muted)]">An alternate stands in for ONE slot: a role&apos;s alternates back that role&apos;s primaries, a department&apos;s back that department&apos;s, and a named alternate backs the primary you pair them with below. An unpaired alternate can sign but satisfies nothing.</div>
                {alternates.length > 0 && (
                  <div className="space-y-1">
                    {alternates.map((a) => (
                      <div key={a.uid} className="flex items-center gap-2 text-[11px]">
                        <span className="min-w-0 truncate text-[var(--color-text)]">{a.name || a.email}</span>
                        <span className="text-[var(--color-text-muted)] shrink-0">stands in for</span>
                        <select
                          value={alternateBacks[a.uid] && slotOptions.some((o) => o.key === alternateBacks[a.uid]) ? alternateBacks[a.uid] : ""}
                          onChange={(e) => setAlternateBacks((m) => ({ ...m, [a.uid]: e.target.value }))}
                          className="text-[11px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 outline-none focus:border-[var(--color-accent)] min-w-0"
                        >
                          <option value="">— not paired —</option>
                          {slotOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                        </select>
                      </div>
                    ))}
                    {unpairedAlternates.length > 0 && <div className="text-[11px] text-amber-600">{unpairedAlternates.map((a) => a.name || a.email).join(", ")}: not paired with a primary slot — their signature will not count toward completion.</div>}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--color-text-muted)]">Activate alternates after</span>
                  <input type="number" min={1} value={timeoutDays} onChange={(e) => setTimeoutDays(Math.max(1, parseInt(e.target.value) || 1))} className="text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 w-16 outline-none focus:border-[var(--color-accent)]" />
                  {level === "library" && (
                    <label className="ml-4 inline-flex items-center gap-2 text-xs text-[var(--color-text-muted)] cursor-pointer select-none" title="DEC-21: when the person publishing is themselves a reviewer, at least one signed primary reviewer must be someone else. On by default for any library with a required-review roster.">
                      <input type="checkbox" checked={requireIndependent} onChange={(e) => setRequireIndependent(e.target.checked)} />
                      Require an independent reviewer (publisher can&apos;t be the only signer)
                    </label>
                  )}
                  <span className="text-[11px] text-[var(--color-text-muted)]">days</span>
                </div>
                <PickRow orgId={orgId} label="Extra draft viewers (besides reviewers + owner + DocCtrl)" people={viewers} setPeople={setViewers} roles={viewerRoles} setRoles={setViewerRoles} allTeams={allTeams} teamIds={viewerTeams} setTeamIds={setViewerTeams} />
                {noReviewers && <div className="text-[11px] text-amber-600">Add at least one primary reviewer (person, role, or department), or a rev can never publish.</div>}
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
