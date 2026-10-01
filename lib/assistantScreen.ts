// lib/assistantScreen.ts — pure, isomorphic. ASK-6.
//
// Text the MODEL wrote that a page would otherwise put in front of an input
// box (a calculation's "Need" prompt) or on a button (a clarify round's
// question and aspects). The knowledge page shows it as the assistant's words
// — never as the app's. Pure and dependency-free so the ask route can run the
// same screen before relaying the text (the server-side half), and the page
// runs it again at the point of entry.
//
// Refusing on vocabulary never converged: every refusing word list found a
// real engineering sentence (a clevis pin, a PIN code that is a postal code,
// the employer social security rate, VB.NET, an SSO slam-shut valve), and the
// page had no screen at all before ASK-6. So the screen refuses in exactly two
// cases, and everything else that touches a credential is a CAUTION — an amber
// line beside the text that never takes the input or the buttons away:
//
//   REFUSE ({ ok: false }) —
//     (a) a real URL: an explicit http:// / https:// scheme, or a token
//         starting "www.". A bare dotted token ("Std.Dev.", "VB.NET",
//         "Smith Mfg.Co.", "acme.com") is not one; a lower-case bare domain
//         is a caution.
//     (b) the injection signature: a secret named as the reader's (or as a
//         credential by its own name) AND an instruction to put it in this
//         box, in the same sentence or the next one — "…requires the
//         requester's SSO password to sign the result — enter it below."
//   Besides those two, only an empty text or one longer than
//   ASSISTANT_REQUEST_MAX is not shown (a length guard, not a vocabulary rule).
//
//   CAUTION ({ ok: true, caution }) — a password / passcode, a PIN or a
//   one-time / MFA / verification / recovery code, credentials or a login,
//   keys, secrets and tokens, card / account / routing numbers, an IBAN, an
//   SSN, a date of birth, a security question… Recall over precision, except
//   that a pin that is a part ("the clevis pin diameter", "the input pin")
//   stays plain.
//
// The kinds: "need" (opens an input) and "clarify" (sits above buttons) get
// both refusals and the cautions. "aspect" (one button label) is refused only
// for a URL or its length, and never cautioned.

export const ASSISTANT_REQUEST_MAX = 1000;

export type AssistantTextKind = "need" | "clarify" | "aspect";

export type AssistantScreenResult = { ok: true; caution?: string } | { ok: false; reason: string };

/** The amber lines a card shows beside the text — the input stays open. */
export const ASSISTANT_CREDENTIAL_CAUTION =
  "This question mentions a password, PIN, code or other credential. This app never needs your credentials. " +
  "If that is what it is asking for, don't enter it.";
export const ASSISTANT_LINK_CAUTION =
  "This question mentions a web address. This app never needs you to visit a site or sign in anywhere to answer it. " +
  "Don't follow it to enter anything.";

// ── REFUSE (a): a real URL ──────────────────────────────────────────────────
const URL_RE = /\bhttps?:\/\/\S|(?:^|[^\w.@/-])www\.[\w-]/i;

