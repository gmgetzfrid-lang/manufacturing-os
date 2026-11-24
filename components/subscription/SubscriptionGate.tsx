"use client";

// SubscriptionGate: no subscription, no use.
//
// A workspace whose trial has ended, or whose subscription was canceled,
// went unpaid or was paused, sees one screen instead of the app: what
// happened and the one thing to do (an admin subscribes; everyone else is
// told to ask one). The server refuses changes too (proxy.ts) and so does
// the database (20261124_subscription_enforced.sql).
//
// Always reachable, even lapsed:
//   - /admin/billing      so an admin can pay and get access back.
//   - /admin/data-export  your data is yours: one-click exit holds.
//   - /profile            so anyone can sign out or switch workspace.
//
// While the subscription loads, nothing shows (no flash of the app). If
// the lookup fails (info === null), the app opens: a hiccup must never
// lock out a paying workspace.

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
const BILLING_ROLES = ["Admin", "Manager"];
const EXPORT_ROLES = ["Admin", "Manager", "DocCtrl"];

export default function SubscriptionGate({ children }: { children: React.ReactNode }) {
  const { info, loading } = useSubscription();
  const { activeRole } = useRole();
  const pathname = usePathname() ?? "";

  if (loading) return null;
  if (hasAccess(info)) return <>{children}</>;
  const escapeHatch = ALLOWED_WHEN_LAPSED.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (escapeHatch) return <>{children}</>;
  return <SubscriptionBlocked info={info} role={activeRole} />;
}

const day = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

function SubscriptionBlocked({
  info,
  role,
}: {
  info: SubscriptionInfo | null;
  role?: string | null;
}) {
  const canPay = BILLING_ROLES.includes(role ?? "");
  const canExport = EXPORT_ROLES.includes(role ?? "");
  const ended = day(info?.trialEndsAt);
  const reason =
    info?.status === "trialing"
      ? ended ? `Your free trial ended on ${ended}.` : "Your free trial has ended."
      : info?.status === "canceled"
        ? "This workspace's subscription was canceled."
        : info?.status === "unpaid"
          ? "This workspace's invoice wasn't paid."
          : info?.status === "paused"
            ? "This workspace is paused."
            : "This workspace has no active subscription.";

  return (
    <PageShell width="form">
      <PageHero
        kicker="Subscription"
        title={reason}
        size="md"
        sub={canPay
          ? "Subscribe to keep using the workspace. Your documents, history and audit trail are kept as they are."
          : "Ask your workspace admin to subscribe. Your documents, history and audit trail are kept as they are."}
        tools={
          <button
            type="button"
            onClick={() => { setPreferMicrosoft(false); void supabase.auth.signOut(); }}
            className={heroQuiet}
          >
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        }
        primary={canPay ? (
          <Link href="/admin/billing" className={heroPrimary}>
            <CreditCard className="w-4 h-4" /> Subscribe
          </Link>
        ) : undefined}
      />
      {canExport && (
        <PageBody>
          <Card label="Your data">
            <p className="text-body text-[var(--color-text-muted)] mb-3">You can still download everything, in standard formats.</p>
            <Link href="/admin/data-export" className={heroQuiet}>
              <Download className="w-4 h-4" /> Export your data
            </Link>
          </Card>
        </PageBody>
      )}
    </PageShell>
  );
}
