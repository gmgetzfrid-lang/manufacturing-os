// lib/assistantScreen.ts — pure, isomorphic. ASK-6.
//
// Text the MODEL wrote that a page would otherwise put in front of an input
// box (a calculation's "Need" prompt) or on a button (a clarify round's
// aspects). The knowledge page shows it as the assistant's words — never as
// the app's. Pure and dependency-free so the ask route can run the same
// screen before relaying the text (the server-side half), and the page runs
// it again at the point of entry.
//
// Two tiers, because a refusal takes the input away and so must never fire
// on an engineering prompt:
//
//   TIER 1 — REFUSE. Only vocabulary with no engineering meaning: a password /
//   passcode / passphrase (a one-time password included), an MFA / 2FA /
//   two-factor or authenticator code, a verification or security code asked
//   of the reader, CVV / CVC, an SSN, a credit or debit card number, a bank
//   account or bank routing number, an IBAN, a date of birth, a security
//   question or a mother's maiden name, an API / secret key or an access /
//   bearer token, login / SSO credentials or the reader's own login asked
//   for ("Enter your SSO login."), and a link. Words an engineering
//   library uses for other things are NOT here: a pin (clevis, input, supply,
//   connector), a PIN code (an Indian postal code — IS 875's wind zones are
//   looked up by it), OTP (operating test pressure), a "routing number" (a
//   manufacturing routing), a "card number" (an I/O card), PWD (Public Works
//   Department schedules), an inspector's or welder's "credentials", SECRET
//   (a drawing classification), "log in" / "sign in" written as two words
//   ("the log in base 10", "the sign in front of the term"), and a bare
//   access word near an ask verb ("Give the login count.").
//
//   TIER 2 — CAUTION, NEVER BLOCK. A pin, PIN, OTP or digit code in a phrase
//   that can make it a credential (bound to your card, bank, account, phone
//   or SIM; a digit count; what it unlocks; how it was delivered; or the
//   whole of what is asked). The text is shown with its input or buttons
//   enabled, and the card adds an amber line (`ASSISTANT_PIN_CAUTION`). An
//   ask verb with a login / sign-in / SSO / MFA word in the same sentence is
//   the same kind of caution (`ASSISTANT_LOGIN_CAUTION`). No pin / PIN / OTP
//   / code or access-word heuristic ever takes the input away.
//
// Each tier is as strict as what the text can make someone do:
//   - "need"    — a Need prompt OPENS AN INPUT: a tier-1 term refuses it
//                 outright.
//   - "clarify" — the clarify question sits above buttons, not an input: it
//                 is refused only when it ASKS for a tier-1 term (enter your
//                 password, provide your SSO login…) — a library of access-
//                 control SOPs legitimately asks "which aspect: password
//                 rules, MFA, or remote login?".
//   - "aspect"  — one short button label: only length and links. "Password
//                 length and rotation" is an aspect, not a request.

export const ASSISTANT_REQUEST_MAX = 600;

export type AssistantTextKind = "need" | "clarify" | "aspect";

export type AssistantScreenResult = { ok: true; caution?: string } | { ok: false; reason: string };

/** The amber lines a card shows beside a tier-2 match — the input stays open. */
export const ASSISTANT_PIN_CAUTION =
  "This question mentions a PIN or a code. This app never needs your personal PINs or one-time codes. " +
  "If that is what it is asking for, don't enter it.";
export const ASSISTANT_LOGIN_CAUTION =
  "This question mentions a login, sign-in or MFA. This app never needs your login, password or MFA codes. " +
  "If that is what it is asking for, don't enter it.";

