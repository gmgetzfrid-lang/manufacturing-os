"use client";

// AiPrecondition — the AI entry points on the Projects and Companies pages
// say what they need BEFORE the click (projects-tab UX-13): no key of your
// own, the acceptable-use agreement not yet accepted, or the month's budget
// spent. The facts come from lib/aiReadiness (the AI settings dialog's own
// routes; "ready" is shared for a minute per org, a refusal only for a few
// seconds); the server's gates stay the authority — a check that could not
// be made leaves the button as it was. A refusal is re-checked whenever the
// window regains focus or the tab becomes visible again (the person may
// have just saved a key elsewhere), so a button is never held disabled on
// a stale answer.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { fetchAiReadiness, aiReadinessRefuses, AI_READINESS_CHECKING, type AiReadiness } from "@/lib/aiReadiness";

async function authedFetch(url: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

/** The readiness of the AI features for this person in `orgId`. */
export function useAiReadiness(orgId: string | null | undefined): AiReadiness {
  const [readiness, setReadiness] = useState<AiReadiness>(AI_READINESS_CHECKING);
  const current = useRef<AiReadiness>(AI_READINESS_CHECKING);
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    let seq = 0;
    const load = (fresh: boolean) => {
      const mine = ++seq;
      void fetchAiReadiness(orgId, authedFetch, Date.now(), { fresh }).then((r) => {
        if (cancelled || mine !== seq) return;
        current.current = r;
        setReadiness(r);
      });
    };
    load(false);
    // Back from fixing it (another tab, the settings page, an admin's raise):
    // a standing refusal or a "needs the agreement" note is read again.
    const recheck = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const r = current.current;
      if (aiReadinessRefuses(r) || r.state === "no_agreement") load(true);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [orgId]);
  return readiness;
}

/** A refusal the server is certain to make: the button is disabled with the
 *  reason beside it. The agreement is stated but not enforced here (the
 *  server alone knows whether its table exists yet). */
export function aiBlocked(r: AiReadiness): boolean {
  return aiReadinessRefuses(r);
}

/** The precondition, stated beside the button — nothing when ready, still
 *  checking, or unknown. */
export function AiPreconditionNote({ readiness, className = "" }: { readiness: AiReadiness; className?: string }) {
  if (!readiness.message) return null;
  return (
    <span role="note" className={`inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 dark:text-amber-300 ${className}`}>
      <KeyRound aria-hidden="true" className="w-3 h-3 shrink-0" />
      <span>
        {readiness.message}
        {readiness.href && readiness.cta && (
          <> <Link href={readiness.href} className="underline">{readiness.cta}</Link></>
        )}
      </span>
    </span>
  );
}
