"use client";

// /submit/<token> — the contracted company's drop point. No account, no
// site access: they see the project's intake register (their own documents
// only), submit new drawings/files, and submit revisions to their own
// items. Upload-only by design — no downloads of org content, no deletes.
// Review-required submissions show "in review" until the project team
// approves; trusted links see their revision become current immediately.

import React, { useCallback, useEffect, useState } from "react";
import {
  UploadCloud, FileText, Loader2, CheckCircle2, X, CircleAlert,
} from "lucide-react";
import { PageHero, PageBody, Card, heroQuiet } from "@/components/ui/PageHero";
import { Button } from "@/components/ui/Button";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatusTag } from "@/components/requests/RequestBits";
import { field as kitField, label as kitLabel } from "@/components/admin/kit";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { friendlyError } from "@/lib/friendlyError";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import FileThumb from "@/components/ui/FileThumb";
import { useDraft } from "@/hooks/useDraft";

const sizeOf = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** The drop box for one file: lights up while a file is over it, then
 *  shows the file picked (picture or type, name, size) with a way to take
 *  it off. */
function FileDrop({ file, onFile, hint, accept, disabled }: { file: File | null; onFile: (f: File | null) => void; hint: string; accept?: string; disabled?: boolean }) {
  const drag = useFileDrag((fs) => onFile(fs[0]), disabled);
  return (
    <label {...drag.bind} className={`flex items-center gap-3 rounded-xl border border-dashed border-[var(--color-border-control)] px-3 py-3 min-h-16 cursor-pointer hover:bg-[var(--color-surface-2)] ${drag.ring}`}>
      {file ? <FileThumb file={file} size={36} /> : <UploadCloud aria-hidden className="w-5 h-5 text-[var(--color-text-faint)] shrink-0" />}
      <span className="min-w-0 flex-1 text-[15px] [overflow-wrap:anywhere]">
        {drag.over ? <b className="text-[var(--color-text)]">{drag.say}</b>
          : file ? <><b className="text-[var(--color-text)]">{file.name}</b> <span className="text-[var(--color-text-muted)]">· {sizeOf(file.size)}</span></>
            : <span className="text-[var(--color-text-muted)]">{hint}</span>}
      </span>
      {file && !disabled && (
        <button type="button" onClick={(e) => { e.preventDefault(); onFile(null); }} aria-label="Take this file off" title="Take this file off" className="shrink-0 w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
      )}
      <input type="file" accept={accept} className="hidden" disabled={disabled} onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
    </label>
  );
}

/** One upload to the portal. Throws the server's words when it's refused. */
async function sendForm(form: FormData): Promise<string | undefined> {
  const res = await fetch("/api/intake/upload", { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(body?.error || `It didn't go through (HTTP ${res.status}).`);
  return body.message;
}

interface IntakeItem {
  docId: string; label: string; rev: string | null; status: string | null;
  pendingReview: boolean; lastOutcome?: "rejected" | "approved" | null;
  updatedAt: string | null;
}
interface RedlineRequest {
  ticketRef: string; ticketNumber: string | null; title: string; docLabel: string | null;
}
interface SubmittedQuote {
  id: string; fileName: string;
  status: "under_review" | "awarded" | "not_selected";
  submittedAt: string | null;
}
interface Resolved {
  projectName: string; orgName: string | null; companyName: string;
  allowAutoSupersede: boolean; items: IntakeItem[];
  redlineRequests?: RedlineRequest[];
  /** 'quote' links submit prices, not drawings — the portal reshapes. */
  purpose?: "documents" | "quote";
  rfqGroup?: string | null;
  quotes?: SubmittedQuote[];
}

// Module-level so its identity is stable across renders — defined inside the
// component it would remount the whole form (and drop input focus) on every
// keystroke.
function Shell({ kicker, title, sub, children }: { kicker: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)]">
      <div className="mx-auto w-full max-w-3xl px-2 sm:px-6 pt-2 sm:pt-8 pb-16">
        <PageHero kicker={kicker} title={title} sub={sub} size="md" />
        <PageBody>{children}</PageBody>
      </div>
    </div>
  );
}

