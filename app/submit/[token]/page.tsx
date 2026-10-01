"use client";

// /submit/<token> — the contracted company's drop point. No account, no
// site access: they see the project's intake register (their own documents
// only), submit new drawings/files, and submit revisions to their own
// items. Upload-only by design — no downloads of org content, no deletes.
// Review-required submissions show "in review" until the project team
// approves; trusted links see their revision become current immediately.

import React, { useCallback, useEffect, useState } from "react";
import {
  UploadCloud, FileText, Loader2, AlertTriangle, CheckCircle2, Clock, Building2, Pen,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { putWithXhr, UploadCancelledError } from "@/lib/storage";
import { INTAKE_TOKEN_HEADER, INTAKE_BEGUN_HEADER, LINK_GONE_MESSAGE, LINK_INVALID_MESSAGE, PROJECT_CLOSED_MESSAGE } from "@/lib/intakeLinks";

interface IntakeItem {
  docId: string; label: string; rev: string | null; status: string | null;
  pendingReview: boolean; lastOutcome?: "rejected" | "approved" | null;
  /** SAF-9: why the last submission was not accepted. */
  rejectionReason?: string | null;
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
  /** When the link stops working (SEC-5). */
  expiresAt?: string | null;
}

type DoorBody = { ok?: boolean; message?: string; note?: string; error?: string; ref?: string } | null;

/** POST a submission. The link's token travels in a header, never in the
 *  body — the server checks it before reading a byte of the upload
 *  (INTK-8). A browser that is also signed in to the app sends that session
 *  too, so an insider using a contractor's link is recorded as themselves
 *  (SEC-16). */
async function doorHeaders(token: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { [INTAKE_TOKEN_HEADER]: token };
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
  } catch { /* no app session — the ordinary contractor case */ }
  return headers;
}

async function postToDoor(token: string, form: FormData, begunKey?: string | null): Promise<{ res: Response; body: DoorBody }> {
  const headers = await doorHeaders(token);
  // INTK-15: the fallback for a direct upload names its begin — the door
  // counted that attempt already and does not count it twice.
  if (begunKey) headers[INTAKE_BEGUN_HEADER] = begunKey;
  const res = await fetch("/api/intake/upload", { method: "POST", body: form, headers });
  const body = (await res.json().catch(() => null)) as DoorBody;
  return { res, body };
}

/** The most the multipart door could ever take: the platform caps a
 *  function's request body at 4.5 MB, multipart framing included. Read here
 *  as 4.5 MiB — the upper reading — so no file the multipart door took
 *  before the direct door existed is refused without trying it. */
const MULTIPART_DOOR_MAX_BYTES = 4.5 * 1024 * 1024;
/** Storage refused the PUT and the multipart door cannot take the file. */
const STORAGE_REFUSED = "The file didn't reach storage — try again. If it keeps failing, contact your project contact.";

type BeginBody = { ok?: boolean; uploadKey?: string; uploadUrl?: string; contentType?: string; error?: string; ref?: string; code?: string } | null;

/** INTK-15: send a submission through the DIRECT door — the bytes go
 *  straight to storage on a PUT the door presigned for this link (so the
 *  100 MB limit is real), then the door checks the stored file (the same
 *  type sniff, budget, review rules and notices as before) and files it.
 *  The token travels in a header on both steps. The multipart POST is the
 *  fallback, carrying the begin so the attempt is counted once: when the
 *  door cannot presign; when the browser cannot reach storage (a network
 *  error — no PUT CORS) at any size, a large file then getting the size
 *  sentence; and when storage refuses the PUT (a 403, a 400, a 5xx, a
 *  stall) for any file the multipart door could take — one the platform's
 *  body cap then refuses (a 413 with no door answer) gets the storage
 *  sentence, not the 100 MB one. */
