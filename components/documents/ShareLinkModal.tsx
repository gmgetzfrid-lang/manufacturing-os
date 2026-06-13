"use client";

// ShareLinkModal — generate + manage time-limited public share links
// for a single document. Mounted from the inspector toolbar.

import React, { useCallback, useEffect, useState } from "react";
import {
  X, Link as LinkIcon, Plus, Copy, Trash2, Loader2, AlertTriangle,
  CheckCircle2, ExternalLink, Eye,
} from "lucide-react";
import {
  createShareLink, listShareLinks, revokeShareLink, type DocumentShare,
} from "@/lib/documentShares";
import { appConfirm } from "@/components/providers/DialogProvider";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  orgId: string;
  documentId: string;
  documentLabel?: string;
  createdBy: string;
  createdByName?: string;
}

const DURATION_OPTIONS = [
  { label: "24 hours", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days (default)", days: 30 },
  { label: "90 days", days: 90 },
  { label: "Never expires", days: 0 },
];

export default function ShareLinkModal({
  isOpen, onClose, orgId, documentId, documentLabel,
  createdBy, createdByName,
}: Props) {
  const [shares, setShares] = useState<DocumentShare[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [days, setDays] = useState<number>(30);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const list = await listShareLinks(documentId);
      setShares(list);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [documentId]);

  useEffect(() => { if (isOpen) void refresh(); }, [isOpen, refresh]);

  if (!isOpen) return null;

  const create = async () => {
    setBusy(true); setError(null);
    try {
      await createShareLink({
        orgId, documentId, expiresInDays: days,
        note: note.trim() || undefined,
        createdBy, createdByName,
      });
      setNote("");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const revoke = async (id: string) => {
    if (!(await appConfirm({ title: "Revoke share link", message: "Revoke this share link? Anyone using it loses access immediately.", tone: "danger" }))) return;
    try { await revokeShareLink(id, createdBy); await refresh(); }
    catch (e) { setError((e as Error).message); }
  };

  const baseUrl = typeof window !== "undefined" ? `${window.location.origin}/share/` : "/share/";

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 rounded-lg bg-teal-100 text-teal-700"><LinkIcon className="w-5 h-5" /></div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Share link</div>
            <div className="text-xs text-[var(--color-text-muted)] truncate">{documentLabel ?? documentId.slice(0, 8)}</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-2">
            <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Create new</div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note — e.g. &quot;for John at the vendor&quot;"
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm"
              disabled={busy}
            />
            <div className="flex items-center gap-2">
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                disabled={busy}
              >
                {DURATION_OPTIONS.map((o) => (
                  <option key={o.days} value={o.days}>{o.label}</option>
                ))}
              </select>
              <button
                onClick={create}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Create link
              </button>
            </div>
            <div className="text-[10px] text-[var(--color-text-muted)]">
              Anyone with the resulting URL can open the document until it expires or you revoke it. Every access is counted.
            </div>
          </div>

          <div>
            <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-2">Existing links ({shares.length})</div>
            {loading ? (
              <div className="text-xs text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>
            ) : shares.length === 0 ? (
              <div className="text-xs italic text-[var(--color-text-faint)]">None yet.</div>
            ) : (
              <ul className="space-y-2">
                {shares.map((s) => {
                  const url = `${baseUrl}${s.token}`;
                  const isRevoked = !!s.revokedAt;
                  const isExpired = !!s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
                  const dead = isRevoked || isExpired;
                  return (
                    <li key={s.id} className={`rounded-lg border p-3 ${dead ? "border-[var(--color-border)] bg-slate-50/50 opacity-60" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={url}
                          onClick={(e) => (e.target as HTMLInputElement).select()}
                          className="flex-1 px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[11px] font-mono text-[var(--color-text)]"
                        />
                        {!dead && (
                          <>
                            <button
                              onClick={async () => {
                                try { await navigator.clipboard.writeText(url); setCopied(s.id); setTimeout(() => setCopied(null), 1500); }
                                catch { /* ignore */ }
                              }}
                              className="p-1.5 rounded-md bg-[var(--color-surface-2)] hover:bg-slate-200 text-[var(--color-text)]"
                              title="Copy"
                            >
                              {copied === s.id ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1.5 rounded-md bg-[var(--color-surface-2)] hover:bg-slate-200 text-[var(--color-text)]"
                              title="Open"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                            <button
                              onClick={() => void revoke(s.id)}
                              className="p-1.5 rounded-md bg-rose-100 hover:bg-rose-200 text-rose-700"
                              title="Revoke"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="mt-2 text-[10px] text-[var(--color-text-muted)] flex flex-wrap items-center gap-x-3 gap-y-1">
                        {s.note && <span className="italic text-[var(--color-text-muted)]">&ldquo;{s.note}&rdquo;</span>}
                        {s.createdByName && <span>by {s.createdByName}</span>}
                        {s.expiresAt && (
                          <span>{isExpired ? "expired" : "expires"} {new Date(s.expiresAt).toLocaleDateString()}</span>
                        )}
                        {isRevoked && <span className="text-rose-700">revoked</span>}
                        <span className="inline-flex items-center gap-0.5"><Eye className="w-2.5 h-2.5" /> {s.accessCount}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
