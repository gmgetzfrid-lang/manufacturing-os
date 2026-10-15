"use client";

// components/documents/LibraryAiSwitch.tsx — "Never send to AI" for one
// library. Turning it on deletes the AI's copies at once (the documents are
// untouched) and closes every AI door to the library. Admin and Doc Control.

import React, { useState } from "react";
import { ShieldOff, ShieldCheck, Loader2 } from "lucide-react";
import { estatePost } from "@/lib/estate/client";

export default function LibraryAiSwitch({ orgId, libraryId, libraryName, excluded, canChange, onChanged, compact = false }: {
  orgId: string; libraryId: string; libraryName: string; excluded: boolean; canChange: boolean;
  onChanged?: (excluded: boolean) => void; compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const flip = async () => {
    const next = !excluded;
    if (next && !window.confirm(`Never send "${libraryName}" to AI?\n\nNothing in it will be read by AI, indexed for questions, read off drawings or attached to an AI review. Copies the AI already holds are deleted now. The documents themselves are not touched.`)) return;
    if (!next && !window.confirm(`Allow "${libraryName}" to be sent to AI again?\n\nNothing is read until someone links it in Intelligence or presses Connect everything.`)) return;
    setBusy(true); setNote(null);
    try {
      const r = await estatePost<{ excluded: boolean; purged: number }>("/api/documents/library-ai", { orgId, libraryId, excluded: next });
      setNote(r.excluded ? (r.purged ? `${r.purged} AI cop${r.purged === 1 ? "y" : "ies"} deleted.` : "Nothing had been sent.") : null);
      onChanged?.(r.excluded);
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };
  const Icon = excluded ? ShieldOff : ShieldCheck;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <button onClick={() => void flip()} disabled={!canChange || busy} title={canChange ? (excluded ? "Click to allow AI again" : "Click to never send this library to AI") : "Only Admin and Doc Control can change this"}
        className={`inline-flex items-center gap-1 rounded-full border font-bold disabled:opacity-60 ${compact ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"} ${excluded ? "border-rose-300 bg-rose-50 text-rose-700" : "border-emerald-300 bg-emerald-50 text-emerald-700"}`}>
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />} {excluded ? "Never sent to AI" : "AI may read"}
      </button>
      {note && <span className={`text-[10px] ${/migration|could not|denied|only/i.test(note) ? "text-red-700" : "text-[var(--color-text-muted)]"}`}>{note}</span>}
    </span>
  );
}
