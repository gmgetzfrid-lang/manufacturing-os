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

interface IntakeItem {
  docId: string; label: string; rev: string | null; status: string | null;
  pendingReview: boolean; updatedAt: string | null;
}
interface RedlineRequest {
  ticketRef: string; ticketNumber: string | null; title: string; docLabel: string | null;
}
interface Resolved {
  projectName: string; orgName: string | null; companyName: string;
  allowAutoSupersede: boolean; items: IntakeItem[];
  redlineRequests?: RedlineRequest[];
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
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  // Redline uploads (per collision ticket)
  const [redlineBusy, setRedlineBusy] = useState<string | null>(null);

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
      const res = await fetch("/api/intake/upload", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setMsg({ tone: "ok", text: body.message ?? "Submitted." });
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
      const form = new FormData();
      form.set("token", token);
      form.set("file", f);
      form.set("ticketId", ticketRef);
      const res = await fetch("/api/intake/upload", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setMsg({ tone: "ok", text: body.message ?? "Redlines sent." });
      await refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally { setRedlineBusy(null); }
  };

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-screen bg-[var(--color-surface-2)] flex items-start justify-center p-4 sm:p-8">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-lg p-6">{children}</div>
    </div>
  );

  if (state === "loading") return <Shell><div className="text-center text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Opening your submission portal…</div></Shell>;
  if (state !== "ok" || !data) {
    const text = state === "revoked" ? "This link has been revoked. Contact your project contact for a fresh one."
      : state === "expired" ? "This link has expired. Contact your project contact for a fresh one."
      : state === "notfound" ? "This link doesn't exist — it may have been mistyped."
      : "Something went wrong opening this link. Try again shortly.";
    return <Shell><div className="text-center"><AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-2" /><p className="text-sm text-[var(--color-text-muted)]">{text}</p></div></Shell>;
  }

  return (
    <Shell>
      <div className="flex items-center gap-3 mb-1">
        <div className="p-2.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200"><Building2 className="w-5 h-5" /></div>
        <div className="min-w-0">
          <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">Drawing &amp; file submission portal</div>
          <h1 className="text-base font-black text-[var(--color-text)] truncate">{data.projectName}{data.orgName ? ` · ${data.orgName}` : ""}</h1>
          <div className="text-xs text-[var(--color-text-muted)]">Submitting as <b>{data.companyName}</b>{data.allowAutoSupersede ? " · trusted: your revisions publish immediately" : " · submissions are reviewed before becoming current"}</div>
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
            <span className="text-sm text-[var(--color-text-muted)] truncate">{file ? file.name : "Choose the file (PDF, DWG, ZIP… up to 100 MB)"}</span>
            <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
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
                  <input type="file" className="hidden" onChange={(e) => { void submitRedline(r.ticketRef, e.target.files?.[0] ?? null); e.target.value = ""; }} />
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
            <li key={i.docId} className="flex items-center gap-2 px-3 py-2 text-sm">
              <FileText className="w-4 h-4 text-blue-500 shrink-0" />
              <span className="font-bold text-[var(--color-text)] truncate">{i.label}</span>
              <span className="text-xs text-[var(--color-text-muted)]">Rev {i.rev ?? "—"}</span>
              {i.pendingReview
                ? <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-amber-700"><Clock className="w-3 h-3" /> in review</span>
                : <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700"><CheckCircle2 className="w-3 h-3" /> current</span>}
            </li>
          ))}
        </ul>
        <div className="mt-3 text-[10px] text-[var(--color-text-faint)]">Every submission is recorded with your company name on {data.orgName ?? "the client"}&apos;s revision history. This portal is upload-only.</div>
      </div>
    </Shell>
  );
}
