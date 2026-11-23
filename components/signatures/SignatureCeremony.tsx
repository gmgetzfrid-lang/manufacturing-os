"use client";

// SignatureCeremony — the deliberate "sign here" act. The signer picks an
// intent, reads the plain-language statement they're affirming, and confirms by
// either DRAWING their signature (touchpad — mouse / finger / stylus) or TYPING
// their name to match. This intent capture is what separates a legal-grade
// signature from a click.

import React from "react";
import { X, PenLine, ShieldCheck, Loader2, Type as TypeIcon, Signature, KeyRound } from "lucide-react";
import {
  signingReauthState, verifySigningCredential, reauthWithProvider,
  type SignatureIntent, type SigningReauth,
} from "@/lib/eSignatures";
import SignaturePad from "@/components/signatures/SignaturePad";
import { heroPrimary as primaryBtn, heroQuiet as secondaryBtn } from "@/components/ui/PageHero";

import { friendlyError } from "@/lib/friendlyError";
const INTENTS: SignatureIntent[] = ["Approved", "Reviewed", "Acknowledged", "Witnessed", "Rejected"];

export default function SignatureCeremony({
  signerName, defaultIntent = "Approved", defaultStatement, resourceLabel, busy,
  allowDrawn = true, defaultMode = "draw", lockIntent = false, onCancel, onSign,
}: {
  signerName: string;
  defaultIntent?: SignatureIntent;
  defaultStatement?: string;
  resourceLabel?: string;
  busy?: boolean;
  /** Offer the touchpad-drawn mode (default true). */
  allowDrawn?: boolean;
  /** Which capture mode to open in when both are available. */
  defaultMode?: "draw" | "type";
  /** Hide the intent picker (e.g. a read-&-understood flow is always "Acknowledged"). */
  lockIntent?: boolean;
  onCancel: () => void;
  onSign: (intent: SignatureIntent, statement: string, signatureImage?: string | null) => void;
}) {
  const [intent, setIntent] = React.useState<SignatureIntent>(defaultIntent);
  const [mode, setMode] = React.useState<"draw" | "type">(allowDrawn ? defaultMode : "type");
  const [typed, setTyped] = React.useState("");
  const [drawn, setDrawn] = React.useState<string | null>(null);
  const [agreed, setAgreed] = React.useState(false);

  // Re-authentication: signing must prove it's YOU at the keyboard, not just
  // someone at your unlocked workstation. Password accounts re-enter their
  // password; SSO accounts need a recent provider sign-in.
  const [reauth, setReauth] = React.useState<SigningReauth | null | "loading">("loading");
  const [password, setPassword] = React.useState("");
  const [verifying, setVerifying] = React.useState(false);
  const [reauthError, setReauthError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    signingReauthState()
      .then((s) => { if (!cancelled) setReauth(s); })
      .catch(() => { if (!cancelled) setReauth(null); });
    return () => { cancelled = true; };
  }, []);

  const statement = defaultStatement ?? `I, ${signerName}, ${intent.toLowerCase()} ${resourceLabel ?? "this document"} and affirm this as my electronic signature.`;
  const nameMatches = typed.trim().toLowerCase() === signerName.trim().toLowerCase() && signerName.trim().length > 0;
  const signed = mode === "draw" ? !!drawn : nameMatches;
  const identityReady =
    reauth === "loading" ? false
    : reauth === null ? true                 // no session info — server still validates the write
    : reauth.method === "password" ? password.length > 0
    : reauth.fresh;
  const canSign = signed && agreed && identityReady && !busy && !verifying;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const submit = async () => {
    if (reauth !== "loading" && reauth?.method === "password") {
      setVerifying(true);
      setReauthError(null);
      try {
        await verifySigningCredential(reauth.email, password);
      } catch (e) {
        setReauthError(friendlyError(e));
        setVerifying(false);
        return;
      }
      setVerifying(false);
    }
    onSign(intent, statement, mode === "draw" ? drawn : null);
  };

  // Switching modes remounts the pad blank — clear the captured image so a
  // stale, no-longer-visible drawing can never be submitted as the signature.
  const switchMode = (m: "draw" | "type") => { setMode(m); setDrawn(null); };

  // One choice out of a few: a segmented control, the picked one ruled
  // in graphite.
  const seg = (on: boolean) =>
    `inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-[14px] font-semibold transition-colors ${on
      ? "border-[var(--color-text)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-[inset_0_0_0_1px_var(--color-text)]"
      : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`;
  const label = "block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5";
  const input = "w-full h-11 px-3 rounded-md border bg-[var(--color-surface)] text-[var(--color-text)] outline-none focus:ring-2";

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="sig-ceremony-title" className="fixed inset-0 z-[500] bg-[var(--color-ink)]/60 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={() => !busy && onCancel()}>
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-lg shadow-2xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 h-14 border-b border-[var(--color-border)]">
          <ShieldCheck className="w-4 h-4 text-[var(--color-text-muted)]" />
          <h2 id="sig-ceremony-title" className="font-display text-[19px] font-semibold text-[var(--color-text)] flex-1">Sign {resourceLabel ?? "this document"}</h2>
          <button type="button" onClick={() => !busy && onCancel()} aria-label="Close" className="w-8 h-8 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-5">
          {!lockIntent && (
            <fieldset>
              <legend className={label}>What you are signing for</legend>
              <div className="flex flex-wrap gap-1.5" role="radiogroup">
                {INTENTS.map((it) => (
                  <button key={it} type="button" role="radio" aria-checked={intent === it} onClick={() => setIntent(it)} className={seg(intent === it)}>
                    {it}
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          <div className="border-l-[3px] border-[var(--color-border-strong)] pl-3">
            <div className="text-[13px] text-[var(--color-text-muted)]">You are affirming</div>
            <p className="text-[15px] text-[var(--color-text)] leading-snug">{statement}</p>
          </div>

          {allowDrawn && (
            <div className="flex gap-1.5" role="radiogroup" aria-label="How to sign">
              <button type="button" role="radio" aria-checked={mode === "draw"} onClick={() => switchMode("draw")} className={seg(mode === "draw")}><Signature className="w-4 h-4" /> Draw</button>
              <button type="button" role="radio" aria-checked={mode === "type"} onClick={() => switchMode("type")} className={seg(mode === "type")}><TypeIcon className="w-4 h-4" /> Type your name</button>
            </div>
          )}

          {mode === "draw" ? (
            <div>
              <div className={label}>Sign your name</div>
              <SignaturePad onChange={setDrawn} />
            </div>
          ) : (
            <div>
              <label htmlFor="sig-typed" className={label}>Type your full name to sign</label>
              <input
                id="sig-typed"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={signerName}
                className={`${input} ${typed.length > 0 && !nameMatches ? "border-[var(--state-overdue)] focus:ring-[var(--state-overdue)]/30" : "border-[var(--color-border-strong)] focus:ring-[var(--color-accent-ring)]"}`}
                style={{ fontFamily: "cursive", fontSize: "1.15rem" }}
                autoFocus
              />
              {typed.length > 0 && !nameMatches && <p className="text-[13px] text-[var(--state-overdue)] mt-1">Must match your account name: {signerName}</p>}
            </div>
          )}

          {reauth === "loading" && (
            <p className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking your sign-in…</p>
          )}
          {reauth !== "loading" && reauth?.method === "password" && (
            <div>
              <label htmlFor="sig-password" className={label}>
                <span className="inline-flex items-center gap-1"><KeyRound className="w-3.5 h-3.5" /> Confirm your password</span>
              </label>
              <input
                id="sig-password"
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setReauthError(null); }}
                placeholder="Your account password"
                autoComplete="current-password"
                className={`${input} ${reauthError ? "border-[var(--state-overdue)] focus:ring-[var(--state-overdue)]/30" : "border-[var(--color-border-strong)] focus:ring-[var(--color-accent-ring)]"}`}
              />
              {reauthError
                ? <p className="text-[13px] text-[var(--state-overdue)] mt-1">{reauthError}</p>
                : <p className="text-[13px] text-[var(--color-text-muted)] mt-1">Asked each time, so nobody can sign from your unlocked screen.</p>}
            </div>
          )}
          {reauth !== "loading" && reauth?.method === "sso" && !reauth.fresh && (
            <div className="border-l-[3px] border-[var(--state-held)] pl-3">
              <p className="text-[14px] text-[var(--color-text)]">
                Signing needs a recent sign-in. Sign in with Microsoft again; you&apos;ll come straight back here.
              </p>
              <button type="button" onClick={() => void reauthWithProvider()} className={`mt-2 ${secondaryBtn}`}>
                <KeyRound className="w-4 h-4" /> Sign in again
              </button>
            </div>
          )}

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 w-4 h-4 shrink-0 accent-[var(--color-text)]" />
            <span className="text-[14px] leading-snug text-[var(--color-text)]">I understand this signature is binding and is recorded with my name, role and the time.</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--color-border)]">
          <button type="button" onClick={() => !busy && onCancel()} className={secondaryBtn}>Cancel</button>
          <button type="button" onClick={submit} disabled={!canSign} className={primaryBtn}>
            {busy || verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <PenLine className="w-4 h-4" />} Sign
          </button>
        </div>
      </div>
    </div>
  );
}
