"use client";

// ShareLinkModal — generate + manage time-limited public share links
// for a single document. Mounted from the inspector toolbar.
//
// Round F (P1 SHARE): minting is a controller-tier act (Admin / DocCtrl by
// collection) or a granted publisher of the library — the same authority
// that issues what the link serves; anyone else sees why the box is absent.
// The never-expiring option is gone and 90 days is the ceiling (lib/shareRules). A
// Draft / Superseded / Void / Archived or held document is refused with the
// reason before anything is inserted (and by the database if not). A share
// always serves the CURRENT revision — stated here and on the landing page;
// every link row says which revision it resolves to today, resolved by the
// same rule the public routes run (lib/shareRules resolveServedVersion), or
// that it is not serving and why.

import React, { useCallback, useEffect, useState } from "react";
import {
  X, Link as LinkIcon, Plus, Copy, Trash2, Loader2, AlertTriangle,
  CheckCircle2, ExternalLink, Eye, QrCode,
} from "lucide-react";
import {
  createShareLink, listShareLinks, revokeShareLink, loadShareDocumentContext, canMintShare,
  describeShareRefusal, SHARE_MAX_DAYS, type DocumentShare, type ShareServedState,
} from "@/lib/documentShares";
import { useRole } from "@/components/providers/RoleContext";
import { publicOrigin } from "@/lib/publicOrigin";
import QrBadge from "@/components/ui/QrBadge";
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

