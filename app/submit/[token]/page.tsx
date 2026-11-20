"use client";

// /submit/<token> — the contracted company's drop point. No account, no
// site access: they see the project's intake register (their own documents
// only), submit new drawings/files, and submit revisions to their own
// items. Upload-only by design — no downloads of org content, no deletes.
// Review-required submissions show "in review" until the project team
// approves; trusted links see their revision become current immediately.

import React, { useCallback, useEffect, useState } from "react";
import {
  UploadCloud, FileText, Loader2, AlertTriangle, CheckCircle2, Clock, Building2, Pen, X,
} from "lucide-react";
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
    <label {...drag.bind} className={`flex items-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-2.5 cursor-pointer hover:border-[var(--color-accent-ring)] ${drag.ring}`}>
      {file ? <FileThumb file={file} size={36} /> : <UploadCloud className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />}
      <span className="min-w-0 flex-1 text-sm truncate">
        {drag.over ? <b className="text-[var(--color-text)]">{drag.say}</b>
          : file ? <><b className="text-[var(--color-text)]">{file.name}</b> <span className="text-[var(--color-text-muted)]">· {sizeOf(file.size)}</span></>
            : <span className="text-[var(--color-text-muted)]">{hint}</span>}
      </span>
      {file && !disabled && (
        <button type="button" onClick={(e) => { e.preventDefault(); onFile(null); }} aria-label="Take this file off" className="shrink-0 p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>
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
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--color-surface-2)] flex items-start justify-center p-4 sm:p-8">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-lg p-6">{children}</div>
    </div>
  );
}

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
      setMsg({ tone: "err", text: `${file.name} didn't go through (${(e as Error).message.replace(/\.$/, "")}). Tap Try again.` });
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
      setRedlineFailed({ ticketRef, file: f, error: (e as Error).message });
    } finally { setRedlineBusy(null); }
  };

  if (state === "loading") return <Shell><div role="status" className="text-center text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Opening your submission portal…</div></Shell>;
  if (state !== "ok" || !data) {
    const text = state === "revoked" ? "This link has been turned off. Ask your project contact for a new one."
      : state === "expired" ? "This link has expired. Ask your project contact for a new one."
      : state === "notfound" ? "This link wasn't found. Check it was copied in full."
      : "This link couldn't be opened just now.";
    return (
      <Shell>
        <div className="text-center">
          <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
          <p className="text-sm text-[var(--color-text-muted)]">{text}</p>
          {state === "error" && <button onClick={() => { setState("loading"); void refresh(); }} className="mt-3 h-9 px-4 rounded-lg border border-[var(--color-border-strong)] text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Try again</button>}
        </div>
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
        setMsg({ tone: "err", text: `${file.name} didn't go through (${(e as Error).message.replace(/\.$/, "")}). Tap Try again.` });
      } finally { setBusy(false); }
    };
    return (
      <Shell>
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)]"><Building2 className="w-5 h-5" /></div>
          <div className="min-w-0">
            <div className="text-[11px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">Quote submission portal</div>
            <h1 className="text-base font-black text-[var(--color-text)] truncate">{data.projectName}{data.orgName ? ` · ${data.orgName}` : ""}</h1>
            <div className="text-xs text-[var(--color-text-muted)]">
              Submitting as <b>{data.companyName}</b>{data.rfqGroup ? <> · scope: <b>{data.rfqGroup}</b></> : null}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-[var(--color-border-strong)] p-4 space-y-2">
          <div className="text-xs text-[var(--color-text-muted)]">
            Upload your quote as a PDF. Include your <b>price breakdown</b>, <b>labor hours and crew size</b>,
            and any <b>exclusions</b>. Bids are compared on all three.
          </div>
          <FileDrop file={file} onFile={(f) => { setFile(f); setMsg(null); }} accept=".pdf,application/pdf" disabled={busy} hint="Drop your quote here or choose it (PDF, up to 100 MB)" />
          <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="Note to the project team (optional)"
            className="w-full h-9 rounded-lg border border-[var(--color-border-strong)] px-2.5 text-sm bg-[var(--color-surface)]" />
          <button onClick={() => void submitQuote()} disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-sm font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />} {busy ? `Sending ${file?.name ?? "it"}…` : msg?.tone === "err" && file ? "Try again" : "Submit quote"}
          </button>
          {msg && (
            <div role={msg.tone === "err" ? "alert" : "status"} className={`text-xs border-l-2 pl-3 py-1 ${msg.tone === "ok" ? "border-emerald-500 text-emerald-700 dark:text-emerald-300" : "border-rose-500 text-rose-700 dark:text-rose-300"}`}>{msg.text}</div>
          )}
        </div>

        <div className="mt-4">
          <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Your submitted quotes</div>
          {(data.quotes?.length ?? 0) === 0 && <div className="text-xs italic text-[var(--color-text-faint)]">Nothing yet. Your first quote shows here with its status.</div>}
          <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] overflow-hidden">
            {(data.quotes ?? []).map((q) => (
              <li key={q.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <FileText className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                <span className="font-bold text-[var(--color-text)] truncate">{q.fileName}</span>
                {q.submittedAt && <span className="text-xs text-[var(--color-text-muted)]">{new Date(q.submittedAt).toLocaleDateString()}</span>}
                {q.status === "awarded"
                  ? <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700"><CheckCircle2 className="w-3 h-3" /> awarded</span>
                  : q.status === "not_selected"
                    ? <span className="ml-auto text-[11px] font-bold text-[var(--color-text-faint)]">not selected</span>
                    : <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-amber-700"><Clock className="w-3 h-3" /> under review</span>}
              </li>
            ))}
          </ul>
          <div className="mt-3 text-[11px] text-[var(--color-text-faint)]">Quotes go straight to {data.orgName ?? "the client"}&apos;s bid tabulation. This portal is upload-only.</div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center gap-3 mb-1">
        <div className="p-2.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)]"><Building2 className="w-5 h-5" /></div>
        <div className="min-w-0">
          <div className="text-[11px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">Drawing &amp; file submission portal</div>
          <h1 className="text-base font-black text-[var(--color-text)] truncate">{data.projectName}{data.orgName ? ` · ${data.orgName}` : ""}</h1>
          <div className="text-xs text-[var(--color-text-muted)]">Submitting as <b>{data.companyName}</b>{data.allowAutoSupersede ? " · trusted: your revisions publish immediately" : " · submissions are reviewed before becoming current"}</div>
        </div>
      </div>

      {/* Submit form */}
      <div className="mt-4 rounded-xl border border-[var(--color-border-strong)] p-4">
        <div className="flex items-center gap-1 mb-3 rounded-lg border border-[var(--color-border)] p-0.5 w-fit">
          <button onClick={() => setMode("new")} className={`px-3 py-1 rounded-md text-xs font-bold ${mode === "new" ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "text-[var(--color-text-muted)]"}`}>New document</button>
          <button onClick={() => setMode("rev")} disabled={data.items.length === 0} className={`px-3 py-1 rounded-md text-xs font-bold disabled:opacity-40 ${mode === "rev" ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "text-[var(--color-text-muted)]"}`}>Revision of ours</button>
        </div>
        <div className="space-y-2">
          {mode === "new" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (required)" className="h-9 rounded-lg border border-[var(--color-border-strong)] px-2.5 text-sm bg-[var(--color-surface)]" />
              <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Drawing number (optional)" className="h-9 rounded-lg border border-[var(--color-border-strong)] px-2.5 text-sm bg-[var(--color-surface)]" />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select value={targetDoc} onChange={(e) => setTargetDoc(e.target.value)} className="h-9 rounded-lg border border-[var(--color-border-strong)] px-2 text-sm bg-[var(--color-surface)]">
                <option value="">Pick your document…</option>
                {data.items.map((i) => <option key={i.docId} value={i.docId}>{i.label} (Rev {i.rev ?? "-"})</option>)}
              </select>
              <input value={revLabel} onChange={(e) => setRevLabel(e.target.value)} placeholder="New revision label, e.g. B" className="h-9 rounded-lg border border-[var(--color-border-strong)] px-2.5 text-sm bg-[var(--color-surface)]" />
            </div>
          )}
          <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="What changed? (goes on the record)" className="w-full h-9 rounded-lg border border-[var(--color-border-strong)] px-2.5 text-sm bg-[var(--color-surface)]" />
          <FileDrop file={file} onFile={(f) => { setFile(f); setMsg(null); }} disabled={busy} hint="Drop the file here or choose it (PDF, DWG, ZIP… up to 100 MB)" />
          <button onClick={() => void submit()} disabled={busy} className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-sm font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />} {busy ? `Sending ${file?.name ?? "it"}…` : msg?.tone === "err" && file ? "Try again" : "Submit"}
          </button>
          {msg && (
            <div role={msg.tone === "err" ? "alert" : "status"} className={`text-xs border-l-2 pl-3 py-1 ${msg.tone === "ok" ? "border-emerald-500 text-emerald-700 dark:text-emerald-300" : "border-rose-500 text-rose-700 dark:text-rose-300"}`}>{msg.text}</div>
          )}
        </div>
      </div>

      {/* Redlines requested — collision tickets waiting on their markups */}
      {(data.redlineRequests?.length ?? 0) > 0 && (
        <div className="mt-4 border-l-2 border-amber-500 pl-3">
          <div className="flex items-center gap-2 mb-1">
            <Pen className="w-4 h-4 text-[var(--color-text-muted)]" />
            <span className="text-sm font-black text-amber-800 dark:text-amber-300">Redlines requested</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mb-2">
            One of your sheets conflicts with existing drawings. Upload your markups here: they go straight to the drafting ticket.
          </p>
          <ul className="space-y-1.5">
            {(data.redlineRequests ?? []).map((r) => (
              <RedlineRow key={r.ticketRef} r={r} busy={redlineBusy === r.ticketRef}
                failed={redlineFailed?.ticketRef === r.ticketRef ? redlineFailed : null}
                onFile={(f) => void submitRedline(r.ticketRef, f)} />
            ))}
          </ul>
        </div>
      )}

      {/* Their register */}
      <div className="mt-4">
        <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Your submissions on this project</div>
        {data.items.length === 0 && <div className="text-xs italic text-[var(--color-text-faint)]">Nothing yet. Your first submission shows here.</div>}
        <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] overflow-hidden">
          {data.items.map((i) => (
            <li key={i.docId} className="flex items-center gap-2 px-3 py-2 text-sm">
              <FileText className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
              <span className="font-bold text-[var(--color-text)] truncate">{i.label}</span>
              <span className="text-xs text-[var(--color-text-muted)]">Rev {i.rev ?? "-"}</span>
              {i.pendingReview
                ? <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-amber-700"><Clock className="w-3 h-3" /> in review</span>
                : i.lastOutcome === "rejected"
                  ? <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-rose-700"><AlertTriangle className="w-3 h-3" /> not accepted: send a new revision</span>
                  : <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700"><CheckCircle2 className="w-3 h-3" /> current</span>}
            </li>
          ))}
        </ul>
        <div className="mt-3 text-[11px] text-[var(--color-text-faint)]">Every submission is recorded with your company name on {data.orgName ?? "the client"}&apos;s revision history. This portal is upload-only.</div>
      </div>
    </Shell>
  );
}

