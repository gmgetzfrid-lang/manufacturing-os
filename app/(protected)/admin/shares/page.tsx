"use client";

// /admin/shares — DIST-15: every external share link in the organisation, in
// one place, with per-row and bulk revoke.
//
// The list is read by the server (/api/share/inventory): the controller tier
// by the caller's role COLLECTION (isControllerRole — no role list here or
// there, DEC-35); anyone else sees the server's refusal. It carries no token.
// Live links come first; expired and revoked ones stay listed for the record.
// A creator who is no longer an active member is marked — their links already
// stop serving at the next resolve, and here they can be revoked for the
// record in one act. Every revocation, one row or many, goes through
// revokeShareLink — the checked, audited revoke the share modal uses — so each
// revoked link writes its own SHARE_LINK_REVOKED row; a refusal is reported
// for its row and never read as revoked.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Link2, Loader2, AlertTriangle, CheckCircle2, UserX, Ban } from "lucide-react";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import { supabase } from "@/lib/supabase";
import { revokeShareLink } from "@/lib/documentShares";
import {
  loadShareInventory, revokeShareLinks, shareBulkTargets, shareLinkState, sortShareInventory,
  SHARE_INVENTORY_LIMIT, type ShareBulkRevokeResult, type ShareBulkSelection, type ShareInventoryRow,
} from "@/lib/shareInventory";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
const STATE_LABEL = { live: "Live", expired: "Expired", revoked: "Revoked" } as const;
const STATE_CLASS = {
  live: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired: "bg-slate-100 text-slate-600 border-slate-200",
  revoked: "bg-rose-50 text-rose-700 border-rose-200",
} as const;