/** Every option expires; the last one is the ceiling. Exported for the test. */
export const DURATION_OPTIONS = [
  { label: "24 hours", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days (default)", days: 30 },
  { label: `${SHARE_MAX_DAYS} days (maximum)`, days: SHARE_MAX_DAYS },
];

export default function ShareLinkModal({
  isOpen, onClose, orgId, documentId, documentLabel,
  createdBy, createdByName,
}: Props) {
  const { hasAnyRole } = useRole();
  const isController = hasAnyRole(["Admin", "DocCtrl"]);
  const [shares, setShares] = useState<DocumentShare[]>([]);
  // EGRESS-8: whether the caller can read the document. When not, the server
  // lists only the caller's own links and withholds every token — nothing
  // below renders a URL it cannot use, and no new link can be created.
  const [readable, setReadable] = useState(true);
  // Who may mint (controller tier / granted publisher) and why the document
  // cannot be shared right now (status / archive / hold) — null = shareable.
  const [canMint, setCanMint] = useState<boolean | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [currentRev, setCurrentRev] = useState<string | null>(null);
  const [docStatus, setDocStatus] = useState<string | null>(null);
  // What a link serves right now, by the routes' own rule (SHR-7).
  const [served, setServed] = useState<ShareServedState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The listing's own failure, kept apart from the document context: a list
  // error says nothing about who may mint.
  const [listError, setListError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [days, setDays] = useState<number>(30);
  const [copied, setCopied] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null); setListError(null);
    try {
      let readableNow = true;
      try {
        const listing = await listShareLinks(documentId);
        readableNow = listing.readable;
        setReadable(listing.readable);
        setShares(listing.shares);
      } catch (e) { setListError((e as Error).message); }
      if (!readableNow) {
        // EGRESS-8: the caller cannot read the document, so the documents
        // read would come back empty ("Document not found") — there is no
        // context to load and nothing to mint. The amber notice says so.
        setCanMint(null); setRefusal(null); setCurrentRev(null); setDocStatus(null); setServed(null);
        return;
      }
      try {
        const ctx = await loadShareDocumentContext(documentId);
        setCurrentRev(ctx.rev);
        setDocStatus(ctx.status);
        setServed(ctx.served);
        const [allowed, why] = await Promise.all([
          canMintShare({ orgId, uid: createdBy, libraryId: ctx.libraryId, isController }),
          describeShareRefusal(documentId),
        ]);
        setCanMint(allowed);
        setRefusal(why);
      } catch (e) {
        // Unknown document state: neither "you may not mint" nor a Create box.
        setError((e as Error).message); setCanMint(null); setServed(null);
      }
    } finally { setLoading(false); }
  }, [documentId, orgId, createdBy, isController]);

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

  // PHYS-13: the copied link and the QR carry the PUBLIC origin — a link
  // minted on a preview deploy must not dead-end an outsider on a Vercel
  // login. publicOrigin() falls back to the browser origin only when
  // NEXT_PUBLIC_SITE_URL is unset (see lib/publicOrigin.ts).
  const origin = publicOrigin();
  const baseUrl = origin ? `${origin}/share/` : "/share/";
  const showCreate = readable && canMint === true && refusal === null;
  // What every live link resolves to today — the same answer for every row
  // (a share always serves the current revision), stated the way the public
  // routes would decide it: refused with the reason, no published file, or
  // the served revision's own label.
  const resolvesTo: string | null = !readable || served === null ? null
    : refusal ? "not serving now — see above"
    : served.kind === "served" ? `resolves to Rev ${served.rev || "0"}`
    : served.kind === "none" ? "no published file to serve"
    : "couldn't confirm which revision it serves";

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 rounded-lg bg-teal-100 text-teal-700"><LinkIcon className="w-5 h-5" /></div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Share link</div>
            <div className="text-xs text-[var(--color-text-muted)] truncate">
              {documentLabel ?? documentId.slice(0, 8)}
              {currentRev !== null && <> · Rev {currentRev || "0"}</>}
              {docStatus && <> · {docStatus}</>}
            </div>
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

          {listError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> Couldn&rsquo;t load the existing links: {listError}
            </div>
          )}

          {!readable && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                You can&rsquo;t currently read this document, so its share links aren&rsquo;t shown and no new link can be created.
                Links you created are listed below without their URL &mdash; revoke any that are no longer needed.
              </span>
            </div>
          )}

          {readable && !loading && canMint === false && (
            <div className="rounded-lg bg-slate-50 border border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                Sharing a document outside the organisation is a Document Control / Admin act, or one for a publisher granted on this library.
                Ask a controller to mint the link; existing links are listed below.
              </span>
            </div>
          )}

          {readable && !loading && refusal && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>No new link can be created, and existing links are not serving: {refusal}</span>
            </div>
          )}

          {showCreate && <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-2">
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
              Anyone with the resulting URL can download a stamped, uncontrolled copy until the link expires (at most {SHARE_MAX_DAYS} days) or you revoke it.
              A share always serves the <b>current</b> revision &mdash; today {served?.kind === "served" ? <>Rev {served.rev || "0"}</> : served?.kind === "none" ? <>no published file</> : <>unconfirmed</>}; if the document is revved, the same link serves the new revision.
              It does not serve while the document is on hold, voided or archived (and serves again if that is undone); superseding the document revokes it. Every download is recorded on the distribution record.
            </div>
          </div>}

          <div>
            <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-2">Existing links ({shares.length})</div>
            {loading ? (
              <div className="text-xs text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>
            ) : shares.length === 0 ? (
              <div className="text-xs italic text-[var(--color-text-faint)]">None yet.</div>
            ) : (
              <ul className="space-y-2">
                {shares.map((s) => {
                  // No token → the server withheld it (EGRESS-8): render no URL,
                  // no copy / QR / open — only the metadata and Revoke.
                  const url = s.token ? `${baseUrl}${s.token}` : null;
                  const isRevoked = !!s.revokedAt;
                  const isExpired = !!s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
                  const dead = isRevoked || isExpired;
                  const usable = !!url && readable && !dead;
                  return (
                    <li key={s.id} className={`rounded-lg border p-3 ${dead ? "border-[var(--color-border)] bg-slate-50/50 opacity-60" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
                      <div className="flex items-center gap-2">
                        {url ? (
                          <input
                            readOnly
                            value={url}
                            onClick={(e) => (e.target as HTMLInputElement).select()}
                            className="flex-1 px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[11px] font-mono text-[var(--color-text)]"
                          />
                        ) : (
                          <div className="flex-1 px-2 py-1 rounded border border-dashed border-[var(--color-border)] text-[11px] italic text-[var(--color-text-faint)]">
                            Link hidden &mdash; you can&rsquo;t read this document
                          </div>
                        )}
                        {usable && url && (
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
                            <button
                              onClick={() => setQrFor(qrFor === s.id ? null : s.id)}
                              className={`p-1.5 rounded-md ${qrFor === s.id ? "bg-slate-800 text-white" : "bg-[var(--color-surface-2)] hover:bg-slate-200 text-[var(--color-text)]"}`}
                              title="Show QR — hand the link to the person next to you"
                            >
                              <QrCode className="w-3.5 h-3.5" />
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
                          </>
                        )}
                        {!dead && (
                          <button
                            onClick={() => void revoke(s.id)}
                            className="p-1.5 rounded-md bg-rose-100 hover:bg-rose-200 text-rose-700"
                            title="Revoke"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="mt-2 text-[10px] text-[var(--color-text-muted)] flex flex-wrap items-center gap-x-3 gap-y-1">
                        {s.note && <span className="italic text-[var(--color-text-muted)]">&ldquo;{s.note}&rdquo;</span>}
                        {s.createdByName && <span>by {s.createdByName}</span>}
                        {!dead && resolvesTo && <span title="A share always serves the current revision">{resolvesTo}</span>}
                        {s.expiresAt && (
                          <span>{isExpired ? "expired" : "expires"} {new Date(s.expiresAt).toLocaleDateString()}</span>
                        )}
                        {isRevoked && <span className="text-rose-700">revoked</span>}
                        <span className="inline-flex items-center gap-0.5" title="Times the link was opened"><Eye className="w-2.5 h-2.5" /> {s.accessCount}</span>
                      </div>
                      {qrFor === s.id && usable && url && (
                        <div className="mt-2 flex justify-center animate-in fade-in">
                          <QrBadge value={url} size={140} caption="Scan to open this share link" />
                        </div>
                      )}
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
