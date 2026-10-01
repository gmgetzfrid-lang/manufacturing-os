// lib/assistantScreen.ts — pure, isomorphic. ASK-6.
//
// Text the MODEL wrote that a page would otherwise put in front of an input
// box (a calculation's "Need" prompt) or on a button (a clarify round's
// aspects). The knowledge page shows it as the assistant's words — never as
// the app's — and refuses it outright when it reaches for something this app
// never collects: a password, a key, an account or identity number, or a
// link. Pure and dependency-free so the ask route can run the same screen
// before relaying the text (the server-side half), and the page runs it
// again at the point of entry.
//
// The screen is as strict as what the text can make someone do:
//   - "need"    — a Need prompt OPENS AN INPUT: a credential, secret, account
//                 or identity term refuses it outright, and a login / sign-in
//                 / SSO / MFA term refuses it when the prompt asks the reader
//                 to enter or give one.
//   - "clarify" — the clarify question sits above buttons, not an input: it
//                 is refused only when it ASKS for one of those (enter your
//                 password, provide your SSO login…) — a library of access-
//                 control SOPs legitimately asks "which aspect: password
//                 rules, MFA, or remote login?".
//   - "aspect"  — one short button label: only length and links. "Password
//                 length and rotation" is an aspect, not a request.
//
// A PIN and a one-time code are credentials by what is bound to them, never
// by where the word sits or how it is capitalised. "pin" is an ordinary
// engineering noun ("the clearance between your pin and the bore", "the
// material grade of the SHEAR PIN, which the BOM leaves blank", "Need: DOWEL
// PIN", a connector's pin number) and OTP is also the operating test
// pressure, so neither word refuses anything on its own. One is refused only
//   - in a fixed credential phrase: PIN code, OTP code, one-time code /
//     password / PIN, verification / security / SMS / authenticator code;
//   - bound to a credential cue: a digit count ("the 4-digit pin"), a card,
//     bank or account ("your debit card pin", "enter your banking pin", "the
//     PIN number for the vendor portal"), what it unlocks ("enter the pin to
//     unlock", "your PIN to continue", "the pin you use to sign in"), or how
//     it was delivered ("the 6-digit code we texted you", "the code from your
//     authenticator app");
//   - or when it is the whole of what is asked: "Enter your PIN.", "What is
//     your OTP?", "Enter the 6-digit code." — never "Provide the pin
//     diameter", where the pin only names what the value belongs to.
// A cue must be bound to the word, not merely share its sentence: "Provide
// the pin diameter to verify the double-shear capacity" and "the pin load,
// taking into account the eccentricity" are calculations.

export const ASSISTANT_REQUEST_MAX = 600;

export type AssistantTextKind = "need" | "clarify" | "aspect";

