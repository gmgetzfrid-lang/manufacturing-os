"use client";

// AiPrecondition — the AI entry points on the Projects and Companies pages
// say what they need BEFORE the click (projects-tab UX-13): no key of your
// own, the acceptable-use agreement not yet accepted, or the month's budget
// spent. The facts come from lib/aiReadiness (the AI settings dialog's own
// routes, read once a minute per org); the server's gates stay the
// authority — a check that could not be made leaves the button as it was.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { fetchAiReadiness, AI_READINESS_CHECKING, type AiReadiness } from "@/lib/aiReadiness";

async function authedFetch(url: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

/** The readiness of the AI features for this person in `orgId`. */
export function useAiReadiness(orgId: string | null | undefined): AiReadiness {
  const [readiness, setReadiness] = useState<AiReadiness>(AI_READINESS_CHECKING);
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void fetchAiReadiness(orgId, authedFetch).then((r) => { if (!cancelled) setReadiness(r); });
    return () => { cancelled = true; };
  }, [orgId]);
  return readiness;
}

/** A refusal the server is certain to make: the button is disabled with the
 *  reason beside it. The agreement is stated but not enforced here (the
 *  server alone knows whether its table exists yet). */
export function aiBlocked(r: AiReadiness): boolean {
  return r.state === "no_key" || r.state === "over_cap";
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
