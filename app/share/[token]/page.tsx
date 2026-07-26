"use client";

// /share/<token> — public landing for a shared document.
//
// No auth required. Resolution happens server-side via /api/share/resolve
// (service role, gated only by possession of the unguessable token) — the
// old direct table query was blocked by RLS for the outside recipients the
// link exists for. The download comes from /api/share/file, which stamps
// SERVER-SIDE (uncontrolled watermark, rev footer, verify-QR) before any
// byte leaves — client-side stamping was CORS-blocked by the bucket, and
// its fallback opened the raw unstamped file. There is no raw-URL path
// anymore: the copy that leaves is always marked.

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  FileText, Download, Loader2, AlertTriangle, ShieldCheck,
} from "lucide-react";

interface ResolvedShare {
  documentId: string;
  versionId: string | null;
  documentNumber: string | null;
  title: string | null;
  rev: string | null;
  orgName: string | null;
  fileUrl: string | null;
}

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<"loading" | "ok" | "revoked" | "expired" | "notfound" | "error">("loading");
  const [data, setData] = useState<ResolvedShare | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch(`/api/share/resolve?token=${encodeURIComponent(token)}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          if (body?.error === "revoked") setState("revoked");
          else if (body?.error === "expired") setState("expired");
          else if (res.status === 404 || body?.error === "notfound" || body?.error === "invalid") setState("notfound");
          else { setErrorMessage(body?.error ?? `HTTP ${res.status}`); setState("error"); }
          return;
        }
        setData((await res.json()) as ResolvedShare);
        setState("ok");
      } catch (e) {
        setErrorMessage((e as Error).message);
        setState("error");
      }
    })();
  }, [token]);

  const handleDownload = async () => {
    if (!data?.fileUrl) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const label = data.documentNumber || data.title || "document";
      // The server stamps before it responds — this is just "save the blob".
      const res = await fetch(data.fileUrl);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error === "revoked" || body?.error === "expired"
          ? "This link is no longer active — ask the owner for a fresh one."
          : "The file couldn't be prepared. Try again, or ask the person who shared it.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${label.replace(/[^\w.\-]+/g, "_")}_Rev${(data.rev ?? "0").replace(/[^\w.\-]+/g, "_")}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-surface-2)] flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-lg p-6">
        {state === "loading" && (
          <div className="text-center text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Resolving share link…</div>
        )}
        {state === "notfound" && (
          <Centered icon={AlertTriangle} tone="rose" title="Link not found" body="This share link doesn't exist. It may have been mistyped or revoked." />
        )}
        {state === "revoked" && (
          <Centered icon={AlertTriangle} tone="amber" title="Link revoked" body="The owner has revoked this share. Ask them for a fresh link if you still need access." />
        )}
        {state === "expired" && (
          <Centered icon={AlertTriangle} tone="amber" title="Link expired" body="This share has passed its expiration date. Ask the owner for a fresh link." />
        )}
        {state === "error" && (
          <Centered icon={AlertTriangle} tone="rose" title="Couldn't load" body={errorMessage ?? "Something went wrong resolving this share link."} />
        )}
        {state === "ok" && data && (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200"><FileText className="w-5 h-5" /></div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">Shared document</div>
                <h1 className="text-base font-black text-[var(--color-text)] truncate">{data.documentNumber || data.title || "Document"}</h1>
              </div>
            </div>
            {data.title && data.documentNumber && (
              <div className="text-sm text-[var(--color-text)] mb-1">{data.title}</div>
            )}
            <div className="text-xs text-[var(--color-text-muted)] mb-4">Rev {data.rev || "0"} · From {data.orgName ?? "—"}</div>
            {data.fileUrl ? (
              <button
                onClick={() => void handleDownload()}
                disabled={downloading}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold disabled:opacity-60"
              >
                {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {downloading ? "Preparing stamped copy…" : "Download stamped copy"}
              </button>
            ) : (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 p-3 rounded-lg">
                Link is valid but the file couldn&apos;t be resolved. Ask the person who shared it to check the document still has a published file.
              </div>
            )}
            {downloadError && (
              <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 p-2.5 rounded-lg flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {downloadError}
              </div>
            )}
            <div className="mt-4 text-[10px] text-[var(--color-text-faint)] inline-flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" /> Access counted on the distribution record · copy is watermarked with a verify QR
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Centered({ icon: Icon, tone, title, body }: { icon: React.ComponentType<{ className?: string }>; tone: "rose" | "amber"; title: string; body: string }) {
  const c = tone === "rose" ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <div className="text-center">
      <div className={`w-12 h-12 mx-auto mb-3 rounded-full border ${c} flex items-center justify-center`}>
        <Icon className="w-6 h-6" />
      </div>
      <h1 className="text-lg font-black text-[var(--color-text)]">{title}</h1>
      <p className="text-sm text-[var(--color-text-muted)] mt-1">{body}</p>
    </div>
  );
}
