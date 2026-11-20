"use client";

// Shown once after the app issues a one-time password (adding a member who
// signs in with a password, or resetting one). The admin copies it to the
// person by a channel they trust. It isn't stored anywhere the admin can see
// again: closing this is the last look.

import React, { useState } from "react";
import { KeyRound, Copy, Check } from "lucide-react";
import { Modal, ModalHeader, ModalBody } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

export function TempPasswordNotice({ email, password, expiresAt, onClose }: {
  email: string;
  password: string;
  expiresAt: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const until = expiresAt ? new Date(expiresAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "the end of today";
  const copy = async () => {
    try { await navigator.clipboard.writeText(password); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* select it by hand */ }
  };
  return (
    <Modal onClose={onClose} size="sm">
      <ModalHeader icon={KeyRound} title="One-time password" subtitle={email} onClose={onClose} />
      <ModalBody>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 py-2.5 font-display text-[22px] tracking-wide text-[var(--color-heading)] tabular-nums">{password}</code>
            <Button variant="secondary" onClick={() => void copy()} aria-label="Copy the password">
              {copied ? <><Check className="w-4 h-4" /> Copied</> : <><Copy className="w-4 h-4" /> Copy</>}
            </Button>
          </div>
          <ul className="space-y-2 text-[14px] text-[var(--color-text)]">
            <li className="flex gap-2"><span className="ui-count is-solid shrink-0">1</span> Give it to them in person or by phone, not in the same email as their address.</li>
            <li className="flex gap-2"><span className="ui-count is-solid shrink-0">2</span> They sign in with it and must set their own password right away.</li>
            <li className="flex gap-2"><span className="ui-count is-warn shrink-0">!</span> If they don&apos;t by <b className="font-semibold">{until}</b>, the account is suspended until you reset it.</li>
          </ul>
          <p className="text-[13px] text-[var(--color-text-muted)]">This is the only time it&apos;s shown.</p>
          <Button className="w-full" onClick={onClose}>Done</Button>
        </div>
      </ModalBody>
    </Modal>
  );
}

export default TempPasswordNotice;
