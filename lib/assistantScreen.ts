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

export const ASSISTANT_REQUEST_MAX = 600;
const ASSISTANT_SECRET_RE = /\b(?:pass(?:word|code|phrase)s?|pwd|api[\s_-]?keys?|secret(?:s| key)?|access[\s_-]?tokens?|bearer|credentials?|log[\s-]?in|sign[\s-]?in|sso|mfa|2fa|otp|one[\s-]time (?:code|password)|social security|ssn|credit card|card number|cvv|bank account|routing number|iban|date of birth)\b/i;
const ASSISTANT_LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w.-]+\.(?:com|net|org|io|ai|co|app|dev|ru|cn)(?:\/\S*)?\b/i;
export function screenAssistantRequest(text: string): { ok: true } | { ok: false; reason: string } {
  const t = (text ?? "").trim();
  if (!t) return { ok: false, reason: "it was empty" };
  if (t.length > ASSISTANT_REQUEST_MAX) return { ok: false, reason: "it was far longer than a request for a value" };
  if (ASSISTANT_SECRET_RE.test(t)) return { ok: false, reason: "it asks for a credential, account or identity detail" };
  if (ASSISTANT_LINK_RE.test(t)) return { ok: false, reason: "it contains a link" };
  return { ok: true };
}
