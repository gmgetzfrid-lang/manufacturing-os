"use client";

// DistributionAcks — the acknowledged-distribution surface, two faces:
//
//   RECIPIENT: a bright, unmissable "please confirm" bar with a single
//   button. Two seconds, on the record.
//
//   CONTROLLER: "8 of 12 confirmed" progress, per-person status, member
//   picker to request more, one-click reminder to the stragglers.

import React, { useCallback, useEffect, useState } from "react";
import {
  ClipboardCheck, ChevronDown, ChevronUp, CheckCircle2, Clock,
  BellRing, Loader2, UserPlus, X,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/components/providers/ToastProvider";
import {
  listAcksForVersion, getMyPendingAck, requestAcks, acknowledge,
  renudgeUnacked, type DistributionAck,
} from "@/lib/distributionAcks";

interface DistributionAcksProps {
  documentId: string;
  orgId: string;
  libraryId?: string | null;
  docLabel: string;
  currentRev: string | null;
  currentVersionId: string | null;
  currentUserId: string;
  currentUserName?: string | null;
  isController: boolean;
}

interface Member { uid: string; email: string | null; role: string | null }

export default function DistributionAcks({
  documentId, orgId, libraryId, docLabel, currentRev, currentVersionId,
  currentUserId, currentUserName, isController,
}: DistributionAcksProps) {
  const [acks, setAcks] = useState<DistributionAck[]>([]);
  const [myPending, setMyPending] = useState<DistributionAck | null>(null);
  const [open, setOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [acking, setAcking] = useState(false);
  const [reminded, setReminded] = useState(false);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    if (!currentVersionId) return;
    const [rows, mine] = await Promise.all([
      listAcksForVersion(currentVersionId),
      getMyPendingAck(currentVersionId, currentUserId),
    ]);
    setAcks(rows);
    setMyPending(mine);
  }, [currentVersionId, currentUserId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setAcks([]); setMyPending(null); setOpen(false); setShowPicker(false); setReminded(false);
      if (alive) await load();
    })();
    return () => { alive = false; };
  }, [load]);

  const openPicker = async () => {
    setShowPicker(true);
    if (members.length === 0) {
      const { data } = await supabase
        .from("org_members")
        .select("uid, email, role")
        .eq("org_id", orgId)
        .eq("status", "active");
      setMembers((((data as Array<Record<string, unknown>>) ?? [])
        .map((m) => ({ uid: String(m.uid), email: (m.email as string | null) ?? null, role: (m.role as string | null) ?? null }))
        .filter((m) => m.uid !== currentUserId)));
    }
  };

  const handleRequest = async () => {
    if (!currentVersionId || checked.size === 0) return;
    setBusy(true);
    try {
      await requestAcks({
        orgId, documentId, libraryId, docLabel,
        versionId: currentVersionId, revLabel: currentRev,
        recipients: members.filter((m) => checked.has(m.uid)).map((m) => ({ uid: m.uid, email: m.email })),
        actorUserId: currentUserId,
        actorName: currentUserName || "Document Control",
      });
      setShowPicker(false);
      setChecked(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  };

  const handleAcknowledge = async () => {
    if (!myPending) return;
    setAcking(true);
    try {
      await acknowledge(myPending.id, currentUserId);
    } catch (e) {
      // acknowledge() throws on zero rows (already stamped in another tab, or
      // not this user's row). Say why the click didn't record — the reload in
      // finally reconciles the bar either way, so a benign race self-heals.
      showToast({ type: "error", title: "Confirmation not recorded", message: (e as Error).message });
    } finally {
      await load();
      setAcking(false);
    }
  };

  const handleRemind = async () => {
    setBusy(true);
    try {
      await renudgeUnacked({
        orgId, documentId, libraryId, docLabel, revLabel: currentRev,
        acks, actorUserId: currentUserId, actorName: currentUserName || "Document Control",
      });
      setReminded(true);
    } finally {
      setBusy(false);
    }
  };

  const confirmed = acks.filter((a) => a.acknowledgedAt).length;
  const shortName = (a: DistributionAck) => a.recipientEmail?.split("@")[0] ?? "member";

  // Nothing to show: no acks exist and the viewer can't create any.
  if (!currentVersionId || (acks.length === 0 && !myPending && !isController)) return null;

  return (
    <div className="space-y-2">
      {/* RECIPIENT FACE — the unmissable confirm bar. */}
      {myPending && (
        <div className="rounded-xl border-2 border-blue-400 bg-blue-50 p-3 flex items-center gap-3 animate-in fade-in">
          <ClipboardCheck className="w-5 h-5 text-blue-600 shrink-0" />
          <div className="flex-1 min-w-0 text-xs text-blue-900">
            <b>{myPending.requestedByName || "Document Control"}</b> asked you to confirm you have{" "}
            <b>Rev {myPending.revLabel ?? currentRev ?? "?"}</b> of this document.
          </div>
          <button
            onClick={() => void handleAcknowledge()}
            disabled={acking}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-blue-600 hover:bg-blue-500 shadow disabled:opacity-50"
          >
            {acking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            I have this revision
          </button>
        </div>
      )}

      {/* CONTROLLER FACE — progress + management. */}
      {(acks.length > 0 || isController) && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <button
            onClick={() => setOpen((v) => !v)}
            className="w-full px-3.5 py-2.5 flex items-center gap-2 hover:bg-[var(--color-surface-2)] transition-colors"
          >
            <ClipboardCheck className="w-4 h-4 text-blue-600 shrink-0" />
            <span className="text-xs font-bold text-[var(--color-text)]">Distribution confirmations</span>
            <span className="ml-auto">
              {acks.length === 0 ? (
                <span className="text-[10px] font-bold text-[var(--color-text-faint)]">none requested for Rev {currentRev ?? "—"}</span>
              ) : (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                  confirmed === acks.length ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"
                }`}>
                  {confirmed} of {acks.length} confirmed
                </span>
              )}
            </span>
            {open ? <ChevronUp className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
          </button>

          {open && (
            <div className="px-3.5 pb-3 border-t border-[var(--color-border)] pt-2.5 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
              {acks.length > 0 && (
                <>
                  {/* Progress bar */}
                  <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all duration-500"
                      style={{ width: `${acks.length ? Math.round((confirmed / acks.length) * 100) : 0}%` }}
                    />
                  </div>
                  <div className="space-y-0.5">
                    {acks.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-[11px] py-0.5">
                        {a.acknowledgedAt
                          ? <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                          : <Clock className="w-3 h-3 text-amber-500 shrink-0" />}
                        <span className="font-bold text-[var(--color-text)] truncate">{shortName(a)}</span>
                        <span className="text-[var(--color-text-faint)] ml-auto shrink-0">
                          {a.acknowledgedAt
                            ? `confirmed ${new Date(a.acknowledgedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                            : `asked ${new Date(a.requestedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {isController && (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={() => void openPicker()}
                    className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold border border-blue-200 text-blue-700 hover:bg-blue-50"
                  >
                    <UserPlus className="w-3 h-3" /> Request confirmations…
                  </button>
                  {acks.some((a) => !a.acknowledgedAt) && (
                    reminded ? (
                      <span className="text-[10px] font-bold text-emerald-700">Reminder sent ✓</span>
                    ) : (
                      <button
                        onClick={() => void handleRemind()}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold border border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                      >
                        <BellRing className="w-3 h-3" /> Remind the unconfirmed
                      </button>
                    )
                  )}
                </div>
              )}

              {/* Member picker */}
              {showPicker && (
                <div className="rounded-lg border border-[var(--color-border)] p-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">
                      Who must confirm Rev {currentRev ?? "?"}?
                    </span>
                    <button onClick={() => setShowPicker(false)} className="p-0.5 rounded hover:bg-[var(--color-surface-2)]">
                      <X className="w-3 h-3 text-[var(--color-text-faint)]" />
                    </button>
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-0.5">
                    {members.map((m) => (
                      <label key={m.uid} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[var(--color-surface-2)] cursor-pointer text-[11px]">
                        <input
                          type="checkbox"
                          checked={checked.has(m.uid)}
                          onChange={(e) => {
                            setChecked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(m.uid); else next.delete(m.uid);
                              return next;
                            });
                          }}
                          className="rounded"
                        />
                        <span className="font-bold text-[var(--color-text)]">{m.email?.split("@")[0] ?? m.uid.slice(0, 8)}</span>
                        {m.role && <span className="text-[9px] text-[var(--color-text-faint)] uppercase">{m.role}</span>}
                      </label>
                    ))}
                  </div>
                  <button
                    onClick={() => void handleRequest()}
                    disabled={busy || checked.size === 0}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ClipboardCheck className="w-3 h-3" />}
                    Ask {checked.size || "…"} {checked.size === 1 ? "person" : "people"} to confirm
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