// A PIN, OTP or code bound to what makes it a credential (see above).
const DELIVERED = String.raw`(?:that |which )?(?:(?:we|i)(?: just)? |(?:was|were|has been|have been|is|are|just) )?`;
const PIN_CREDENTIAL = [
  String.raw`(?:pin|otp)[\s-]?codes?`,
  String.raw`one[\s-]time (?:codes?|passwords?|pins?)`,
  String.raw`(?:verification|security|sms|authenticator) codes?`,
  String.raw`\d+[\s-]?digits? (?:pin|otp|passcode)s?`,
  String.raw`(?:debit|credit|bank(?:ing)?|atm|card|account)(?:'s)? (?:card(?:'s)? )?pins?`,
  // "the PIN for your bank account", "the PIN number for the vendor portal" —
  // the credential noun ends the phrase, so "the pin for the card guide" and
  // "the base pin of the portal frame" are not one
  String.raw`pins?(?: numbers?)? (?:for (?:the |your |my |our )?|to (?:your|my) )(?:[\w-]+ )?(?:portal|website|bank|account|card|phone|log[\s-]?in|sign[\s-]?in)s?(?=\s*(?:$|[.?!,;:)]))`,
  String.raw`(?:pin|otp)s? (?:to|so (?:i|we) can|in order to|(?:that )?you use to|used to) (?:unlock|log[\s-]?in|sign[\s-]?in|verify|authenticate|continue|proceed)`,
  String.raw`(?:pin|otp)s? for (?:identity )?(?:verification|authentication)(?: purposes)?(?=\s*(?:$|[.?!,;:)]))`,
  String.raw`(?:otp|code)s? ${DELIVERED}(?:texted|sent|emailed|e-mailed|messaged)(?: to)? you`,
  String.raw`pins? ${DELIVERED}texted(?: to)? you`,
  String.raw`(?:pin|otp|code)s? (?:${DELIVERED}(?:sent|texted|delivered) )?(?:by|via|over|in|from) (?:the |your |an? )?(?:sms|text message|authenticator)`,
].join("|");
// Terms naming a credential, a secret, or an account / identity detail.
const SECRET_TERMS = String.raw`pass(?:word|code|phrase)s?|pwd|api[\s_-]?keys?|secret[\s_-]?keys?|access[\s_-]?tokens?|bearer[\s_-]?tokens?|credentials?|${PIN_CREDENTIAL}|social security(?: numbers?)?|ssn|credit[\s-]?cards?(?: numbers?)?|card numbers?|cvv|bank accounts?(?: numbers?)?|routing numbers?|iban|date of birth`;
// Terms that are ordinary words in an engineering library ("the sign in front
// of the term", "login requirements") and a request only when asked for.
const ACCESS_TERMS = String.raw`log[\s-]?ins?|sign[\s-]?ins?|sso|mfa|2fa|secrets?`;
// Asking the reader to hand something over. "your" is looked at, never
// consumed, so "what's your PIN?" still reaches "your PIN".
const ASK_VERBS = String.raw`enter|type (?:in|it|them|the)|type(?= your)|provide|paste|give|share|send|supply|submit|input|confirm(?= your)|reply with|tell me|what(?:'s| is| are)(?= your)`;
// A PIN, OTP or digit code that is the WHOLE of what is asked — the text, or
// what follows an ask verb, ends with it ("Enter your PIN.", "What is the
// OTP?", "PIN?"). "Provide the pin diameter", "Need: DOWEL PIN" and "Provide
// your OTP (operating test pressure) in psig" ask for something else.
const PIN_ASKED_RE = new RegExp(
  String.raw`(?:^|\b(?:${ASK_VERBS}|what(?:'s| is| are))\s+)`
  + String.raw`(?:(?:your|my)\s+(?:pin|otp)s?(?:\s+numbers?)?|(?:(?:your|my|the|a|an)\s+)?(?:\d+[\s-]?digit\s+(?:pin|otp|code)s?|(?:pin|otp)s?))`
  + String.raw`(?:,?\s+(?:here|below|now|please|again))?\s*[.?!:]*$`, "i");

const NEED_SECRET_RE = new RegExp(
  String.raw`\b(?:${SECRET_TERMS})\b|\b(?:${ASK_VERBS})\b[^.?!\n]{0,60}\b(?:${ACCESS_TERMS})\b`, "i");
const ASKS_FOR_SECRET_RE = new RegExp(
  String.raw`\b(?:${ASK_VERBS})\b[^.?!\n]{0,60}\b(?:${SECRET_TERMS}|${ACCESS_TERMS})\b`
  + String.raw`|\b(?:${SECRET_TERMS}|${ACCESS_TERMS})\b[^.?!\n]{0,60}\b(?:enter|paste) (?:it|them|here|below)\b`, "i");
const ASSISTANT_LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w.-]+\.(?:com|net|org|io|ai|co|app|dev|ru|cn)(?:\/\S*)?\b/i;

export function screenAssistantRequest(
  text: string, kind: AssistantTextKind = "need",
): { ok: true } | { ok: false; reason: string } {
  const t = (text ?? "").trim();
  if (!t) return { ok: false, reason: "it was empty" };
  if (t.length > ASSISTANT_REQUEST_MAX) return { ok: false, reason: "it was far longer than a request for a value" };
  const secret = kind === "need" ? [NEED_SECRET_RE, PIN_ASKED_RE] : kind === "clarify" ? [ASKS_FOR_SECRET_RE, PIN_ASKED_RE] : [];
  if (secret.some((re) => re.test(t))) return { ok: false, reason: "it asks for a credential, account or identity detail" };
  if (ASSISTANT_LINK_RE.test(t)) return { ok: false, reason: "it contains a link" };
  return { ok: true };
}
