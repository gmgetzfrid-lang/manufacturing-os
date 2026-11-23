"use client";

// /admin/archive-view — open files out of an offline backup, in memory.
//
// The frictionless side of archiving for space: when a file has been shed to a
// cold archive, anyone sent here can drop that archive and view what they need
// — nothing is re-uploaded, and it's discarded the moment they leave.

import React from "react";
import BackupViewer from "@/components/archive/BackupViewer";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody } from "@/components/ui/PageHero";
import { useRole } from "@/components/providers/RoleContext";

export default function ArchiveViewPage() {
  const { activeOrgId, activeRole } = useRole();
  // Policy-gated (default: Admin/DocCtrl) — this page opens backup contents,
  // and previously had no guard at all.
  const [allowed, setAllowed] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (!activeOrgId || !activeRole) return;
    let alive = true;
    void import("@/lib/capabilityPolicy").then(async ({ loadCapabilityPolicy, policyAllows }) => {
      const p = await loadCapabilityPolicy(activeOrgId);
      if (alive) setAllowed(policyAllows(p, "admin.archive_view", activeRole));
    }).catch(() => { if (alive) setAllowed(true); });
    return () => { alive = false; };
  }, [activeOrgId, activeRole]);
  if (allowed === false) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Storage · View from a backup" back={{ href: "/admin/storage", label: "Back to Storage" }}
          title="Admin and Doc Control only." size="md"
          sub="The backup viewer is for Admin and Doc Control. An admin can change this under Admin, Permissions, Action permissions." />
      </PageShell>
    );
  }
  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Storage · View from a backup"
        back={{ href: "/admin/storage", label: "Back to Storage" }}
        size="md"
        title="Open a backup here."
        sub="Open files from a backup .zip in this browser. Nothing is uploaded, and it's gone when you leave."
      />
      <PageBody>
        <BackupViewer />
      </PageBody>
    </PageShell>
  );
}