const field = kitField;

/** What came of the last send: a quiet check, or what went wrong and that
 *  the file is still picked. */
function SendNote({ msg }: { msg: { tone: "ok" | "err"; text: string } | null }) {
  if (!msg) return null;
  return msg.tone === "ok"
    ? <p role="status" className="flex items-start gap-1.5 text-[14px] text-[var(--color-text)]"><CheckCircle2 aria-hidden className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-released)]" />{msg.text}</p>
    : <p role="alert" className="flex items-start gap-1.5 text-[14px] font-semibold text-[var(--state-overdue-text)]"><CircleAlert aria-hidden className="w-4 h-4 mt-0.5 shrink-0" />{msg.text}</p>;
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export default function IntakePortal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = React.use(params);
  const [state, setState] = useState<"loading" | "ok" | "revoked" | "expired" | "notfound" | "error">("loading");
  const [data, setData] = useState<Resolved | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // Submission form
  const [mode, setMode] = useState<"new" | "rev">("new");
  const [targetDoc, setTargetDoc] = useState("");
  const [title, setTitle] = useState("");
  const [number, setNumber] = useState("");
  const [revLabel, setRevLabel] = useState("");
  const [changeNote, setChangeNote] = useState("");
  // The note typed for the record comes back if the page reloads.
  useDraft<string>(`submit:${token}:note`, changeNote, setChangeNote, (v) => !v.trim());
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  // Redline uploads (per collision ticket), and one that failed (kept for Try again).
  const [redlineBusy, setRedlineBusy] = useState<string | null>(null);
  const [redlineFailed, setRedlineFailed] = useState<{ ticketRef: string; file: File; error: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/intake/resolve?token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setState(body?.error === "revoked" ? "revoked" : body?.error === "expired" ? "expired" : res.status === 404 ? "notfound" : "error");
        return;
      }
      setData((await res.json()) as Resolved);
      setState("ok");
    } catch { setState("error"); }
  }, [token]);
  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async () => {
    if (!file) { setMsg({ tone: "err", text: "Choose a file first." }); return; }
    if (mode === "new" && !title.trim()) { setMsg({ tone: "err", text: "A title is required for a new document." }); return; }
    if (mode === "rev" && (!targetDoc || !revLabel.trim())) { setMsg({ tone: "err", text: "Pick the document and give the new revision a label." }); return; }
    setBusy(true); setMsg(null);
    try {
      const form = new FormData();
      form.set("token", token);
      form.set("file", file);
      if (mode === "rev") { form.set("docId", targetDoc); form.set("revLabel", revLabel.trim()); }
      else { form.set("title", title.trim()); if (number.trim()) form.set("number", number.trim()); if (revLabel.trim()) form.set("revLabel", revLabel.trim()); }
      if (changeNote.trim()) form.set("changeNote", changeNote.trim());
      const message = await tryUpload(file.name, () => sendForm(form));
      setMsg({ tone: "ok", text: message ?? "Submitted." });
      setFile(null); setTitle(""); setNumber(""); setRevLabel(""); setChangeNote("");
      await refresh();
    } catch (e) {
      // The file and the form stay filled in: Submit again tries again.
      setMsg({ tone: "err", text: `${file.name} didn't go through. ${friendlyError(e)} The file is still picked: tap Try again.` });
    } finally { setBusy(false); }
  };

  const submitRedline = async (ticketRef: string, f: File | null) => {
    if (!f) return;
    setRedlineBusy(ticketRef); setMsg(null); setRedlineFailed(null);
    try {
      const form = new FormData();
      form.set("token", token);
      form.set("file", f);
      form.set("ticketId", ticketRef);
      const message = await tryUpload(f.name, () => sendForm(form));
      setMsg({ tone: "ok", text: message ?? "Redlines sent." });
      await refresh();
    } catch (e) {
      // Kept, so Try again on its row sends the same file.
      setRedlineFailed({ ticketRef, file: f, error: friendlyError(e) });
    } finally { setRedlineBusy(null); }
  };

  if (state === "loading") return <Shell kicker="Submission portal" title="Opening your submission portal."><Card><SkeletonText lines={4} /></Card></Shell>;
  if (state !== "ok" || !data) {
    const text = state === "revoked" ? "This link has been turned off. Ask your project contact for a new one."
      : state === "expired" ? "This link has expired. Ask your project contact for a new one."
      : state === "notfound" ? "This link wasn't found. Check it was copied in full."
      : "This link couldn't be opened just now.";
    return (
      <Shell kicker="Submission portal" title={state === "revoked" ? "This link is turned off." : state === "expired" ? "This link has expired." : state === "notfound" ? "Link not found." : "Couldn't open the link."}>
        <Card>
          <p className="text-[14px] text-[var(--color-text)]">{text}</p>
          {state === "error" && <button type="button" onClick={() => { setState("loading"); void refresh(); }} className={`${heroQuiet} mt-3`}>Try again</button>}
        </Card>
      </Shell>
    );
  }

  // ── Quote links: submit your PRICE, see your bid's status ──
  if (data.purpose === "quote") {
    const submitQuote = async () => {
      if (!file) { setMsg({ tone: "err", text: "Choose your quote PDF first." }); return; }
      setBusy(true); setMsg(null);
      try {
        const form = new FormData();
        form.set("token", token);
        form.set("file", file);
        if (changeNote.trim()) form.set("changeNote", changeNote.trim());
        const message = await tryUpload(file.name, () => sendForm(form));
        setMsg({ tone: "ok", text: message ?? "Quote received." });
        setFile(null); setChangeNote("");
        await refresh();
      } catch (e) {
        setMsg({ tone: "err", text: `${file.name} didn't go through. ${friendlyError(e)} The file is still picked: tap Try again.` });
      } finally { setBusy(false); }
    };
    const quotes = data.quotes ?? [];
    const reviewing = quotes.filter((q) => q.status === "under_review").length;
    return (
      <Shell kicker={<>Quote submission · {data.projectName}{data.orgName ? ` · ${data.orgName}` : ""}</>}
        title={quotes.length ? <>{plural(quotes.length, "quote")} sent.{reviewing ? <span className="text-[var(--color-ink-muted)]"> {reviewing} under review.</span> : null}</> : "No quote sent yet."}
        sub={<>Submitting as <b className="font-semibold text-[var(--color-text)]">{data.companyName}</b>{data.rfqGroup ? <>, for <b className="font-semibold text-[var(--color-text)]">{data.rfqGroup}</b></> : null}</>}>
        <Card label="Send your quote" className="space-y-3">
          <p className="text-[15px] text-[var(--color-text-muted)]">
            Upload your quote as a PDF with your price breakdown, labor hours and crew size, and any exclusions. Bids are compared on all three.
          </p>
          <FileDrop file={file} onFile={(f) => { setFile(f); setMsg(null); }} accept=".pdf,application/pdf" disabled={busy} hint="Drop your quote here or choose it (PDF, up to 100 MB)" />
          <div>
            <label htmlFor="q-note" className={kitLabel}>Note to the project team <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></label>
            <input id="q-note" value={changeNote} onChange={(e) => setChangeNote(e.target.value)} className={field} />
          </div>
          <Button onClick={() => void submitQuote()} loading={busy} variant={file ? "primary" : "secondary"} className="w-full">
            {!busy && <UploadCloud className="w-4 h-4" />} {busy ? `Sending ${file?.name ?? "it"}` : msg?.tone === "err" && file ? "Try again" : "Submit quote"}
          </Button>
          <SendNote msg={msg} />
        </Card>

        <Card label="Your submitted quotes" pad={false}>
          {quotes.length === 0 && <p className="px-4 sm:px-5 py-4 text-[15px] text-[var(--color-text-muted)]">Nothing yet. Your first quote shows here with its status.</p>}
          <ul className="divide-y divide-[var(--color-border)]">
            {quotes.map((q) => (
              <li key={q.id} className="flex items-center gap-3 px-4 sm:px-5 py-3 text-[15px]">
                <FileText aria-hidden className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-[var(--color-text)] truncate">{q.fileName}</span>
                  {q.submittedAt && <span className="block text-[13px] text-[var(--color-text-muted)]">Sent {new Date(q.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>}
                </span>
                {q.status === "awarded"
                  ? <StatusTag tone="good">Awarded</StatusTag>
                  : q.status === "not_selected"
                    ? <StatusTag tone="none">Not selected</StatusTag>
                    : <StatusTag tone="warn">Under review</StatusTag>}
              </li>
            ))}
          </ul>
          <p className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] text-[13px] text-[var(--color-text-muted)]">Quotes go straight to {data.orgName ?? "the client"}&apos;s bid comparison. This portal is upload-only.</p>
        </Card>
      </Shell>
    );
  }

  // The answer: what they've sent and where it stands.
  const inReview = data.items.filter((i) => i.pendingReview).length;
  const redlines = data.redlineRequests?.length ?? 0;
  const answer = redlines ? <>{plural(redlines, "redline request")}.<span className="text-[var(--color-ink-muted)]"> Waiting on your markups.</span></>
    : data.items.length ? <>{plural(data.items.length, "submission")}.{inReview ? <span className="text-[var(--color-ink-muted)]"> {inReview} in review.</span> : <span className="text-[var(--color-ink-muted)]"> All current.</span>}</>
      : "Nothing submitted yet.";
  return (
    <Shell kicker={<>Drawing &amp; file submission · {data.projectName}{data.orgName ? ` · ${data.orgName}` : ""}</>} title={answer}
      sub={<>Submitting as <b className="font-semibold text-[var(--color-text)]">{data.companyName}</b>. {data.allowAutoSupersede ? "Trusted: your revisions publish at once." : "Submissions are reviewed before they become current."}</>}>

      {/* Submit form */}
      <Card label="Send a file">
        <div role="group" aria-label="What you're sending" className={`${bandSeg} mb-4`}>
          <button type="button" aria-pressed={mode === "new"} onClick={() => setMode("new")} className={bandSegItem(mode === "new")}>New document</button>
          <button type="button" aria-pressed={mode === "rev"} onClick={() => setMode("rev")} disabled={data.items.length === 0} title={data.items.length === 0 ? "Send a document first; then you can send its revisions" : undefined} className={`${bandSegItem(mode === "rev")} disabled:opacity-40`}>Revision of ours</button>
        </div>
        <div className="space-y-4">
          {mode === "new" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label htmlFor="s-title" className={kitLabel}>Title</label><input id="s-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Spool list E-104" className={field} /></div>
              <div><label htmlFor="s-num" className={kitLabel}>Drawing number <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></label><input id="s-num" value={number} onChange={(e) => setNumber(e.target.value)} autoComplete="off" className={field} /></div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="s-doc" className={kitLabel}>Your document</label>
                <select id="s-doc" value={targetDoc} onChange={(e) => setTargetDoc(e.target.value)} className={field}>
                  <option value="">Pick one</option>
                  {data.items.map((i) => <option key={i.docId} value={i.docId}>{i.label} (Rev {i.rev ?? "none"})</option>)}
                </select>
              </div>
              <div><label htmlFor="s-rev" className={kitLabel}>New revision</label><input id="s-rev" value={revLabel} onChange={(e) => setRevLabel(e.target.value)} placeholder="e.g. B" autoComplete="off" className={field} /></div>
            </div>
          )}
          <div>
            <label htmlFor="s-note" className={kitLabel}>What changed <span className="font-normal text-[var(--color-text-muted)]">(goes on the record)</span></label>
            <input id="s-note" value={changeNote} onChange={(e) => setChangeNote(e.target.value)} className={field} />
          </div>
          <FileDrop file={file} onFile={(f) => { setFile(f); setMsg(null); }} disabled={busy} hint="Drop the file here or choose it (PDF, DWG or ZIP, up to 100 MB)" />
          <Button onClick={() => void submit()} loading={busy} variant={file ? "primary" : "secondary"} className="w-full">
            {!busy && <UploadCloud className="w-4 h-4" />} {busy ? `Sending ${file?.name ?? "it"}` : msg?.tone === "err" && file ? "Try again" : "Submit"}
          </Button>
          <SendNote msg={msg} />
        </div>
      </Card>

      {/* Redlines requested: collision tickets waiting on their markups */}
      {(data.redlineRequests?.length ?? 0) > 0 && (
        <Card label="Redlines requested">
          <p className="text-[15px] text-[var(--color-text-muted)] mb-2">
            One of your sheets conflicts with existing drawings. Upload your markups here: they go straight to the drafting request.
          </p>
          <ul className="divide-y divide-[var(--color-border)]">
            {(data.redlineRequests ?? []).map((r) => (
              <RedlineRow key={r.ticketRef} r={r} busy={redlineBusy === r.ticketRef}
                failed={redlineFailed?.ticketRef === r.ticketRef ? redlineFailed : null}
                onFile={(f) => void submitRedline(r.ticketRef, f)} />
            ))}
          </ul>
        </Card>
      )}

      {/* Their register */}
      <Card label="Your submissions on this project" pad={false}>
        {data.items.length === 0 && <p className="px-4 sm:px-5 py-4 text-[15px] text-[var(--color-text-muted)]">Nothing yet. Your first submission shows here.</p>}
        <ul className="divide-y divide-[var(--color-border)]">
          {data.items.map((i) => (
            <li key={i.docId} className="flex items-center gap-3 px-4 sm:px-5 py-3 text-[15px]">
              <FileText aria-hidden className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-[var(--color-text)] truncate">{i.label}</span>
                <span className="block text-[13px] text-[var(--color-text-muted)]">Rev {i.rev ?? "none"}{i.updatedAt ? `, ${new Date(i.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</span>
              </span>
              {i.pendingReview
                ? <StatusTag tone="warn">In review</StatusTag>
                : i.lastOutcome === "rejected"
                  ? <StatusTag tone="bad" className="whitespace-normal text-right">Not accepted: send a new revision</StatusTag>
                  : <StatusTag tone="good">Current</StatusTag>}
            </li>
          ))}
        </ul>
        <p className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] text-[13px] text-[var(--color-text-muted)]">Every submission is recorded with your company name on {data.orgName ?? "the client"}&apos;s revision history. This portal is upload-only.</p>
      </Card>
    </Shell>
  );
}

/** One redline request: drop the markups on it or choose them; one that
 *  didn't go through keeps its file for Try again. */
function RedlineRow({ r, busy, failed, onFile }: { r: RedlineRequest; busy: boolean; failed: { file: File; error: string } | null; onFile: (f: File) => void }) {
  const drag = useFileDrag((fs) => onFile(fs[0]), busy);
  return (
    <li {...drag.bind} className={`py-3 text-[14px] ${drag.ring}`}>
      <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
        <span className="min-w-0 flex-1 basis-[220px]">
          <span className="block font-semibold text-[15px] text-[var(--color-text)]">{r.title}</span>
          <span className="block text-[13px] text-[var(--color-text-muted)] tabular-nums">{r.ticketNumber ?? ""}{r.docLabel ? `, ${r.docLabel}` : ""}</span>
        </span>
        <label className={`${heroQuiet} cursor-pointer ${busy ? "opacity-50 pointer-events-none" : ""}`}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
          {drag.over ? drag.say : busy ? "Sending" : "Upload redlines"}
          <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />
        </label>
      </div>
      {failed && !busy && (
        <div className="mt-1.5 flex items-center gap-2">
          <FileThumb file={failed.file} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-[var(--color-text)]">{failed.file.name} <span className="font-normal text-[var(--color-text-muted)]">{sizeOf(failed.file.size)}</span></span>
            <span role="alert" className="block text-[13px] text-[var(--state-overdue-text)]">Didn&apos;t go through. {failed.error}</span>
          </span>
          <button type="button" onClick={() => onFile(failed.file)} className={`${heroQuiet} h-8 shrink-0`}>Try again</button>
        </div>
      )}
    </li>
  );
}
