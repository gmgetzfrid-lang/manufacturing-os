"use client";

// /transmittal/<token> — the recipient's side of a transmittal. Isolated,
// token-gated, no account (same trust model as the intake portal): the
// contractor sees the official record — number, purpose, the document/rev
// list — downloads the files EXACTLY as sent, and acknowledges receipt
// with their name. That acknowledgment is the org's their-side,
// timestamped proof of delivery.

import React, { useCallback, useEffect, useState } from "react";
import { FileText, CheckCircle2, Download } from "lucide-react";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import { Button } from "@/components/ui/Button";
import CopyId from "@/components/ui/CopyId";
import ErrorNote from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { field as kitField, label as kitLabel } from "@/components/admin/kit";
import { friendlyError } from "@/lib/friendlyError";

/** "Nov 14" this year, "Nov 14, 2025" before; with the time when asked. */
function when(iso: string, time = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return time ? `${day}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : day;
}

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
      if (!res.ok || !body?.url) throw Object.assign(new Error(body?.error || ""), { status: res.status });
      window.open(body.url, "_blank", "noopener");
    } catch (e) {
      setMsg({ tone: "err", text: `That file didn't download. ${friendlyError(e)}` });
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
      if (!res.ok || !body?.ok) throw Object.assign(new Error(body?.error || ""), { status: res.status });
      setMsg({ tone: "ok", text: "Receipt recorded. The issuer has been told." });
      await refresh();
    } catch (e) {
      setMsg({ tone: "err", text: `The receipt wasn't recorded. ${friendlyError(e)}` });
    } finally { setAckBusy(false); }
  };

  if (state === "loading") return <Shell kicker="Transmittal" title="Opening the transmittal…"><SkeletonRows rows={3} cols={1} what="the transmittal" /></Shell>;
  if (state !== "ok" || !data) {
    const title = state === "voided" ? "This transmittal was voided." : state === "notfound" ? "No transmittal at this link." : "The transmittal didn't open.";
    const sub = state === "voided" ? "The issuer withdrew it, so it is no longer a valid record. Ask them for a replacement."
      : state === "notfound" ? "The link may have been mistyped. Ask the issuer to send it again."
      : undefined;
    return (
      <Shell kicker="Transmittal" title={title} sub={sub}>
        {state === "error" && <ErrorNote title="It didn't load." next="Check your connection, then try again." onRetry={() => { setState("loading"); void refresh(); }} />}
      </Shell>
    );
  }

  const acknowledged = data.status === "acknowledged";
  const n = data.items.length;
  const from = `${data.orgName ?? "the issuer"}${data.fromName ? ` (${data.fromName})` : ""}`;
  const to = [data.recipientName, data.recipientCompany].filter(Boolean).join(", ");

  return (
    <Shell
      kicker={<span className="inline-flex flex-wrap items-baseline gap-x-2">Transmittal <CopyId value={data.number} label="transmittal number" />{data.purpose ? <span>{data.purpose}</span> : null}</span>}
      title={acknowledged ? "Received. It's on the record." : `${n} document${n === 1 ? "" : "s"} for you.`}
      sub={<>
        {data.subject || "Document transmittal"}. From <b className="font-semibold text-[var(--color-text)]">{from}</b>{data.issuedAt ? `, issued ${when(data.issuedAt)}` : ""}.
        {to ? <> To {to}.</> : null}
      </>}
    >
        {msg && (msg.tone === "ok" ? (
          <p role="status" className="flex items-center gap-2 text-[15px] text-[var(--color-text)]">
            <CheckCircle2 aria-hidden className="w-5 h-5 text-[var(--state-released)]" /> {msg.text}
          </p>
        ) : (
          <ErrorNote compact title={msg.text} next="" />
        ))}

        {/* Document list with downloads */}
        <Card label={<>Documents <span className="font-sans text-[14px] font-normal tabular-nums text-[var(--color-text-muted)]">{n}</span></>} pad={false} className="overflow-hidden">
          <ul className="divide-y divide-[var(--color-border)]">
            {data.items.map((i) => (
              <li key={i.documentId} className="px-4 sm:px-5 py-3 flex items-center gap-3">
                <FileText aria-hidden className="w-4 h-4 text-[var(--color-text-faint)] shrink-0 max-sm:hidden" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] flex items-baseline gap-2 min-w-0">
                    <CopyId value={i.number} label="document number" />
                    {i.rev && <span className="shrink-0 text-[13px] text-[var(--color-text-muted)]">Rev <span className="ui-id text-[var(--color-text)]">{i.rev}</span></span>}
                  </div>
                  {i.title && i.title !== i.number && <div className="text-[13px] text-[var(--color-text-muted)] truncate">{i.title}</div>}
                </div>
                <Button variant="secondary" size="sm" onClick={() => void download(i.documentId)} loading={downloading === i.documentId} className="shrink-0">
                  {downloading !== i.documentId && <Download className="w-4 h-4" />} Download
                </Button>
              </li>
            ))}
          </ul>
          <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] text-[13px] text-[var(--color-text-muted)]">Files download at the revision issued here. A newer revision is not part of this record.</div>
        </Card>

        {data.notes && (
          <Card label="Notes from the issuer">
            <div className="text-[14px] text-[var(--color-text)] whitespace-pre-wrap">{data.notes}</div>
          </Card>
        )}

        {/* Acknowledgment */}
        {acknowledged ? (
          <Card>
            <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--color-text)]">
              <CheckCircle2 aria-hidden className="w-5 h-5 text-[var(--state-released)]" /> Receipt recorded
            </div>
            <div className="text-[14px] text-[var(--color-text-muted)] mt-1">
              {data.acknowledgedByName ? <>By <b className="font-semibold text-[var(--color-text)]">{data.acknowledgedByName}</b></> : "Recorded"}
              {data.acknowledgedAt ? <>, {when(data.acknowledgedAt, true)}</> : null}. It&apos;s kept on the record.
            </div>
          </Card>
        ) : (
          <Card label="Confirm you received them">
            <p className="text-[14px] text-[var(--color-text-muted)] mb-4">
              This tells {data.orgName ?? "the issuer"} you got these documents at the revisions above. Your name and the time are recorded.
            </p>
            <form onSubmit={(e) => { e.preventDefault(); void acknowledge(); }} className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className={kitLabel}>Your name</span>
                <input value={ackName} onChange={(e) => setAckName(e.target.value)} placeholder="Dave Miller, Acme Fabricators"
                  autoComplete="name" required className={kitField} />
              </label>
              <label className="block">
                <span className={kitLabel}>Note <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></span>
                <input value={ackNote} onChange={(e) => setAckNote(e.target.value)} placeholder="Received, going to the shop"
                  className={kitField} />
              </label>
              <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
                <Button type="submit" loading={ackBusy} disabled={!ackName.trim()}>Confirm receipt</Button>
                {!ackName.trim() && <span className="text-[13px] text-[var(--color-text-muted)]">Enter your name to confirm.</span>}
              </div>
            </form>
          </Card>
        )}

        <p className="px-1 text-[13px] text-[var(--color-text-muted)]">
          Downloads and the receipt are logged. Only people with this link can see it.
        </p>
    </Shell>
  );
}
