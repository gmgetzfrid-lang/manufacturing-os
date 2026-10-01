"use client";

// /transmittal/<token> — the recipient's side of a transmittal. Isolated,
// token-gated, no account (same trust model as the intake portal): the
// contractor sees the official record — number, purpose, the document/rev
// list — downloads the files EXACTLY as sent, and acknowledges receipt
// with their name. That acknowledgment is the org's their-side,
// timestamped proof of delivery.
//
// TRX-5: downloads stream through /api/transmittal, which stamps each PDF
// UNCONTROLLED with the as-issued revision and a verify QR and records the
// copy before it is released — this page only saves the bytes it is given,
// and says so when a file arrived WITHOUT the marking (not a PDF, or a PDF
// too large to mark: the route's X-Transmittal-Stamped header).
// TRX-3 / TRX-8: each document shows its status and effective date AS SENT
// and the fingerprint (SHA-256) and size of the file issued. TRX-4: a revoked
// or expired link says so, distinctly from a voided transmittal.

import React, { useCallback, useEffect, useState } from "react";
import {
  FileText, Loader2, AlertTriangle, CheckCircle2, Download, Building2, PenLine,
} from "lucide-react";

interface PortalItem {
  documentId: string; number: string; title: string | null; rev: string | null;
  statusAsSent?: string | null; effectiveDate?: string | null; fileHash?: string | null; fileSize?: number | null;
}
interface PortalData {
  number: string; subject: string | null; purpose: string | null; status: string;
  notes: string | null; orgName: string | null; fromName: string | null;
  issuedAt: string | null; acknowledgedAt: string | null; acknowledgedByName: string | null;
  recipientName: string | null; recipientCompany: string | null;
  portalExpiresAt?: string | null;
  items: PortalItem[];
}

