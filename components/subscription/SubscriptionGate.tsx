"use client";

// SubscriptionGate — the app's curtain for a LAPSED workspace, when the
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
// free trial whose end has passed (past_due is the grace period) — sees this
// curtain instead of the page. The curtain is not the boundary: the server
// refuses new seats and new stored bytes itself. Nothing is deleted.
//
// Escape hatches (always reachable, even when lapsed):
//   - /admin/billing      so a billing admin can pay and recover;
//   - /admin/data-export  so the "your data is yours, one-click exit"
//                         promise holds after a lapse;
//   - /admin/storage      the full ZIP backup, binaries included;
//   - /profile            so anyone can sign out or switch workspace.
//
// Fail-open: while the server's answer is loading, or if it cannot be had,
// the page renders — a transient fault never locks anyone out.

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock, CreditCard, Download, LogOut } from "lucide-react";
import { supabase, setPreferMicrosoft } from "@/lib/supabase";
import { signOutOfThisBrowser } from "@/lib/swSession";
import { useRole } from "@/components/providers/RoleContext";
import { adminSurface } from "@/lib/adminSurfaces";
import type { Role } from "@/types/schema";

export const ALLOWED_WHEN_LAPSED = ["/admin/billing", "/admin/data-export", "/admin/storage", "/profile"];

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

/** Should the curtain show? Only when the server says enforcement is on AND
 *  the workspace has no access, and the page is not an escape hatch. A
 *  missing answer (loading, or a failed request) never curtains. */
export function curtainFor(verdict: ServerAccessVerdict | null, pathname: string): boolean {
  if (!verdict || !verdict.enforced || verdict.access) return false;
  return !ALLOWED_WHEN_LAPSED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
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
        // fail-open: no answer, no curtain
      }
    })();
    return () => { live = false; };
  }, [orgId]);
  return verdict && verdict.orgId === orgId ? verdict.v : null;
}

export default function SubscriptionGate({ children }: { children: React.ReactNode }) {
  const { activeOrgId, hasAnyRole } = useRole();
  const pathname = usePathname() ?? "";
  const verdict = useServerAccessVerdict(activeOrgId);

  if (!curtainFor(verdict, pathname)) return <>{children}</>;

  return (
    <SubscriptionBlocked
      reason={verdict?.reason ?? null}
      canRenew={hasAnyRole(BILLING_WRITERS)}
      canExport={hasAnyRole(EXPORTERS)}
    />
  );
}

export function SubscriptionBlocked({
  reason,
  canRenew,
  canExport,
}: {
  reason: string | null;
  canRenew: boolean;
  canExport: boolean;
}) {
  return (
    <div className="min-h-full w-full flex items-center justify-center p-6 bg-[var(--color-canvas)]">
      <div className="w-full max-w-md bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 mx-auto flex items-center justify-center mb-4">
          <Lock className="w-7 h-7 text-amber-600" />
        </div>
        <h1 className="text-xl font-black text-[var(--color-text)]">Subscription required</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-2">{reason ?? "This workspace's subscription is inactive."}</p>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          {canRenew
            ? "Renew to restore access. Your documents, audit trail, and history are safe and unchanged."
            : "Your documents and audit trail are safe. Ask a workspace Admin or Manager to renew access."}
        </p>

        <div className="mt-6 flex flex-col gap-2">
          {canRenew && (
            <Link
              href="/admin/billing"
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-sm font-bold transition-colors"
            >
              <CreditCard className="w-4 h-4" /> Go to Billing
            </Link>
          )}
          {canExport && (
            <Link
              href="/admin/data-export"
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:bg-[var(--color-canvas)] text-[var(--color-text)] text-sm font-bold transition-colors"
            >
              <Download className="w-4 h-4" /> Export your data
            </Link>
          )}
          <button
            onClick={() => { setPreferMicrosoft(false); void signOutOfThisBrowser(supabase); }}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-sm font-semibold transition-colors"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
