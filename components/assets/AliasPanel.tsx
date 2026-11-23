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
import { Plus, X, Sparkles, Hand, ScanEye } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonText } from "@/components/ui/Skeleton";
import { friendlyError } from "@/lib/friendlyError";
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
    } catch (e) { setError(`Couldn't add ${alias}. ${friendlyError(e)}`); }
    finally { setBusy(false); }
  };

  const remove = async (a: AssetAlias) => {
    setError(null);
    try { await removeAssetAlias(a.id); await refresh(); }
    catch (e) { setError(`Couldn't remove ${a.alias}. ${friendlyError(e)}`); }
  };

  return (
    <section className="min-w-0">
      <div className="flex items-end gap-2 mb-3 min-h-8">
        <h2 className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)]">Also known as</h2>
        {rows && rows.length > 0 && <span className="ui-count">{rows.length}</span>}
      </div>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 space-y-3">
      <p className="text-[14px] text-[var(--color-text-muted)]">
        Nicknames, old tags before a renumber, vendor names.
      </p>
      {rows === null && <SkeletonText lines={1} />}
      {loadFailed && <ErrorNote compact title="Couldn't load the other names." onRetry={() => void refresh()} />}

      {rows && rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rows.map((a) => {
            const Icon = ORIGIN_ICON[a.origin] ?? Hand;
            return (
              <span key={a.id}
                title={`${ALIAS_ORIGIN_LABELS[a.origin] ?? a.origin}${a.created_by_name ? ` · ${a.created_by_name}` : ""}`}
                className="group ui-tag !pr-0.5">
                <Icon className="w-3 h-3 opacity-70" />
                {a.alias}
                {canManage && (
                  <button onClick={() => void remove(a)}
                    aria-label={`Remove alias ${a.alias}`}
                    className="w-5 h-5 grid place-items-center rounded hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface)]">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {canManage && rows !== null && (
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. the north furnace, F-101 (old tag)"
            aria-label="Another name for this equipment"
            enterKeyHint="done"
            autoComplete="off"
            className="flex-1 min-w-0 h-10 pointer-coarse:h-11 px-3 border border-[var(--color-border-control)] rounded-lg text-[15px] max-sm:text-[16px] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]"
          />
          <Button type="submit" variant="secondary" loading={busy} disabled={!draft.trim()}>
            <Plus aria-hidden className="w-4 h-4" /> Add
          </Button>
        </form>
      )}

      {rows && rows.length === 0 && !canManage && !loadFailed && (
        <div className="text-[14px] text-[var(--color-text-muted)]">No other names recorded.</div>
      )}
      {error && <ErrorNote compact title={error} next="" />}
      </div>
    </section>
  );
}
