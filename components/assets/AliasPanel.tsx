"use client";

// AliasPanel — teach the system what people actually call this equipment.
//
// Punctuation and case are already handled for every asset automatically
// (E-22 = E22 = "e 22"). This is for the names no rule can derive: the
// nickname, the tag before a renumber, the vendor's name for the skid.
//
// Teaching one here makes it work everywhere at once — typing it finds this
// hub, search matches it, the drawing→equipment bridge accepts it, and the
// link proposer can connect documents that only ever used the nickname.

import React, { useCallback, useEffect, useState } from "react";
import { Tags, Plus, X, Loader2, Sparkles, Hand, ScanEye } from "lucide-react";
import {
  listAssetAliases, addAssetAlias, removeAssetAlias,
  ALIAS_ORIGIN_LABELS, type AssetAlias, type AliasOrigin,
} from "@/lib/assetAliases";

const ORIGIN_ICON: Record<AliasOrigin, React.ComponentType<{ className?: string }>> = {
  human: Hand, extraction: Sparkles, vision: ScanEye,
};

export default function AliasPanel({
  orgId, assetId, canManage, userId, userName,
}: {
  orgId: string;
  assetId: string;
  canManage: boolean;
  userId?: string;
  userName?: string;
}) {
  const [rows, setRows] = useState<AssetAlias[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const refresh = useCallback(async () => {
    try { setRows(await listAssetAliases(assetId)); setLoadFailed(false); }
    catch { setLoadFailed(true); setRows([]); }
  }, [assetId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const add = async () => {
    const alias = draft.trim();
    if (!alias) return;
    setBusy(true); setError(null);
    try {
      await addAssetAlias({ orgId, assetId, alias, userId, userName });
      setDraft("");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async (a: AssetAlias) => {
    setError(null);
    try { await removeAssetAlias(a.id); await refresh(); }
    catch (e) { setError(`Couldn't remove ${a.alias}: ${(e as Error).message}`); }
  };

  if (rows === null) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 text-[13px] text-[var(--color-text-muted)] flex items-center gap-2 w-full">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading other names…
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 space-y-2.5">
      <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
        <Tags className="w-4 h-4" />
        <h2 className="text-[13px] font-semibold text-[var(--color-text-muted)]">Also known as</h2>
      </div>
      <p className="text-[13px] text-[var(--color-text-muted)]">
        Nicknames, old tags before a renumber, vendor names.
      </p>
      {loadFailed && (
        <p role="alert" className="text-[13px] text-[var(--state-overdue)]">
          Couldn&apos;t load the other names. <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>
        </p>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rows.map((a) => {
            const Icon = ORIGIN_ICON[a.origin] ?? Hand;
            return (
              <span key={a.id}
                title={`${ALIAS_ORIGIN_LABELS[a.origin] ?? a.origin}${a.created_by_name ? ` · ${a.created_by_name}` : ""}`}
                className="group inline-flex items-center gap-1 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] pl-2 pr-1 py-0.5 text-[13px] font-bold text-[var(--color-text)]">
                <Icon className="w-3 h-3 text-[var(--color-text-faint)]" />
                {a.alias}
                {canManage && (
                  <button onClick={() => void remove(a)}
                    aria-label={`Remove alias ${a.alias}`}
                    className="p-0.5 rounded-full text-[var(--color-text-faint)] hover:text-[var(--state-overdue)] opacity-50 group-hover:opacity-100">
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {canManage && (
        <div className="flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="e.g. the north furnace, F-101 (old tag)"
            aria-label="Another name for this equipment"
            className="flex-1 min-w-0 h-9 px-2.5 border border-[var(--color-border-strong)] rounded-lg text-[13px] bg-[var(--color-surface)]"
          />
          <button onClick={() => void add()} disabled={busy || !draft.trim()}
            className="inline-flex items-center gap-1 h-9 px-3 rounded-lg text-[13px] font-bold text-[var(--color-surface)] bg-[var(--color-text)] hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Teach
          </button>
        </div>
      )}

      {rows.length === 0 && !canManage && !loadFailed && (
        <div className="text-[13px] text-[var(--color-text-faint)] italic">No other names recorded.</div>
      )}
      {error && <div role="alert" className="text-[13px] text-[var(--state-overdue)]">{error}</div>}
    </section>
  );
}
