"use client";

import React from "react";
import { supabase, setPreferMicrosoft } from "@/lib/supabase";
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
import { resolveProtectedView } from "@/lib/protectedGate";

const ProtectedContent = ({ children }: { children: React.ReactNode }) => {
  const { loading, uid, userEmail, membershipState } = useRole();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  // Stable callbacks so the Sidebar's route-change / Escape effects can list
  // them as deps honestly without re-firing every render.
  const openMobileNav = React.useCallback(() => setMobileNavOpen(true), []);
  const closeMobileNav = React.useCallback(() => setMobileNavOpen(false), []);

  // All four membership states are handled — the decision lives in
  // resolveProtectedView so the contract is pinned by lib/__tests__.
  // "resolving" is the state this ladder used to fall through: the watchdogs
  // force-clear `loading` while the membership answer is still in flight, and
  // rendering the app then means rendering it at the placeholder role
  // ("Viewer", roles: []) — a fake Viewer app for a signed-in Admin.
  const view = resolveProtectedView({ loading, uid, membershipState });

  if (view === "authenticating") {
    return (
      <div className="h-dvh w-full flex flex-col items-center justify-center bg-[var(--color-canvas)] animate-in fade-in">
        <Spinner size="lg" className="mb-4" />
        <h2 className="text-xl font-bold text-[var(--color-text)]">Authenticating...</h2>
      </div>
    );
  }

  if (view === "resolving") return <ResolvingMembershipScreen />;

  // A signed-in account with no workspace membership gets a HARD STOP, not a
  // fake empty Viewer app. There are exactly two doors into a workspace —
  // an admin adds you, or you start a trial with a brand-new workspace — and
  // this screen says so. Likewise, a failed membership lookup gets a retry,
  // never a silent downgrade to Viewer.
  if (view === "no-membership") return <NotAMemberScreen email={userEmail} />;
  if (view === "membership-error") return <MembershipErrorScreen />;

  return (
    <div className="flex h-dvh bg-[var(--color-canvas)] text-[var(--color-text)] flex-col">
      <TrialBanner />
      <WorkspaceRelocationBanner />
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

/** Top-strip notice shown after a workspace self-heal moved this session
 *  somewhere the device/profile did not point (ORGSEL-4). Copies the
 *  TrialBanner strip shape. "Make default" persists the choice — a pick
 *  among several workspaces is deliberately NOT persisted until the user
 *  confirms it (ORGSEL-1). */
function WorkspaceRelocationBanner() {
  const { workspaceRelocation, activeOrgId, setActiveOrgId, acknowledgeWorkspaceRelocation } = useRole();
  const [orgName, setOrgName] = React.useState<string | null>(null);

  const toOrgId = workspaceRelocation?.toOrgId ?? null;
  React.useEffect(() => {
    if (!toOrgId) { setOrgName(null); return; }
    let alive = true;
    // Destination org is always readable (the user is an active member
    // there); the origin org may not be, so it is never looked up.
    void supabase.from("orgs").select("name").eq("id", toOrgId).maybeSingle()
      .then(({ data }) => { if (alive) setOrgName((data as { name?: string } | null)?.name ?? null); });
    return () => { alive = false; };
  }, [toOrgId]);

  if (!workspaceRelocation || workspaceRelocation.toOrgId !== activeOrgId) return null;

  const several = workspaceRelocation.candidateCount > 1;
  return (
    <div className="bg-amber-500 text-white px-4 py-2 text-xs font-bold flex items-center justify-center gap-3 shadow">
      <span>
        You&apos;re in {orgName ? <b>{orgName}</b> : "a different workspace"} — your usual
        workspace isn&apos;t available for this account
        {several ? ", so the most capable of your workspaces was chosen" : ""}.
      </span>
      {several && (
        <button
          onClick={() => { void setActiveOrgId(workspaceRelocation.toOrgId); }}
          className="px-2.5 py-1 rounded-md bg-white/20 hover:bg-white/30 text-[11px] font-black uppercase tracking-wide"
        >
          Make default
        </button>
      )}
      <button
        onClick={acknowledgeWorkspaceRelocation}
        aria-label="Dismiss workspace notice"
        className="px-2 py-1 rounded-md hover:bg-white/20 text-[13px] font-black leading-none"
      >
        ×
      </button>
    </div>
  );
}

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
            onClick={() => {
              // Explicit sign-out to SWITCH ACCOUNTS: the silent-Microsoft
              // flag must be cleared first, or the login page's silent SSO
              // walks the user straight back into the identity they are
              // trying to leave (IDENT-4).
              setPreferMicrosoft(false);
              void supabase.auth.signOut();
            }}
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

/** The honest slow-path screen (SESS-3). Shown when the membership lookup is
 *  still in flight after the spinner watchdogs gave up on it. Says what the
 *  error screen says — access unchanged — because the alternative was a
 *  silent, plausible, wrong render: a Viewer app for an Admin. */
function ResolvingMembershipScreen() {
  return (
    <div className="h-dvh w-full flex items-center justify-center bg-[var(--color-canvas)] p-6">
      <div className="max-w-md w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl p-8 text-center">
        <Spinner size="lg" className="mb-4 mx-auto" />
        <h1 className="text-lg font-black text-[var(--color-text)]">Still loading your workspace…</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-2">
          This is taking longer than usual — likely a slow connection or a cold
          database start. Your access is unchanged; this is a delay, not a
          permissions change.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-5 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-black shadow"
        >
          Reload
        </button>
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
