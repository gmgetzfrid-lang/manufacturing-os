"use client";

// AckSection — the read-&-understood panel in the document Inspector. Anyone
// assigned sees a "Read & acknowledge" button (touchpad signature); the owner /
// controllers (canManage) see the full roster, can nudge or waive, set the
// requirement on this doc / its folder / the library, and print the audit report.

import React, { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, Loader2, Pencil, X, Plus, BellRing, FileDown, CheckCircle2, Clock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { searchOrgUsers, type OrgUser } from "@/lib/notifications";
import SignatureCeremony from "@/components/signatures/SignatureCeremony";
import AckPill from "@/components/documents/AckPill";
import {
  resolveEffectiveAckPolicy, listRoster, recordAcknowledgment, waiveAcknowledgment,
  nudgeAcknowledgment, setAckPolicy, openAckReport,
  type AckRosterRow, type AckSummary,
} from "@/lib/acknowledgments";
import { ALL_ROLES, type AckPolicy, type DocumentRecord, type Role } from "@/types/schema";

type Level = "document" | "collection" | "library";

function summarize(rows: AckRosterRow[]): AckSummary {
  let done = 0, pending = 0, waived = 0; let oldest: string | null = null;
  for (const r of rows) {
    if (r.status === "acknowledged") done++;
    else if (r.status === "waived") waived++;
    else if (r.status === "pending") { pending++; if (!oldest || r.assignedAt < oldest) oldest = r.assignedAt; }
  }
  return { required: done + pending, done, pending, waived, hardGate: false, oldestPendingAt: oldest };
}

export default function AckSection({ doc, orgId, canManage }: {
  doc: DocumentRecord;
  orgId: string;
  canManage: boolean;
}) {
  const { uid, userEmail, activeRole } = useRole();
  const [docPol, setDocPol] = useState<AckPolicy | null>(null);
  const [folderPol, setFolderPol] = useState<AckPolicy | null>(null);
  const [libPol, setLibPol] = useState<AckPolicy | null>(null);
  const [roster, setRoster] = useState<AckRosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [signing, setSigning] = useState(false);

  const load = useCallback(async () => {
    if (!doc.id) return;
    setLoading(true);
    try {
      const [{ data: d }, { data: l }, rosterRows] = await Promise.all([
        supabase.from("documents").select("ack_policy, collection_id").eq("id", doc.id).maybeSingle(),
        supabase.from("libraries").select("ack_policy").eq("id", doc.libraryId).maybeSingle(),
        listRoster(doc.id, doc.currentVersionId ?? null),
      ]);
      setDocPol((d?.ack_policy as AckPolicy) ?? null);
      setLibPol((l?.ack_policy as AckPolicy) ?? null);
      const colId = (d?.collection_id as string | null) ?? doc.collectionId ?? null;
      if (colId) {
        const { data: c } = await supabase.from("collections").select("ack_policy").eq("id", colId).maybeSingle();
        setFolderPol((c?.ack_policy as AckPolicy) ?? null);
      } else setFolderPol(null);
      setRoster(rosterRows);
    } finally { setLoading(false); }
  }, [doc.id, doc.libraryId, doc.collectionId, doc.currentVersionId]);

  useEffect(() => { void load(); }, [load]);

  const eff = resolveEffectiveAckPolicy(docPol, folderPol, libPol);
  const summary = summarize(roster);
  if (summary.hardGate === false && eff?.hardGate) summary.hardGate = true;
  const myPending = roster.find((r) => r.assigneeUserId === uid && r.status === "pending");
  const signerName = (userEmail?.split("@")[0] ?? "").trim() || "user";
  const label = doc.documentNumber || doc.title || doc.name || "this document";
  const rev = myPending?.revisionLabel || doc.rev || "";

  // ── Sign (any assignee) ──
  const doSign = async (_intent: unknown, statement: string, signatureImage?: string | null) => {
    if (!uid || !doc.id || !myPending) return;
    setBusy(true);
    try {
      await recordAcknowledgment({
        orgId, documentId: doc.id, documentVersionId: doc.currentVersionId ?? null,
        revisionLabel: myPending.revisionLabel, rosterId: myPending.id,
        signerUserId: uid, signerName, signerRole: activeRole ?? null, signerEmail: userEmail ?? null,
        statement, signatureImage: signatureImage ?? null,
      });
      setSigning(false);
      await load();
    } finally { setBusy(false); }
  };

  // ── Nudge / waive (canManage) ──
  const nudge = async (rosterId: string) => { setBusy(true); try { await nudgeAcknowledgment({ orgId, rosterId }); } finally { setBusy(false); } };
  const waive = async (rosterId: string) => {
    const reason = window.prompt("Reason for waiving this acknowledgment (e.g. left the role, on leave):", "");
    if (reason == null) return;
    setBusy(true);
    try { await waiveAcknowledgment({ orgId, rosterId, documentId: doc.id!, reason: reason.trim() || "waived", actorId: uid ?? "", actorName: userEmail }); await load(); }
    finally { setBusy(false); }
  };

  // ── Policy editor (canManage) ──
  const [scope, setScope] = useState<Level>("document");
  const [enabled, setEnabled] = useState(true);
  const [hardGate, setHardGate] = useState(false);
  const [people, setPeople] = useState<OrgUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [userQuery, setUserQuery] = useState("");
  const [userHits, setUserHits] = useState<OrgUser[]>([]);

  const prefillFromScope = useCallback(async (lv: Level) => {
    const src = lv === "document" ? docPol : lv === "collection" ? folderPol : libPol;
    setEnabled(src?.enabled ?? true);
    setHardGate(!!src?.hardGate);
    setRoles((src?.assigneeRoles ?? []) as Role[]);
    if (src?.assigneeIds?.length) {
      const { data } = await supabase.from("org_members").select("uid, email, display_name").eq("org_id", orgId).in("uid", src.assigneeIds);
      setPeople((data ?? []).map((u) => ({ uid: u.uid as string, name: (u.display_name as string) || (u.email as string) || "user", email: (u.email as string) || "", role: "" })));
    } else setPeople([]);
  }, [docPol, folderPol, libPol, orgId]);

  const beginEdit = async () => { setScope("document"); await prefillFromScope("document"); setMode("edit"); };
  const changeScope = async (lv: Level) => { setScope(lv); await prefillFromScope(lv); };

  useEffect(() => {
    if (mode !== "edit" || !userQuery.trim()) { setUserHits([]); return; }
    let alive = true;
    searchOrgUsers(orgId, userQuery.trim()).then((u) => { if (alive) setUserHits(u); }).catch(() => {});
    return () => { alive = false; };
  }, [mode, userQuery, orgId]);

  const targetId = scope === "document" ? doc.id : scope === "collection" ? doc.collectionId : doc.libraryId;
  const saveEdit = async () => {
    if (!targetId) return;
    setBusy(true);
    try {
      const policy: AckPolicy = { enabled, assigneeIds: people.map((p) => p.uid), assigneeRoles: roles, hardGate };
      await setAckPolicy({ level: scope, id: targetId, orgId, policy, actorId: uid, actorName: userEmail });
      setMode("view"); await load();
    } finally { setBusy(false); }
  };
  const clearPolicy = async () => {
    if (!targetId) return;
    setBusy(true);
    try { await setAckPolicy({ level: scope, id: targetId, orgId, policy: null, actorId: uid, actorName: userEmail }); setMode("view"); await load(); }
    finally { setBusy(false); }
  };
  const toggleRole = (r: Role) => setRoles((prev) => prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]);

  const report = () => openAckReport(
    { label, title: doc.title, revisionLabel: doc.rev, generatedAt: new Date().toISOString() },
    roster,
  );

  const inp = "text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 outline-none focus:border-[var(--color-accent)]";
  const src: Level | null = docPol ? "document" : folderPol ? "collection" : libPol ? "library" : null;

  const statusChip = (r: AckRosterRow) => {
    if (r.status === "acknowledged") return <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700"><CheckCircle2 className="w-3 h-3" /> {r.acknowledgedAt?.slice(0, 10)}</span>;
    if (r.status === "waived") return <span className="text-[10px] font-bold text-[var(--color-text-muted)]">Waived</span>;
    return <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-600"><Clock className="w-3 h-3" /> Outstanding</span>;
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <ClipboardCheck className="w-4 h-4 text-[var(--color-text-muted)]" />
        <span className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">Read &amp; understood</span>
        <div className="ml-auto"><AckPill summary={summary} /></div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
      ) : (
        <>
          {/* Assignee's own sign action */}
          {myPending && (
            <button onClick={() => setSigning(true)} className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-accent)] text-white text-xs font-black shadow hover:opacity-90">
              <Pencil className="w-3.5 h-3.5" /> Read &amp; acknowledge{rev ? ` Rev ${rev}` : ""}
            </button>
          )}

          {/* Effective requirement */}
          <div className="text-[11px] text-[var(--color-text)]">
            {eff
              ? <>Acknowledgment required · <span className="text-[var(--color-text-muted)]">from {src === "document" ? "this document" : src === "collection" ? "this folder" : "the library"}{eff.hardGate ? " · hard-gated" : ""}</span></>
              : <span className="text-[var(--color-text-muted)]">No acknowledgment required.</span>}
          </div>

          {/* Roster */}
          {roster.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-[var(--color-border)]">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-bold text-[var(--color-text-muted)]">{summary.done} of {summary.required} acknowledged{summary.waived ? ` · ${summary.waived} waived` : ""}</div>
                {canManage && <button onClick={report} className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-accent)] hover:underline"><FileDown className="w-3 h-3" /> Report</button>}
              </div>
              <div className="max-h-40 overflow-y-auto space-y-0.5">
                {roster.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-[11px] py-0.5">
                    <span className="min-w-0 truncate text-[var(--color-text)]">{r.assigneeName || r.assigneeUserId}{r.assigneeRole ? <span className="text-[var(--color-text-muted)]"> · {r.assigneeRole}</span> : null}</span>
                    <span className="ml-auto shrink-0">{statusChip(r)}</span>
                    {canManage && r.status === "pending" && (
                      <>
                        <button title="Nudge" onClick={() => void nudge(r.id)} disabled={busy} className="shrink-0 p-1 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><BellRing className="w-3 h-3" /></button>
                        <button title="Waive" onClick={() => void waive(r.id)} disabled={busy} className="shrink-0 p-1 rounded hover:bg-red-50 text-red-500"><X className="w-3 h-3" /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Manage entry-point */}
          {canManage && mode === "view" && (
            <div className="pt-1">
              <button onClick={() => void beginEdit()} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text)] text-[11px] font-bold hover:bg-[var(--color-surface-2)]">
                <Pencil className="w-3.5 h-3.5" /> {eff ? "Edit requirement" : "Set requirement"}
              </button>
            </div>
          )}

          {/* Editor */}
          {canManage && mode === "edit" && (
            <div className="space-y-2 pt-1 border-t border-[var(--color-border)]">
              <div className="flex gap-1">
                {(["document", "collection", "library"] as Level[]).map((lv) => (
                  <button key={lv} onClick={() => void changeScope(lv)} disabled={lv === "collection" && !doc.collectionId}
                    className={`flex-1 px-2 py-1 rounded-lg text-[10px] font-bold disabled:opacity-30 ${scope === lv ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
                    {lv === "document" ? "This doc" : lv === "collection" ? "This folder" : "Library"}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-[11px] text-[var(--color-text)]">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require acknowledgment
              </label>
              {enabled && (
                <>
                  <div className="space-y-1">
                    <div className="text-[10px] font-bold text-[var(--color-text-muted)]">Named people</div>
                    <div className="flex flex-wrap gap-1">
                      {people.map((p) => (
                        <span key={p.uid} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[var(--color-text)]">{p.name || p.email}<button onClick={() => setPeople((prev) => prev.filter((x) => x.uid !== p.uid))}><X className="w-3 h-3" /></button></span>
                      ))}
                    </div>
                    <input value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="Search people…" className={`${inp} w-full`} />
                    {userHits.length > 0 && (
                      <div className="rounded-lg border border-[var(--color-border)] max-h-28 overflow-y-auto">
                        {userHits.filter((u) => !people.some((p) => p.uid === u.uid)).map((u) => (
                          <button key={u.uid} onClick={() => { setPeople((prev) => [...prev, u]); setUserQuery(""); setUserHits([]); }} className="w-full text-left px-2 py-1 text-[11px] hover:bg-[var(--color-surface-2)] flex items-center gap-1.5"><Plus className="w-3 h-3" /> {u.name || u.email}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="text-[10px] font-bold text-[var(--color-text-muted)]">Whole roles</div>
                    <div className="flex flex-wrap gap-1">
                      {ALL_ROLES.map((r) => (
                        <button key={r} onClick={() => toggleRole(r)} className={`px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors ${roles.includes(r) ? "bg-[var(--color-accent)] text-white border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>{r}</button>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-start gap-2 text-[10px] text-[var(--color-text)]">
                    <input type="checkbox" checked={hardGate} onChange={(e) => setHardGate(e.target.checked)} className="mt-0.5" />
                    <span>Hard-gate (mark rev &ldquo;pending acknowledgment&rdquo; until everyone signs)</span>
                  </label>
                </>
              )}
              <div className="flex justify-between gap-2 pt-1">
                <button onClick={() => void clearPolicy()} disabled={busy} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50">Remove</button>
                <div className="flex gap-2">
                  <button onClick={() => setMode("view")} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)]">Cancel</button>
                  <button onClick={() => void saveEdit()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-[11px] font-bold disabled:opacity-50">{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {signing && (
        <SignatureCeremony
          signerName={signerName}
          resourceLabel={`${label}${rev ? ` Rev ${rev}` : ""}`}
          defaultIntent="Acknowledged"
          defaultStatement={`I, ${signerName}, confirm I have READ and UNDERSTOOD ${label}${rev ? ` Rev ${rev}` : ""}, and affirm this as my electronic signature.`}
          lockIntent
          busy={busy}
          onCancel={() => !busy && setSigning(false)}
          onSign={doSign}
        />
      )}
    </div>
  );
}
