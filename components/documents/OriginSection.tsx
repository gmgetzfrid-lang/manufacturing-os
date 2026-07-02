"use client";

// OriginSection — a compact Inspector panel to view/set a document's ORIGIN
// (internal vs external) and, for external documents, the source's own reference
// + edition. ISO 9001 §7.5.3 control of documents of external origin.

import React, { useCallback, useEffect, useState } from "react";
import { Globe, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import OriginBadge from "@/components/documents/OriginBadge";
import { setDocumentOrigin } from "@/lib/documentOrigin";
import type { DocumentRecord } from "@/types/schema";

export default function OriginSection({ doc, orgId, canManage }: {
  doc: DocumentRecord;
  orgId: string;
  canManage: boolean;
}) {
  const { uid } = useRole();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [origin, setOrigin] = useState<"internal" | "external">("internal");
  const [source, setSource] = useState("");
  const [reference, setReference] = useState("");
  const [edition, setEdition] = useState("");
  const [url, setUrl] = useState("");

  const load = useCallback(async () => {
    if (!doc.id) return;
    setLoading(true);
    try {
      const { data } = await supabase.from("documents").select("origin, external_source, external_reference, external_edition, external_url").eq("id", doc.id).maybeSingle();
      setOrigin((data?.origin as "internal" | "external") ?? "internal");
      setSource((data?.external_source as string) ?? "");
      setReference((data?.external_reference as string) ?? "");
      setEdition((data?.external_edition as string) ?? "");
      setUrl((data?.external_url as string) ?? "");
    } finally { setLoading(false); }
  }, [doc.id]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!doc.id) return;
    setBusy(true);
    try {
      await setDocumentOrigin({ documentId: doc.id, orgId, actorId: uid, origin, externalSource: source, externalReference: reference, externalEdition: edition, externalUrl: url });
      setEditing(false); await load();
    } finally { setBusy(false); }
  };

  // Internal + non-manager + not editing → stay quiet (internal is the default).
  if (!loading && origin !== "external" && !editing && !canManage) return null;

  const inp = "text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 outline-none focus:border-[var(--color-accent)]";

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Globe className="w-4 h-4 text-[var(--color-text-muted)]" />
        <span className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">Origin</span>
        {!loading && !editing && (
          <div className="ml-auto flex items-center gap-2">
            {origin === "external" ? <OriginBadge origin="external" source={source} reference={reference} edition={edition} /> : <span className="text-[11px] text-[var(--color-text-muted)]">Internal</span>}
            {canManage && <button onClick={() => setEditing(true)} className="text-[10px] font-bold text-[var(--color-accent)] hover:underline">Edit</button>}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
      ) : editing ? (
        <div className="space-y-2">
          <div className="flex gap-1">
            {(["internal", "external"] as const).map((o) => (
              <button key={o} onClick={() => setOrigin(o)} className={`flex-1 px-2 py-1 rounded-lg text-[11px] font-bold ${origin === o ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>{o === "internal" ? "Internal" : "External origin"}</button>
            ))}
          </div>
          {origin === "external" && (
            <div className="space-y-1.5">
              <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source (e.g. API, Emerson, OSHA)" className={`${inp} w-full`} />
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Source reference (e.g. API 610)" className={`${inp} w-full`} />
              <input value={edition} onChange={(e) => setEdition(e.target.value)} placeholder="Source edition (e.g. 11th Ed / 2020)" className={`${inp} w-full`} />
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Source URL (optional)" className={`${inp} w-full`} />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => { setEditing(false); void load(); }} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)]">Cancel</button>
            <button onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-[11px] font-bold disabled:opacity-50">{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save</button>
          </div>
        </div>
      ) : origin === "external" && (edition || url) ? (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          {edition && <span>Edition {edition}</span>}
          {url && <>{edition ? " · " : ""}<a href={url} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">source</a></>}
        </div>
      ) : null}
    </div>
  );
}
