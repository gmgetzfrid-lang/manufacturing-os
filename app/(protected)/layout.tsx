"use client";

import React from "react";
import Sidebar from "@/components/navigation/Sidebar";
import { RoleProvider, useRole } from "@/components/providers/RoleContext";
import { SubscriptionProvider } from "@/components/providers/SubscriptionProvider";
import { ToastProvider } from "@/components/providers/ToastProvider";
import { NotificationListener } from "@/components/providers/NotificationListener";
import TrialBanner from "@/components/subscription/TrialBanner";
import { Loader2 } from "lucide-react";

const ProtectedContent = ({ children }: { children: React.ReactNode }) => {
  const { loading } = useRole();

  if (loading) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-slate-50">
        <Loader2 className="w-12 h-12 text-orange-600 animate-spin mb-4" />
        <h2 className="text-xl font-bold text-slate-800">Authenticating...</h2>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-50 flex-col">
      <TrialBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto relative">
          <NotificationListener />
          {children}
        </main>
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
        <SubscriptionProvider>
          <ProtectedContent>{children}</ProtectedContent>
        </SubscriptionProvider>
      </RoleProvider>
    </ToastProvider>
  );
}
