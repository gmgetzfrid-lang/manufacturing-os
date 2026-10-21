"use client";

// SubscriptionGate — the app's notice for a LAPSED workspace, when the
// operator has switched subscription enforcement on (admin-and-org BILL-10 /
// ORG-9 / BILL-14, Round G P5; DEC-18).
//
// The switch is the server's SUBSCRIPTION_ENFORCE variable — off unless the
// operator sets it to "true". This component carries no switch of its own:
// it asks the server (/api/subscription/access), which answers with the same
// check the billable routes refuse on (lib/serverAuth.ts orgAccessVerdict /
// enforceOrgAccess). With the switch off the server says so without reading
// anything and the app renders exactly as it always has; the TrialBanner is
// the only sign of an ended trial.
//
// With the switch on, a lapsed workspace — canceled, unpaid, paused, or a
// free trial whose end has passed (past_due is the grace period) — sees a
// strip above every page saying what is paused. The page itself ALWAYS
// renders: members keep reading, downloading and exporting their controlled
// documents (DEC-90 ruling (2): a lapsed workspace is not locked out of its
// own records). What is paused is what the SERVER refuses — new seats and
// new stored files (create-user, storage/upload-url, storage/multipart) —
// and the strip says exactly that, in the server's own sentence. Other row
// writes are not refused while lapsed (BILL-10's Partial names the gap and
// its owner), so the strip never claims the workspace is read-only.
// Nothing is deleted. Billing, data export, /admin/storage's full backup and
// /profile are reachable like every other page.
//
// Fail-open: while the server's answer is loading, or if it cannot be had,
// no strip shows — a transient fault never alarms anyone.

import React from "react";
import Link from "next/link";
import { Lock, CreditCard, Download } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { adminSurface } from "@/lib/adminSurfaces";
import type { Role } from "@/types/schema";

/** Who may renew (start a checkout / open the portal): the billing surface's
 *  writes set, the set the Stripe routes' gate holds them to. */
const BILLING_WRITERS = (adminSurface("billing")?.writes ?? []) as Role[];
/** Who may export the whole workspace: the data-export surface's entry, the
 *  set every /api/data-export route and /admin/storage's backup admit. */
const EXPORTERS = (() => {
  const entry = adminSurface("data-export")?.entry;
  return (Array.isArray(entry) ? entry : []) as Role[];
})();

export type ServerAccessVerdict = { enforced: boolean; access: boolean; reason: string | null };

/** Should the lapsed-workspace notice show? Only when the server says
 *  enforcement is on AND the workspace has no access. A missing answer
 *  (loading, or a failed request) never shows it. It never hides the page. */
export function lapsedNoticeFor(verdict: ServerAccessVerdict | null): boolean {
  return !!verdict && verdict.enforced && !verdict.access;
}

/** Ask the server once per workspace. null until it answers, and on any
 *  failure (fail-open). */
function useServerAccessVerdict(orgId: string | null): ServerAccessVerdict | null {
  const [verdict, setVerdict] = React.useState<{ orgId: string; v: ServerAccessVerdict } | null>(null);
  React.useEffect(() => {
    if (!orgId) return;
    let live = true;
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const res = await fetch(`/api/subscription/access?orgId=${encodeURIComponent(orgId)}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as Partial<ServerAccessVerdict>;
        if (live && typeof body.enforced === "boolean" && typeof body.access === "boolean") {
          setVerdict({ orgId, v: { enforced: body.enforced, access: body.access, reason: body.reason ?? null } });
        }
      } catch {
        // fail-open: no answer, no strip
      }
    })();
    return () => { live = false; };
  }, [orgId]);
  return verdict && verdict.orgId === orgId ? verdict.v : null;
}

export default function SubscriptionGate({ children }: { children: React.ReactNode }) {
  const { activeOrgId, hasAnyRole } = useRole();
  const verdict = useServerAccessVerdict(activeOrgId);

  if (!lapsedNoticeFor(verdict)) return <>{children}</>;

  return (
    <>
      <SubscriptionLapsedNotice
        reason={verdict?.reason ?? null}
        canRenew={hasAnyRole(BILLING_WRITERS)}
        canExport={hasAnyRole(EXPORTERS)}
      />
      {children}
    </>
  );
}

/** The fallback when the server gave no sentence: what is paused, the same
 *  limbs lib/serverAuth.ts lapsedWorkspaceMessage names. */
export const LAPSED_FALLBACK =
  "This workspace's subscription is inactive, so adding members and uploading new files are paused until billing is renewed (an Admin or Manager can do that under Admin → Billing). Nothing has been deleted; documents can still be opened, downloaded and exported.";

export function SubscriptionLapsedNotice({
  reason,
  canRenew,
  canExport,
}: {
  reason: string | null;
  canRenew: boolean;
  canExport: boolean;
}) {
  return (
    <div
      role="status"
      data-subscription-lapsed=""
      className="w-full bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs"
    >
      <Lock className="w-4 h-4 shrink-0 text-amber-600" aria-hidden="true" />
      <p className="flex-1 min-w-[12rem]">
        <span className="font-bold">Subscription inactive. </span>
        {reason ?? LAPSED_FALLBACK}
      </p>
      {canRenew && (
        <Link
          href="/admin/billing"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-bold"
        >
          <CreditCard className="w-3.5 h-3.5" aria-hidden="true" /> Go to Billing
        </Link>
      )}
      {canExport && (
        <Link
          href="/admin/data-export"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-amber-300 hover:bg-amber-100 font-bold"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" /> Export your data
        </Link>
      )}
    </div>
  );
}