// ── TIER 1 ──────────────────────────────────────────────────────────────────
// Terms naming a credential, a secret, or an account / identity detail —
// none of them an engineering word.
const SECRET_TERMS = [
  String.raw`pass(?:word|code|phrase)s?`,
  String.raw`(?:mfa|2fa|two[\s-]factor|multi[\s-]factor)(?: auth(?:entication)?)? codes?|authenticator codes?`,
  String.raw`(?:your|my) (?:verification|security|confirmation) codes?`,
  String.raw`(?:verification|security) codes? (?:on|from) (?:the back of )?your`,
  String.raw`api[\s_-]?keys?|secret[\s_-]?keys?|access[\s_-]?tokens?|bearer[\s_-]?tokens?`,
  String.raw`(?:log-?in|sign-?in|sso|account|user|your|my) credentials?`,
  String.raw`social security(?: numbers?)?|ssn`,
  String.raw`credit[\s-]?cards?(?: numbers?)?|(?:debit|payment|bank)[\s-]?card numbers?|cvv2?|cvc|card verification (?:value|code)`,
  String.raw`bank accounts?(?: numbers?)?|(?:bank(?:'s)?|aba|ach) routing numbers?|iban`,
  String.raw`date of birth|(?:mother'?s )?maiden names?|security questions?`,
].join("|");
// Asking the reader to hand something over. "your" is looked at, never
// consumed, so "what's your MFA code?" still reaches "your".
const ASK_VERBS = String.raw`enter|type (?:in|it|them|the)|type(?= your)|provide|paste|give|share|send|supply|submit|input|confirm(?= your)|reply with|tell me|what(?:'s| is| are)(?= your)`;
// A clause that opens by asking for something. Only verbs that are never an
// adjective before "pin": "input pin" and "supply pin" are nouns.
const CLAUSE_START = String.raw`(?:^|[.?!;:]\s+)(?:please\s+)?`;
const ASK_LEAD = String.raw`(?:enter|type|provide|give|paste|submit|reply with|tell me|what(?:'s| is| are))`;
const CLAUSE_ASK = String.raw`${CLAUSE_START}${ASK_LEAD}\s+`;
const CLAUSE_END = String.raw`(?:,?\s+(?:here|below|now|please|again))?\s*(?:[.?!;:]|$)`;
// "Enter the verification code." — the code is the whole of what is asked.
const ASKED_CODE = String.raw`${CLAUSE_ASK}(?:the |a )?(?:verification|security|confirmation) codes?${CLAUSE_END}`;
// The reader's own login as the object of the ask: "Enter your SSO login.",
// "Provide your SSO login so I can sign the calc." — never "your login count".
const ASKED_LOGIN = String.raw`\b(?:${ASK_VERBS})\s+(?:your|my)\s+(?:sso\s+|single[\s-]sign-on\s+)?(?:log-?ins?|sign-?ins?|sso)`
  + String.raw`(?:\s+(?:details|info|information|name|id|username))?`
  + String.raw`(?=\s*(?:$|[.?!,;:)\u2013\u2014]|(?:so|to|for|and|here|below|now|please|in|into|on)\b))`;

const NEED_SECRET_RE = new RegExp(
  String.raw`\b(?:${SECRET_TERMS})\b|${ASKED_LOGIN}|${ASKED_CODE}`, "i");
const ASKS_FOR_SECRET_RE = new RegExp(
  String.raw`\b(?:${ASK_VERBS})\b[^.?!\n]{0,60}\b(?:${SECRET_TERMS})\b`
  + String.raw`|\b(?:${SECRET_TERMS})\b[^.?!\n]{0,60}\b(?:enter|paste) (?:it|them|here|below)\b|${ASKED_LOGIN}|${ASKED_CODE}`, "i");
const ASSISTANT_LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w.-]+\.(?:com|net|org|io|ai|co|app|dev|ru|cn)(?:\/\S*)?\b/i;