// ── REFUSE (b): the injection signature ─────────────────────────────────────
// Where "this box" is: "below", "here", "in the box / field below"…
const BOX_PLACE = String.raw`(?:in\s+)?(?:below|here)|(?:in|into|inside)\s+(?:the|this)\s+(?:[\w-]+\s+)?(?:box|field|input|space|form|area|prompt)`;
// A secret noun counts only where it heads its phrase (end of clause, a dash,
// "to sign / so I can", "is required", or the box itself) — never "the
// password policy", "your pin diameter", "your login count".
const HEAD_END = String.raw`(?=\s*(?:$|[.?!,;:)–—]|(?:to\s+(?:sign|approve|authori[sz]e|confirm|continue|proceed|unlock|verify|authenticate|log|access|complete|submit|release)|so\s+(?:i|we|that|the)|(?:is|are|was|were|will\s+be)\s+(?:required|needed|necessary|mandatory)|now|please|${BOX_PLACE})\b))`;
// Named as the reader's own, or the requester's / the signer's…
const POSSESSOR = String.raw`(?:your|my|(?:the\s+)?(?:requester|requestor|user|reader|employee|approver|signer|signatory|account\s+holder|cardholder)'s)`;
// …or qualified as a credential ("network login", "e-signature PIN"). SSO is
// only a qualifier: alone it is also a slam-shut valve. No word that also
// names a part's place ("bank", "root", "portal") qualifies.
const QUALIFIER = String.raw`(?:e-?signature|electronic\s+signature|digital\s+signature|signing|badge|employee|network|domain|corporate|company|okta|sign-?on|single\s+sign-on|sso|windows|vpn|active\s+directory|banking|debit|credit|atm|sim|personal|login|admin(?:istrator)?)`;
// Credentials by their own name — they count with no possessor.
const STRONG_NOUN = String.raw`pass(?:word|code)s?|pass\s?phrases?|private\s+keys?|secret\s+access\s+keys?|client\s+secrets?|(?:mfa|2fa|two-factor|multi-factor|one-time|authenticator|recovery|backup)\s+(?:codes?|passwords?|pins?)`;
// Words that are a credential only when someone's or qualified. A lower-case
// "pin" counts only when qualified ("badge pin"); "your pin" is a part.
const WEAK_NOUN = String.raw`pins?|log-?ins?|log-?ons?|sign-?ins?|sign-?ons?|tokens?|secrets?|access\s+(?:keys?|codes?)|(?:verification|security)\s+codes?|card\s+numbers?|account\s+numbers?|credentials?`;
const SECRET_PHRASE_RE = new RegExp(
  String.raw`\b(${POSSESSOR}\s+)?((?:${QUALIFIER}\s+){0,2})(${STRONG_NOUN}|${WEAK_NOUN})${HEAD_END}`, "gi");
const STRONG_RE = new RegExp(String.raw`^(?:${STRONG_NOUN})$`, "i");
// An instruction to put it in THIS box: "enter it below", "paste them here",
// "put it in the box", "enter it in the field below"…
const BOX_RE = new RegExp(
  String.raw`\b(?:enter|type|paste|put|input|write|key|fill|add|insert|drop)\s+(?:it|them|this|that|these|those)\s+(?:${BOX_PLACE})\b`, "i");
// …or the secret itself named as the object: "Enter your SSO password below."
const ASKED_BEFORE_RE = /\b(?:enter|type|paste|put|input|write|key|provide|give|submit|supply)\b/i;
const PLACE_AFTER_RE = new RegExp(String.raw`^\s+(?:${BOX_PLACE})\b`, "i");

/** Does this sentence name a secret (as defined above)? Returns whether it is
 *  also put in the box in the same breath ("Enter your PIN below."). */
function secretIn(sentence: string): { named: boolean; placed: boolean } {
  let named = false;
  for (const m of sentence.matchAll(SECRET_PHRASE_RE)) {
    const [, poss, qual, noun = ""] = m; // the possessor, the qualifiers, the noun
    const strong = STRONG_RE.test(noun);
    const qualified = !!qual?.trim();
    if (!strong && !poss && !qualified) continue;
    if (/^pins?$/i.test(noun) && !/^PINs?$/.test(noun) && !qualified) continue; // "your pin" is a part
    named = true;
    const end = (m.index ?? 0) + m[0].length;
    if (PLACE_AFTER_RE.test(sentence.slice(end)) && ASKED_BEFORE_RE.test(sentence.slice(0, m.index ?? 0))) {
      return { named, placed: true };
    }
  }
  return { named, placed: false };
}

function injectionSignature(t: string): boolean {
  const sentences = t.match(/[^.?!\n]+[.?!]*/g) ?? [];
  for (let i = 0; i < sentences.length; i++) {
    const s = secretIn(sentences[i]);
    if (!s.named) continue;
    if (s.placed || BOX_RE.test(sentences[i]) || (i + 1 < sentences.length && BOX_RE.test(sentences[i + 1]))) return true;
  }
  return false;
}