async function sendToDoor(token: string, file: File, fields: Record<string, string>): Promise<{ res: Response; body: DoorBody }> {
  const multipart = (begunKey?: string | null) => {
    const form = new FormData();
    form.set("file", file);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return postToDoor(token, form, begunKey);
  };
  const json = async (step: "begin" | "finalize", payload: Record<string, unknown>) => fetch(`/api/intake/upload?step=${step}`, {
    method: "POST", body: JSON.stringify(payload),
    headers: { ...(await doorHeaders(token)), "Content-Type": "application/json" },
  });
  const begin = await json("begin", { fileName: file.name, size: file.size, contentType: file.type });
  const b = (await begin.json().catch(() => null)) as BeginBody;
  if (!begin.ok || !b?.ok || !b.uploadUrl || !b.uploadKey) {
    // A refusal the door made (link, size, rate, budget) is the answer; an
    // unavailable direct path is retried the old way.
    if (b?.code === "direct_unavailable" || !b) return multipart(b?.uploadKey);
    return { res: begin, body: b };
  }
  try {
    await putWithXhr(b.uploadUrl, file, b.contentType ?? "application/octet-stream");
  } catch (e) {
    if (e instanceof UploadCancelledError) throw e;
    if (/network error/i.test((e as Error).message)) return multipart(b.uploadKey);
    if (file.size > MULTIPART_DOOR_MAX_BYTES) throw new Error(STORAGE_REFUSED);
    const viaMultipart = await multipart(b.uploadKey);
    if (viaMultipart.res.status === 413 && !viaMultipart.body) throw new Error(STORAGE_REFUSED);
    return viaMultipart;
  }
  const fin = await json("finalize", { uploadKey: b.uploadKey, fileName: file.name, contentType: file.type, fields });
  return { res: fin, body: (await fin.json().catch(() => null)) as DoorBody };
}

/** The sentence the contractor sees for a refused upload: the server's own
 *  plain message (a 429 names its limit; a gone link says so), plus the
 *  reference the project team can look up (INTK-13). Never a bare status. */
