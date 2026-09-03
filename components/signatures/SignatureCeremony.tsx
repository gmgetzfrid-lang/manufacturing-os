"use client";

// SignatureCeremony — the deliberate "sign here" act. The signer picks an
// intent, reads the plain-language statement they're affirming, and confirms by
// either DRAWING their signature (touchpad — mouse / finger / stylus) or TYPING
// their name to match. This intent capture is what separates a legal-grade
// signature from a click.

import React from "react";
import { X, PenLine, ShieldCheck, Loader2, Type as TypeIcon, Signature, KeyRound } from "lucide-react";
import {
  signingReauthState, reauthWithProvider,
  type SignatureIntent, type SigningReauth, type SigningCredential,
} from "@/lib/eSignatures";
import SignaturePad from "@/components/signatures/SignaturePad";

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
  /** SURF-14: the credential rides WITH the signature to the server, which
   *  verifies it before minting the row — nothing is verified here. */
  onSign: (intent: SignatureIntent, statement: string, signatureImage?: string | null, reauth?: SigningCredential) => void;
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
    : reauth === null ? true                 // no session info here — the signing route verifies and refuses if it cannot
    : reauth.method === "password" ? password.length > 0
    : reauth.fresh;
  const canSign = signed && agreed && identityReady && !busy;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const submit = async () => {
    setReauthError(null);
    // The password is never checked in the browser: it goes to the signing
    // route, which verifies it against Supabase Auth and only then mints the
    // row — so a signature is bound to a re-authentication the server saw.
    const credential: SigningCredential = reauth !== "loading" && reauth?.method === "password"
      ? { method: "password", password }
      : { method: "sso" };
    onSign(intent, statement, mode === "draw" ? drawn : null, credential);
  };

  // Switching modes remounts the pad blank — clear the captured image so a
  // stale, no-longer-visible drawing can never be submitted as the signature.
  const switchMode = (m: "draw" | "type") => { setMode(m); setDrawn(null); };

  const tabBtn = (m: "draw" | "type", label: string, Icon: typeof TypeIcon) => (
    <button
      onClick={() => switchMode(m)}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${mode === m ? "bg-[var(--color-accent)] text-white border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[500] bg-slate-900/75 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={() => !busy && onCancel()}>
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[var(--color-border)]">
          <ShieldCheck className="w-4 h-4 text-[var(--color-accent)]" />
          <h2 className="text-sm font-black text-[var(--color-text)] flex-1">Electronic signature</h2>
          <button onClick={() => !busy && onCancel()} className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          {!lockIntent && (
            <div>
              <label className="block text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">Intent</label>
              <div className="flex flex-wrap gap-1.5">
                {INTENTS.map((it) => (
                  <button
                    key={it}
                    onClick={() => setIntent(it)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${intent === it ? "bg-[var(--color-accent)] text-white border-transparent" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}
                  >
                    {it}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)] p-3">
            <div className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">You are affirming</div>
            <p className="text-sm text-[var(--color-text)] leading-relaxed">{statement}</p>
          </div>

          {allowDrawn && (
            <div className="flex gap-1.5">
              {tabBtn("draw", "Draw signature", Signature)}
              {tabBtn("type", "Type name", TypeIcon)}
            </div>
          )}

          {mode === "draw" ? (
            <div>
              <label className="block text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">Sign your name</label>
              <SignaturePad onChange={setDrawn} />
            </div>
          ) : (
            <div>
              <label className="block text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">Type your full name to sign</label>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={signerName}
                className={`w-full h-11 px-3 rounded-lg border bg-[var(--color-surface)] text-[var(--color-text)] outline-none focus:ring-2 ${typed.length > 0 && !nameMatches ? "border-rose-300 focus:ring-rose-300/40" : "border-[var(--color-border)] focus:ring-[var(--color-accent-ring)]"}`}
                style={{ fontFamily: "cursive", fontSize: "1.15rem" }}
                autoFocus
              />
              {typed.length > 0 && !nameMatches && <p className="text-[11px] text-rose-600 mt-1">Must match your account name exactly: {signerName}</p>}
            </div>
          )}

          {reauth !== "loading" && reauth?.method === "password" && (
            <div>
              <label className="block text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
                <span className="inline-flex items-center gap-1"><KeyRound className="w-3 h-3" /> Confirm your password</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setReauthError(null); }}
                placeholder="Your account password"
                autoComplete="current-password"
                className={`w-full h-11 px-3 rounded-lg border bg-[var(--color-surface)] text-[var(--color-text)] outline-none focus:ring-2 ${reauthError ? "border-rose-300 focus:ring-rose-300/40" : "border-[var(--color-border)] focus:ring-[var(--color-accent-ring)]"}`}
              />
              {reauthError
                ? <p className="text-[11px] text-rose-600 mt-1">{reauthError}</p>
                : <p className="text-[11px] text-[var(--color-text-faint)] mt-1">Re-entered at the moment of signing, so a signature can only come from you — not from your unlocked screen.</p>}
            </div>
          )}
          {reauth !== "loading" && reauth?.method === "sso" && !reauth.fresh && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs text-amber-800">
                Signatures need a recent sign-in. Verify it&apos;s you with your Microsoft account, then finish signing — you&apos;ll come straight back here.
              </p>
              <button
                onClick={() => void reauthWithProvider()}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700"
              >
                <KeyRound className="w-3.5 h-3.5" /> Re-authenticate with Microsoft
              </button>
            </div>
          )}

          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
            <span className="text-xs text-[var(--color-text-muted)]">I understand this electronic signature is legally binding and will be permanently recorded with my name, role, and timestamp.</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--color-border)]">
          <button onClick={() => !busy && onCancel()} className="px-4 py-2 rounded-lg text-sm font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Cancel</button>
          <button
            onClick={submit}
            disabled={!canSign}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-bold disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <PenLine className="w-4 h-4" />} Sign
          </button>
        </div>
      </div>
    </div>
  );
}
