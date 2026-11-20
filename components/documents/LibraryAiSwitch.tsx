"use client";

// components/documents/LibraryAiSwitch.tsx: "AI may read" for one library,
// as a real on/off switch. Turning it off deletes the AI's copies at once
// (the documents are untouched) and closes every AI door to the library.
// Admin and Doc Control.

import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { estatePost } from "@/lib/estate/client";
import { StatusTag } from "@/components/documents/StatusTag";

export default function LibraryAiSwitch({ orgId, libraryId, libraryName, excluded, canChange, onChanged, compact = false }: {
  orgId: string; libraryId: string; libraryName: string; excluded: boolean; canChange: boolean;
  onChanged?: (excluded: boolean) => void;
  /** In a table row: the column heading names it, so the label is for
   *  screen readers only. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const on = !excluded;
  const flip = async () => {
    const next = !excluded;
    if (next && !window.confirm(`Never send "${libraryName}" to AI?\n\nNothing in it will be read by AI, indexed for questions, read off drawings or attached to an AI review. Copies the AI already holds are deleted now. The documents themselves are not touched.`)) return;
    if (!next && !window.confirm(`Allow "${libraryName}" to be sent to AI again?\n\nNothing is read until someone links it in Intelligence or presses Connect everything.`)) return;
    setBusy(true); setNote(null);
    try {
      const r = await estatePost<{ excluded: boolean; purged: number }>("/api/documents/library-ai", { orgId, libraryId, excluded: next });
      setNote(r.excluded ? { text: r.purged ? `${r.purged} AI cop${r.purged === 1 ? "y" : "ies"} deleted.` : "Nothing had been sent.", bad: false } : null);
      onChanged?.(r.excluded);
    } catch (e) { setNote({ text: (e as Error).message, bad: true }); }
    finally { setBusy(false); }
  };
  const label = "AI may read";
  return (
    <span className="inline-flex flex-col gap-0.5 align-middle">
      <span className="inline-flex items-center gap-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${label} ${libraryName}`}
          onClick={() => void flip()}
          disabled={!canChange || busy}
          title={canChange ? (on ? "Turn off: never send this library to AI" : "Turn on: allow AI to read this library") : "Only Admin and Doc Control can change this"}
          className="group inline-flex items-center gap-2 rounded-md text-[14px] text-[var(--color-text)] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
        >
          <span className={`relative inline-flex shrink-0 w-9 h-5 rounded-full transition-colors group-disabled:opacity-50 ${on ? "bg-[var(--color-main)]" : "bg-[var(--color-border-strong)]"}`}>
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-[var(--color-surface)] shadow grid place-items-center transition-transform ${on ? "translate-x-4" : ""}`}>
              {busy && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-muted)]" />}
            </span>
          </span>
          <span className={compact ? "sr-only" : "whitespace-nowrap"}>{label}</span>
        </button>
        <StatusTag tone={on ? "good" : "none"}>{on ? "Allowed" : "Never sent"}</StatusTag>
      </span>
      {note && <span role={note.bad ? "alert" : undefined} className={`text-[13px] ${note.bad ? "text-[var(--state-overdue)]" : "text-[var(--color-text-muted)]"}`}>{note.text}</span>}
    </span>
  );
}
