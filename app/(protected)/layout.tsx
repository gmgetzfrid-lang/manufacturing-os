"use client";

import React from "react";
import { supabase } from "@/lib/supabase";
import Sidebar from "@/components/navigation/Sidebar";
import TopBar from "@/components/navigation/TopBar";
import GlobalCommandPalette from "@/components/navigation/GlobalCommandPalette";
import { RoleProvider, useRole } from "@/components/providers/RoleContext";
import { OrgBrandingProvider } from "@/components/providers/OrgBrandingProvider";
import { SubscriptionProvider } from "@/components/providers/SubscriptionProvider";
import { ToastProvider } from "@/components/providers/ToastProvider";
import { NotificationListener } from "@/components/providers/NotificationListener";
import UploadIndicator from "@/components/providers/UploadIndicator";
import { CornerDock } from "@/components/ui/CornerDock";
import BackupIndicator from "@/components/providers/BackupIndicator";
import KnowledgeIndexIndicator from "@/components/providers/KnowledgeIndexIndicator";
import TrialBanner from "@/components/subscription/TrialBanner";
import SubscriptionGate from "@/components/subscription/SubscriptionGate";
import RelationshipGraphHost from "@/components/documents/RelationshipGraphHost";
import BackToGraphChip from "@/components/graph/BackToGraphChip";
import SignatureCaptureHost from "@/components/signatures/SignatureCaptureHost";
import { DialogHost } from "@/components/providers/DialogProvider";
import { NotificationCenterProvider } from "@/components/notifications/NotificationCenter";
import UpdatePill from "@/components/system/UpdatePill";
import { Spinner } from "@/components/ui/Spinner";

const ProtectedContent = ({ children }: { children: React.ReactNode }) => {
  const { loading, uid, userEmail, membershipState } = useRole();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  // Stable callbacks so the Sidebar's route-change / Escape effects can list
  // them as deps honestly without re-firing every render.
  const openMobileNav = React.useCallback(() => setMobileNavOpen(true), []);
  const closeMobileNav = React.useCallback(() => setMobileNavOpen(false), []);

  if (loading) {
    return (
      <div className="h-dvh w-full flex flex-col items-center justify-center bg-[var(--color-canvas)] animate-in fade-in">
        <Spinner size="lg" className="mb-4" />
        <h2 className="text-xl font-bold text-[var(--color-text)]">Authenticating...</h2>
      </div>
    );
  }

  // A signed-in account with no workspace membership gets a HARD STOP, not a
  // fake empty Viewer app. There are exactly two doors into a workspace —
  // an admin adds you, or you start a trial with a brand-new workspace — and
  // this screen says so. Likewise, a failed membership lookup gets a retry,
  // never a silent downgrade to Viewer.
  if (uid && membershipState === "none") return <NotAMemberScreen email={userEmail} />;
  if (uid && membershipState === "error") return <MembershipErrorScreen />;

  return (
    <div className="flex h-dvh bg-[var(--color-canvas)] text-[var(--color-text)] flex-col">
      <TrialBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar mobileOpen={mobileNavOpen} onMobileClose={closeMobileNav} />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <TopBar onOpenMobileNav={openMobileNav} />
          <main className="flex-1 overflow-auto relative">
            <NotificationListener />
            <UpdatePill />
            <CornerDock />
            <UploadIndicator />
            <BackupIndicator />
            <KnowledgeIndexIndicator />
            <GlobalCommandPalette />
            <SubscriptionGate>{children}</SubscriptionGate>
            <BackToGraphChip />
            <RelationshipGraphHost />
            <SignatureCaptureHost />
            <DialogHost />
          </main>
        </div>
      </div>
    </div>
  );
};

function NotAMemberScreen({ email }: { email: string | null }) {
  return (
    <div className="h-dvh w-full flex items-center justify-center bg-[var(--color-canvas)] p-6">
      <div className="max-w-md w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-100 border border-amber-200 flex items-center justify-center mx-auto mb-4">
          <span className="text-2xl" aria-hidden>🔒</span>
        </div>
        <h1 className="text-lg font-black text-[var(--color-text)]">This account isn&apos;t a member of any workspace</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-2 leading-relaxed">
          You&apos;re signed in as <b className="text-[var(--color-text)]">{email ?? "an unrecognized account"}</b>,
          but no workspace has admitted this account. Workspaces are invite-only: an
          administrator adds you, or you start a free trial with a brand-new workspace.
        </p>
        <p className="text-xs text-[var(--color-text-faint)] mt-2">
          Expecting to see your workspace? You may be signed in with a different
          account than usual (a personal vs. work Microsoft account, for example).
          Sign out and sign back in with the account your admin added.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2 flex-wrap">
          <button
            onClick={() => { void supabase.auth.signOut(); }}
            className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-black shadow"
          >
            Sign out & switch account
          </button>
          <a href="/signup"
            className="px-4 py-2.5 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          >
            Start a free trial
          </a>
        </div>
      </div>
    </div>
  );
}

function MembershipErrorScreen() {
  return (
    <div className="h-dvh w-full flex items-center justify-center bg-[var(--color-canvas)] p-6">
      <div className="max-w-md w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl p-8 text-center">
        <h1 className="text-lg font-black text-[var(--color-text)]">Couldn&apos;t load your workspace</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-2">
          The connection dropped while looking up your membership. Your access is
          unchanged — this is a network hiccup, not a permissions change.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-5 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-black shadow"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <RoleProvider>
        <OrgBrandingProvider>
          <SubscriptionProvider>
            <NotificationCenterProvider>
              <ProtectedContent>{children}</ProtectedContent>
            </NotificationCenterProvider>
          </SubscriptionProvider>
        </OrgBrandingProvider>
      </RoleProvider>
    </ToastProvider>
  );
}