/** The issued file's size, as the record shows it. */
function sizeLabel(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

/** What the route's refusal codes mean to the recipient. */
function downloadError(status: number, body: { error?: string } | null): string {
  const code = body?.error;
  if (code === "revoked") return "The issuer has revoked this link — contact them for access.";
  if (code === "expired") return "This link has expired — contact the issuer for a fresh one.";
  if (code === "voided") return "This transmittal was voided by the issuer.";
  if (code === "unrecorded") return "The download could not be recorded on the issuer's distribution record, so the file was not released. Try again shortly.";
  return code || `The file couldn't be prepared (HTTP ${status}).`;
}

export default function TransmittalPortal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = React.use(params);
  const [state, setState] = useState<"loading" | "ok" | "voided" | "revoked" | "expired" | "notfound" | "error">("loading");
  const [data, setData] = useState<PortalData | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [ackName, setAckName] = useState("");
  const [ackNote, setAckNote] = useState("");
  const [ackBusy, setAckBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/transmittal?token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setState(body?.error === "voided" ? "voided"
          : body?.error === "revoked" ? "revoked"
          : body?.error === "expired" ? "expired"
          : res.status === 404 ? "notfound" : "error");
        return;
      }
      setData((await res.json()) as PortalData);
      setState("ok");
    } catch { setState("error"); }
  }, [token]);
  useEffect(() => { void refresh(); }, [refresh]);

  const download = async (docId: string) => {
    setDownloading(docId); setMsg(null);
    try {
      // The server stamps and records before it responds — this saves the blob.
      const res = await fetch(`/api/transmittal?token=${encodeURIComponent(token)}&file=${encodeURIComponent(docId)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(downloadError(res.status, body));
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const named = disposition.match(/filename="([^"]+)"/)?.[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = named || "document";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (res.headers.get("x-transmittal-stamped") === "0") {
        setMsg({ tone: "ok", text: `${named || "The file"} was released without the UNCONTROLLED marking (it is not a PDF, or it is too large to mark). It is the file as issued — confirm with the issuer that this revision is still current before you use it.` });
      }
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally { setDownloading(null); }
  };

  const acknowledge = async () => {
    if (!ackName.trim()) { setMsg({ tone: "err", text: "Enter your name to acknowledge receipt." }); return; }
    setAckBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/transmittal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name: ackName.trim(), note: ackNote.trim() || undefined }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error === "revoked" || body?.error === "expired" ? downloadError(res.status, body) : body?.error || `HTTP ${res.status}`);
      setMsg({ tone: "ok", text: "Receipt recorded — thank you. The issuer has been notified." });
      await refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally { setAckBusy(false); }
  };

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-dvh bg-slate-100 dark:bg-slate-950 flex items-start justify-center p-4 sm:p-8">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-lg overflow-hidden">{children}</div>
    </div>
  );

  if (state === "loading") return <Shell><div className="p-8 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Opening transmittal…</div></Shell>;
  if (state !== "ok" || !data) {
    const text = state === "voided" ? "This transmittal was voided by the issuer — it is no longer a valid record. Contact them for a replacement."
      : state === "revoked" ? "The issuer has revoked this link. The transmittal itself still stands — contact them if you need access again."
      : state === "expired" ? "This link has expired. The transmittal itself still stands — contact the issuer for a fresh link."
      : state === "notfound" ? "This link doesn't exist — it may have been mistyped."
      : "Something went wrong opening this transmittal. Try again shortly.";
    return <Shell><div className="p-8 text-center"><AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-2" /><p className="text-sm text-slate-500">{text}</p></div></Shell>;
  }

  const acknowledged = data.status === "acknowledged";

  return (
    <Shell>
      {/* Official header band */}
      <div className="px-6 py-5 border-b-4 border-orange-600 bg-gradient-to-br from-orange-50 to-white dark:from-slate-900 dark:to-slate-900">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[11px] font-black tracking-[0.2em] text-orange-700 dark:text-orange-400 uppercase">Transmittal {data.number}</div>
            <h1 className="text-xl font-black text-slate-900 dark:text-white mt-0.5">{data.subject || "Document Transmittal"}</h1>
            <div className="text-xs text-slate-500 mt-1">
              From <b className="text-slate-700 dark:text-slate-300">{data.orgName ?? "the issuer"}</b>
              {data.fromName ? ` (${data.fromName})` : ""}{data.issuedAt ? ` · issued ${new Date(data.issuedAt).toLocaleDateString()}` : ""}
            </div>
          </div>
          <div className="shrink-0 text-right">
            {data.purpose && (
              <span className="inline-block text-[10px] font-black uppercase tracking-wider text-orange-700 bg-orange-100 border border-orange-300 rounded-full px-3 py-1">{data.purpose}</span>
            )}
            <div className="mt-2">
              {acknowledged
                ? <span className="inline-flex items-center gap-1 text-[11px] font-black text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> Acknowledged</span>
                : <span className="text-[11px] font-black text-amber-700">Awaiting your acknowledgment</span>}
            </div>
          </div>
        </div>
        {(data.recipientName || data.recipientCompany) && (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
            <Building2 className="w-3.5 h-3.5" /> To: <b>{[data.recipientName, data.recipientCompany].filter(Boolean).join(" · ")}</b>
          </div>
        )}
      </div>

      <div className="p-6 space-y-5">
        {msg && (
          <div className={`rounded-xl border px-3 py-2.5 text-xs font-bold ${msg.tone === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-rose-300 bg-rose-50 text-rose-700"}`}>{msg.text}</div>
        )}

        {/* Document list with downloads */}
        <div>
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Documents transmitted ({data.items.length})</div>
          <ul className="rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
            {data.items.map((i) => (
              <li key={i.documentId} className="px-3.5 py-2.5 flex items-center gap-3">
                <FileText className="w-4 h-4 text-orange-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                    <span className="font-mono">{i.number}</span>
                    {i.rev && <span className="ml-2 text-[10px] font-black text-slate-500 bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-0.5">REV {i.rev}</span>}
                    {i.statusAsSent && <span className="ml-1.5 text-[10px] font-bold text-slate-500">{i.statusAsSent} as sent</span>}
                  </div>
                  {i.title && <div className="text-[11px] text-slate-500 truncate">{i.title}</div>}
                  {i.effectiveDate && (
                    <div className={`text-[10px] font-bold ${i.effectiveDate.slice(0, 10) > new Date().toISOString().slice(0, 10) ? "text-amber-700" : "text-slate-500"}`}>
                      Effective {i.effectiveDate.slice(0, 10)}{i.effectiveDate.slice(0, 10) > new Date().toISOString().slice(0, 10) ? " — not yet in force" : ""}
                    </div>
                  )}
                  {(i.fileHash || sizeLabel(i.fileSize)) && (
                    <div className="text-[10px] font-mono text-slate-400" title={i.fileHash ? `SHA-256 of the file issued: ${i.fileHash}` : undefined}>
                      {i.fileHash ? `SHA-256 ${i.fileHash.slice(0, 12)}…` : ""}{i.fileHash && sizeLabel(i.fileSize) ? " · " : ""}{sizeLabel(i.fileSize) ?? ""}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => void download(i.documentId)}
                  disabled={downloading === i.documentId}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-[11px] font-black hover:opacity-85 disabled:opacity-50 transition-opacity"
                >
                  {downloading === i.documentId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-1.5 text-[10px] text-slate-400">Files download exactly as issued on this transmittal — if a newer revision exists, it is NOT what this record covers. Each PDF is marked UNCONTROLLED with its revision and a QR to check whether it is still current (a file that cannot be marked — not a PDF, or a very large one — is released as issued, and this page tells you when that happens).{data.portalExpiresAt ? ` This link works until ${new Date(data.portalExpiresAt).toLocaleDateString()}.` : ""}</div>
        </div>

        {data.notes && (
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Notes from the issuer</div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 px-3.5 py-2.5 text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{data.notes}</div>
          </div>
        )}

        {/* Acknowledgment */}
        {acknowledged ? (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800 px-4 py-3.5">
            <div className="flex items-center gap-2 text-sm font-black text-emerald-800 dark:text-emerald-300">
              <CheckCircle2 className="w-4 h-4" /> Receipt acknowledged
            </div>
            <div className="text-xs text-emerald-700 dark:text-emerald-400 mt-1">
              {data.acknowledgedByName ? <>By <b>{data.acknowledgedByName}</b></> : "Recorded"}
              {data.acknowledgedAt ? <> on {new Date(data.acknowledgedAt).toLocaleString()}</> : null}. This confirmation is part of the permanent record.
            </div>
          </div>
        ) : (
          <div className="rounded-xl border-2 border-orange-300 bg-orange-50/60 dark:bg-orange-950/30 dark:border-orange-800 p-4">
            <div className="flex items-center gap-2 text-sm font-black text-slate-900 dark:text-white mb-1">
              <PenLine className="w-4 h-4 text-orange-600" /> Acknowledge receipt
            </div>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mb-3">
              Confirming tells {data.orgName ?? "the issuer"} you received these documents at the revisions listed above. Your name, your note, the time and the network address you confirm from are recorded on the transmittal.
            </p>
            <div className="flex items-end gap-2 flex-wrap">
              <label className="block flex-1 min-w-48">
                <span className="text-[9px] font-black uppercase tracking-wider text-slate-500">Your name (required)</span>
                <input value={ackName} onChange={(e) => setAckName(e.target.value)} placeholder="e.g. Dave Miller — Acme Fabricators"
                  className="mt-0.5 w-full h-9 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 text-sm text-slate-900 dark:text-white" />
              </label>
              <label className="block flex-1 min-w-48">
                <span className="text-[9px] font-black uppercase tracking-wider text-slate-500">Note (optional)</span>
                <input value={ackNote} onChange={(e) => setAckNote(e.target.value)} placeholder="e.g. received, distributing to shop"
                  className="mt-0.5 w-full h-9 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 text-sm text-slate-900 dark:text-white" />
              </label>
              <button onClick={() => void acknowledge()} disabled={ackBusy}
                className="h-9 inline-flex items-center gap-1.5 px-4 rounded-lg bg-orange-600 text-white text-sm font-black hover:bg-orange-700 disabled:opacity-50 transition-colors">
                {ackBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Acknowledge
              </button>
            </div>
          </div>
        )}

        <div className="text-[10px] text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-3">
          Transmittal {data.number} · This page is the live record — every download and the acknowledgment are logged. Only the holder of this link can see it.
        </div>
      </div>
    </Shell>
  );
}
