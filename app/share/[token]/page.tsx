"use client";

// /share/<token>: the page someone outside the company opens from a sent
// link. No sign-in. What they see comes from /api/share/resolve (gated by
// the unguessable token, and by the code when the link asks for one); each
// file comes from /api/share/file, stamped on the server as an uncontrolled
// copy before any byte leaves.
//
//   Code screen   when the link asks for a code. The code is kept in this
//                 tab only (sessionStorage), so a reload doesn't ask again.
//   The list      who sent it, for whom, until when, and the documents. A
//                 link with one document opens straight into the viewer.
//   The viewer    the stamped PDF drawn in the page (never the browser's
//                 PDF plugin, which has its own download button).
//   Dead links    expired, turned off, locked, not found: one sentence and
//                 who to ask.

import React, { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { Loader2, Eye, Download, ShieldCheck, FileText } from "lucide-react";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import { Problem, shortDateTime } from "@/components/admin/kit";
import { Button } from "@/components/ui/Button";
import CopyId from "@/components/ui/CopyId";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { PublicBar } from "@/components/marketing/PublicChrome";
import { useSender } from "@/components/brand/WorkspaceLogo";
import type { ResolvedShare, ResolvedShareItem } from "@/lib/documentShares";

import { friendlyError } from "@/lib/friendlyError";
const SharedPdfViewer = dynamic(() => import("@/components/viewers/SharedPdfViewer"), { ssr: false });

type State = "loading" | "code" | "ok" | "revoked" | "expired" | "locked" | "notfound" | "error";

const DEAD: Record<"revoked" | "expired" | "locked" | "notfound", string> = {
  expired: "This link has expired.",
  revoked: "This link was turned off.",
  locked: "This link is locked.",
  notfound: "This link doesn't exist.",
};

const codeKey = (token: string) => `share-code:${token}`;
function readCode(token: string): string {
  try { return sessionStorage.getItem(codeKey(token)) ?? ""; } catch { return ""; }
}
function keepCode(token: string, code: string | null) {
  try { if (code) sessionStorage.setItem(codeKey(token), code); else sessionStorage.removeItem(codeKey(token)); } catch { /* private mode */ }
}

/** A dead-link answer from either route moves the whole page there. */
const deadFrom = (err: string | undefined): keyof typeof DEAD | null =>
  err === "revoked" || err === "expired" || err === "locked" ? err
    : err === "notfound" || err === "invalid" ? "notfound" : null;

const itemName = (it: ResolvedShareItem) => it.documentNumber || it.title || "Document";

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>("loading");
  const [data, setData] = useState<ResolvedShare | null>(null);
  useSender(data, state !== "loading");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Each wrong code starts the boxes over, empty.
  const [codeTry, setCodeTry] = useState(0);
  const code = useRef("");

  // The open document.
  const [viewing, setViewing] = useState<{ item: ResolvedShareItem; url: string | null; error: string | null } | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const autoOpened = useRef(false);

  const headers = useCallback((): Record<string, string> => (code.current ? { "x-share-code": code.current } : {}), []);

  const resolve = useCallback(async (fromCodeScreen: boolean) => {
    if (!token) return;
    if (fromCodeScreen) setChecking(true);
    try {
      const res = await fetch(`/api/share/resolve?token=${encodeURIComponent(token)}`, { headers: headers(), cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (ResolvedShare & { error?: string }) | null;
      if (!res.ok) {
        const dead = deadFrom(body?.error);
        if (dead) { keepCode(token, null); setState(dead); return; }
        if (body?.error === "code" || body?.error === "badcode") {
          keepCode(token, null);
          code.current = "";
          setCodeError(body.error === "badcode" ? "That code isn't right." : null);
          setCodeTry((n) => n + 1);
          setState("code");
          return;
        }
        setState("error");
        return;
      }
      if (code.current) keepCode(token, code.current);
      setCodeError(null);
      setData(body);
      setState("ok");
    } catch {
      setState("error");
    } finally {
      setChecking(false);
    }
  }, [token, headers]);

  useEffect(() => {
    if (!token) return;
    code.current = readCode(token);
    void resolve(false);
  }, [token, resolve]);

  const fetchFile = useCallback(async (it: ResolvedShareItem, view: boolean): Promise<Blob> => {
    const qs = new URLSearchParams({ token, doc: it.documentId });
    if (view) qs.set("view", "1");
    const res = await fetch(`/api/share/file?${qs}`, { headers: headers(), cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const dead = deadFrom(body?.error);
      if (dead && dead !== "notfound") { setViewing(null); setState(dead); throw new Error(DEAD[dead]); }
      if (body?.error === "code" || body?.error === "badcode") { setViewing(null); code.current = ""; keepCode(token, null); setState("code"); throw new Error("That code isn't right."); }
      throw new Error(
        body?.error === "unstampable" ? "This file couldn't be stamped as an uncontrolled copy, so it isn't shown. Ask the person who sent it for a PDF."
          : body?.error === "nodownload" ? "The person who sent this didn't allow downloading. You can view it here."
            : body?.error === "nofile" ? "There's no file for this document. Ask the person who sent it."
              : "The file couldn't be opened. Try again in a minute.",
      );
    }
    return res.blob();
  }, [token, headers]);

  const openViewer = useCallback(async (it: ResolvedShareItem) => {
    setViewing({ item: it, url: null, error: null });
    try {
      const blob = await fetchFile(it, true);
      setViewing((v) => (v && v.item.documentId === it.documentId ? { ...v, url: URL.createObjectURL(blob) } : v));
    } catch (e) {
      setViewing((v) => (v && v.item.documentId === it.documentId ? { ...v, error: (e as Error).message } : v));
    }
  }, [fetchFile]);

  const closeViewer = useCallback(() => {
    setViewing((v) => { if (v?.url) URL.revokeObjectURL(v.url); return null; });
  }, []);

  const download = useCallback(async (it: ResolvedShareItem) => {
    setDownloading(it.documentId);
    setDownloadError(null);
    try {
      const blob = await fetchFile(it, false);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safe = (s: string) => s.replace(/[^\w.\-]+/g, "_");
      a.href = url;
      a.download = `${safe(itemName(it))}_Rev${safe(it.rev ?? "0")}${it.markedUp ? "_markup" : ""}.pdf`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setDownloadError(friendlyError(e));
    } finally {
      setDownloading(null);
    }
  }, [fetchFile]);

  // One document: straight into the viewer (once; closing shows the page).
  useEffect(() => {
    if (state === "ok" && data && data.items.length === 1 && data.items[0].viewable && !autoOpened.current) {
      autoOpened.current = true;
      void openViewer(data.items[0]);
    }
  }, [state, data, openViewer]);

  const submitCode = (value: string) => {
    if (!/^\d{6}$/.test(value) || checking) return;
    code.current = value;
    void resolve(true);
  };

  // ── The page ──────────────────────────────────────────────────────────
  const from = data?.orgName ? `From ${data.orgName}` : "Sent to you";
  if (state === "loading") {
    return (
      <Shell kicker="Sent to you" title="Opening the link…">
        <SkeletonRows rows={2} cols={1} what="the documents" />
      </Shell>
    );
  }
  if (state === "revoked" || state === "expired" || state === "locked" || state === "notfound") {
    return (
      <Shell kicker="Sent to you" title={DEAD[state]}
        sub={`${state === "locked" ? "The code was entered wrong too many times. " : ""}Ask the person who sent it for a new link.`} />
    );
  }
  if (state === "error") {
    return (
      <Shell kicker="Sent to you" title="The link couldn't be opened right now." sub="Try again in a minute.">
        <div><Button onClick={() => { setState("loading"); void resolve(false); }}>Try again</Button></div>
      </Shell>
    );
  }
  if (state === "code") {
    return (
      <Shell kicker="Sent to you" title="Enter the code" sub="The person who sent this link gave you a 6-digit code separately, by a call or a text.">
        <Card>
          <CodeBoxes key={codeTry} onDone={submitCode} busy={checking} error={codeError} onTyping={() => setCodeError(null)} />
        </Card>
      </Shell>
    );
  }

  // state === "ok"
  const d = data!;
  const until = d.expiresAt ? shortDateTime(d.expiresAt) : null;
  const sentBy = [
    d.senderName ? `Sent by ${d.senderName}` : "Sent",
    d.orgName ? ` at ${d.orgName}` : "",
    d.recipient ? ` for ${d.recipient}` : "",
    ".",
  ].join("");
  const title = d.items.length === 1 ? itemName(d.items[0]) : `${d.items.length} documents`;

  return (
    <>
      <Shell kicker={from} title={title} sub={<>{sentBy}{until ? <><br />Open until {until}.</> : null}</>}>
        <Card pad={false}>
          <ul className="divide-y divide-[var(--color-border)]">
            {d.items.map((it) => (
              <li key={it.documentId} className="px-4 sm:px-5 py-3.5 flex items-center gap-3 flex-wrap sm:flex-nowrap">
                <FileText className="w-5 h-5 shrink-0 text-[var(--color-text-muted)] max-sm:hidden" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-reading">
                      {it.documentNumber ? <CopyId value={it.documentNumber} label="document number" /> : <span className="font-medium text-[var(--color-text)]">{itemName(it)}</span>}
                    </span>
                    {it.rev && <span className="text-body text-[var(--color-text-muted)]">Rev <span className="ui-id text-[var(--color-text)]">{it.rev}</span></span>}
                    {it.markedUp && <span className="ui-pill is-muted">Marked up</span>}
                  </div>
                  {it.documentNumber && it.title && <div className="text-body text-[var(--color-text-muted)] mt-0.5 truncate">{it.title}</div>}
                  {!it.viewable && <div className="text-body text-[var(--color-text-muted)] mt-0.5">There&apos;s no file to show for this one. Ask the person who sent it.</div>}
                </div>
                {it.viewable && (
                  <div className="flex items-center gap-2 shrink-0 max-sm:w-full">
                    <Button variant="secondary" onClick={() => void openViewer(it)} className="max-sm:flex-1">
                      <Eye className="w-4 h-4" /> View
                    </Button>
                    {d.allowDownload && (
                      <Button variant="secondary" onClick={() => void download(it)} loading={downloading === it.documentId} className="max-sm:flex-1">
                        {downloading !== it.documentId && <Download className="w-4 h-4" />} Download
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {downloadError && <div className="px-4 sm:px-5 pb-3"><Problem>{downloadError}</Problem></div>}
        </Card>
        <div className="space-y-1.5 text-body text-[var(--color-text-muted)] px-1 -mt-4">
          <p className="flex items-start gap-2"><ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
            <span>These are uncontrolled copies. Every page is stamped with the revision and a QR code to check whether it is still current.</span></p>
          {!d.allowDownload && <p className="pl-6">View only: the person who sent this didn&apos;t allow downloading.</p>}
          <p className="pl-6">Each time you open this link, it&apos;s recorded.</p>
        </div>
      </Shell>

      {viewing && (viewing.url ? (
        <SharedPdfViewer
          url={viewing.url}
          title={[itemName(viewing.item), viewing.item.rev ? `Rev ${viewing.item.rev}` : null].filter(Boolean).join(" ")}
          sub={[viewing.item.documentNumber && viewing.item.title ? viewing.item.title : null, viewing.item.markedUp ? "Marked-up copy" : null].filter(Boolean).join(", ") || null}
          onClose={closeViewer}
          onDownload={d.allowDownload ? () => void download(viewing.item) : undefined}
          downloading={downloading === viewing.item.documentId}
          downloadNote={d.allowDownload ? undefined : "View only"}
        />
      ) : (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 px-6 bg-[var(--color-canvas)] text-center" role="dialog" aria-modal="true">
          {viewing.error
            ? <>
                <p className="text-reading text-[var(--color-text)] max-w-md">{viewing.error}</p>
                <Button variant="secondary" onClick={closeViewer}>Back to the list</Button>
              </>
            : <p className="text-reading text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Opening {itemName(viewing.item)}…</p>}
        </div>
      ))}
    </>
  );
}

function Shell({ kicker, title, sub, children }: { kicker: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)]">
      <PublicBar />
      <main className="px-3 sm:px-6 pt-6 pb-16">
        <div className="mx-auto w-full max-w-2xl">
          <PageHero kicker={kicker} title={title} sub={sub} size="md" />
          {children && <PageBody>{children}</PageBody>}
        </div>
      </main>
    </div>
  );
}

/** Six boxes, one digit each: the number keyboard on a phone, paste fills
 *  them all, Backspace steps back. Opens itself when the sixth is typed. */
function CodeBoxes({ onDone, busy, error, onTyping }: { onDone: (code: string) => void; busy: boolean; error: string | null; onTyping: () => void }) {
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  useEffect(() => { refs.current[0]?.focus(); }, []);
  const set = (i: number, raw: string) => {
    const only = raw.replace(/\D/g, "");
    onTyping();
    if (only.length > 1) {
      // Pasted, or the phone filled it from a message.
      const next = [...digits];
      for (let k = 0; k < 6 - i && k < only.length; k++) next[i + k] = only[k];
      setDigits(next);
      const filled = next.join("");
      refs.current[Math.min(5, i + only.length)]?.focus();
      if (/^\d{6}$/.test(filled)) onDone(filled);
      return;
    }
    const next = [...digits];
    next[i] = only;
    setDigits(next);
    if (only && i < 5) refs.current[i + 1]?.focus();
    const filled = next.join("");
    if (/^\d{6}$/.test(filled)) onDone(filled);
  };

  const code = digits.join("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onDone(code); }}>
      <div className="text-body font-medium text-[var(--color-text)]">Code</div>
      <div className="mt-3 flex items-center gap-2 sm:gap-3" role="group" aria-label="6-digit code">
        {digits.map((v, i) => (
          <React.Fragment key={i}>
            {i === 3 && <span aria-hidden className="w-1 sm:w-2" />}
            <input
              ref={(el) => { refs.current[i] = el; }}
              value={v}
              onChange={(e) => set(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !digits[i] && i > 0) { refs.current[i - 1]?.focus(); }
                if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
                if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
              }}
              onFocus={(e) => e.currentTarget.select()}
              inputMode="numeric" pattern="[0-9]*" autoComplete={i === 0 ? "one-time-code" : "off"}
              maxLength={6} disabled={busy}
              aria-label={`Digit ${i + 1}`}
              className={`w-11 h-14 sm:w-14 sm:h-16 text-center font-display tabular-nums text-[26px] sm:text-[30px] font-semibold rounded-lg border bg-[var(--color-surface)] text-[var(--color-text)] disabled:opacity-60 ${error ? "border-[var(--state-overdue)]" : "border-[var(--color-border-control)]"}`}
            />
          </React.Fragment>
        ))}
      </div>
      {error && <Problem className="mt-3">{error}</Problem>}
      <Button type="submit" disabled={!/^\d{6}$/.test(code)} loading={busy} className="mt-4 w-full sm:w-auto sm:min-w-[160px]">
        Open
      </Button>
      {!/^\d{6}$/.test(code) && !busy && <p className="mt-2 text-body text-[var(--color-text-muted)]">Type all six digits to open it.</p>}
    </form>
  );
}