// ── TIER 2 (caution only) ───────────────────────────────────────────────────
// Access words that are ordinary in an engineering library ("login
// requirements", "MFA for remote login"): beside an ask verb they are a
// caution, never a refusal ("Give the login count."). Only the closed forms —
// "log in" / "sign in" as two words are left out ("Give the log in base 10").
const ACCESS_TERMS = String.raw`log-?ins?|sign-?ins?|sso|mfa|2fa|two[\s-]factor`;
const ACCESS_CAUTION_RE = new RegExp(String.raw`\b(?:${ASK_VERBS})\b[^.?!\n]{0,60}\b(?:${ACCESS_TERMS})\b`, "i");
const PIN = String.raw`(?:pin|otp|passcode)s?`;
// A delivery: "…we texted you", "…that was sent to your phone".
const DELIVERED = String.raw`(?:that |which )?(?:(?:we|i)(?: just)? |(?:was|were|has been|have been|is|are|just) )?`;
const DELIVERED_TO = String.raw`(?:you\b|your (?:phone|mobile|email|e-mail|inbox|device|number))`;
// What a credential unlocks, counted only where the purpose ends the clause or
// names a credential object — "the release pin to unlock the latch" and "the
// alignment pins used to verify the fixture position" are mechanisms.
const CREDENTIAL_OBJECT = String.raw`(?:it|your (?:phone|mobile|account|device|identity|card|sim))`;
const PURPOSE_END = String.raw`(?=\s*(?:[.?!,;:)]|$)|\s+${CREDENTIAL_OBJECT}\b)`;
const PIN_CAUTION_RE = new RegExp([
  // fixed phrases (PIN code is also an Indian postal code — a caution, never a refusal)
  String.raw`\b(?:pin|otp)[\s-]?codes?\b`,
  String.raw`\bone[\s-]time (?:codes?|pins?)\b`,
  String.raw`\b(?:verification|security|sms) codes?\b`,
  // a digit count, before or after: "the 4-digit pin", "your PIN (4 digits)"
  String.raw`\b\d+[\s-]?digits? (?:${PIN}|codes?)\b`,
  String.raw`\b(?:${PIN}|codes?)\s*\(?\s*\d+[\s-]?digits?\b`,
  // bound to the reader's card, bank, account, phone or SIM — after your / my, or as a possessive
  String.raw`\b(?:your|my)\s+(?:[\w-]+\s+){0,2}?(?:debit|credit|bank(?:ing)?|atm|card|account|phone|mobile|sim)(?:'s)?\s+(?:card(?:'s)?\s+)?${PIN}\b`,
  String.raw`\b(?:debit|credit|bank|atm|card|account|phone|sim)'s\s+${PIN}\b`,
  String.raw`\b${PIN}(?: numbers?)? (?:for|to|of|on) (?:your|my) (?:[\w-]+ )?(?:portal|website|app|bank|account|card|phone|mobile|sim|device|log-?in|sign-?in)s?\b`,
  String.raw`\b${PIN}(?: numbers?)? for the (?:[\w-]+ )?(?:portal|website|app|log-?in|sign-?in)(?=\s*(?:[.?!,;:)]|$))`,
  // what it unlocks: the reader's own PIN for a purpose, or any PIN whose purpose ends the clause
  String.raw`\b(?:your|my) ${PIN} (?:to|so (?:i|we) can|in order to) (?:sign|approve|authori[sz]e|confirm|continue|proceed|unlock|verify|authenticate|log-?in|sign-?in|log in|sign in|access)\b`,
  String.raw`\b${PIN} (?:to|so (?:i|we) can|in order to|(?:that )?you use to|used to) (?:unlock|log-?in|sign-?in|log in|sign in|verify|authenticate|continue|proceed)${PURPOSE_END}`,
  String.raw`\b${PIN} for (?:identity )?(?:verification|authentication)(?: purposes)?${PURPOSE_END}`,
  // how it was delivered
  String.raw`\b(?:otp|codes?|${PIN}) ${DELIVERED}(?:texted|sent|emailed|e-mailed|messaged)(?: to)? ${DELIVERED_TO}`,
  String.raw`\b(?:otp|codes?|${PIN}) (?:${DELIVERED}(?:sent|texted|delivered) )?(?:by|via|over|in|from|on) (?:the |your |an? )?(?:[\w-]+ )?(?:sms|text message|authenticator)\b`,
  // the whole of what is asked: "Enter your PIN.", "What is the OTP?", "PIN?"
  String.raw`${CLAUSE_START}(?:${ASK_LEAD}\s+)?(?:(?:your|my|the|a|an)\s+)?(?:\d+[\s-]?digit\s+(?:${PIN}|codes?)|(?:pin|otp)s?(?:\s+numbers?)?)${CLAUSE_END}`,
].join("|"), "i");

export function screenAssistantRequest(
  text: string, kind: AssistantTextKind = "need",
): AssistantScreenResult {
  const t = (text ?? "").trim();
  if (!t) return { ok: false, reason: "it was empty" };
  if (t.length > ASSISTANT_REQUEST_MAX) return { ok: false, reason: "it was far longer than a request for a value" };
  const secret = kind === "need" ? NEED_SECRET_RE : kind === "clarify" ? ASKS_FOR_SECRET_RE : null;
  if (secret?.test(t)) return { ok: false, reason: "it asks for a credential, account or identity detail" };
  if (ASSISTANT_LINK_RE.test(t)) return { ok: false, reason: "it contains a link" };
  if (kind !== "aspect" && PIN_CAUTION_RE.test(t)) return { ok: true, caution: ASSISTANT_PIN_CAUTION };
  if (kind !== "aspect" && ACCESS_CAUTION_RE.test(t)) return { ok: true, caution: ASSISTANT_LOGIN_CAUTION };
  return { ok: true };
}
