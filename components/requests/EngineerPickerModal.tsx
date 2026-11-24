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

import { heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  User, Loader2, ChevronRight, Briefcase, Inbox, CircleAlert,
} from "lucide-react";
import { Textarea } from "@/components/ui/Field";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { friendlyError } from "@/lib/friendlyError";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { useDraft } from "@/hooks/useDraft";

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
  /** Where the typed comment is kept until it's sent. */
  draftKey?: string | null;
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
  draftKey = null,
  onSubmit,
}: EngineerPickerModalProps) {
  const [engineers, setEngineers] = useState<EngineerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const draft = useDraft<string>(isOpen ? draftKey : null, comment, setComment, (v) => !v.trim());

  useEffect(() => {
    if (!isOpen || !orgId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        // Pull every active engineer in the org — headline role OR the
        // additive roles array (the server validates against both, so an
        // Admin who also holds Engineer-2 must appear here too).
        const { data: allMembers, error: memErr } = await supabase
          .from("org_members")
          .select("uid, email, role, roles")
          .eq("org_id", orgId)
          .eq("status", "active");
        if (memErr) throw memErr;
        const members = ((allMembers as Array<Record<string, unknown>>) ?? []).filter((m) => {
          const held: string[] = Array.isArray(m.roles) && (m.roles as string[]).length > 0
            ? (m.roles as string[])
            : [String(m.role ?? "")];
          return held.some((r) => r.includes("Engineer"));
        });

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
        if (alive) setLoadError(friendlyError(e));
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
    if (requireComment && !comment.trim()) return setError("Add a short note so they know what to look at");
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
      draft.clear();
      onClose();
    } catch (e) {
      setError(friendlyError(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} dismissable={!busy} zIndex={410}>
        <ModalHeader icon={Briefcase} title={title} subtitle={description} onClose={busy ? undefined : onClose} />

        <ModalBody className="space-y-4">
          <div>
            <div className="text-body font-medium text-[var(--color-text)]">Engineer</div>
            <div className="mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border)]">
              {loading ? (
                <SkeletonRows rows={3} cols={1} what="engineers" sheet={false} />
              ) : loadError ? (
                <p role="alert" className="p-4 text-reading text-[var(--color-text)]"><span className="font-medium">The engineers didn&apos;t load.</span> <span className="text-[var(--color-text-muted)]">{loadError}</span></p>
              ) : filtered.length === 0 ? (
                <div className="p-4 text-reading text-[var(--color-text-muted)] text-center">
                  <p className="font-medium text-[var(--color-text)]">No active engineers in this workspace.</p>
                  <p className="mt-1 text-body">An admin can invite one, or give an existing member an Engineer role.</p>
                  <a href="/admin/users" className="inline-block mt-2 text-reading text-[var(--color-accent-text)] hover:underline underline-offset-2">Open Users</a>
                </div>
              ) : (
                <div className="divide-y divide-[var(--color-border)]">
                  {filtered.map((eng) => (
                    <label
                      key={eng.uid}
                      className={`flex items-center gap-3 p-3 cursor-pointer transition-colors hover:bg-[var(--color-surface-2)] ${selectedId === eng.uid ? "bg-[var(--color-surface-2)]" : ""}`}
                    >
                      <input
                        type="radio"
                        name="engineer"
                        value={eng.uid}
                        checked={selectedId === eng.uid}
                        onChange={(e) => setSelectedId(e.target.value)}
                        className="accent-[var(--color-text)]"
                      />
                      <User aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />
                      <div className="flex-1 min-w-0">
                        <div className="text-reading font-medium text-[var(--color-text)] truncate">{eng.name}</div>
                        <div className="text-body text-[var(--color-text-muted)] truncate">{eng.email}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-body text-[var(--color-text-muted)]">{eng.role}</span>
                        <span
                          title={`${eng.workload} open ticket${eng.workload === 1 ? "" : "s"}`}
                          className={`inline-flex items-center gap-1 text-body font-medium tabular-nums ${eng.workload < 3 ? "text-[var(--color-text-muted)]" : "text-[var(--state-held-text)]"}`}
                        >
                          <Inbox className="w-3 h-3" /> {eng.workload}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="text-body text-[var(--color-text-muted)] mt-1.5">Fewest open requests first.</div>
          </div>

          {requireComment && (
            <div>
              <label className="text-body font-medium text-[var(--color-text)]">{commentLabel.replace(/\s*\*$/, "")}</label>
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                className="mt-1.5 resize-y"
                placeholder={commentPlaceholder}
              />
            </div>
          )}

          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-body font-medium text-[var(--state-overdue-text)]"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" />{error}</p>
          )}
        </ModalBody>

        <ModalFooter>
          <button type="button" onClick={onClose} disabled={busy} className={heroQuiet}>Cancel</button>
          <button type="button" onClick={submit} disabled={busy} className={heroPrimary}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
            {busy ? "Sending" : "Send to engineer"}
          </button>
        </ModalFooter>
    </Modal>
  );
}
