// components/notifications/kindIcon.ts
//
// One icon per notification kind, for every surface that draws one: the
// header bell's list and the attention feed (the Notification Center, /inbox,
// the dashboard widget). Both used to keep their own map — the bell a
// hand-written KIND_ICON, the feed substring predicates — and they drew
// different icons for the same row (TAX-5: a review_requested row was a bare
// Bell in one and a GitBranch in the other). The icon now comes from
// lib/notificationKinds.ts KIND_META.icon, the registry's column for exactly
// this (notifications Round G, N3 — DEC-81 §1).

import type React from "react";
import {
  Bell, Briefcase, Check, ClipboardList, Database, FileSignature, FileText, Flag, GitBranch, HardDrive, Lock,
  MailPlus, MessageSquare, Send, UserPlus, AlertOctagon,
} from "lucide-react";
import { kindMeta, type KindIcon } from "@/lib/notificationKinds";

export type IconComponent = React.ComponentType<{ className?: string }>;

/** KIND_META's icon names, as components. `satisfies` makes a new KindIcon
 *  name a type error here until it is drawn. */
export const KIND_ICON_COMPONENTS = {
  MessageSquare, FileText, UserPlus, MailPlus, AlertOctagon, Lock, GitBranch,
  FileSignature, Check, Briefcase, Bell, Send, HardDrive, Database, Flag,
} as const satisfies Record<KindIcon, IconComponent>;

/** The icon for a feed item's kind: a ticket row is a clipboard (it is not a
 *  notification kind); a kind no union declares any more (a legacy row) is
 *  the plain bell, where it fell before. */
export function iconForKind(kind: string): IconComponent {
  if (kind === "ticket") return ClipboardList;
  const meta = kindMeta(kind);
  return meta ? KIND_ICON_COMPONENTS[meta.icon] : Bell;
}
