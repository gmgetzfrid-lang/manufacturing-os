"use client";

// Settings: one place that lists every setting and where it lives. Your
// own settings first; the workspace's settings for admins below.

import React from "react";
import Link from "next/link";
import { ChevronRight, User, Bell, Palette, Image as ImageIcon, Users, Settings2, Download, CreditCard, HardDrive, ShieldCheck } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useTheme } from "@/components/providers/ThemeProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";

type Row = { href: string; icon: React.ComponentType<{ className?: string }>; name: string; what: string };

const YOURS: Row[] = [
  { href: "/profile", icon: User, name: "Profile", what: "Your name, role and workspaces" },
  { href: "/settings/notifications", icon: Bell, name: "Notifications", what: "What reaches you, and how often" },
];

const WORKSPACE: Row[] = [
  { href: "/admin/branding", icon: ImageIcon, name: "Logo and colors", what: "The logo, brand color and accent everyone sees" },
  { href: "/admin/users", icon: Users, name: "Members", what: "Who is in the workspace and their roles" },
  { href: "/admin/permissions", icon: ShieldCheck, name: "Permissions", what: "What each role can do" },
  { href: "/admin/settings", icon: Settings2, name: "Workspace settings", what: "Names, numbering and defaults" },
  { href: "/admin/storage", icon: HardDrive, name: "Storage and backup", what: "How full storage is, and backups" },
  { href: "/admin/data-export", icon: Download, name: "Data export", what: "Take all of your data, any time" },
  { href: "/admin/billing", icon: CreditCard, name: "Billing", what: "Plan and invoices" },
];

function Rows({ rows }: { rows: Row[] }) {
  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {rows.map((r) => {
        const Icon = r.icon;
        return (
          <li key={r.href}>
            <Link href={r.href} className="group flex items-center gap-4 px-4 sm:px-5 py-3.5 hover:bg-[var(--color-surface-2)]">
              <span className="w-9 h-9 shrink-0 rounded-md grid place-items-center bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]">
                <Icon className="w-[18px] h-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-[var(--color-text)] group-hover:text-[var(--color-accent-text)]">{r.name}</span>
                <span className="block text-[13px] text-[var(--color-text-muted)]">{r.what}</span>
              </span>
              <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] group-hover:text-[var(--color-accent-text)]" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function SettingsPage() {
  const { activeRole } = useRole();
  const { mode, toggleMode } = useTheme();
  const isAdmin = activeRole === "Admin";
  return (
    <PageShell width="form">
      <PageHero kicker="Settings" title="Settings." sub={isAdmin ? "Your own settings, then the workspace's." : "Your own settings. An admin sets the workspace's."} />
      <PageBody>
        <Card label="Yours" pad={false}>
          <Rows rows={YOURS} />
          <div className="flex items-center gap-4 px-4 sm:px-5 py-3.5 border-t border-[var(--color-border)]">
            <span className="w-9 h-9 shrink-0 rounded-md grid place-items-center bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]">
              <Palette className="w-[18px] h-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-[var(--color-text)]">Light or dark</span>
              <span className="block text-[13px] text-[var(--color-text-muted)]">Just for you, on this device</span>
            </span>
            <div role="radiogroup" aria-label="Light or dark" className="inline-flex h-9 rounded-md border border-[var(--color-border-strong)] overflow-hidden text-[14px] font-semibold">
              {(["light", "dark"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => mode !== m && toggleMode()}
                  className={`px-3.5 ${mode === m ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                  {m === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </div>
        </Card>
        {isAdmin && (
          <Card label="Workspace" pad={false}>
            <Rows rows={WORKSPACE} />
          </Card>
        )}
      </PageBody>
    </PageShell>
  );
}
