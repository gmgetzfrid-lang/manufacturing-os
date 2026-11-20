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
  Download, Loader2, AlertTriangle, ShieldCheck,
} from "lucide-react";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";

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
          ? "This link is no longer active - ask the owner for a fresh one."
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

  // The answer: what this link gives you, or why it doesn't.
  const title = state === "loading" ? "Opening the shared document…"
    : state === "notfound" ? "This link doesn't exist."
    : state === "revoked" ? "This link was revoked."
    : state === "expired" ? "This link has expired."
    : state === "error" ? "It didn't open."
    : data?.documentNumber || data?.title || "Shared document";
  const sub = state === "ok" && data
    ? <>{data.title && data.documentNumber && data.title !== data.documentNumber ? <>{data.title}. </> : null}Rev {data.rev || "0"}, from {data.orgName ?? "-"}.</>
    : undefined;
  const canDownload = state === "ok" && !!data?.fileUrl;

  return (
    <main className="min-h-dvh bg-[var(--color-canvas)] px-3 sm:px-6 py-4 sm:py-8 pb-24">
      <div className="mx-auto w-full max-w-2xl">
        <PageHero
          kicker={state === "ok" ? `Shared document${data?.orgName ? ` · ${data.orgName}` : ""}` : "Shared document"}
          title={title}
          sub={sub}
          size="md"
          primary={canDownload ? (
            <button onClick={() => void handleDownload()} disabled={downloading} className={heroPrimary}>
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {downloading ? "Preparing stamped copy…" : "Download stamped copy"}
            </button>
          ) : undefined}
        />
        <PageBody>
          <Card>
            {state === "loading" && (
              <div className="text-[14px] text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Opening the shared document…</div>
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
              <div className="space-y-3">
                {data.fileUrl ? (
                  <p className="text-[14px] text-[var(--color-text)]">
                    The copy you download is stamped: it says it&apos;s uncontrolled, shows the revision, and carries a code to check whether it&apos;s still current.
                  </p>
                ) : (
                  <p className="text-[14px] text-amber-800 dark:text-amber-300">
                    The link works, but its file couldn&apos;t be found. Ask the person who shared it to check the document still has a file.
                  </p>
                )}
                {downloadError && (
                  <p role="alert" className="text-[14px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {downloadError}
                  </p>
                )}
                <div className="pt-3 border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" /> Each download is recorded.
                </div>
              </div>
            )}
          </Card>
        </PageBody>
      </div>
    </main>
  );
}

function Centered({ icon: Icon, tone, title, body }: { icon: React.ComponentType<{ className?: string }>; tone: "rose" | "amber"; title: string; body: string }) {
  const c = tone === "rose" ? "text-rose-700 dark:text-rose-300" : "text-amber-700 dark:text-amber-300";
  return (
    <div className="flex items-start gap-3">
      <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${c}`} />
      <div>
        <h2 className="text-[14px] font-bold text-[var(--color-text)]">{title}</h2>
        <p className="text-[14px] text-[var(--color-text-muted)] mt-0.5">{body}</p>
      </div>
    </div>
  );
}
