"use client";

// /transmittal/<token> — the recipient's side of a transmittal. Isolated,
// token-gated, no account (same trust model as the intake portal): the
// contractor sees the official record — number, purpose, the document/rev
// list — downloads the files EXACTLY as sent, and acknowledges receipt
// with their name. That acknowledgment is the org's their-side,
// timestamped proof of delivery.

import React, { useCallback, useEffect, useState } from "react";
import {
  FileText, Loader2, AlertTriangle, CheckCircle2, Download, PenLine,
} from "lucide-react";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";

// The page frame: paper, a band with the answer, cards over its edge. Kept
// outside the page component so typing in the receipt form doesn't remount
// everything (and drop the cursor) on each key.
function Shell({ kicker, title, sub, children }: { kicker: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-[var(--color-canvas)] px-3 sm:px-6 py-4 sm:py-8">
      <div className="mx-auto w-full max-w-3xl">
        <PageHero kicker={kicker} title={title} sub={sub} size="md" />
        <PageBody>{children}</PageBody>
      </div>
    </main>
  );
}

interface PortalItem { documentId: string; number: string; title: string | null; rev: string | null }
interface PortalData {
  number: string; subject: string | null; purpose: string | null; status: string;
  notes: string | null; orgName: string | null; fromName: string | null;
  issuedAt: string | null; acknowledgedAt: string | null; acknowledgedByName: string | null;
  recipientName: string | null; recipientCompany: string | null;
  items: PortalItem[];
}

export default function TransmittalPortal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = React.use(params);
  const [state, setState] = useState<"loading" | "ok" | "voided" | "notfound" | "error">("loading");
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
        setState(body?.error === "voided" ? "voided" : res.status === 404 ? "notfound" : "error");
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
      const res = await fetch(`/api/transmittal?token=${encodeURIComponent(token)}&file=${encodeURIComponent(docId)}`);
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) throw new Error(body?.error || `HTTP ${res.status}`);
      window.open(body.url, "_blank", "noopener");
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
      if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setMsg({ tone: "ok", text: "Receipt recorded - thank you. The issuer has been notified." });
      await refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally { setAckBusy(false); }
  };

  if (state === "loading") return <Shell kicker="Transmittal" title="Opening the transmittal…"><Card><div className="py-6 text-center text-[14px] text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Opening transmittal…</div></Card></Shell>;
  if (state !== "ok" || !data) {
    const text = state === "voided" ? "This transmittal was voided by the issuer - it is no longer a valid record. Contact them for a replacement."
      : state === "notfound" ? "This link doesn't exist - it may have been mistyped."
      : "Something went wrong opening this transmittal. Try again shortly.";
    const title = state === "voided" ? "This transmittal was voided." : state === "notfound" ? "No transmittal at this link." : "It didn't open.";
    return <Shell kicker="Transmittal" title={title}><Card><div className="py-4 flex items-start gap-3"><AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" /><p className="text-[14px] text-[var(--color-text)]">{text}</p></div></Card></Shell>;
  }

  const acknowledged = data.status === "acknowledged";
  const n = data.items.length;
  const from = `${data.orgName ?? "the issuer"}${data.fromName ? ` (${data.fromName})` : ""}`;
  const to = [data.recipientName, data.recipientCompany].filter(Boolean).join(" · ");

  return (
    <Shell
      kicker={<>Transmittal {data.number}{data.purpose ? ` · ${data.purpose}` : ""}</>}
      title={acknowledged ? "Received. It's on the record." : `${n} document${n === 1 ? "" : "s"} for you.`}
      sub={<>
        {data.subject || "Document Transmittal"}. From <b className="text-white">{from}</b>{data.issuedAt ? `, issued ${new Date(data.issuedAt).toLocaleDateString()}` : ""}.
        {to ? <> To {to}.</> : null}
      </>}
    >
        {msg && (
          <Card>
            <p role={msg.tone === "ok" ? "status" : "alert"} className={`text-[14px] font-semibold ${msg.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{msg.text}</p>
          </Card>
        )}

        {/* Document list with downloads */}
        <Card label={`Documents transmitted (${n})`} pad={false} className="overflow-hidden">
          <ul className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {data.items.map((i) => (
              <li key={i.documentId} className="px-4 sm:px-5 py-3 flex items-center gap-3">
                <FileText className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-bold text-[var(--color-text)] truncate">
                    <span className="font-mono">{i.number}</span>
                    {i.rev && <span className="ml-2 text-[12px] font-semibold text-[var(--color-text-muted)]">Rev {i.rev}</span>}
                  </div>
                  {i.title && i.title !== i.number && <div className="text-[13px] text-[var(--color-text-muted)] truncate">{i.title}</div>}
                </div>
                <button
                  onClick={() => void download(i.documentId)}
                  disabled={downloading === i.documentId}
                  className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] border border-[var(--color-border-strong)] text-[var(--color-text)] text-[13px] font-semibold hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
                >
                  {downloading === i.documentId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download
                </button>
              </li>
            ))}
          </ul>
          <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)]">Files download at the revision issued here. A newer revision is not part of this record.</div>
        </Card>

        {data.notes && (
          <Card label="Notes from the issuer">
            <div className="text-[14px] text-[var(--color-text)] whitespace-pre-wrap">{data.notes}</div>
          </Card>
        )}

        {/* Acknowledgment */}
        {acknowledged ? (
          <Card>
            <div className="flex items-center gap-2 text-[14px] font-bold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-4 h-4" /> Receipt acknowledged
            </div>
            <div className="text-[13px] text-[var(--color-text-muted)] mt-1">
              {data.acknowledgedByName ? <>By <b className="text-[var(--color-text)]">{data.acknowledgedByName}</b></> : "Recorded"}
              {data.acknowledgedAt ? <> on {new Date(data.acknowledgedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</> : null}. It&apos;s kept on the record.
            </div>
          </Card>
        ) : (
          <Card label={<span className="inline-flex items-center gap-1.5"><PenLine className="w-3.5 h-3.5" /> Acknowledge receipt</span>}>
            <p className="text-[14px] text-[var(--color-text-muted)] mb-3">
              This tells {data.orgName ?? "the issuer"} you got these documents at the revisions above. Your name and the time are recorded.
            </p>
            <div className="flex items-end gap-2 flex-wrap">
              <label className="block flex-1 min-w-48">
                <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">Your name (required)</span>
                <input value={ackName} onChange={(e) => setAckName(e.target.value)} placeholder="e.g. Dave Miller, Acme Fabricators"
                  className="mt-1 w-full h-10 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-base sm:text-[14px] text-[var(--color-text)]" />
              </label>
              <label className="block flex-1 min-w-48">
                <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">Note (optional)</span>
                <input value={ackNote} onChange={(e) => setAckNote(e.target.value)} placeholder="e.g. received, distributing to shop"
                  className="mt-1 w-full h-10 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-base sm:text-[14px] text-[var(--color-text)]" />
              </label>
              <button onClick={() => void acknowledge()} disabled={ackBusy}
                className="h-10 inline-flex items-center gap-1.5 px-5 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-extrabold hover:bg-[var(--color-accent-hover)] shadow-[0_12px_24px_-12px_var(--color-accent)] disabled:opacity-50 transition-colors">
                {ackBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Acknowledge
              </button>
            </div>
          </Card>
        )}

        <p className="px-1 text-[12px] text-[var(--color-text-muted)]">
          Transmittal {data.number} · Downloads and the receipt are logged. Only people with this link can see it.
        </p>
    </Shell>
  );
}