// ── CAUTION: everything else that touches a credential ──────────────────────
// Asking the reader to hand something over. "your" is looked at, never
// consumed, so "what's your MFA code?" still reaches "your".
const ASK_VERBS = String.raw`enter|type (?:in|it|them|the)|type(?= your)|provide|paste|give|share|send|supply|submit|input|confirm(?= your)|reply with|tell me|what(?:'s| is| are)(?= your)`;
// A clause that opens by asking for something. Only verbs that are never an
// adjective before "pin": "input pin" and "supply pin" are nouns.
const CLAUSE_START = String.raw`(?:^|[.?!;:]\s+)(?:please\s+)?`;
const ASK_LEAD = String.raw`(?:enter|type|provide|give|paste|submit|reply with|tell me|what(?:'s| is| are))`;
const CLAUSE_END = String.raw`(?:,?\s+(?:here|below|now|please|again))?\s*(?:[.?!;:]|$)`;
const PIN = String.raw`(?:pin|otp|passcode)s?`;
const DELIVERED = String.raw`(?:that |which )?(?:(?:we|i)(?: just)? |(?:was|were|has been|have been|is|are|just) )?`;
const DELIVERED_TO = String.raw`(?:you\b|your (?:phone|mobile|email|e-mail|inbox|device|number))`;
// What a credential unlocks, counted only where the purpose ends the clause or
// names a credential object — "the release pin to unlock the latch" and "the
// alignment pins used to verify the fixture position" are mechanisms.
const CREDENTIAL_OBJECT = String.raw`(?:it|your (?:phone|mobile|account|device|identity|card|sim))`;
const PURPOSE_END = String.raw`(?=\s*(?:[.?!,;:)]|$)|\s+${CREDENTIAL_OBJECT}\b)`;

