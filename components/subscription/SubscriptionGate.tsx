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
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock, CreditCard, Download, LogOut } from "lucide-react";
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
    <div className="min-h-full w-full flex items-center justify-center p-6 bg-[var(--color-canvas)]">
      <div className="w-full max-w-md bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 mx-auto flex items-center justify-center mb-4">
          <Lock className="w-7 h-7 text-amber-600" />
        </div>
        <h1 className="text-xl font-black text-[var(--color-text)]">Subscription required</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-2">{reason}</p>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          {admin
            ? "Renew to restore access. Your documents, audit trail, and history are safe and unchanged."
            : "Your documents and audit trail are safe. Ask a workspace admin to renew access."}
        </p>

        <div className="mt-6 flex flex-col gap-2">
          {admin && (
            <Link
              href="/admin/billing"
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-sm font-bold transition-colors"
            >
              <CreditCard className="w-4 h-4" /> Go to Billing
            </Link>
          )}
          <Link
            href="/admin/data-export"
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:bg-[var(--color-canvas)] text-[var(--color-text)] text-sm font-bold transition-colors"
          >
            <Download className="w-4 h-4" /> Export your data
          </Link>
          <button
            onClick={() => { setPreferMicrosoft(false); void supabase.auth.signOut(); }}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-sm font-semibold transition-colors"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
