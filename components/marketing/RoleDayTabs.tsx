"use client";

// "Your day, easier" — the section that sells to a PERSON, not a checklist.
// Prospects pick their own job and see three before→after moments from a
// normal working day. Deliberately facility-agnostic: the pain is the same
// whether the site runs crude, cereal, or cement.

import React, { useState } from "react";
import { FolderKanban, HardHat, Wrench, LineChart } from "lucide-react";
import { bandSeg, bandSegItem } from "@/components/admin/band";

type Moment = { before: string; after: string };
type Role = {
  key: string;
  label: string;
  icon: React.ReactNode;
  intro: string;
  moments: Moment[];
};

const ROLES: Role[] = [
  {
    key: "doc",
    label: "Document control",
    icon: <FolderKanban className="w-4 h-4" />,
    intro: "You are the single point of failure for the site's paper trail. Not anymore.",
    moments: [
      {
        before: "Five PDFs named “FINAL_rev3” on the shared drive. Which one is current? Nobody is certain.",
        after: "One current revision per document. Superseded copies are marked, stamped and recalled from everyone who downloaded them.",
      },
      {
        before: "Importing 200 legacy drawings means a week of retyping title blocks into a spreadsheet.",
        after: "Drop the files. Numbers, revs, sheets, and units parse from the filenames, AI reads the title blocks, you confirm one staging grid.",
      },
      {
        before: "The auditor asks who approved Rev 3, and the answer is a phone call to whoever was on shift.",
        after: "Filter the audit log, export the evidence. Every approval, download, and login was already recorded.",
      },
    ],
  },
  {
    key: "eng",
    label: "Engineering",
    icon: <HardHat className="w-4 h-4" />,
    intro: "Less hunting through documents, more engineering.",
    moments: [
      {
        before: "The answer is somewhere in a 400-page standard. There goes the morning.",
        after: "Ask the library in plain language. The answer comes back cited to the exact page, with the highlighted proof one click away.",
      },
      {
        before: "A change went out with a sign-off from someone who wasn't qualified to give it.",
        after: "Approval physically routes through a qualified engineer. The workflow enforces it; there is no way around it.",
      },
      {
        before: "Which drawings, equipment, and open tickets does this change actually touch?",
        after: "Open the impact panel or the site graph: everything wired to that tag, on one screen, before you commit.",
      },
    ],
  },
  {
    key: "ops",
    label: "Operations & maintenance",
    icon: <Wrench className="w-4 h-4" />,
    intro: "The information walks to the equipment, instead of you walking to the office.",
    moments: [
      {
        before: "“What does that vessel even look like?” means a walk across the site to find out.",
        after: "Tap the equipment tag wherever it appears: dated photos, linked drawings, current status.",
      },
      {
        before: "Is the drawing in your hand still current? Honestly, who knows.",
        after: "Scan the QR stamped on the print. Your phone answers current or superseded, with no login.",
      },
      {
        before: "The job's paperwork is a folder of loose printouts assembled by hand.",
        after: "Work packages bundle every document for the job, and acknowledged distribution proves who got what, and when.",
      },
    ],
  },
  {
    key: "biz",
    label: "Leadership & quality",
    icon: <LineChart className="w-4 h-4" />,
    intro: "The state of the program at a glance, and leverage that stays with you.",
    moments: [
      {
        before: "“Are we audit-ready?” The honest answer is that nobody knows until the audit.",
        after: "Live dashboards show past-due requests and unacknowledged distributions every day, not once a year.",
      },
      {
        before: "The vendor doubles the price at renewal and your data is hostage in their format.",
        after: "Three self-serve exit paths. Your entire dataset in standard formats, one click, any time. The leverage is yours.",
      },
      {
        before: "Contractor onboarding is weeks of IT tickets and over-broad access.",
        after: "Scoped project membership and a tokened intake portal: outside teams submit work without seeing the rest of your library.",
      },
    ],
  },
];

export function RoleDayTabs() {
  const [active, setActive] = useState(ROLES[0].key);
  const role = ROLES.find((r) => r.key === active) ?? ROLES[0];
  return (
    <div>
      {/* On a phone the jobs keep going sideways (the strip scrolls). */}
      <div role="tablist" aria-label="Pick your job" className={bandSeg}>
        {ROLES.map((r) => (
          <button key={r.key} type="button" role="tab" aria-selected={r.key === active} onClick={() => setActive(r.key)}
            className={`${bandSegItem(r.key === active)} h-9 px-3.5`}>
            {r.icon} {r.label}
          </button>
        ))}
      </div>
      <p key={`intro-${role.key}`} className="mt-4 mb-2.5 font-display text-section font-semibold text-[var(--color-text)]"
        style={{ animation: "rise 0.35s var(--ease-fluid) both" }}>
        {role.intro}
      </p>
      <div role="tabpanel" aria-live="polite" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        <div className="max-md:hidden grid grid-cols-2 bg-[var(--color-surface-2)] text-body font-medium text-[var(--color-text-muted)]">
          <div className="px-4 sm:px-5 h-10 flex items-center">Before</div>
          <div className="px-4 sm:px-5 h-10 flex items-center border-l border-[var(--color-border)]">With Manufacturing OS</div>
        </div>
        <ul className="divide-y divide-[var(--color-border)]">
          {role.moments.map((m, i) => (
            <li key={`${role.key}-${i}`} className="grid grid-cols-1 md:grid-cols-2"
              style={{ animation: `rise 0.4s var(--ease-fluid) ${i * 60}ms both` }}>
              <div className="px-4 sm:px-5 py-3.5 text-reading leading-snug text-[var(--color-text-muted)]">
                <span className="md:hidden block text-body font-medium mb-0.5">Before</span>
                {m.before}
              </div>
              <div className="px-4 sm:px-5 py-3.5 max-md:pt-0 md:border-l border-[var(--color-border)] text-reading leading-snug text-[var(--color-text)]">
                <span className="md:hidden block text-body font-medium text-[var(--color-text-muted)] mb-0.5">With Manufacturing OS</span>
                {m.after}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
