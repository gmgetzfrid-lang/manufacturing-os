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

export const ASSISTANT_REQUEST_MAX = 600;

export type AssistantTextKind = "need" | "clarify" | "aspect";

// Terms naming a credential, a secret, or an account / identity detail.
const SECRET_TERMS = String.raw`pass(?:word|code|phrase)s?|pwd|api[\s_-]?keys?|secret[\s_-]?keys?|access[\s_-]?tokens?|bearer[\s_-]?tokens?|credentials?|one[\s-]time (?:codes?|passwords?)|otps?|social security(?: numbers?)?|ssn|credit[\s-]?cards?(?: numbers?)?|card numbers?|cvv|bank accounts?(?: numbers?)?|routing numbers?|iban|date of birth`;
// Terms that are ordinary words in an engineering library ("the sign in front
// of the term", "login requirements") and a request only when asked for.
const ACCESS_TERMS = String.raw`log[\s-]?ins?|sign[\s-]?ins?|sso|mfa|2fa|secrets?|pins?`;
// Asking the reader to hand something over.
const ASK_VERBS = String.raw`enter|type (?:in|it|them|your|the)|provide|paste|give|share|send|supply|submit|input|confirm your|reply with|tell me|what(?:'s| is| are) your`;

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
  const secret = kind === "need" ? NEED_SECRET_RE : kind === "clarify" ? ASKS_FOR_SECRET_RE : null;
  if (secret?.test(t)) return { ok: false, reason: "it asks for a credential, account or identity detail" };
  if (ASSISTANT_LINK_RE.test(t)) return { ok: false, reason: "it contains a link" };
  return { ok: true };
}
