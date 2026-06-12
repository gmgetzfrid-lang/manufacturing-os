"use client";

import React from "react";
import Sidebar from "@/components/navigation/Sidebar";
import TopBar from "@/components/navigation/TopBar";
import GlobalCommandPalette from "@/components/navigation/GlobalCommandPalette";
import { RoleProvider, useRole } from "@/components/providers/RoleContext";
import { OrgBrandingProvider } from "@/components/providers/OrgBrandingProvider";
import { SubscriptionProvider } from "@/components/providers/SubscriptionProvider";
import { ToastProvider } from "@/components/providers/ToastProvider";
import { NotificationListener } from "@/components/providers/NotificationListener";
import UploadIndicator from "@/components/providers/UploadIndicator";
import TrialBanner from "@/components/subscription/TrialBanner";
import SubscriptionGate from "@/components/subscription/SubscriptionGate";
import CopilotRail from "@/components/ai/CopilotRail";
import RelationshipGraphHost from "@/components/documents/RelationshipGraphHost";
import SignatureCaptureHost from "@/components/signatures/SignatureCaptureHost";
import { DialogHost } from "@/components/providers/DialogProvider";
import { Spinner } from "@/components/ui/Spinner";

const ProtectedContent = ({ children }: { children: React.ReactNode }) => {
  const { loading } = useRole();
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

  return (
    <div className="flex h-dvh bg-[var(--color-canvas)] text-[var(--color-text)] flex-col">
      <TrialBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar mobileOpen={mobileNavOpen} onMobileClose={closeMobileNav} />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <TopBar onOpenMobileNav={openMobileNav} />
          <main className="flex-1 overflow-auto relative">
            <NotificationListener />
            <UploadIndicator />
            <GlobalCommandPalette />
            <SubscriptionGate>{children}</SubscriptionGate>
            <CopilotRail />
            <RelationshipGraphHost />
            <SignatureCaptureHost />
            <DialogHost />
          </main>
        </div>
      </div>
    </div>
  );
};

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
            <ProtectedContent>{children}</ProtectedContent>
          </SubscriptionProvider>
        </OrgBrandingProvider>
      </RoleProvider>
    </ToastProvider>
  );
}
