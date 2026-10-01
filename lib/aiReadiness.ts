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
  usage: { spentUsd?: number; capUsd?: number } | null;
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

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<AiReadiness> }>();

/** Forget what was read (a key was just saved, or a test). */
export function clearAiReadinessCache(): void { cache.clear(); }

/** Read the three facts for `orgId` (one request each, shared by every
 *  button on the page for a minute) and derive the precondition. Never
 *  throws: a failed read is "unknown". */
export function fetchAiReadiness(orgId: string, fetcher: Fetcher, now = Date.now()): Promise<AiReadiness> {
  const hit = cache.get(orgId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
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
  cache.set(orgId, { at: now, value });
  return value;
}