function doorError(res: Response, body: DoorBody): string {
  if (body?.error) return `${body.error}${body.ref ? ` (reference ${body.ref})` : ""}`;
  if (res.status === 413) return "The file is too large for the portal — the limit is 100 MB.";
  return "The upload didn't go through — try again shortly. If it keeps failing, contact your project contact.";
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
  const [state, setState] = useState<"loading" | "ok" | "revoked" | "expired" | "notfound" | "link_gone" | "project_closed" | "error">("loading");
  const [data, setData] = useState<Resolved | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // Submission form
  const [mode, setMode] = useState<"new" | "rev">("new");
  const [targetDoc, setTargetDoc] = useState("");
  const [title, setTitle] = useState("");
  const [number, setNumber] = useState("");
  const [revLabel, setRevLabel] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  // Redline uploads (per collision ticket)
  const [redlineBusy, setRedlineBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/intake/resolve?token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setState(body?.error === "revoked" ? "revoked" : body?.error === "expired" ? "expired"
          : body?.error === "link_gone" ? "link_gone" : body?.error === "project_closed" ? "project_closed"
          : res.status === 404 ? "notfound" : "error");
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
      const fields: Record<string, string> = {};
      if (mode === "rev") { fields.docId = targetDoc; fields.revLabel = revLabel.trim(); }
      else { fields.title = title.trim(); if (number.trim()) fields.number = number.trim(); if (revLabel.trim()) fields.revLabel = revLabel.trim(); }
      if (changeNote.trim()) fields.changeNote = changeNote.trim();
      const { res, body } = await sendToDoor(token, file, fields);
      if (!res.ok || !body?.ok) throw new Error(doorError(res, body));
      setMsg({ tone: "ok", text: `${body.message ?? "Submitted."}${body.note ? ` ${body.note}` : ""}` });
      setFile(null); setTitle(""); setNumber(""); setRevLabel(""); setChangeNote("");
      await refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally { setBusy(false); }
  };

  const submitRedline = async (ticketRef: string, f: File | null) => {
    if (!f) return;
    setRedlineBusy(ticketRef); setMsg(null);
    try {
      const { res, body } = await sendToDoor(token, f, { ticketId: ticketRef });
      if (!res.ok || !body?.ok) throw new Error(doorError(res, body));
      setMsg({ tone: "ok", text: body.message ?? "Redlines sent." });
      await refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally { setRedlineBusy(null); }
  };

  if (state === "loading") return <Shell><div className="text-center text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Opening your submission portal…</div></Shell>;
  if (state !== "ok" || !data) {
    const text = state === "revoked" ? "This link has been revoked. Contact your project contact for a fresh one."
      : state === "expired" ? "This link has expired. Contact your project contact for a fresh one."
      : state === "link_gone" ? LINK_GONE_MESSAGE
      : state === "project_closed" ? PROJECT_CLOSED_MESSAGE
      : state === "notfound" ? LINK_INVALID_MESSAGE
      : "Something went wrong opening this link. Try again shortly.";
    return <Shell><div className="text-center"><AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-2" /><p className="text-sm text-[var(--color-text-muted)]">{text}</p></div></Shell>;
  }

  // ── Quote links: submit your PRICE, see your bid's status ──
  if (data.purpose === "quote") {
    const submitQuote = async () => {
      if (!file) { setMsg({ tone: "err", text: "Choose your quote PDF first." }); return; }
      setBusy(true); setMsg(null);
      try {
        const { res, body } = await sendToDoor(token, file, changeNote.trim() ? { changeNote: changeNote.trim() } : {});
        if (!res.ok || !body?.ok) throw new Error(doorError(res, body));
        setMsg({ tone: "ok", text: body.message ?? "Quote received." });
        setFile(null); setChangeNote("");
        await refresh();
      } catch (e) {
        setMsg({ tone: "err", text: (e as Error).message });
      } finally { setBusy(false); }
    };
    return (
      <Shell>
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200"><Building2 className="w-5 h-5" /></div>
          <div className="min-w-0">
            <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">Quote submission portal</div>
            <h1 className="text-base font-black text-[var(--color-text)] truncate">{data.projectName}{data.orgName ? ` · ${data.orgName}` : ""}</h1>
            <div className="text-xs text-[var(--color-text-muted)]">
              Submitting as <b>{data.companyName}</b>{data.rfqGroup ? <> · scope: <b>{data.rfqGroup}</b></> : null}
              {data.expiresAt ? <> · link valid until {new Date(data.expiresAt).toLocaleDateString()}</> : null}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-[var(--color-border-strong)] p-4 space-y-2">
          <div className="text-xs text-[var(--color-text-muted)]">
            Upload your quote as a PDF. Include your <b>price breakdown</b>, <b>labor hours and crew size</b>,
            and any <b>exclusions</b> — bids are compared on all three, so what you state is what gets credited.
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-2.5 cursor-pointer hover:border-[var(--color-accent-ring)]">
            <UploadCloud className="w-4 h-4 text-[var(--color-accent)]" />
            <span className="text-sm text-[var(--color-text-muted)] truncate">{file ? file.name : "Choose your quote (PDF, up to 100 MB)"}</span>
            <input type="file" accept=".pdf,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="Note to the project team (optional)"
            className="w-full h-9 rounded-lg border border-[var(--color-border-strong)] px-2.5 text-sm bg-[var(--color-surface)]" />
          <button onClick={() => void submitQuote()} disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-sm font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />} Submit quote
          </button>
          {msg && (
            <div className={`text-xs rounded-lg border px-3 py-2 ${msg.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700" : "border-rose-500/30 bg-rose-500/[0.07] text-rose-700"}`}>{msg.text}</div>
          )}
        </div>

        <div className="mt-4">
          <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Your submitted quotes</div>
          {(data.quotes?.length ?? 0) === 0 && <div className="text-xs italic text-[var(--color-text-faint)]">Nothing yet — your first quote will appear here with its status.</div>}
          <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] overflow-hidden">
            {(data.quotes ?? []).map((q) => (
              <li key={q.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <FileText className="w-4 h-4 text-emerald-600 shrink-0" />
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
          <div className="mt-3 text-[10px] text-[var(--color-text-faint)]">Quotes go straight to {data.orgName ?? "the client"}&apos;s bid tabulation. This portal is upload-only.</div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center gap-3 mb-1">
        <div className="p-2.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200"><Building2 className="w-5 h-5" /></div>
        <div className="min-w-0">
          <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">Drawing &amp; file submission portal</div>
          <h1 className="text-base font-black text-[var(--color-text)] truncate">{data.projectName}{data.orgName ? ` · ${data.orgName}` : ""}</h1>
          <div className="text-xs text-[var(--color-text-muted)]">Submitting as <b>{data.companyName}</b>{data.allowAutoSupersede ? " · trusted: once one of your own documents has been approved, your later revisions of it can publish immediately (drawings assigned to you are always reviewed)" : " · submissions are reviewed before becoming current"}{data.expiresAt ? ` · link valid until ${new Date(data.expiresAt).toLocaleDateString()}` : ""}</div>
        </div>
      </div>

      {/* Submit form */}
      <div className="mt-4 rounded-xl border border-[var(--color-border-strong)] p-4">
        <div className="flex items-center gap-1 mb-3 rounded-lg border border-[var(--color-border)] p-0.5 w-fit">
          <button onClick={() => setMode("new")} className={`px-3 py-1 rounded-md text-xs font-bold ${mode === "new" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-text-muted)]"}`}>New document</button>
          <button onClick={() => setMode("rev")} disabled={data.items.length === 0} className={`px-3 py-1 rounded-md text-xs font-bold disabled:opacity-40 ${mode === "rev" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-text-muted)]"}`}>Revision of ours</button>
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
                {data.items.map((i) => <option key={i.docId} value={i.docId}>{i.label} (Rev {i.rev ?? "—"})</option>)}
              </select>
              <input value={revLabel} onChange={(e) => setRevLabel(e.target.value)} placeholder="New revision label, e.g. B" className="h-9 rounded-lg border border-[var(--color-border-strong)] px-2.5 text-sm bg-[var(--color-surface)]" />
            </div>
          )}
          <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="What changed? (goes on the record)" className="w-full h-9 rounded-lg border border-[var(--color-border-strong)] px-2.5 text-sm bg-[var(--color-surface)]" />
          <label className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-2.5 cursor-pointer hover:border-[var(--color-accent-ring)]">
            <UploadCloud className="w-4 h-4 text-[var(--color-accent)]" />
            <span className="text-sm text-[var(--color-text-muted)] truncate">{file ? file.name : "Choose the file (PDF, DWG, DXF or ZIP, up to 100 MB)"}</span>
            <input type="file" accept=".pdf,.dwg,.dxf,.zip" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button onClick={() => void submit()} disabled={busy} className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-sm font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />} Submit
          </button>
          {msg && (
            <div className={`text-xs rounded-lg border px-3 py-2 ${msg.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700" : "border-rose-500/30 bg-rose-500/[0.07] text-rose-700"}`}>{msg.text}</div>
          )}
        </div>
      </div>

      {/* Redlines requested — collision tickets waiting on their markups */}
      {(data.redlineRequests?.length ?? 0) > 0 && (
        <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/[0.05] p-4">
          <div className="flex items-center gap-2 mb-2">
            <Pen className="w-4 h-4 text-amber-600" />
            <span className="text-sm font-black text-[var(--color-text)]">Redlines requested</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mb-2">
            One of your submitted sheets conflicts with existing drawings. Upload your markups here — they attach straight to the drafting ticket.
          </p>
          <ul className="space-y-1.5">
            {(data.redlineRequests ?? []).map((r) => (
              <li key={r.ticketRef} className="flex items-center gap-2 flex-wrap rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs">
                <span className="font-bold text-[var(--color-text)]">{r.title}</span>
                <span className="text-[var(--color-text-faint)]">{r.ticketNumber ?? ""}{r.docLabel ? ` · ${r.docLabel}` : ""}</span>
                <label className={`ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-amber-500/50 text-amber-700 font-black cursor-pointer hover:bg-amber-500/10 ${redlineBusy === r.ticketRef ? "opacity-50 pointer-events-none" : ""}`}>
                  {redlineBusy === r.ticketRef ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3" />}
                  Upload redlines
                  <input type="file" accept=".pdf,.dwg,.dxf,.zip,.png,.jpg,.jpeg" className="hidden" onChange={(e) => { void submitRedline(r.ticketRef, e.target.files?.[0] ?? null); e.target.value = ""; }} />
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Their register */}
      <div className="mt-4">
        <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5">Your submissions on this project</div>
        {data.items.length === 0 && <div className="text-xs italic text-[var(--color-text-faint)]">Nothing yet — your first submission will appear here.</div>}
        <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] overflow-hidden">
          {data.items.map((i) => (
            <li key={i.docId} className="px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-500 shrink-0" />
                <span className="font-bold text-[var(--color-text)] truncate">{i.label}</span>
                <span className="text-xs text-[var(--color-text-muted)]">Rev {i.rev ?? "—"}</span>
                {i.pendingReview
                  ? <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-amber-700"><Clock className="w-3 h-3" /> in review</span>
                  : i.lastOutcome === "rejected"
                    ? <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-rose-700"><AlertTriangle className="w-3 h-3" /> not accepted — resubmit</span>
                    : <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700"><CheckCircle2 className="w-3 h-3" /> current</span>}
              </div>
              {!i.pendingReview && i.lastOutcome === "rejected" && i.rejectionReason && (
                <div className="mt-1 ml-6 text-xs text-[var(--color-text-muted)]">Reviewer&apos;s reason: {i.rejectionReason}</div>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-3 text-[10px] text-[var(--color-text-faint)]">Every submission is recorded with your company name on {data.orgName ?? "the client"}&apos;s revision history. This portal is upload-only.</div>
      </div>
    </Shell>
  );
}
