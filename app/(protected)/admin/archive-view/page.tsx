"use client";

// /admin/archive-view — open files out of an offline backup, in memory.
//
// The frictionless side of archiving for space: when a file has been shed to a
// cold archive, anyone sent here can drop that archive and view what they need
// — nothing is re-uploaded, and it's discarded the moment they leave.

import React from "react";
import Link from "next/link";
import { ArrowLeft, Archive } from "lucide-react";
import BackupViewer from "@/components/archive/BackupViewer";
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
    return <div className="p-8 text-center text-sm text-[var(--color-text-muted)]">The backup viewer is limited to Admin and Document Control. An Admin can change this under Admin → Permissions → Action permissions.</div>;
  }
  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex items-start gap-3 mb-5">
        <Link href="/admin/storage" className="p-2 mt-1 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-black text-[var(--color-text)] flex items-center gap-2">
            <Archive className="w-5 h-5 text-[var(--color-accent)]" /> View from a backup
          </h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            Drop a backup .zip to browse and view its files in your browser. Useful when a file has been archived for space — view it here, then it&apos;s gone again.
          </p>
        </div>
      </div>

      <BackupViewer />
    </div>
  );
}
