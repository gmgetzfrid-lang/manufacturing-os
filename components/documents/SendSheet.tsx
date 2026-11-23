"use client";

// SendSheet: send one or more documents to someone. A dialog on a desktop,
// a sheet from the bottom on a phone; the same steps on both.
//
//   1. Who is it for?
//      Someone outside the company: a controlled link (no sign-in, expires,
//        can ask for a code, every open logged, can be turned off, every
//        copy stamped uncontrolled). Made by the server, which checks the
//        sender can open every document on it.
//      Someone in this workspace: the app's own links (sign-in needed). No
//        database writes.
//   2. (outside) Name or company, how long, code, download, markups.
//   3. (outside) How to send: copy, email, text, QR code; the code in its
//      own box, to give them a different way.
//
// Below the steps: the links already sent for these documents, with Turn off.

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  X, Link2, Building2, ChevronLeft, ChevronDown, Copy, Check, Mail, MessageSquare,
  QrCode, Download, Printer, Loader2, Eye, KeyRound, PenLine, ShieldCheck,
} from "lucide-react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  btnPrimary, btnQuiet, btnRow, btnDanger, btnIcon, field, Problem, StatusTag, shortDateTime,
} from "@/components/admin/kit";
import {
  appLinkFor, createSendLink, linkIsLive, listSentLinks, turnOffSentLink,
  type CreatedLink, type SentLink,
} from "@/lib/documentShares";
import { uploadToPath } from "@/lib/storage";

export interface SendDoc { id: string; documentNumber: string | null; title: string | null; rev: string | null; libraryId: string }
export interface SendSheetProps {
  orgId: string;
  docs: SendDoc[];
  /** The marked-up copy of a document, when the person marked it up (staged documents). Null: the issued file is sent. */
  markedUp?: (docId: string) => Promise<Blob | null>;
  /** The documents that have markups, so the sheet can offer to send them. */
  markedUpIds?: string[];
  onClose: () => void;
}

type Step = "who" | "inside" | "settings" | "made";
type Days = 1 | 7 | 30;

const docName = (d: SendDoc) => d.documentNumber || d.title || "Untitled document";
const docLine = (d: SendDoc) => [docName(d), d.rev ? `Rev ${d.rev}` : null].filter(Boolean).join(" ");

const noSubscribe = () => () => {};

function plural(n: number, one: string, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    // Older browsers and some embedded views: the textarea fallback.
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

/** A short-lived "Copied" on the button that was pressed. */
function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback(async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopied(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1800);
    }
  }, []);
  return { copied, copy };
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors shrink-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] focus-visible:ring-offset-2 ${on ? "bg-[var(--color-main)]" : "bg-[var(--color-border-strong)]"}`}
    >
      <span className={`inline-block h-6 w-6 transform rounded-full bg-[var(--color-surface)] shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}

/** One setting: a label and a line of help on the left, the switch on the
 *  right. The whole row is a tap target. */
function SettingRow({ icon: Icon, title, help, on, onChange, disabled }: {
  icon: React.ComponentType<{ className?: string }>; title: string; help: React.ReactNode;
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div
      className="flex items-start gap-3 py-3.5 cursor-pointer select-none"
      onClick={() => { if (!disabled) onChange(!on); }}
    >
      <Icon className="w-5 h-5 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-[var(--color-text)]">{title}</div>
        <div className="text-[13px] leading-snug text-[var(--color-text-muted)] mt-0.5">{help}</div>
      </div>
      <div onClick={(e) => e.stopPropagation()} className="pt-0.5">
        <Switch on={on} onChange={onChange} label={title} disabled={disabled} />
      </div>
    </div>
  );
}

/** What "Send my markups" does, in words that fit the count. */
function markupHelp(marked: number, total: number): string {
  if (total === 1) return "This goes as your marked-up copy, stamped the same way.";
  if (marked === total) return "These go as your marked-up copies, stamped the same way.";
  if (marked === 1) return `1 of these has your markups. It goes as your marked-up copy, stamped the same way.`;
  return `${marked} of these have your markups. They go as your marked-up copies, stamped the same way.`;
}

