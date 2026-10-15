"use client";

// components/documents/SuspectEquipment.tsx — equipment the drawings gave
// the registry by mistake, shown with the text each was read from, removed
// only on a person's word. Renders nothing when the registry is clean.

import React, { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Trash2, CheckCircle2 } from "lucide-react";
import { estatePost } from "@/lib/estate/client";
import type { SuspectList } from "@/lib/estate/discoveredServer";

export default function SuspectEquipment({ orgId, refreshKey = "", onRemoved }: { orgId: string; refreshKey?: string; onRemoved?: () => void }) {
  const [state, setState] = useState<{ key: string; list: SuspectList | null; error: string | null }>({ key: "", list: null, error: null });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const key = `${orgId}|${refreshKey}`;
  useEffect(() => {
    let alive = true;
    estatePost<SuspectList>("/api/estate/discovered", { orgId, action: "list" })
      .then((list) => { if (alive) { setState({ key, list, error: null }); setPicked(null); } })
      .catch((e) => { if (alive) setState({ key, list: null, error: (e as Error).message }); });
    return () => { alive = false; };
  }, [orgId, key]);
  const list = state.key === key ? state.list : null;
  if (done) return <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2 text-xs text-emerald-800 inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> {done}</div>;
  if (!list || list.items.length === 0) return null;
  const sel = picked ?? new Set(list.items.map((i) => i.id));
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };
  const remove = async () => {
    if (!sel.size) return;
    if (!window.confirm(`Remove ${sel.size} item${sel.size === 1 ? "" : "s"} from the equipment registry? Only items the drawings created and nobody has touched are removed; each is checked again on the server first.`)) return;
    setBusy(true);
    try {
      const r = await estatePost<{ removed: number; columnsCleaned: number }>("/api/estate/discovered", { orgId, action: "remove", ids: [...sel] });
      setDone(`Removed ${r.removed} item${r.removed === 1 ? "" : "s"} from the registry${r.columnsCleaned ? `, and their tags from ${r.columnsCleaned} document${r.columnsCleaned === 1 ? "" : "s"}` : ""}.`);
      onRemoved?.();
    } catch (e) { setState((s) => ({ ...s, error: (e as Error).message })); }
    finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50/70 dark:bg-amber-950/20 p-2.5 space-y-2 text-xs">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
        <div>
          <div className="font-bold">{list.items.length} item{list.items.length === 1 ? "" : "s"} in the equipment registry {list.items.length === 1 ? "was" : "were"} read off a drawing by mistake</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">Drawing numbers, pipe specs, nameplates and revisions that an earlier reader took for equipment. Items with photos, files, notes, manual tags or edits are never listed.{list.readingInProgress ? " Drawings are still being read, so items on no sheet yet are not judged." : ""}</div>
        </div>
      </div>
      {state.error && <div className="text-red-700">{state.error}</div>}
      <ul className="max-h-56 overflow-y-auto space-y-0.5">
        {list.items.map((i) => (
          <li key={i.id}>
            <label className="flex items-start gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-amber-100/60 dark:hover:bg-amber-900/30">
              <input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} className="mt-0.5 w-3.5 h-3.5 accent-amber-600" />
              <span className="min-w-0">
                <span className="font-bold font-mono">{i.tag}</span>
                <span className="text-[var(--color-text-muted)]"> · {i.reason === "on-no-sheet" ? "on no sheet any more" : <>read from &ldquo;<span className="font-mono">{(i.readFrom ?? "").slice(0, 60)}</span>&rdquo;</>}{i.sheets ? ` · ${i.sheets} sheet${i.sheets === 1 ? "" : "s"}` : ""}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button onClick={() => void remove()} disabled={busy || !sel.size} className="rounded-lg bg-amber-600 text-white px-3 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-50">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Remove {sel.size} from the registry
      </button>
    </div>
  );
}
