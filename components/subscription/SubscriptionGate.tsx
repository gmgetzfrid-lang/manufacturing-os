"use client";

// SubscriptionGate — the enforcement that was missing.
//
// Previously `hasAccess()` existed but had ZERO callers: an expired trial
// showed a red banner and nothing else, so lapsed orgs kept full access.
// This gate blocks the app surface once the workspace's subscription has
// definitively lapsed.
//
// Deliberate escape hatches (always reachable even when lapsed):
//   - /admin/billing      so an admin can actually pay and recover.
//   - /admin/data-export  so the "your data is yours, one-click exit"
//                         promise holds even after a lapse.
//   - /profile            so anyone can sign out or switch workspace.
//
// Fail-open: while the subscription is still loading, or if the lookup
// failed (info === null), `hasAccess` returns true so a transient DB hiccup
// never locks anyone out.

import React from "react";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard, Download, LogOut } from "lucide-react";
import { supabase, setPreferMicrosoft } from "@/lib/supabase";
import { useSubscription } from "@/components/providers/SubscriptionProvider";
import { useRole } from "@/components/providers/RoleContext";
import { hasAccess, type SubscriptionInfo } from "@/lib/subscription";

const ALLOWED_WHEN_LAPSED = ["/admin/billing", "/admin/data-export", "/profile"];

function isController(role?: string | null) {
  return role === "Admin" || role === "DocCtrl";
}

export default function SubscriptionGate({ children }: { children: React.ReactNode }) {
  const { info, loading } = useSubscription();
  const { activeRole } = useRole();
  const pathname = usePathname() ?? "";

  // Hard-blocking is OFF by default. It previously walled off the whole app
  // for any workspace whose trial had lapsed — which, for an actively-used or
  // in-development org, just looks like "everything is broken". The TrialBanner
  // still nags. Flip ENFORCE to true (and confirm your orgs' billing state)
  // when you actually want to gate access; even then, only the hard non-payment
  // states block, never a merely-expired trial.
  const ENFORCE = false;

  if (!ENFORCE || loading || hasAccess(info)) return <>{children}</>;

  const hardLapsed =
    info?.status === "canceled" || info?.status === "unpaid" || info?.status === "paused";
  const escapeHatch = ALLOWED_WHEN_LAPSED.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!hardLapsed || escapeHatch) return <>{children}</>;

  return <SubscriptionBlocked info={info} role={activeRole} />;
}

function SubscriptionBlocked({
  info,
  role,
}: {
  info: SubscriptionInfo | null;
  role?: string | null;
}) {
  const admin = isController(role);
  const reason =
    info?.status === "trialing"
      ? "Your free trial has ended."
      : info?.status === "canceled"
        ? "This workspace's subscription was canceled."
        : info?.status === "unpaid" || info?.status === "past_due"
          ? "This workspace has an unpaid invoice."
          : info?.status === "paused"
            ? "This workspace is paused."
            : "This workspace's subscription is inactive.";

  return (
    <PageShell width="form">
      <PageHero
        kicker="Subscription required"
        title={reason}
        size="md"
        sub={admin
          ? "Renew to get access back. Your documents, audit trail and history are safe and unchanged."
          : "Your documents and audit trail are safe. Ask a workspace admin to renew access."}
        tools={
          <button
            type="button"
            onClick={() => { setPreferMicrosoft(false); void supabase.auth.signOut(); }}
            className={heroQuiet}
          >
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        }
        primary={admin ? (
          <Link href="/admin/billing" className={heroPrimary}>
            <CreditCard className="w-4 h-4" /> Go to Billing
          </Link>
        ) : undefined}
      />
      <PageBody>
        <Card label="Your data">
          <p className="text-[14px] text-[var(--color-text-muted)] mb-3">Everything stays exportable while access is paused.</p>
          <Link
            href="/admin/data-export"
            className={heroQuiet}
          >
            <Download className="w-4 h-4" /> Export your data
          </Link>
        </Card>
      </PageBody>
    </PageShell>
  );
}
