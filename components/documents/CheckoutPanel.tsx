"use client";

import React, { useMemo, useState } from "react";
import { Clock, User, CheckCircle2, XCircle } from "lucide-react";
import type { CheckoutMode, CheckoutSession } from "@/types/schema";

const MODES: CheckoutMode[] = ["view", "markup", "edit", "drafting"];

export default function CheckoutPanel(props: {
  sessions: CheckoutSession[];
  currentUserId?: string | null;
  onStart: (mode: CheckoutMode, note: string, linkedTicketId?: string) => void;
  onEnd: (sessionId: string) => void;
  onAbandon: (sessionId: string) => void;
  canStart: boolean;
}) {
  const { sessions, currentUserId, onStart, onEnd, onAbandon, canStart } = props;
  const [mode, setMode] = useState<CheckoutMode>("view");
  const [note, setNote] = useState("");
  const [ticketId, setTicketId] = useState("");

  const activeSessions = useMemo(
    () => sessions.filter((s) => s.status === "active"),
    [sessions]
  );

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-black text-[var(--color-text)]">Checkout Sessions</div>
          <div className="text-xs text-[var(--color-text-muted)]">Who is working, and what they are doing.</div>
        </div>
        <div className="text-xs text-[var(--color-text-muted)]">{activeSessions.length} active</div>
      </div>

      <div className="mt-4 space-y-3">
        {activeSessions.length === 0 ? (
          <div className="text-xs text-[var(--color-text-muted)]">No active sessions.</div>
        ) : (
          activeSessions.map((s) => (
            <div key={s.id} className="flex items-start justify-between gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-bold text-[var(--color-text)] flex items-center gap-2">
                  <User className="h-4 w-4 text-[var(--color-text-muted)]" />
                  {s.userName || s.userId}
                  <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
                    {s.mode}
                  </span>
                </div>
                {s.note && <div className="text-xs text-[var(--color-text-muted)] mt-1">{s.note}</div>}
                {s.linkedTicketId && (
                  <div className="text-[11px] text-[var(--color-text-muted)] mt-1">Ticket: {s.linkedTicketId}</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {s.userId === currentUserId ? (
                  <button
                    onClick={() => onEnd(s.id!)}
                    className="text-xs font-bold text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 transition-colors px-2 py-1 rounded-lg"
                  >
                    Check in
                  </button>
                ) : (
                  <button
                    onClick={() => onAbandon(s.id!)}
                    className="text-xs font-bold text-amber-700 border border-amber-200 bg-amber-50 hover:bg-amber-100 transition-colors px-2 py-1 rounded-lg"
                  >
                    Mark abandoned
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-4 border-t border-[var(--color-border)] pt-4">
        <div className="text-xs font-bold text-[var(--color-text-muted)] mb-2">Start a session</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as CheckoutMode)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            placeholder="Linked ticket id (optional)"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (what are you working on)"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-2">
          <button
            onClick={() => onStart(mode, note, ticketId || undefined)}
            disabled={!canStart}
            className={`px-4 py-2 rounded-lg text-sm font-bold inline-flex items-center gap-2 transition-colors ${
              canStart ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]" : "bg-[var(--color-surface-2)] text-[var(--color-text-faint)] cursor-not-allowed"
            }`}
          >
            <Clock className="h-4 w-4" />
            Start session
          </button>
        </div>
      </div>

      <div className="mt-3 text-[11px] text-[var(--color-text-muted)] flex items-center gap-2">
        <CheckCircle2 className="h-3 w-3" /> Active sessions broadcast to collaborators.
        <XCircle className="h-3 w-3" /> Abandoned sessions can be marked by DocCtrl/Admin.
      </div>
    </div>
  );
}
