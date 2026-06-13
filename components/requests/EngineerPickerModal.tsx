"use client";

// EngineerPickerModal — pick a specific engineer to route a ticket to.
//
// Used by two workflow actions:
//   1. "Flag for Engineering Review" — supervisor flags a ticket from
//      PENDING_ENG_INITIAL to PENDING_ENG_TEAM and picks WHO reviews
//   2. "Send for Engineer Final Approval" — a Viewer-tier requester
//      can't sign off on engineering work directly; they pick the
//      engineer who will do the IFC sign-off
//   3. "Reassign Engineer Reviewer" — admin override
//
// Lists every active org member whose role contains "Engineer" with
// their email + role tag + count of open tickets they're already on
// (workload hint). Required comment + engineer selection before submit.

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  X, User, AlertTriangle, Loader2, ChevronRight, Briefcase, Inbox,
} from "lucide-react";
import { Textarea } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";

interface EngineerOption {
  uid: string;
  email: string;
  name: string;
  role: string;
  workload: number;            // open ticket count, hint to balance
}

interface EngineerPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  orgId: string;
  /** Headline shown in the modal. Differs by action. */
  title: string;
  /** Short body text — what this is about. */
  description: string;
  /** Whether a comment is required (most paths: yes). */
  requireComment?: boolean;
  /** Label for the comment textarea. */
  commentLabel?: string;
  /** Placeholder for the comment textarea. */
  commentPlaceholder?: string;
  /** Pre-selected engineer (e.g. for reassignment — exclude this one). */
  currentEngineerId?: string;
  onSubmit: (params: {
    engineerId: string;
    engineerName: string;
    engineerEmail: string;
    comment: string;
  }) => Promise<void>;
}

export default function EngineerPickerModal({
  isOpen, onClose, orgId, title, description,
  requireComment = true, commentLabel = "Comment *",
  commentPlaceholder = "What do you need them to review?",
  currentEngineerId,
  onSubmit,
}: EngineerPickerModalProps) {
  const [engineers, setEngineers] = useState<EngineerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !orgId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        // Pull every active engineer in the org.
        const { data: members } = await supabase
          .from("org_members")
          .select("uid, email, role")
          .eq("org_id", orgId)
          .eq("status", "active")
          .ilike("role", "%Engineer%");

        const list: EngineerOption[] = (
          (members ?? []) as Array<{ uid: string; email: string | null; role: string }>
        ).map((m) => ({
          uid: m.uid,
          email: m.email || "",
          name: (m.email || "").split("@")[0] || "Engineer",
          role: m.role,
          workload: 0,
        }));

        // Best-effort workload count: open tickets where this engineer is
        // either the assigned engineer or has been pulled into final approval.
        const uids = list.map((e) => e.uid);
        if (uids.length > 0) {
          const { data: open } = await supabase
            .from("tickets")
            .select("assigned_engineer_id, status")
            .eq("org_id", orgId)
            .in("status", ["PENDING_ENG_TEAM", "PENDING_FINAL_APPROVAL", "PENDING_REVIEW"])
            .in("assigned_engineer_id", uids);
          const counts = new Map<string, number>();
          for (const t of (open ?? []) as Array<{ assigned_engineer_id: string }>) {
            counts.set(t.assigned_engineer_id, (counts.get(t.assigned_engineer_id) || 0) + 1);
          }
          list.forEach((e) => { e.workload = counts.get(e.uid) || 0; });
        }

        // Sort by lightest workload first, then by name.
        list.sort((a, b) => a.workload - b.workload || a.name.localeCompare(b.name));

        if (alive) setEngineers(list);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [isOpen, orgId]);

  if (!isOpen) return null;

  const filtered = engineers.filter((e) => e.uid !== currentEngineerId);

  const submit = async () => {
    setError(null);
    if (!selectedId) return setError("Pick an engineer to route this to");
    if (requireComment && !comment.trim()) return setError("Please add a short comment so they know what to look at");
    const engineer = engineers.find((e) => e.uid === selectedId);
    if (!engineer) return;
    setBusy(true);
    try {
      await onSubmit({
        engineerId: engineer.uid,
        engineerName: engineer.name,
        engineerEmail: engineer.email,
        comment: comment.trim(),
      });
      setSelectedId("");
      setComment("");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[210] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-8 animate-in fade-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="p-2 bg-[var(--color-accent-soft)] rounded-lg"><Briefcase className="w-5 h-5 text-[var(--color-accent)]" /></div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-slate-900 truncate">{title}</div>
            <div className="text-xs text-slate-500">{description}</div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-900">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Engineer *</label>
            <div className="mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-slate-200">
              {loading ? (
                <div className="flex items-center gap-2 p-4 text-sm text-slate-500">
                  <Spinner size="sm" /> Loading engineers…
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-4 text-sm text-slate-500 text-center">
                  No active engineers in this workspace.
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {filtered.map((eng) => (
                    <label
                      key={eng.uid}
                      className={`flex items-center gap-3 p-3 cursor-pointer transition-colors hover:bg-slate-50 ${selectedId === eng.uid ? "bg-[var(--color-accent-soft)]" : ""}`}
                    >
                      <input
                        type="radio"
                        name="engineer"
                        value={eng.uid}
                        checked={selectedId === eng.uid}
                        onChange={(e) => setSelectedId(e.target.value)}
                        className="accent-[var(--color-accent)]"
                      />
                      <div className="p-1.5 bg-slate-100 rounded-full"><User className="w-4 h-4 text-slate-600" /></div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-slate-900 truncate">{eng.name}</div>
                        <div className="text-[11px] text-slate-500 truncate">{eng.email}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">{eng.role}</span>
                        <span
                          title={`${eng.workload} open ticket${eng.workload === 1 ? "" : "s"}`}
                          className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                            eng.workload === 0 ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : eng.workload < 3 ? "bg-amber-50 text-amber-700 border-amber-200"
                            : "bg-red-50 text-red-700 border-red-200"
                          }`}
                        >
                          <Inbox className="w-3 h-3" /> {eng.workload}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="text-[10px] text-slate-500 mt-1.5">Sorted by lightest workload first.</div>
          </div>

          {requireComment && (
            <div>
              <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">{commentLabel}</label>
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                className="mt-1 resize-y"
                placeholder={commentPlaceholder}
              />
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {busy ? "Sending…" : "Send to Engineer"}
          </button>
        </div>
      </div>
    </div>
  );
}
