"use client";

// AiBoundaryChip — can the AI read this document? Say so, plainly.
//
// The boundary already exists: knowledge features only ever read documents
// inside libraries/folders someone explicitly linked as a knowledge source.
// But an invisible boundary is a liability — people can't trust what they
// can't see. This states the document's status in one chip, and lets a
// controller carve out a single file without unlinking the whole library.
//
// Excluding is enforced server-side at the knowledge sync (the only door in),
// not here — this is the switch, not the lock.

import React, { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function AiBoundaryChip({
  documentId, libraryId, orgId, canManage,
}: {
  documentId: string;
  libraryId: string;
  orgId: string;
  canManage: boolean;
}) {
  const [excluded, setExcluded] = useState<boolean | null>(null);
  const [inSource, setInSource] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    // Is this document's library (or a folder above it) linked as a
    // knowledge source at all?
    const [{ data: doc }, { data: sources }] = await Promise.all([
      supabase.from("documents").select("ai_excluded, collection_id").eq("id", documentId).maybeSingle(),
      supabase.from("knowledge_sources").select("source_type, source_id").eq("org_id", orgId).limit(200),
    ]);
    const row = doc as { ai_excluded?: boolean; collection_id?: string | null } | null;
    setExcluded(row?.ai_excluded ?? false);
    const list = (sources as Array<{ source_type: string; source_id: string }> | null) ?? [];
    setInSource(list.some((s) =>
      (s.source_type === "library" && s.source_id === libraryId) ||
      (s.source_type !== "library" && !!row?.collection_id && s.source_id === row.collection_id),
    ));
  }, [documentId, libraryId, orgId]);

  useEffect(() => { void load(); }, [load]);

  if (excluded === null || inSource === null) return null;

  // Not in any knowledge source: the AI has never been able to read it.
  // Nothing to toggle — say so and stop.
  if (!inSource) {
    return (
      <span title="This document isn't in any library or folder linked as a knowledge source, so AI features cannot read it."
        className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-faint)]">
        <EyeOff className="w-3 h-3" /> Not AI-readable
      </span>
    );
  }

  const toggle = async () => {
    if (!canManage) return;
    setBusy(true);
    try {
      const next = !excluded;
      const { error } = await supabase.from("documents")
        .update({ ai_excluded: next }).eq("id", documentId);
      if (!error) setExcluded(next);
    } finally { setBusy(false); }
  };

  return (
    <button
      onClick={() => void toggle()}
      disabled={!canManage || busy}
      title={excluded
        ? "Held back from AI: this document is inside an indexed source, but excluded — it is not mirrored, chunked, or retrievable in answers."
        : "AI-readable: this document is inside an indexed knowledge source and can be cited in answers." +
          (canManage ? " Click to hold it back." : "")}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold transition-colors ${
        excluded
          ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
          : "bg-cyan-50 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300"
      } ${canManage ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" />
        : excluded ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
      {excluded ? "Held from AI" : "AI-readable"}
    </button>
  );
}