export default function ShareLinksAdminPage() {
  const { activeOrgId, uid } = useRole();
  const [rows, setRows] = useState<ShareInventoryRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShareBulkRevokeResult | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const inv = await loadShareInventory(activeOrgId, session?.access_token);
      setRows(sortShareInventory(inv.rows));
      setTruncated(inv.truncated);
      setSelected(new Set());
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const now = Date.now();
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => (showAll || shareLinkState(r, now) === "live") && (!q || [
      r.documentNumber, r.documentTitle, r.createdByName, r.libraryName, r.note,
    ].some((v) => (v ?? "").toLowerCase().includes(q))));
  }, [rows, showAll, query, now]);
  const liveCount = rows.filter((r) => shareLinkState(r, now) === "live").length;
  const leaverCount = rows.filter((r) => shareLinkState(r, now) === "live" && !r.creatorActive).length;

  // The bulk scopes offered: creators, documents and libraries that have live links.
  const scopes = useMemo(() => {
    const live = rows.filter((r) => shareLinkState(r, now) === "live");
    const uniq = <T,>(xs: Array<[string, T]>) => [...new Map(xs).entries()];
    return {
      creators: uniq(live.map((r) => [r.createdBy, `${r.createdByName || r.createdBy}${r.creatorActive ? "" : " (no longer a member)"}`] as [string, string])),
      documents: uniq(live.map((r) => [r.documentId, r.documentNumber || r.documentTitle || r.documentId] as [string, string])),
      libraries: uniq(live.filter((r) => r.libraryId).map((r) => [r.libraryId as string, r.libraryName || (r.libraryId as string)] as [string, string])),
    };
  }, [rows, now]);

  const runRevoke = async (sel: ShareBulkSelection, what: string) => {
    if (!uid) return;
    const ids = shareBulkTargets(rows, sel);
    if (ids.length === 0) return;
    if (!(await appConfirm({
      title: `Revoke ${ids.length} share link${ids.length === 1 ? "" : "s"}?`,
      message: `${what}. Each link stops working at once and its revocation is written to the audit log. This cannot be undone — a new link can be made from the document if needed.`,
      tone: "danger",
    }))) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await revokeShareLinks(ids, uid, revokeShareLink));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <PageShell width="work" className="space-y-5">
      <PageHeaderBar
        icon={Link2}
        title="Share links"
        subtitle="Every external link to a document in this organisation — who made it, when it expires, how often it was opened. Revoke one, a selection, or all of a person's, a document's or a library's links."
      />

      {error && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {result && (
        <div className="space-y-2" aria-live="polite">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            Revoked <b>{result.revoked.length}</b> link{result.revoked.length === 1 ? "" : "s"}.
          </div>
          {result.failed.length > 0 && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
              <div className="font-bold mb-1">{result.failed.length} not revoked</div>
              <ul className="ml-5 list-disc">{result.failed.slice(0, 8).map((f) => <li key={f.id}>{f.reason}</li>)}</ul>
            </div>
          )}
          {result.auditWarnings.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <ul className="ml-5 list-disc">{result.auditWarnings.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {!error && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span><b>{liveCount}</b> live</span>
            {leaverCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-700"><UserX className="w-4 h-4" /> {leaverCount} by people no longer in the organisation</span>
            )}
            <label className="inline-flex items-center gap-1.5 text-xs ml-auto">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show expired and revoked
            </label>
            <input
              value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by document, person, library…"
              className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs w-64"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              disabled={busy || selected.size === 0}
              onClick={() => void runRevoke({ kind: "selected", ids: [...selected] }, `${selected.size} selected link${selected.size === 1 ? "" : "s"}`)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 text-white font-bold disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />} Revoke selected ({selected.size})
            </button>
            <BulkScope label="All by" options={scopes.creators} disabled={busy}
              onPick={(id, name) => void runRevoke({ kind: "creator", createdBy: id }, `Every live link made by ${name}`)} />
            <BulkScope label="All on" options={scopes.documents} disabled={busy}
              onPick={(id, name) => void runRevoke({ kind: "document", documentId: id }, `Every live link to ${name}`)} />
            <BulkScope label="All in library" options={scopes.libraries} disabled={busy}
              onPick={(id, name) => void runRevoke({ kind: "library", libraryId: id }, `Every live link to a document in ${name}`)} />
          </div>
          {truncated && (
            <p className="text-xs text-amber-700">Showing the newest {SHARE_INVENTORY_LIMIT} links; older ones are not listed here.</p>
          )}

          {loading ? (
            <div className="py-10 text-center text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading…</div>
          ) : visible.length === 0 ? (
            <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">{showAll ? "No share links." : "No live share links."}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-[var(--color-text-muted)]">
                  <tr>
                    <th className="p-2" />
                    <th className="p-2">Document</th>
                    <th className="p-2">Made by</th>
                    <th className="p-2">Created</th>
                    <th className="p-2">Expires</th>
                    <th className="p-2">Opened</th>
                    <th className="p-2">State</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const state = shareLinkState(r, now);
                    return (
                      <tr key={r.id} className="border-t border-[var(--color-border)] align-top">
                        <td className="p-2">
                          {state === "live" && (
                            <input type="checkbox" aria-label={`Select the link to ${r.documentNumber ?? r.documentId}`}
                              checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                          )}
                        </td>
                        <td className="p-2">
                          {r.libraryId ? (
                            <Link href={`/documents/${r.libraryId}?doc=${r.documentId}`} className="font-bold hover:underline">{r.documentNumber || r.documentTitle || r.documentId}</Link>
                          ) : <span className="font-bold">{r.documentNumber || r.documentTitle || r.documentId}</span>}
                          <div className="text-[var(--color-text-muted)]">{r.documentTitle}{r.documentStatus ? ` · ${r.documentStatus}` : ""}{r.libraryName ? ` · ${r.libraryName}` : ""}</div>
                          {r.note && <div className="italic text-[var(--color-text-faint)]">“{r.note}”</div>}
                        </td>
                        <td className="p-2">
                          {r.createdByName || r.createdBy}
                          {!r.creatorActive && (
                            <div className="inline-flex items-center gap-1 text-amber-700"><UserX className="w-3 h-3" /> no longer an active member</div>
                          )}
                        </td>
                        <td className="p-2 whitespace-nowrap">{fmt(r.createdAt)}</td>
                        <td className="p-2 whitespace-nowrap">{r.expiresAt ? fmt(r.expiresAt) : "never (legacy)"}</td>
                        <td className="p-2 whitespace-nowrap">{r.accessCount}×{r.accessLastAt ? ` · last ${fmt(r.accessLastAt)}` : ""}</td>
                        <td className="p-2">
                          <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATE_CLASS[state]}`}>{STATE_LABEL[state]}</span>
                          {state === "revoked" && <div className="text-[var(--color-text-faint)]">{fmt(r.revokedAt)}</div>}
                        </td>
                        <td className="p-2">
                          {state === "live" && (
                            <button disabled={busy}
                              onClick={() => void runRevoke({ kind: "selected", ids: [r.id] }, `The link to ${r.documentNumber || r.documentTitle || "this document"} made by ${r.createdByName || r.createdBy}`)}
                              className="px-2 py-1 rounded-md border border-rose-200 text-rose-700 font-bold hover:bg-rose-50 disabled:opacity-50">
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

function BulkScope({ label, options, disabled, onPick }: {
  label: string; options: Array<[string, string]>; disabled: boolean; onPick: (id: string, name: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <select
      value="" disabled={disabled} aria-label={`Revoke ${label.toLowerCase()}`}
      onChange={(e) => { const id = e.target.value; const name = options.find(([k]) => k === id)?.[1] ?? id; if (id) onPick(id, name); }}
      className="px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <option value="">Revoke {label.toLowerCase()}…</option>
      {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select>
  );
}
