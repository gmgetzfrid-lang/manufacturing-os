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
import StagingTray from "@/components/documents/StagingTray";
import SignatureCaptureHost from "@/components/signatures/SignatureCaptureHost";
import { DialogHost } from "@/components/providers/DialogProvider";
import { NotificationCenterProvider } from "@/components/notifications/NotificationCenter";
import UpdatePill from "@/components/system/UpdatePill";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { SlowNotice, useElapsed, startOver } from "@/components/system/SlowNotice";
import { useKeepScroll } from "@/hooks/useKeepScroll";
import { flushHistory } from "@/lib/historyQueue";
import { checkSignin } from "@/lib/signinCheck";
import { btnQuiet, btnPrimary } from "@/components/admin/kit";
import { useRouter } from "next/navigation";

const ProtectedContent = ({ children }: { children: React.ReactNode }) => {
  const { loading, uid, userEmail, membershipState } = useRole();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  // Stable callbacks so the Sidebar's route-change / Escape effects can list
  // them as deps honestly without re-firing every render.
  const openMobileNav = React.useCallback(() => setMobileNavOpen(true), []);
  const closeMobileNav = React.useCallback(() => setMobileNavOpen(false), []);
  const waited = useElapsed(loading);
  const [mainEl, setMainEl] = React.useState<HTMLElement | null>(null);
  useKeepScroll(mainEl);
  // History lines that didn't save earlier are sent again: now, when the
  // connection comes back, and every few minutes.
  React.useEffect(() => {
    void flushHistory();
    const t = window.setInterval(() => { void flushHistory(); }, 3 * 60_000);
    const on = () => { void flushHistory(); };
    window.addEventListener("online", on);
    return () => { window.clearInterval(t); window.removeEventListener("online", on); };
  }, []);

  // A remembered session gets the workspace's sign-in rules once per visit:
  // a company email that signed in with a password, or a one-time password
  // past its day, is signed out; a one-time password still in its day must
  // be replaced first.
  const router = useRouter();
  React.useEffect(() => {
    if (!uid) return;
    const key = `signin-checked:${uid}`;
    try { if (sessionStorage.getItem(key)) return; } catch { /* check every time */ }
    let alive = true;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const v = await checkSignin(session?.access_token ?? null);
      if (!alive) return;
      if (v.action === "not_added") { await supabase.auth.signOut(); router.replace("/?signin=not_added"); return; }
      if (v.action === "use_microsoft" || v.action === "expired") { await supabase.auth.signOut(); router.replace("/"); return; }
      if (v.action === "set_password") { router.replace("/set-password"); return; }
      if (v.action === "ok") { try { sessionStorage.setItem(key, "1"); } catch { /* fine */ } }
    })();
    return () => { alive = false; };
  }, [uid, router]);

  if (loading) {
    // The app's shape while the workspace loads (the side menu, a header
    // and a list), not a spinner over the whole screen.
    return (
      <div className="h-dvh w-full flex bg-[var(--color-canvas)]" aria-busy="true">
        <div className="surface-side max-md:hidden w-64 shrink-0" aria-hidden />
        <div className="flex-1 min-w-0 px-4 sm:px-6 lg:px-8 pt-20">
          <p role="status" className="text-[14px] text-[var(--color-text-muted)]">Loading your workspace</p>
          <Skeleton className="mt-4 w-[min(420px,80%)] h-7" />
          <Skeleton className="mt-3 w-[min(300px,60%)] h-4" />
          <SkeletonRows rows={5} cols={2} className="mt-8 max-w-[1400px]" />
          <div className="w-full max-w-sm"><SlowNotice secs={waited} onStartOver={() => startOver()} /></div>
        </div>
      </div>
    );
  }

  // A signed-in account with no workspace membership gets a HARD STOP, not a
  // fake empty Viewer app. There are exactly two doors into a workspace —
  // an admin adds you, or a new workspace is paid for — and this screen
  // says so. Likewise, a failed membership lookup gets a retry,
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
          {/* Never scrolls sideways (a phone would let the page drift and
              bounce): wide content scrolls in its own strip or table. */}
          {/* vt-page: the part that cross-fades when moving between views
              (lib/viewTransition); the side menu and top bar hold still. */}
          <main ref={setMainEl} className="vt-page flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none relative">
            <NotificationListener />
            <UpdatePill />
            <CornerDock />
            <UploadIndicator />
            <BackupIndicator />
            <KnowledgeIndexIndicator />
            <GlobalCommandPalette />
            {/* Clipped sideways: nothing wider than the screen can widen the
                page, so even focusing a field can't shift it sideways (the
                main's own overflow only stops a drag). */}
            <div className="h-full [overflow-x:clip]">
              <SubscriptionGate>{children}</SubscriptionGate>
            </div>
            <BackToGraphChip />
            <RelationshipGraphHost />
            <SignatureCaptureHost />
            <DialogHost />
          </main>
          {/* "Staged: 3 documents" on every Documents page while something is
              staged: its own row under the page, never over its last rows. */}
          <StagingTray />
        </div>
      </div>
    </div>
  );
};

function NotAMemberScreen({ email }: { email: string | null }) {
  // Reached only when the server says this account has no ACTIVE membership
  // (a failed lookup is the retry screen, never this one). An account in no
  // workspace at all is signed out and deleted at sign-in, so what's left is
  // access an admin suspended.
  return (
    <div className="h-dvh w-full flex items-center justify-center bg-[var(--color-canvas)] p-6">
      <div className="max-w-md w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-8">
        <h1 className="text-[20px] font-semibold text-[var(--color-heading)]">Your access is off.</h1>
        <p className="text-[15px] text-[var(--color-text)] mt-2 leading-relaxed">
          You&apos;re signed in as <b>{email ?? "this account"}</b>. Your access to the workspace is suspended. Ask your admin to turn it back on, then sign in again.
        </p>
        <div className="mt-5">
          <button type="button" onClick={() => { void supabase.auth.signOut(); }} className={btnQuiet}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function MembershipErrorScreen() {
  return (
    <div className="h-dvh w-full flex items-center justify-center bg-[var(--color-canvas)] p-6">
      <div className="max-w-md w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-8 text-center">
        <h1 className="text-[20px] font-semibold text-[var(--color-text)]">Couldn&apos;t load your workspace</h1>
        <p className="text-[15px] text-[var(--color-text-muted)] mt-2">
          The connection dropped while looking up your membership. Your access is
          unchanged. Check your connection, then try again.
        </p>
        <button
          onClick={() => window.location.reload()}
          className={`mt-5 ${btnPrimary}`}
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