const CREDENTIAL_CAUTION_RE = new RegExp([
  // credentials, secrets and identity details by name
  String.raw`\bpass(?:word|code|phrase)s?\b|\bpass words?\b|\bpwd\b|\bpw\b`,
  String.raw`\b(?:mfa|2fa|two[\s-]factor|multi[\s-]factor)(?: auth(?:entication)?)? codes?\b|\bauthenticator(?: app)? codes?\b`,
  String.raw`\b(?:recovery|backup) (?:codes?|keys?)\b|\bokta verify\b|\brsa (?:securid|tokens?|codes?)\b|\bsecurid\b`,
  String.raw`\b(?:your|my) (?:verification|security|confirmation|access) codes?\b|\b(?:verification|security) codes? (?:on|from) (?:the back of )?your\b`,
  String.raw`\b(?:door|gate|keypad|alarm|access) codes?\b`,
  String.raw`\b(?:api|secret|private|access|ssh|recovery)[\s_-]?keys?\b|\bclient[\s_-]?secrets?\b|\bapi[\s_-]?secrets?\b|\bsecret access keys?\b`,
  String.raw`\b(?:access|bearer|auth|api|session|refresh|security)[\s_-]?tokens?\b|\b(?:your|my) (?:[\w-]+ )?(?:tokens?|secrets?)\b`,
  String.raw`\bcredentials?\b|\b(?:your|my) (?:[\w-]+ ){0,2}(?:log-?ins?|log-?ons?|sign-?ins?|sign-?ons?|user ?names?)\b`,
  String.raw`\b(?:sign|log) in (?:details|info|information|credentials|name|id)\b`,
  String.raw`\b(?:e-?signature|electronic signature|digital signature|signing|badge|employee|approval) pins?\b`,
  String.raw`\b(?:your|my) (?:employee|badge|staff|user) (?:id|number)s?\b`,
  String.raw`\bsocial security\b|\bssn\b|\bdate of birth\b|\b(?:mother'?s )?maiden names?\b|\bsecurity (?:questions?|answers?)\b`,
  String.raw`\bpassport numbers?\b|\bdriver'?s licen[cs]e(?: numbers?)?\b|\bnational id\b|\btax id\b|\baadhaar\b`,
  String.raw`\bcredit[\s-]?cards?\b|\b(?:debit|payment|bank)[\s-]?card numbers?\b|\bcvv2?\b|\bcvc\b|\bcard verification (?:value|code)\b`,
  String.raw`\b(?:your|my) (?:[\w-]+ ){0,2}(?:card|account|routing) numbers?\b|\b(?:your|my) bank(?:ing)? details\b`,
  String.raw`\bbank accounts?\b|\b(?:bank(?:'s)?|aba|ach) routing numbers?\b|\biban\b`,
  // the reader's own login asked for, and a login / SSO / MFA word beside an ask verb
  String.raw`\b(?:${ASK_VERBS})\b[^.?!\n]{0,60}\b(?:log-?ins?|log-?ons?|sign-?ins?|sign-?ons?|sso|mfa|2fa|two[\s-]factor)\b`,
  // a PIN, OTP or code in a phrase that can make it a credential (PIN code is also an Indian postal code)
  String.raw`\b(?:pin|otp)[\s-]?codes?\b|\bone[\s-]time (?:codes?|pins?|passwords?)\b|\b(?:verification|security|sms) codes?\b`,
  String.raw`\b\d+[\s-]?digits? (?:${PIN}|codes?)\b|\b(?:${PIN}|codes?)\s*\(?\s*\d+[\s-]?digits?\b`,
  String.raw`\b(?:your|my)\s+(?:[\w-]+\s+){0,2}?(?:debit|credit|bank(?:ing)?|atm|card|account|phone|mobile|sim)(?:'s)?\s+(?:card(?:'s)?\s+)?${PIN}\b`,
  String.raw`\b(?:debit|credit|bank|atm|card|account|phone|sim)'s\s+${PIN}\b`,
  String.raw`\b${PIN}(?: numbers?)? (?:for|to|of|on) (?:your|my) (?:[\w-]+ )?(?:portal|website|app|bank|account|card|phone|mobile|sim|device|log-?in|sign-?in)s?\b`,
  String.raw`\b${PIN}(?: numbers?)? for the (?:[\w-]+ )?(?:portal|website|app|log-?in|sign-?in)(?=\s*(?:[.?!,;:)]|$))`,
  String.raw`\b(?:your|my) ${PIN} (?:to|so (?:i|we) can|in order to) (?:sign|approve|authori[sz]e|confirm|continue|proceed|unlock|verify|authenticate|log-?in|sign-?in|log in|sign in|access)\b`,
  String.raw`\b${PIN} (?:to|so (?:i|we) can|in order to|(?:that )?you use to|used to) (?:unlock|log-?in|sign-?in|log in|sign in|verify|authenticate|continue|proceed)${PURPOSE_END}`,
  String.raw`\b${PIN} for (?:identity )?(?:verification|authentication)(?: purposes)?${PURPOSE_END}`,
  String.raw`\b(?:otp|codes?|${PIN}) ${DELIVERED}(?:texted|sent|emailed|e-mailed|messaged)(?: to)? ${DELIVERED_TO}`,
  String.raw`\b(?:otp|codes?|${PIN}) (?:${DELIVERED}(?:sent|texted|delivered) )?(?:by|via|over|in|from|on) (?:the |your |an? )?(?:[\w-]+ )?(?:sms|text message|authenticator)\b`,
  // the whole of what is asked: "Enter your PIN.", "What is the OTP?", "PIN?", "Enter the verification code."
  String.raw`${CLAUSE_START}(?:${ASK_LEAD}\s+)?(?:(?:your|my|the|a|an)\s+)?(?:\d+[\s-]?digit\s+(?:${PIN}|codes?)|(?:pin|otp)s?(?:\s+numbers?)?|(?:verification|security|confirmation|access)\s+codes?)${CLAUSE_END}`,
].join("|"), "i");
// A bare domain, written the way a web address is ("acme.com",
// "portal.vendor.io/login") — lower case, so "VB.NET" and "Mfg.Co." are not.
const BARE_DOMAIN_RE = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|co|app|dev|ru|cn)\b/;

export function screenAssistantRequest(
  text: string, kind: AssistantTextKind = "need",
): AssistantScreenResult {
  // curly apostrophes are the same apostrophe ("What’s your login?")
  const t = (text ?? "").replace(/[‘’ʼ]/g, "'").trim();
  if (!t) return { ok: false, reason: "it was empty" };
  if (t.length > ASSISTANT_REQUEST_MAX) return { ok: false, reason: "it was far longer than a request for a value" };
  if (URL_RE.test(t)) return { ok: false, reason: "it contains a link" };
  if (kind === "aspect") return { ok: true };
  if (injectionSignature(t)) return { ok: false, reason: "it asks you to type a credential into this box" };
  if (CREDENTIAL_CAUTION_RE.test(t)) return { ok: true, caution: ASSISTANT_CREDENTIAL_CAUTION };
  if (BARE_DOMAIN_RE.test(t)) return { ok: true, caution: ASSISTANT_LINK_CAUTION };
  return { ok: true };
}
