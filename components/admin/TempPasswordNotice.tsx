"use client";

// Shown once after the app issues a one-time password (adding a member who
// signs in with a password, or resetting one). The admin copies it to the
// person by a channel they trust. It isn't stored anywhere the admin can see
// again: closing this is the last look.

import React, { useState } from "react";
import { Copy, Check } from "lucide-react";
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
      <ModalHeader title="One-time password" subtitle={email} onClose={onClose} />
      <ModalBody>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all select-all rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 py-2.5 font-display text-section tracking-wide text-[var(--color-heading)] tabular-nums">{password}</code>
            <Button variant="secondary" onClick={() => void copy()} aria-label="Copy the password">
              {copied ? <><Check className="w-4 h-4" /> Copied</> : <><Copy className="w-4 h-4" /> Copy</>}
            </Button>
          </div>
          <ol className="space-y-1.5 text-body text-[var(--color-text)] list-decimal ml-5">
            <li>Give it to them in person or by phone, not in the same email as their address.</li>
            <li>They sign in with it and must set their own password right away.</li>
          </ol>
          <p className="text-body text-[var(--state-held-text)] font-medium">If they don&apos;t by {until}, the account is suspended until you reset it.</p>
          <p className="text-body text-[var(--color-text-muted)]">This is the only time it&apos;s shown.</p>
          <Button className="w-full" onClick={onClose}>Done</Button>
        </div>
      </ModalBody>
    </Modal>
  );
}

export default TempPasswordNotice;
