"use client";

// DocClassControl — the DOCUMENT-level doc_class declaration, controller-only,
// living in the inspector's Manage & lifecycle drawer. Library/folder level
// is declared in the review-policy modal; this is the per-document override
// (most specific wins). Shows the EFFECTIVE class so the controller sees what
// actually applies, and an evidence-based suggestion (suggestDocClass) when
// nothing is declared anywhere — a prefill hint, never enforcement.

import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  effectiveDocClassForDocument,
  setDocClass,
  suggestDocClass,
  type DocClass,
} from "@/lib/docClass";
import { useToast } from "@/components/providers/ToastProvider";

interface DocClassControlProps {
  documentId: string;
  collectionId?: string | null;
  libraryId?: string | null;
  /** The document's file name — its extension feeds the class suggestion. */
  fileName?: string | null;
}

export default function DocClassControl({ documentId, collectionId, libraryId, fileName }: DocClassControlProps) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [declared, setDeclared] = useState<DocClass | "inherit">("inherit");
  const [effective, setEffective] = useState<DocClass | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      try {
        // select("*") — doc_class may predate migration 20261012.
        const [{ data }, eff] = await Promise.all([
          supabase.from("documents").select("*").eq("id", documentId).maybeSingle(),
          effectiveDocClassForDocument({ id: documentId, collectionId: collectionId ?? null, libraryId: libraryId ?? null }),
        ]);
        if (!alive) return;
        const raw = ((data as Record<string, unknown> | null)?.doc_class as string | null) ?? null;
        setDeclared(raw === "drawing" || raw === "procedure" ? raw : "inherit");
        setEffective(eff);
      } catch { /* control degrades to inherit */ }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [documentId, collectionId, libraryId]);

  const apply = async (next: DocClass | "inherit") => {
    if (busy || next === declared) return;
    setBusy(true);
    const prev = declared;
    setDeclared(next);
    try {
      await setDocClass({ level: "document", id: documentId, docClass: next === "inherit" ? null : next });
      const eff = await effectiveDocClassForDocument({ id: documentId, collectionId: collectionId ?? null, libraryId: libraryId ?? null });
      setEffective(eff);
    } catch (e) {
      setDeclared(prev);
      showToast({ type: "error", title: "Document class not saved", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const ext = fileName?.includes(".") ? fileName.split(".").pop() ?? null : null;
  const suggestion = !effective ? suggestDocClass({ fileType: ext }) : null;

  return (
    <div>
      <div className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1 flex items-center gap-1.5">
        Document class
        {(loading || busy) && <Loader2 className="w-3 h-3 animate-spin" />}
      </div>
      <div className="flex bg-[var(--color-surface-2)] p-1 rounded-lg">
        {([
          { v: "inherit", label: "Inherit" },
          { v: "drawing", label: "Drawing / CAD" },
          { v: "procedure", label: "Procedure" },
        ] as const).map((o) => (
          <button
            key={o.v}
            type="button"
            disabled={loading || busy}
            onClick={() => void apply(o.v)}
            className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all disabled:opacity-60 ${declared === o.v ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="text-[10px] text-[var(--color-text-muted)] mt-1">
        {effective === "drawing"
          ? "Effective: Drawing — non-minor publishes require an MOC; check-in routes redlines to drafting."
          : effective === "procedure"
            ? "Effective: Procedure — the owner/publishers release revisions directly."
            : suggestion
              ? `Unclassified. Suggested: ${suggestion === "drawing" ? "Drawing / CAD" : "Procedure"} (from the file's type) — declare it so the right change process applies.`
              : "Unclassified — no class-specific rules apply. Declare here, or at the folder/library level in the review-policy settings."}
      </div>
    </div>
  );
}
