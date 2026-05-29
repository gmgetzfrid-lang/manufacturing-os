"use client";

// TopBar — slim header that sits above the main content area. Holds
// the notification bell on the right (social-platform convention)
// and leaves the left empty for now; future breadcrumbs and search
// can drop in without re-laying out the page.

import React from "react";
import { useRole } from "@/components/providers/RoleContext";
import NotificationBell from "@/components/notifications/NotificationBell";

export default function TopBar() {
  const { uid } = useRole();
  return (
    <header className="shrink-0 h-12 bg-white/80 backdrop-blur border-b border-slate-200 px-4 flex items-center gap-3">
      <div className="flex-1" />
      {uid && <NotificationBell userId={uid} variant="header" />}
    </header>
  );
}
