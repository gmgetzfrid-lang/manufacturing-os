// components/chat/shared.ts — small things every chat component agrees on.

import { BookOpen, Bot, Globe } from "lucide-react";
import type { ChatScope } from "@/lib/chatClient";

export const SCOPE_META: Record<ChatScope, {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Short line under the composer placeholder. */
  hint: string;
  placeholder: string;
}> = {
  library: {
    label: "Library",
    icon: BookOpen,
    hint: "Answers come only from the indexed documents, cited to the page.",
    placeholder: 'Ask the library - e.g. "What is the minimum hydrotest pressure for Class 300 piping?"',
  },
  tools: {
    label: "System tools",
    icon: Bot,
    hint: "Asks the system, not the internet - looks up documents, equipment, audit history; writes are proposed, never done on its own.",
    placeholder: 'Ask the system - e.g. "What documents mention E-101?" or "What connects P-101 to T-201?"',
  },
  internet: {
    label: "Internet",
    icon: Globe,
    hint: "Answers come from the internet / general knowledge - not your controlled documents.",
    placeholder: 'Ask the web - e.g. "What is the latest edition of API 653 and what changed?"',
  },
};

export const EXAMPLES: Record<ChatScope, string[]> = {
  library: [
    "What is the minimum hydrotest pressure for Class 300 piping?",
    "Which bolting torque applies to a 24\" Class 150 flange?",
    "What inspection interval does API 510 require for this vessel class?",
  ],
  tools: [
    "What documents mention E-101?",
    "Do we have any standards about pipe supports?",
    "What connects P-101 to T-201?",
    "Where did I store the tank inspection procedure?",
  ],
  internet: [
    "What is the latest edition of API 653 and what changed?",
    "Typical allowable stress for SA-516 Gr 70 at 400°F?",
  ],
};

/** "2m", "3h", "Tue", "Oct 3" — rail-sized relative time. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return new Date(iso).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
