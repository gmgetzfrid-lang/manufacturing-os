"use client";

// Settings: one place that lists every setting and where it lives. Your
// own settings first; the workspace's settings for admins below, grouped
// by job.

import React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useTheme } from "@/components/providers/ThemeProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody } from "@/components/ui/PageHero";
import { Section } from "@/components/admin/kit";
import { bandSeg, bandSegItem } from "@/components/admin/band";

type Row = { href: string; name: string; what: string };

const YOURS: Row[] = [
  { href: "/profile", name: "Profile", what: "Your name, role and workspaces" },
  { href: "/settings/notifications", name: "Notifications", what: "Which emails you get, and how often" },
];

const WORKSPACE: Array<{ group: string; rows: Row[] }> = [
  { group: "People and access", rows: [
    { href: "/admin/users", name: "People", what: "Who is in the workspace and their roles" },
    { href: "/admin/teams", name: "Teams", what: "Groups of people, and the libraries a team owns" },
    { href: "/admin/permissions", name: "Permissions", what: "What each role can see and do" },
  ] },
  { group: "Documents and requests", rows: [
    { href: "/admin/libraries", name: "Libraries", what: "Folders, numbering and review steps" },
    { href: "/admin/requests", name: "Request forms", what: "What a drafting request asks for" },
    { href: "/admin/scope", name: "Operational scope", what: "Plants, units and systems" },
    { href: "/admin/ai-instructions", name: "AI instructions", what: "Your site's conventions, written once" },
  ] },
  { group: "Workspace", rows: [
    { href: "/admin/branding", name: "Logo and colors", what: "The logo, colors and slide template everyone sees" },
    { href: "/admin/settings", name: "Workspace settings", what: "Sign-in rules, request numbering, email" },
    { href: "/admin/billing", name: "Billing", what: "Plan and invoices" },
  ] },
  { group: "Data", rows: [
    { href: "/admin/storage", name: "Storage and backup", what: "How full storage is, and what can be cleared" },
    { href: "/admin/data-export", name: "Data export", what: "Take all of your data, any time" },
    { href: "/admin/restore", name: "Restore from a backup", what: "Put records back from an export" },
  ] },
];

function Rows({ rows }: { rows: Row[] }) {
  return (
    <ul className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
      {rows.map((r) => (
        <li key={r.href}>
          <Link href={r.href} className="group flex items-center gap-4 px-4 sm:px-5 min-h-[60px] py-3 hover:bg-[var(--color-surface-2)] transition-colors">
            <span className="min-w-0 flex-1">
              <span className="block text-reading font-medium text-[var(--color-text)]">{r.name}</span>
              <span className="block text-body text-[var(--color-text-muted)]">{r.what}</span>
            </span>
            <ChevronRight aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-text-faint)] group-hover:text-[var(--color-text)] group-hover:translate-x-0.5 transition-transform motion-reduce:transition-none" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function SettingsPage() {
  const { activeRole } = useRole();
  const { mode, toggleMode } = useTheme();
  const isAdmin = activeRole === "Admin";
  return (
    <PageShell width="form">
      <PageHero kicker="Settings" title="Settings." sub={isAdmin ? "Yours first, then the workspace's." : "Your own settings. An admin sets the workspace's."} />
      <PageBody>
        <Section label="Yours">
          <Rows rows={YOURS} />
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 sm:px-5 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-reading font-medium text-[var(--color-text)]">Light or dark</span>
              <span className="block text-body text-[var(--color-text-muted)]">Just for you, on this device</span>
            </span>
            <div role="radiogroup" aria-label="Light or dark" className={bandSeg}>
              {(["light", "dark"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => mode !== m && toggleMode()}
                  className={bandSegItem(mode === m)}>
                  {m === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </div>
        </Section>
        {isAdmin && WORKSPACE.map((g) => (
          <Section key={g.group} label={g.group}>
            <Rows rows={g.rows} />
          </Section>
        ))}
      </PageBody>
    </PageShell>
  );
}
