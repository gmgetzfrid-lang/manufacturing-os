// lib/aiReadiness.ts — can this person run an AI feature right now? Said
// BEFORE the click (projects-tab UX-13).
//
// Every AI feature route goes through lib/ai/governedCall.ts, which refuses
// — only once invoked — when the caller has no key of their own (412), has
// not accepted the acceptable-use agreement (428), or has spent their
// monthly cap (402). The Projects surfaces used to let a person search for a
// document, pick it, click, and wait for the model before learning that.
// This module reads the same three facts through the routes that already
// serve them to the AI settings dialog (GET /api/ai/connection, /agreement,
// /usage — each the caller's own row, behind their session) and turns them
// into one precondition the button can state. It decides nothing: the
// server's gates stay the authority, and a check that cannot be made says
// "unknown" and leaves the button enabled.

export type AiReadinessState = "checking" | "ready" | "no_key" | "no_agreement" | "over_cap" | "unknown";

export interface AiReadiness {
  state: AiReadinessState;
  /** What stands in the way, in one sentence — null when nothing does (or unknown). */
  message: string | null;
  /** Where the person fixes it, when there is a place. */
  href: string | null;
  cta: string | null;
}

/** Where a person adds their own key (the setup page's "AI settings"). */
export const AI_SETTINGS_HREF = "/intelligence/setup";
/** Where the acceptable-use agreement is offered (the first question in Knowledge). */
export const AI_AGREEMENT_HREF = "/knowledge";

export const AI_READINESS_CHECKING: AiReadiness = { state: "checking", message: null, href: null, cta: null };
export const AI_READINESS_UNKNOWN: AiReadiness = { state: "unknown", message: null, href: null, cta: null };

/** The three facts, as the routes return them; `null` = that read failed. */
export interface AiFacts {
  connection: { personal?: { provider?: string | null } | null } | null;
  agreement: { accepted?: boolean } | null;
  usage: { spentUsd?: number; capUsd?: number; locked?: boolean } | null;
}

/** Pure: the facts → the precondition, in governedCall's order (key, then
 *  agreement, then cap). A fact that could not be read is not a refusal. */
export function aiReadinessFrom(f: AiFacts): AiReadiness {
  if (f.connection && !f.connection.personal) {
    return {
      state: "no_key",
      message: "Needs your AI key — AI features here run on your own Claude or OpenAI key.",
      href: AI_SETTINGS_HREF, cta: "Set it up (1 min)",
    };
  }
  if (f.agreement && f.agreement.accepted === false) {
    return {
      state: "no_agreement",
      message: "Needs the AI acceptable-use agreement — you accept it once, when you ask your first question in Knowledge.",
      href: AI_AGREEMENT_HREF, cta: "Open Knowledge",
    };
  }
  const spent = Number(f.usage?.spentUsd ?? 0);
  const cap = Number(f.usage?.capUsd ?? 0);
  // GOV-3 (intelligence I-05, DEC-73 item 2): a $0 cap is a LOCK
  // (`locked: true`, capUsd 0), never "no cap" — the server refuses every AI
  // call for it (integrator, at the J10 merge: the I-05 merge gate's rule for
  // every reader of /api/ai/usage).
  if (f.usage && (f.usage.locked === true || (f.usage.capUsd !== undefined && cap === 0))) {
    return {
      state: "over_cap",
      message: "Your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it.",
      href: AI_SETTINGS_HREF, cta: "See your usage",
    };
  }
  if (f.usage && cap > 0 && spent >= cap) {
    return {
      state: "over_cap",
      message: `Your monthly AI budget is used up ($${spent.toFixed(2)} of $${cap.toFixed(2)}) — an administrator can raise it.`,
      href: AI_SETTINGS_HREF, cta: "See your usage",
    };
  }
  if (!f.connection || !f.agreement || !f.usage) return AI_READINESS_UNKNOWN;
  return { state: "ready", message: null, href: null, cta: null };
}

type Fetcher = (url: string) => Promise<Response>;

/** A precondition that disables a button: the server is certain to refuse. */
export function aiReadinessRefuses(r: AiReadiness): boolean {
  return r.state === "no_key" || r.state === "over_cap";
}

/** "Ready" / "unknown" are shared by every button on the page for a minute.
 *  A refusal — a missing key, an unsigned agreement, a spent budget — is
 *  kept only long enough for the buttons mounting together to share one
 *  read: the person may be fixing it right now (a key saved in another tab,
 *  a cap raised by an administrator), and a button must never stay
 *  disabled on a stale answer. */
const TTL_MS = 60_000;
const REFUSAL_TTL_MS = 3_000;
/** A FRESH read (the re-check on focus / visibility) still shares a read
 *  that is in flight or was started this recently: every button on the
 *  page re-checks on the same event (the checklist cards hold one each, up
 *  to 50), and one alt-tab fires both `focus` and `visibilitychange` — so
 *  they cost one read of the three routes, not one per button. A re-check
 *  after the window reads again. */
export const FRESH_SHARE_MS = 1_000;
const cache = new Map<string, { at: number; value: Promise<AiReadiness>; ttl: number; settled: boolean }>();

/** Forget what was read (a key was just saved, or a test). */
export function clearAiReadinessCache(orgId?: string): void {
  if (orgId) cache.delete(orgId); else cache.clear();
}

/** Read the three facts for `orgId` (one request each, shared by the
 *  buttons on the page) and derive the precondition. Never throws: a failed
 *  read is "unknown". `fresh` (a re-check on focus) skips the cached answer
 *  but shares a read still in flight or started within FRESH_SHARE_MS. */
export function fetchAiReadiness(orgId: string, fetcher: Fetcher, now = Date.now(), opts: { fresh?: boolean } = {}): Promise<AiReadiness> {
  const hit = cache.get(orgId);
  if (hit && (opts.fresh ? !hit.settled || now - hit.at < FRESH_SHARE_MS : now - hit.at < hit.ttl)) return hit.value;
  const read = async <T,>(path: string): Promise<T | null> => {
    try {
      const res = await fetcher(`${path}?orgId=${encodeURIComponent(orgId)}`);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch { return null; }
  };
  const value = (async () => {
    const [connection, agreement, usage] = await Promise.all([
      read<AiFacts["connection"]>("/api/ai/connection"),
      read<AiFacts["agreement"]>("/api/ai/agreement"),
      read<AiFacts["usage"]>("/api/ai/usage"),
    ]);
    return aiReadinessFrom({ connection, agreement, usage });
  })();
  const entry = { at: now, value, ttl: TTL_MS, settled: false };
  cache.set(orgId, entry);
  // A refusal is not kept: once the answer is known, its entry shrinks to
  // the short window (only while it is still the one cached).
  void value.then((r) => {
    entry.settled = true;
    if (r.state !== "ready" && r.state !== "unknown" && cache.get(orgId) === entry) entry.ttl = REFUSAL_TTL_MS;
  });
  return value;
}
