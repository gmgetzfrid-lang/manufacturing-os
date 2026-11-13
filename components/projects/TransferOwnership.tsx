"use client";

// Members › Transfer ownership: hand the project to someone (a member, or
// anyone in the organization by email) and say what the current owner
// becomes: co-owner, editor, viewer, or off the project. Made it for
// someone else? Hand it over and stay on as co-owner.

import React, { useState } from "react";
import { Crown, Loader2 } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { supabase } from "@/lib/supabase";
import { transferOwnership } from "@/lib/projects";
import type { Project, ProjectMember, ProjectMemberRole } from "@/types/schema";

const KEEP: Array<{ v: ProjectMemberRole | "leave"; label: string; hint: string }> = [
  { v: "co_owner", label: "Co-owner", hint: "Everything the owner can do, except delete the project or hand it over" },
  { v: "collaborator", label: "Editor", hint: "Updates the work" },
  { v: "observer", label: "Viewer", hint: "Reads only" },
  { v: "leave", label: "Leave the project", hint: "Off the member list" },
];

export function TransferOwnershipModal({ project, members, preselect, actorUserId, actorEmail, onDone, onClose }: {
  project: Project; members: ProjectMember[]; preselect?: string | null;
  actorUserId: string; actorEmail?: string;
  onDone: (note?: string) => void; onClose: () => void;
}) {
  const candidates = members.filter((m) => m.userId !== project.ownerUserId);
  const [pick, setPick] = useState<string>(preselect ?? candidates[0]?.userId ?? "__email__");
  const [email, setEmail] = useState("");
  const [keepAs, setKeepAs] = useState<ProjectMemberRole | "leave">("co_owner");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const actorIsOwner = project.ownerUserId === actorUserId;
  const ownerName = actorIsOwner ? "You" : (project.ownerUserName || "The current owner");

  const go = async () => {
    setBusy(true); setErr(null);
    try {
      let to: { id: string; name?: string; email?: string };
      if (pick === "__email__") {
        const e = email.trim().toLowerCase();
        if (!e) throw new Error("Type their email.");
        const { data: users } = await supabase.from("users").select("id, email").eq("email", e).limit(2);
        const list = (users ?? []) as Array<{ id: string; email: string }>;
        if (list.length > 1) throw new Error("More than one account has that email - ask your admin.");
        const u = list[0];
        const { data: inOrg } = u ? await supabase.from("org_members").select("uid").eq("org_id", project.orgId).eq("uid", u.id).eq("status", "active").maybeSingle() : { data: null };
        if (!u || !inOrg) throw new Error("No one with that email in this organization.");
        to = { id: u.id, email: e, name: e.split("@")[0] };
      } else {
        const m = candidates.find((x) => x.userId === pick);
        if (!m) throw new Error("Pick the new owner.");
        to = { id: m.userId, name: m.userName ?? undefined, email: m.userEmail ?? undefined };
      }
      const res = await transferOwnership({
        projectId: project.id!, newOwnerUserId: to.id, newOwnerName: to.name, newOwnerEmail: to.email,
        keepAs, previousOwnerName: actorIsOwner ? actorEmail?.split("@")[0] : project.ownerUserName, previousOwnerEmail: actorIsOwner ? actorEmail : undefined,
        actorUserId, actorEmail,
      });
      onDone(res.note);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const radio = (on: boolean) => `flex items-start gap-2 rounded-lg border px-3 py-2 text-left ${on ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/40" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`;
  return (
    <Modal onClose={onClose} size="md">
      <ModalHeader icon={Crown} title="Transfer ownership" subtitle={project.name} onClose={onClose} />
      <ModalBody>
        <div className="space-y-4">
          <div>
            <div className="text-[12px] font-semibold text-[var(--color-text-muted)] mb-1.5">New owner</div>
            <div className="space-y-1.5" role="radiogroup" aria-label="New owner">
              {candidates.map((m) => (
                <button key={m.userId} type="button" role="radio" aria-checked={pick === m.userId} onClick={() => setPick(m.userId)} className={`${radio(pick === m.userId)} w-full`}>
                  <span className="text-[13px] font-bold text-[var(--color-text)]">{m.userName || m.userEmail || m.userId}</span>
                  {m.userEmail && m.userName && <span className="text-[12px] text-[var(--color-text-muted)]">{m.userEmail}</span>}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={pick === "__email__"} onClick={() => setPick("__email__")} className={`${radio(pick === "__email__")} w-full`}>
                <span className="text-[13px] font-bold text-[var(--color-text)]">Someone else in the organization</span>
              </button>
              {pick === "__email__" && (
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="their.email@company.com" aria-label="New owner's email" autoFocus
                  className="w-full h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-[13px]" />
              )}
            </div>
          </div>
          <div>
            <div className="text-[12px] font-semibold text-[var(--color-text-muted)] mb-1.5">{ownerName === "You" ? "You become" : `${ownerName} becomes`}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" role="radiogroup" aria-label="The current owner becomes">
              {KEEP.map((k) => (
                <button key={k.v} type="button" role="radio" aria-checked={keepAs === k.v} onClick={() => setKeepAs(k.v)} className={`${radio(keepAs === k.v)} flex-col`}>
                  <span className="text-[13px] font-bold text-[var(--color-text)]">{k.label}</span>
                  <span className="text-[11.5px] text-[var(--color-text-muted)]">{k.hint}</span>
                </button>
              ))}
            </div>
          </div>
          {err && <div className="text-[12px] text-rose-700 dark:text-rose-300">{err}</div>}
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Cancel</button>
          <button type="button" onClick={() => void go()} disabled={busy || (pick === "__email__" && !email.trim())}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Transfer ownership
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
