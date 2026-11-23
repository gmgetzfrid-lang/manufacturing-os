"use client";

// StagingTray - "Staged: 3 documents" along the bottom of every Documents
// page while something is staged, with the first few numbers and Open, which
// goes to the Staged page: the documents themselves, open at the first one,
// to mark up and send. It takes its
// own row under the page rather than floating over it, so it never covers
// the last rows of a table; things pinned to the bottom of the screen (a
// phone's main button, the corner cards) move up by its height
// (--staged-tray-h).

import React, { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Layers } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useStagedDocs, stagedLabel } from "@/lib/stagedDocs";
import { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { btnQuiet } from "@/components/admin/kit";

export const STAGED_PAGE = "/documents/staged";
const TRAY_H = "calc(56px + env(safe-area-inset-bottom, 0px))";

/** A page under Documents (any of its tabs), other than the Staged page. */
export function isDocumentsPage(path: string): boolean {
  if (path === STAGED_PAGE || path.startsWith(STAGED_PAGE + "/")) return false;
  return DOCUMENT_VIEWS.some((v) => path === v.href || path.startsWith(v.href + "/"));
}

export default function StagingTray() {
  const pathname = usePathname() ?? "";
  const { activeOrgId, uid } = useRole();
  const staged = useStagedDocs(activeOrgId, uid);
  const show = staged.count > 0 && isDocumentsPage(pathname);

  useEffect(() => {
    if (!show) return;
    const root = document.documentElement;
    root.style.setProperty("--staged-tray-h", TRAY_H);
    return () => { root.style.removeProperty("--staged-tray-h"); };
  }, [show]);

  if (!show) return null;
  const n = staged.count;
  const shown = staged.docs.slice(0, 4).map(stagedLabel);
  const more = n - shown.length;
  return (
    <div data-staged-tray role="region" aria-label="Staged documents"
      className="shrink-0 box-content h-14 pb-[env(safe-area-inset-bottom)] border-t border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[0_-4px_12px_-8px_rgb(31_39_51/0.25)]">
      <div className="h-full px-4 sm:px-6 flex items-center gap-3">
        <Layers aria-hidden className="w-[18px] h-[18px] shrink-0 text-[var(--color-text-muted)]" />
        <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
          <div className="text-[15px] font-semibold text-[var(--color-text)] whitespace-nowrap">
            Staged: <span className="tabular-nums">{n}</span> document{n === 1 ? "" : "s"}
          </div>
          <div className="min-w-0 truncate text-[13px] text-[var(--color-text-muted)] tabular-nums" title={staged.docs.map(stagedLabel).join(", ")}>
            {shown.join(", ")}{more > 0 ? ` and ${more} more` : ""}
          </div>
        </div>
        <Link href={STAGED_PAGE} className={`${btnQuiet} min-w-[88px]`}>Open</Link>
      </div>
    </div>
  );
}