/** One redline request: drop the markups on it or choose them; one that
 *  didn't go through keeps its file for Try again. */
function RedlineRow({ r, busy, failed, onFile }: { r: RedlineRequest; busy: boolean; failed: { file: File; error: string } | null; onFile: (f: File) => void }) {
  const drag = useFileDrag((fs) => onFile(fs[0]), busy);
  return (
    <li {...drag.bind} className={`rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs ${drag.ring}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-bold text-[var(--color-text)]">{r.title}</span>
        <span className="text-[var(--color-text-faint)]">{r.ticketNumber ?? ""}{r.docLabel ? ` · ${r.docLabel}` : ""}</span>
        <label className={`ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text)] font-black cursor-pointer hover:bg-[var(--color-surface-2)] ${busy ? "opacity-50 pointer-events-none" : ""}`}>
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3" />}
          {drag.over ? drag.say : busy ? "Sending…" : "Upload redlines"}
          <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />
        </label>
      </div>
      {failed && !busy && (
        <div className="mt-1.5 flex items-center gap-2">
          <FileThumb file={failed.file} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-bold text-[var(--color-text)]">{failed.file.name} <span className="font-normal text-[var(--color-text-muted)]">· {sizeOf(failed.file.size)}</span></span>
            <span role="alert" className="block text-rose-700 dark:text-rose-300">{failed.error}</span>
          </span>
          <button type="button" onClick={() => onFile(failed.file)} className="shrink-0 h-7 px-2.5 rounded-lg border border-[var(--color-border-strong)] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Try again</button>
        </div>
      )}
    </li>
  );
}
