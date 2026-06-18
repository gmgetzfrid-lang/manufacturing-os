"use client";

// Home dashboard — a per-user, customizable grid of widgets. Each widget is an
// insight-rich link into a tool (Document Control, Drafting Requests, Projects,
// …). Hit "Customize" to add/remove/resize/reorder. The personal inbox cockpit
// is untouched and still lives at /inbox (the "Home" sidebar item) and as the
// optional "Command Deck" widget.

import DashboardGrid from "@/components/dashboard/DashboardGrid";

export default function DashboardPage() {
  return <DashboardGrid />;
}
