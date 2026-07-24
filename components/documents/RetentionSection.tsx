"use client";

// RetentionSection — the records-management panel in the document Inspector.
// Shows the effective retention policy + state, lets a controller (canManage)
// place/release a LEGAL HOLD (which freezes the record against deletion), and
// dispose a record once it's past retention. Editing the policy can target this
// document, its folder, or the whole library.

import React, { useCallback, useEffect, useState } from "react";
import { Archive, Loader2, Pencil, Lock, Unlock, ShieldAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import RetentionPill from "@/components/documents/RetentionPill";
import {
  resolveEffectiveRetentionPolicy, setRetentionPolicy, placeLegalHold, releaseLegalHold, disposeDocument,
} from "@/lib/retention";
import type { DocumentRecord, RetentionPolicy } from "@/types/schema";

type Level = "document" | "collection" | "library";
type Basis = NonNullable<RetentionPolicy["basis"]>;
type Action = NonNullable<RetentionPolicy["action"]>;

function describe(p?: RetentionPolicy | null): string {
  if (!p || !p.enabled || !p.years) return "No retention policy";
  return `Retain ${p.years} year${p.years === 1 ? "" : "s"} from ${p.basis ?? "created"}`;
}

export default function RetentionSection({ doc, orgId, canManage }: {
  doc: DocumentRecord;
  orgId: string;
  canManage: boolean;
}) {
  const { uid, userEmail } = useRole();
  const [docPol, setDocPol] = useState<RetentionPolicy | null>(null);
  const [folderPol, setFolderPol] = useState<RetentionPolicy | null>(null);
  const [libPol, setLibPol] = useState<RetentionPolicy | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [state, setStateVal] = useState<string | null>(null);
  const [hold, setHold] = useState<{ on: boolean; matter: string | null; reason: string | null }>({ on: false, matter: null, reason: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"view" | "edit">("view");

  const load = useCallback(async () => {
    if (!doc.id) return;
    setLoading(true);
    try {
      const [{ data: d }, { data: lib }] = await Promise.all([
        supabase.from("documents").select("retention_policy, retention_until, disposition_state, legal_hold, legal_hold_matter, legal_hold_reason, collection_id").eq("id", doc.id).maybeSingle(),
        supabase.from("libraries").select("retention_policy").eq("id", doc.libraryId).maybeSingle(),
      ]);
      setDocPol((d?.retention_policy as RetentionPolicy) ?? null);
      setLibPol((lib?.retention_policy as RetentionPolicy) ?? null);
      setUntil((d?.retention_until as string | null) ?? null);
      setStateVal((d?.disposition_state as string | null) ?? null);
      setHold({ on: !!d?.legal_hold, matter: (d?.legal_hold_matter as string | null) ?? null, reason: (d?.legal_hold_reason as string | null) ?? null });
      const colId = (d?.collection_id as string | null) ?? doc.collectionId ?? null;
      if (colId) {
        const { data: c } = await supabase.from("collections").select("retention_policy").eq("id", colId).maybeSingle();
        setFolderPol((c?.retention_policy as RetentionPolicy) ?? null);
      } else setFolderPol(null);
    } finally { setLoading(false); }
  }, [doc.id, doc.libraryId, doc.collectionId]);

  useEffect(() => { void load(); }, [load]);

  const eff = resolveEffectiveRetentionPolicy(docPol, folderPol, libPol);
  const src: Level | null = docPol ? "document" : folderPol ? "collection" : libPol ? "library" : null;
  const eligible = state === "eligible";

  // ── Legal hold ──
  const placeHold = async () => {
    if (!doc.id) return;
    const matter = window.prompt("Legal hold — matter / case name:", hold.matter || "");
    if (matter == null || !matter.trim()) return;
    const reason = window.prompt("Reason (optional):", "") ?? "";
    setBusy(true);
    try { await placeLegalHold({ scope: "document", id: doc.id, orgId, matter: matter.trim(), reason: reason.trim() || undefined, actorId: uid, actorName: userEmail }); await load(); }
    finally { setBusy(false); }
  };
  const release = async () => {
    if (!doc.id) return;
    const reason = window.prompt("Release the legal hold — reason (optional):", "") ?? "";
    setBusy(true);
    try { await releaseLegalHold({ scope: "document", id: doc.id, orgId, reason: reason.trim() || undefined, actorId: uid, actorName: userEmail }); await load(); }
    finally { setBusy(false); }
  };
  const dispose = async () => {
    if (!doc.id) return;
    if (!window.confirm("Dispose this record? It will be archived and marked disposed (the audit trail is kept). This is a records-management action.")) return;
    setBusy(true);
    try {
      const res = await disposeDocument({ documentId: doc.id, orgId, action: "archive", actorId: uid, actorName: userEmail });
      if (!res.ok) window.alert(res.reason === "legal_hold" ? "This record is under a legal hold — release it first." : `Couldn't dispose: ${res.reason ?? "unknown"}`);
      await load();
    } finally { setBusy(false); }
  };

  // ── Policy editor ──
  const [scope, setScope] = useState<Level>("document");
  const [enabled, setEnabled] = useState(true);
  const [years, setYears] = useState(7);
  const [basis, setBasis] = useState<Basis>("created");
  const [action, setAction] = useState<Action>("review");
  const prefill = (lv: Level) => {
    const s = lv === "document" ? docPol : lv === "collection" ? folderPol : libPol;
    setEnabled(s?.enabled ?? true); setYears(s?.years ?? 7); setBasis(s?.basis ?? "created"); setAction(s?.action ?? "review");
  };
  const beginEdit = () => { setScope("document"); prefill("document"); setMode("edit"); };
  const targetId = scope === "document" ? doc.id : scope === "collection" ? doc.collectionId : doc.libraryId;
  const saveEdit = async () => {
    if (!targetId) return;
    setBusy(true);
    try {
      await setRetentionPolicy({ level: scope, id: targetId, orgId, policy: { enabled, years, basis, action }, actorId: uid, actorName: userEmail });
      setMode("view"); await load();
    } finally { setBusy(false); }
  };
  const clearPolicy = async () => {
    if (!targetId) return;
    setBusy(true);
    try { await setRetentionPolicy({ level: scope, id: targetId, orgId, policy: null, actorId: uid, actorName: userEmail }); setMode("view"); await load(); }
    finally { setBusy(false); }
  };

  const inp = "text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 outline-none focus:border-[var(--color-accent)]";

  return (
    <div className={`rounded-xl border p-3 space-y-2.5 ${hold.on ? "border-red-300 bg-red-50/40" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
      <div className="flex items-center gap-2">
        <Archive className="w-4 h-4 text-[var(--color-text-muted)]" />
        <span className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">Retention</span>
        <div className="ml-auto"><RetentionPill retentionUntil={until} dispositionState={state} legalHold={hold.on} /></div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
      ) : (
        <>
          {hold.on && (
            <div className="rounded-lg border border-red-200 bg-white p-2 text-[11px] text-red-800">
              <div className="flex items-center gap-1.5 font-bold"><ShieldAlert className="w-3.5 h-3.5" /> Legal hold{hold.matter ? `: ${hold.matter}` : ""}</div>
              {hold.reason && <div className="text-red-600 mt-0.5">{hold.reason}</div>}
              <div className="text-red-500 mt-0.5">This record can&apos;t be deleted or disposed until the hold is released.</div>
            </div>
          )}

          <div className="text-[11px] text-[var(--color-text)]">
            {eff
              ? <>{describe(eff)} · <span className="text-[var(--color-text-muted)]">from {src === "document" ? "this document" : src === "collection" ? "this folder" : "the library"}</span>{until && <span className="text-[var(--color-text-muted)]"> · until {until.slice(0, 10)}</span>}</>
              : <span className="text-[var(--color-text-muted)]">No retention policy set.</span>}
          </div>

          {canManage && mode === "view" && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {hold.on
                ? <button onClick={() => void release()} disabled={busy} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-[11px] font-bold hover:bg-[var(--color-surface-2)]"><Unlock className="w-3.5 h-3.5" /> Release hold</button>
                : <button onClick={() => void placeHold()} disabled={busy} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-300 text-red-700 text-[11px] font-bold hover:bg-red-50"><Lock className="w-3.5 h-3.5" /> Legal hold</button>}
              {eligible && !hold.on && (
                <button onClick={() => void dispose()} disabled={busy} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-bold"><Archive className="w-3.5 h-3.5" /> Dispose</button>
              )}
              <button onClick={beginEdit} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-[11px] font-bold hover:bg-[var(--color-surface-2)]"><Pencil className="w-3.5 h-3.5" /> {eff ? "Edit" : "Set policy"}</button>
            </div>
          )}

          {canManage && mode === "edit" && (
            <div className="space-y-2 pt-1 border-t border-[var(--color-border)]">
              <div className="flex gap-1">
                {(["document", "collection", "library"] as Level[]).map((lv) => (
                  <button key={lv} onClick={() => { setScope(lv); prefill(lv); }} disabled={lv === "collection" && !doc.collectionId}
                    className={`flex-1 px-2 py-1 rounded-lg text-[10px] font-bold disabled:opacity-30 ${scope === lv ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
                    {lv === "document" ? "This doc" : lv === "collection" ? "This folder" : "Library"}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-[11px] text-[var(--color-text)]">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require retention
              </label>
              {enabled && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-[var(--color-text-muted)]">Retain</span>
                  <input type="number" min={1} value={years} onChange={(e) => setYears(Math.max(1, parseInt(e.target.value) || 1))} className={`${inp} w-16`} />
                  <span className="text-[11px] text-[var(--color-text-muted)]">yrs from</span>
                  <select value={basis} onChange={(e) => setBasis(e.target.value as Basis)} className={inp}>
                    <option value="created">created</option><option value="issued">issued</option><option value="effective">effective</option><option value="superseded">superseded</option>
                  </select>
                  <span className="text-[11px] text-[var(--color-text-muted)]">then</span>
                  <select value={action} onChange={(e) => setAction(e.target.value as Action)} className={inp}>
                    <option value="review">review</option><option value="archive">archive</option><option value="destroy">destroy</option>
                  </select>
                </div>
              )}
              <div className="flex justify-between gap-2 pt-1">
                <button onClick={() => void clearPolicy()} disabled={busy} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50">Remove</button>
                <div className="flex gap-2">
                  <button onClick={() => setMode("view")} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)]">Cancel</button>
                  <button onClick={() => void saveEdit()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-[11px] font-bold disabled:opacity-50">{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
