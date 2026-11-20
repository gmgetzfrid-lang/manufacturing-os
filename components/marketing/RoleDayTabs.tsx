"use client";

// "Your day, easier" — the section that sells to a PERSON, not a checklist.
// Prospects pick their own job and see three before→after moments from a
// normal working day. Deliberately facility-agnostic: the pain is the same
// whether the site runs crude, cereal, or cement.

import React, { useState } from "react";
import {
  FolderKanban, HardHat, Wrench, LineChart, XCircle, CheckCircle2,
} from "lucide-react";

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
        after: "One current revision per document. Superseded copies are marked, stamped - and recalled from everyone who downloaded them.",
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
        after: "Approval physically routes through a qualified engineer. The workflow enforces it - there is no way around.",
      },
      {
        before: "Which drawings, equipment, and open tickets does this change actually touch?",
        after: "Open the impact panel or the site graph - everything wired to that tag, on one screen, before you commit.",
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
        after: "Tap the equipment tag wherever it appears - date-stamped photo gallery, linked drawings, current status.",
      },
      {
        before: "Is the drawing in your hand still current? Honestly, who knows.",
        after: "Scan the QR stamped on the print. Your phone answers: current, or superseded - instantly, no login needed.",
      },
      {
        before: "The job's paperwork is a folder of loose printouts assembled by hand.",
        after: "Work packages bundle every document for the job - and acknowledged distribution proves who received what, when.",
      },
    ],
  },
  {
    key: "biz",
    label: "Leadership & quality",
    icon: <LineChart className="w-4 h-4" />,
    intro: "The state of the program at a glance - and leverage that stays with you.",
    moments: [
      {
        before: "“Are we audit-ready?” The honest answer is that nobody knows until the audit.",
        after: "Live dashboards: past-due requests, unacknowledged distributions, the protection record - visible every day, not once a year.",
      },
      {
        before: "The vendor doubles the price at renewal and your data is hostage in their format.",
        after: "Three self-serve exit paths. Your entire dataset in standard formats, one click, any time. The leverage is yours.",
      },
      {
        before: "Contractor onboarding is weeks of IT tickets and over-broad access.",
        after: "Scoped project membership and a tokened intake portal - external teams submit work without ever seeing the rest of your library.",
      },
    ],
  },
];

export function RoleDayTabs() {
  const [active, setActive] = useState(ROLES[0].key);
  const role = ROLES.find((r) => r.key === active) ?? ROLES[0];
  return (
    <div>
      {/* On a phone the jobs keep going sideways (the last one is cut off,
          so it's plain there's more). */}
      <div className="-mx-4 sm:mx-0 px-4 sm:px-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label="Pick your job"
          className="inline-flex items-center gap-1 p-1 rounded-xl bg-[var(--color-surface)] shadow-[var(--shadow-card)]">
          {ROLES.map((r) => (
            <button key={r.key} type="button" role="tab" aria-selected={r.key === active} onClick={() => setActive(r.key)}
              className={`shrink-0 whitespace-nowrap inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[14px] font-bold transition-colors ${
                r.key === active
                  ? "bg-[var(--color-ink)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}>
              {r.icon} {r.label}
            </button>
          ))}
        </div>
      </div>
      <p key={`intro-${role.key}`} className="mt-6 mb-4 text-[15px] font-bold text-[var(--color-text)]"
        style={{ animation: "rise 0.4s var(--ease-fluid) both" }}>
        {role.intro}
      </p>
      <div role="tabpanel" aria-live="polite" className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {role.moments.map((m, i) => (
          <div key={`${role.key}-${i}`}
            className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden"
            style={{ animation: `rise 0.5s var(--ease-fluid) ${i * 90}ms both` }}>
            <div className="p-5">
              <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-rose-700 dark:text-rose-400 mb-2">
                <XCircle className="w-3.5 h-3.5" /> Before
              </div>
              <p className="text-[14px] text-[var(--color-text-muted)] leading-relaxed">{m.before}</p>
            </div>
            <div className="p-5 border-t border-[var(--color-border)]">
              <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-400 mb-2">
                <CheckCircle2 className="w-3.5 h-3.5" /> After
              </div>
              <p className="text-[14px] text-[var(--color-text)] font-medium leading-relaxed">{m.after}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