function emailFor(docs: SendDoc[], url: string, until: string | null, withCode: boolean): string {
  const subject = docs.length === 1 ? docLine(docs[0]) : `${docs.length} documents`;
  const list = docs.length === 1
    ? `${docLine(docs[0])}${docs[0].title && docs[0].documentNumber ? `, ${docs[0].title}` : ""}`
    : docs.slice(0, 12).map((d) => `- ${docLine(d)}${d.title && d.documentNumber ? `, ${d.title}` : ""}`).join("\n")
      + (docs.length > 12 ? `\n- and ${docs.length - 12} more` : "");
  const lines = [
    docs.length === 1 ? `Here is a link to ${list}:` : `Here is a link to these documents:\n${list}`,
    "",
    url,
    "",
    until ? `The link works until ${until}.` : "",
    withCode ? "You'll need a code to open it. I'll send you the code separately." : "",
  ].filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "");
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n").trim())}`;
}

function insideEmailFor(docs: SendDoc[], links: string): string {
  const subject = docs.length === 1 ? docLine(docs[0]) : `${docs.length} documents`;
  const body = `${docs.length === 1 ? "Here is the link" : "Here are the links"}. Sign in to open ${docs.length === 1 ? "it" : "them"}.\n\n${links}`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function smsFor(docs: SendDoc[], url: string): string {
  const what = docs.length === 1 ? docLine(docs[0]) : `${docs.length} documents`;
  return `sms:?&body=${encodeURIComponent(`${what}: ${url}`)}`;
}

export default function SendSheet({ orgId, docs, markedUp, markedUpIds, onClose }: SendSheetProps): React.JSX.Element | null {
  const [step, setStep] = useState<Step>("who");
  const [listOpen, setListOpen] = useState(false);

  // Step 2 settings.
  const [recipient, setRecipient] = useState("");
  const [days, setDays] = useState<Days>(7);
  const [withCode, setWithCode] = useState(true);
  const [allowDownload, setAllowDownload] = useState(false);
  const markedHere = useMemo(() => docs.filter((d) => (markedUpIds ?? []).includes(d.id)), [docs, markedUpIds]);
  const [sendMarkups, setSendMarkups] = useState(true);
  const [recipientMissing, setRecipientMissing] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<(CreatedLink & { recipient: string; markedUp: number }) | null>(null);
  const [showQr, setShowQr] = useState(false);
  const { copied, copy } = useCopied();

  // Links already sent.
  const [links, setLinks] = useState<SentLink[] | null>(null);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState<string | null>(null);
  const docIdsKey = docs.map((d) => d.id).join(",");
  const loadLinks = useCallback(async () => {
    setLinksError(null);
    try { setLinks(await listSentLinks(orgId, docIdsKey ? docIdsKey.split(",") : [])); }
    catch (e) { setLinks([]); setLinksError((e as Error).message); }
  }, [orgId, docIdsKey]);
  useEffect(() => { void loadLinks(); }, [loadLinks]);

  useEscapeClose(() => { if (!busy) onClose(); });
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (step === "settings") nameRef.current?.focus(); }, [step]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [step]);

  const appLinks = useMemo(() => docs.map((d) => appLinkFor(d)).join("\n"), [docs]);
  const untilPreview = useMemo(() => shortDateTime(new Date(Date.now() + days * 86_400_000).toISOString()), [days]);
  // Drawn in the browser only (a portal), the same on first paint as on the server.
  const inBrowser = useSyncExternalStore(noSubscribe, () => true, () => false);

  if (docs.length === 0 || !inBrowser) return null;

  const single = docs.length === 1 ? docs[0] : null;
  const title = single ? `Send ${docName(single)}` : `Send ${docs.length} documents`;
  const sub = single
    ? [single.title && single.documentNumber && single.title !== single.documentNumber ? single.title : null, single.rev ? `Rev ${single.rev}` : null].filter(Boolean).join(", ")
    : null;

  const create = async () => {
    const who = recipient.replace(/\s+/g, " ").trim();
    if (!who) { setRecipientMissing(true); nameRef.current?.focus(); return; }
    setError(null);
    try {
      const items: Array<{ documentId: string; markupPath?: string | null }> = docs.map((d) => ({ documentId: d.id }));
      let markedUpCount = 0;
      if (sendMarkups && markedUp && markedHere.length > 0) {
        for (let i = 0; i < markedHere.length; i++) {
          setBusy(markedHere.length === 1 ? "Getting your markups ready…" : `Getting your markups ready (${i + 1} of ${markedHere.length})…`);
          const blob = await markedUp(markedHere[i].id);
          if (!blob) continue;
          const path = `orgs/${orgId}/shares/${crypto.randomUUID()}.pdf`;
          await uploadToPath(blob, path, { contentType: "application/pdf" });
          const it = items.find((x) => x.documentId === markedHere[i].id);
          if (it) { it.markupPath = path; markedUpCount++; }
        }
      }
      setBusy("Making the link…");
      const res = await createSendLink({ orgId, recipient: who, expiresDays: days, withCode, allowDownload, items });
      setMade({ ...res, recipient: who, markedUp: markedUpCount });
      setShowQr(false);
      setStep("made");
      void loadLinks();
    } catch (e) {
      setError((e as Error).message || "The link couldn't be made.");
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async (l: SentLink) => {
    const ok = await appConfirm({
      title: "Turn off this link?",
      message: `${l.recipient || "The person you sent it to"} won't be able to open it anymore. You can't turn it back on; send a new link if they need it again.`,
      tone: "danger",
      confirmLabel: "Turn off",
      cancelLabel: "Keep it",
    });
    if (!ok) return;
    setTurningOff(l.id);
    try {
      const at = await turnOffSentLink(orgId, l.id);
      setLinks((prev) => (prev ?? []).map((x) => (x.id === l.id ? { ...x, revokedAt: at } : x)));
    } catch (e) { setLinksError((e as Error).message); }
    finally { setTurningOff(null); }
  };

  const untilMade = made ? shortDateTime(made.expiresAt) : null;
  const showLinks = step !== "inside";

  return createPortal(
    <div className="fixed inset-0 z-[400] flex items-end sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="send-sheet-title">
      <div className="absolute inset-0 bg-[var(--color-ink)]/55 animate-in fade-in" onClick={() => { if (!busy) onClose(); }} />
      <div className="relative w-full sm:max-w-[580px] max-h-[94dvh] sm:max-h-[90vh] flex flex-col bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border-strong)] rounded-t-2xl sm:rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 sm:slide-in-from-bottom-0 sm:zoom-in-95">
        <div aria-hidden className="sm:hidden mx-auto mt-2 h-1.5 w-10 rounded-full bg-[var(--color-border-strong)]" />

        {/* Title: what is being sent. */}
        <div className="flex items-start gap-3 px-5 pt-3 sm:pt-4 pb-3 border-b border-[var(--color-border)] shrink-0">
          <div className="min-w-0 flex-1">
            <h2 id="send-sheet-title" className="font-display text-[21px] leading-tight font-semibold truncate">{title}</h2>
            {sub && <p className="text-[14px] text-[var(--color-text-muted)] mt-0.5 truncate">{sub}</p>}
            {!single && (
              <button type="button" onClick={() => setListOpen((v) => !v)} aria-expanded={listOpen}
                className="mt-1 inline-flex items-center gap-1 text-[14px] font-semibold text-[var(--color-accent-text)] hover:underline underline-offset-2">
                {listOpen ? "Hide the list" : docs.length > 4 ? `Show all ${docs.length}` : "Show the list"}
                <ChevronDown className={`w-4 h-4 transition-transform ${listOpen ? "rotate-180" : ""}`} />
              </button>
            )}
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} aria-label="Close" className={`${btnIcon} w-10 h-10 -mr-2 -mt-1`}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {!single && listOpen && (
            <ul className="px-5 py-2 border-b border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface-2)]">
              {docs.map((d) => (
                <li key={d.id} className="py-2 flex items-baseline gap-3 text-[14px] min-w-0">
                  <span className="font-semibold shrink-0 tabular-nums">{docName(d)}</span>
                  <span className="text-[var(--color-text-muted)] truncate flex-1 min-w-0">{d.documentNumber ? d.title : ""}</span>
                  {d.rev && <span className="shrink-0 text-[var(--color-text-muted)]">Rev {d.rev}</span>}
                  {markedHere.some((m) => m.id === d.id) && <span className="shrink-0 text-[13px] font-semibold text-[var(--color-accent-text)]">Marked up</span>}
                </li>
              ))}
            </ul>
          )}

          <div className="px-5 py-4">
            {step === "who" && (
              <div>
                <h3 className="text-[17px] font-semibold mb-3">Who is it for?</h3>
                <div className="grid gap-3">
                  <ChoiceButton
                    icon={Link2}
                    title="Someone outside the company"
                    body="No sign-in. The link expires, can ask for a code, logs every open, and you can turn it off. Copies are marked uncontrolled."
                    onClick={() => setStep("settings")}
                  />
                  <ChoiceButton
                    icon={Building2}
                    title="Someone in this workspace"
                    body="They sign in and see the live document."
                    onClick={() => setStep("inside")}
                  />
                </div>
              </div>
            )}

            {step === "inside" && (
              <div>
                <h3 className="text-[17px] font-semibold">{docs.length === 1 ? "The link to this document" : "The links to these documents"}</h3>
                <p className="text-[14px] text-[var(--color-text-muted)] mt-1">They sign in and see the live document.</p>
                <textarea
                  readOnly value={appLinks} rows={Math.min(docs.length, 6)}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label={docs.length === 1 ? "Link" : "Links"}
                  className={`mt-3 w-full py-2.5 text-[14px] leading-relaxed resize-none ${field.replace("h-10", "")} whitespace-pre overflow-x-auto`}
                />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <a href={insideEmailFor(docs, appLinks)} className={`${btnQuiet} h-11`}>
                    <Mail className="w-4 h-4" /> Email
                  </a>
                  <a href={smsFor(docs, appLinks)} className={`${btnQuiet} h-11`}>
                    <MessageSquare className="w-4 h-4" /> Text
                  </a>
                </div>
              </div>
            )}

            {step === "settings" && (
              <form onSubmit={(e) => { e.preventDefault(); void create(); }} id="send-settings">
                <h3 className="text-[17px] font-semibold">Set up the link</h3>
                <div className="mt-3">
                  <label htmlFor="send-recipient" className="block text-[14px] font-semibold">Name or company</label>
                  <input
                    id="send-recipient" ref={nameRef} value={recipient} disabled={!!busy} maxLength={120}
                    onChange={(e) => { setRecipient(e.target.value); if (e.target.value.trim()) setRecipientMissing(false); }}
                    placeholder="e.g. John, ABC Contractors" autoComplete="off" enterKeyHint="done"
                    aria-invalid={recipientMissing} aria-describedby="send-recipient-help"
                    className={`mt-1.5 ${field} h-11 ${recipientMissing ? "border-[var(--state-overdue)]" : ""}`}
                  />
                  <p id="send-recipient-help" className={`mt-1 text-[13px] ${recipientMissing ? "text-[var(--state-overdue)] font-semibold" : "text-[var(--color-text-muted)]"}`}>
                    {recipientMissing ? "Say who it's for. It's printed on every page they see." : "Printed on every page they see."}
                  </p>
                </div>

                <div className="mt-4">
                  <div className="text-[14px] font-semibold" id="send-days">Link works for</div>
                  <div role="radiogroup" aria-labelledby="send-days" className="mt-1.5 grid grid-cols-3 rounded-md border border-[var(--color-border-strong)] overflow-hidden">
                    {([1, 7, 30] as Days[]).map((d, i) => (
                      <button
                        key={d} type="button" role="radio" aria-checked={days === d} disabled={!!busy}
                        onClick={() => setDays(d)}
                        className={`h-11 text-[15px] font-semibold transition-colors ${i > 0 ? "border-l border-[var(--color-border-strong)]" : ""} ${days === d ? "bg-[var(--color-main)] text-white" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}
                      >
                        {d === 1 ? "1 day" : `${d} days`}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">Until {untilPreview}.</p>
                </div>

                <div className="mt-2 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                  <SettingRow
                    icon={KeyRound} title="Ask for a code" on={withCode} onChange={setWithCode} disabled={!!busy}
                    help="They type a 6-digit code before anything shows. You give them the code another way, like a call or a text."
                  />
                  <SettingRow
                    icon={Download} title="Let them download a copy" on={allowDownload} onChange={setAllowDownload} disabled={!!busy}
                    help={allowDownload
                      ? "They can save a stamped PDF. Once saved, you can't take it back."
                      : "Off: they can only view it in the browser. Anything shown on a screen can still be photographed or captured."}
                  />
                  {markedHere.length > 0 && markedUp && (
                    <SettingRow
                      icon={PenLine} title="Send my markups" on={sendMarkups} onChange={setSendMarkups} disabled={!!busy}
                      help={sendMarkups ? markupHelp(markedHere.length, docs.length) : "Off: the issued file is sent, without your markups."}
                    />
                  )}
                </div>

                <p className="mt-3 flex items-start gap-2 text-[13px] text-[var(--color-text-muted)]">
                  <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>Every page is stamped UNCONTROLLED with the revision and a QR code to check it is still current. Each open is logged.</span>
                </p>
                {error && <Problem className="mt-3">{error}</Problem>}
              </form>
            )}

            {step === "made" && made && (
              <MadeStep
                made={made} docs={docs} until={untilMade} withCode={!!made.code}
                copied={copied} copy={copy} showQr={showQr} setShowQr={setShowQr}
              />
            )}
          </div>

          {showLinks && (
            <SentLinks links={links} error={linksError} retry={() => void loadLinks()} docs={docs}
              copied={copied} copy={copy} turningOff={turningOff} onTurnOff={turnOff} justMade={made?.id ?? null} />
          )}
        </div>

        {/* The step's buttons: Back on the left, the one main action on the right. */}
        {step !== "who" && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-none sm:rounded-b-xl shrink-0 pb-[max(12px,env(safe-area-inset-bottom))]">
            {step !== "made" && (
              <button type="button" onClick={() => { setError(null); setStep("who"); }} disabled={!!busy} className={`${btnQuiet} h-11`}>
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            <div className="flex-1" />
            {step === "inside" && (
              <button type="button" onClick={() => void copy("app", appLinks)} className={`${btnPrimary} h-11 min-w-[140px]`}>
                {copied === "app" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied === "app" ? "Copied" : docs.length === 1 ? "Copy link" : "Copy links"}
              </button>
            )}
            {step === "settings" && (
              <button type="submit" form="send-settings" disabled={!!busy} className={`${btnPrimary} h-11 min-w-[140px]`}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                {busy ?? "Create link"}
              </button>
            )}
            {step === "made" && (
              <button type="button" onClick={onClose} className={`${btnQuiet} h-11 min-w-[110px]`}>Done</button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ChoiceButton({ icon: Icon, title, body, onClick }: {
  icon: React.ComponentType<{ className?: string }>; title: string; body: string; onClick: () => void;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className="group w-full text-left flex items-start gap-3.5 p-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:border-[var(--color-main)] hover:bg-[var(--color-surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]"
    >
      <span className="ui-icon-tile shrink-0"><Icon className="w-[18px] h-[18px]" /></span>
      <span className="flex-1 min-w-0">
        <span className="block text-[16px] font-semibold text-[var(--color-text)]">{title}</span>
        <span className="block text-[14px] leading-snug text-[var(--color-text-muted)] mt-1">{body}</span>
      </span>
      <ChevronLeft className="w-5 h-5 rotate-180 mt-2.5 shrink-0 text-[var(--color-text-faint)] group-hover:text-[var(--color-text)]" />
    </button>
  );
}

function MadeStep({ made, docs, until, withCode, copied, copy, showQr, setShowQr }: {
  made: CreatedLink & { recipient: string; markedUp: number };
  docs: SendDoc[];
  until: string | null;
  withCode: boolean;
  copied: string | null;
  copy: (key: string, text: string) => Promise<void>;
  showQr: boolean;
  setShowQr: (v: boolean) => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { toDataURL } = await import("qrcode");
        const url = await toDataURL(made.url, { margin: 2, width: 720, errorCorrectionLevel: "M" });
        if (alive) setQr(url);
      } catch { if (alive) setQr(null); }
    })();
    return () => { alive = false; };
  }, [made.url]);

  const what = docs.length === 1 ? docLine(docs[0]) : `${docs.length} documents`;
  const fileBase = `link-${made.recipient.replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "qr"}`;

  const downloadQr = () => {
    if (!qr) return;
    const a = document.createElement("a");
    a.href = qr; a.download = `${fileBase}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const printQr = () => {
    if (!qr) return;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]!));
    const list = docs.slice(0, 20).map((d) => `<li>${esc(docLine(d))}${d.title && d.documentNumber ? ` <span>${esc(d.title)}</span>` : ""}</li>`).join("")
      + (docs.length > 20 ? `<li>and ${docs.length - 20} more</li>` : "");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(what)}</title><style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;text-align:center;margin:48px}
      h1{font-size:28px;margin:0 0 8px} p{font-size:16px;margin:6px 0} img{width:340px;height:340px;margin:24px auto;display:block}
      ul{list-style:none;padding:0;font-size:15px} li{margin:4px 0} li span{color:#555}
    </style></head><body>
      <h1>Scan to open</h1>
      <p>For ${esc(made.recipient)}</p>
      <img src="${qr}" alt="QR code">
      <ul>${list}</ul>
      ${until ? `<p>The link works until ${esc(until)}.</p>` : ""}
      ${withCode ? "<p>You also need the code from the person who sent it.</p>" : ""}
    </body></html>`;
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.srcdoc = html;
    frame.onload = () => {
      const w = frame.contentWindow;
      if (!w) return;
      w.focus(); w.print();
      setTimeout(() => frame.remove(), 60_000);
    };
    document.body.appendChild(frame);
  };

  return (
    <div>
      <h3 className="text-[17px] font-semibold">How to send</h3>
      <p className="text-[14px] text-[var(--color-text-muted)] mt-1">
        For {made.recipient}. {until ? `Works until ${until}.` : ""}
        {made.markedUp > 0 ? ` ${made.markedUp === docs.length ? (docs.length === 1 ? "It's your marked-up copy." : "All are your marked-up copies.") : `${made.markedUp} ${made.markedUp === 1 ? "is your marked-up copy" : "are your marked-up copies"}.`}` : ""}
      </p>

      <div className="mt-3 flex items-stretch gap-2">
        <input
          readOnly value={made.url} aria-label="Link" onFocus={(e) => e.currentTarget.select()}
          className={`${field} h-11 text-[14px] min-w-0 flex-1`}
        />
        <button type="button" onClick={() => void copy("made", made.url)} className={`${btnPrimary} h-11 shrink-0 min-w-[104px]`}>
          {copied === "made" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied === "made" ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <a href={emailFor(docs, made.url, until, withCode)} className={`${btnQuiet} h-14 flex-col gap-1 text-[13px]`}>
          <Mail className="w-5 h-5" /> Email
        </a>
        <a href={smsFor(docs, made.url)} className={`${btnQuiet} h-14 flex-col gap-1 text-[13px]`}>
          <MessageSquare className="w-5 h-5" /> Text
        </a>
        <button type="button" onClick={() => setShowQr(!showQr)} aria-expanded={showQr}
          className={`${btnQuiet} h-14 flex-col gap-1 text-[13px] ${showQr ? "!border-[var(--color-main)] !bg-[var(--color-surface-2)]" : ""}`}>
          <QrCode className="w-5 h-5" /> QR code
        </button>
      </div>

      {showQr && (
        <div className="mt-3 rounded-lg border border-[var(--color-border)] p-4 flex flex-col items-center">
          {qr
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={qr} alt="QR code for the link" className="w-[260px] h-[260px] max-w-full bg-white rounded-md" />
            : <div className="w-[260px] h-[260px] flex items-center justify-center text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /></div>}
          <p className="mt-2 text-[13px] text-[var(--color-text-muted)] text-center">They scan it with a phone camera to open the link.</p>
          <div className="mt-3 grid grid-cols-2 gap-2 w-full max-w-[320px]">
            <button type="button" onClick={downloadQr} disabled={!qr} className={`${btnQuiet} h-11`}><Download className="w-4 h-4" /> Download PNG</button>
            <button type="button" onClick={printQr} disabled={!qr} className={`${btnQuiet} h-11`}><Printer className="w-4 h-4" /> Print</button>
          </div>
        </div>
      )}

      {made.code && (
        <div className="mt-4 rounded-lg border-2 border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-4">
          <div className="text-[14px] font-semibold text-[var(--color-text-muted)]">Code</div>
          <div className="mt-1 flex items-center gap-3 flex-wrap">
            <span className="text-[36px] leading-none font-bold tracking-[0.14em] tabular-nums text-[var(--color-text)] select-all" aria-label={`Code ${made.code.split("").join(" ")}`}>
              {made.code.slice(0, 3)}<span className="inline-block w-3" />{made.code.slice(3)}
            </span>
            <div className="flex-1" />
            <button type="button" onClick={() => void copy("code", made.code!)} className={`${btnQuiet} h-11 min-w-[96px]`}>
              {copied === "code" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied === "code" ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-[14px] font-semibold text-[var(--color-text)]">Send the code a different way than the link (call or text).</p>
          <p className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">It isn&apos;t shown again after you close this. Ten wrong tries lock the link.</p>
        </div>
      )}
    </div>
  );
}

function SentLinks({ links, error, retry, docs, copied, copy, turningOff, onTurnOff, justMade }: {
  links: SentLink[] | null;
  error: string | null;
  retry: () => void;
  docs: SendDoc[];
  copied: string | null;
  copy: (key: string, text: string) => Promise<void>;
  turningOff: string | null;
  onTurnOff: (l: SentLink) => void;
  justMade: string | null;
}) {
  const here = new Set(docs.map((d) => d.id));
  const [now] = useState(() => Date.now());
  return (
    <section className="px-5 pt-4 pb-5 border-t border-[var(--color-border)]" aria-labelledby="send-sent-title">
      <h3 id="send-sent-title" className="text-[15px] font-semibold">Links already sent for {docs.length === 1 ? "this" : "these"}</h3>
      {links === null && !error && (
        <div className="mt-2 text-[14px] text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Looking…</div>
      )}
      {error && <Problem className="mt-2" retry={retry}>{error}</Problem>}
      {links && links.length === 0 && !error && (
        <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">None yet.</p>
      )}
      {links && links.length > 0 && (
        <ul className="mt-2 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {links.map((l) => {
            const live = linkIsLive(l, now);
            const expired = !l.revokedAt && !!l.expiresAt && new Date(l.expiresAt).getTime() < now;
            const status = l.revokedAt ? { tone: "none" as const, text: "Turned off" }
              : l.locked ? { tone: "bad" as const, text: "Locked" }
              : expired ? { tone: "none" as const, text: "Expired" }
              : { tone: "good" as const, text: "Active" };
            const others = l.documentIds.filter((id) => !here.has(id)).length;
            const facts = [
              l.withCode ? "Code on" : "No code",
              l.allowDownload ? "Download on" : "View only",
              l.markedUpIds.some((id) => here.has(id)) ? "Marked up" : null,
              l.documentIds.length > 1 ? `${plural(l.documentIds.length, "document")}${others > 0 ? ` (${others} not in this list)` : ""}` : null,
            ].filter(Boolean).join(" · ");
            return (
              <li key={l.id} className={`py-3 ${live ? "" : "opacity-70"}`}>
                <div className="flex items-start gap-x-3 gap-y-2 flex-wrap sm:flex-nowrap">
                  <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[15px] font-semibold truncate max-w-full">{l.recipient || "No name given"}</span>
                      <StatusTag tone={status.tone}>{status.text}</StatusTag>
                      {justMade === l.id && <span className="text-[13px] text-[var(--color-text-muted)]">Just made</span>}
                    </div>
                    <div className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">
                      Made {shortDateTime(l.createdAt)}{l.createdByName && !l.mine ? ` by ${l.createdByName}` : ""}
                      {l.revokedAt ? `. Turned off ${shortDateTime(l.revokedAt)}` : l.expiresAt ? `. ${expired ? "Expired" : "Expires"} ${shortDateTime(l.expiresAt)}` : ""}
                      {l.locked && !l.revokedAt ? ". Too many wrong codes" : ""}
                    </div>
                    <p className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">
                      <Eye className="inline w-3.5 h-3.5 mr-1 align-[-2px]" />
                      {l.accessCount === 0 ? "Not opened yet" : `Opened ${plural(l.accessCount, "time")}${l.accessLastAt ? `, last ${shortDateTime(l.accessLastAt)}` : ""}`}
                      {` · ${facts}`}
                    </p>
                  </div>
                  {live && (
                    <div className="flex items-center gap-2 shrink-0">
                      {l.url && (
                        <button type="button" onClick={() => void copy(`l:${l.id}`, l.url!)} className={`${btnRow} h-10`}>
                          {copied === `l:${l.id}` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          {copied === `l:${l.id}` ? "Copied" : "Copy link"}
                        </button>
                      )}
                      <button type="button" onClick={() => onTurnOff(l)} disabled={turningOff === l.id} className={`${btnDanger} h-10 text-[13px] px-3`}>
                        {turningOff === l.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                        Turn off
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
