"use client";

// "Your day, easier" — the section that sells to a PERSON, not a checklist.
// Prospects pick their own job and see three before→after moments from a
// normal working day. Deliberately facility-agnostic: the pain is the same
// whether the site runs crude, cereal, or cement.

import React, { useState } from "react";
import {
  FolderKanban, HardHat, Wrench, LineChart, ArrowRight, XCircle, CheckCircle2,
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
        after: "One current revision per document. Superseded copies are marked, stamped — and recalled from everyone who downloaded them.",
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
        after: "Approval physically routes through a qualified engineer. The workflow enforces it — there is no way around.",
      },
      {
        before: "Which drawings, equipment, and open tickets does this change actually touch?",
        after: "Open the impact panel or the site graph — everything wired to that tag, on one screen, before you commit.",
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
        after: "Tap the equipment tag wherever it appears — date-stamped photo gallery, linked drawings, current status.",
      },
      {
        before: "Is the drawing in your hand still current? Honestly, who knows.",
        after: "Scan the QR stamped on the print. Your phone answers: current, or superseded — instantly, no login needed.",
      },
      {
        before: "The job's paperwork is a folder of loose printouts assembled by hand.",
        after: "Work packages bundle every document for the job — and acknowledged distribution proves who received what, when.",
      },
    ],
  },
  {
    key: "biz",
    label: "Leadership & quality",
    icon: <LineChart className="w-4 h-4" />,
    intro: "The state of the program at a glance — and leverage that stays with you.",
    moments: [
      {
        before: "“Are we audit-ready?” The honest answer is that nobody knows until the audit.",
        after: "Live dashboards: past-due requests, unacknowledged distributions, the protection record — visible every day, not once a year.",
      },
      {
        before: "The vendor doubles the price at renewal and your data is hostage in their format.",
        after: "Three self-serve exit paths. Your entire dataset in standard formats, one click, any time. The leverage is yours.",
      },
      {
        before: "Contractor onboarding is weeks of IT tickets and over-broad access.",
        after: "Scoped project membership and a tokened intake portal — external teams submit work without ever seeing the rest of your library.",
      },
    ],
  },
];

export function RoleDayTabs() {
  const [active, setActive] = useState(ROLES[0].key);
  const role = ROLES.find((r) => r.key === active) ?? ROLES[0];
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-6">
        {ROLES.map((r) => (
          <button key={r.key} type="button" onClick={() => setActive(r.key)}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-black border transition-all ${
              r.key === active
                ? "bg-slate-900 text-white border-slate-900 shadow-lg scale-[1.02]"
                : "bg-white text-slate-700 border-slate-200 hover:border-slate-400"
            }`}>
            {r.icon} {r.label}
          </button>
        ))}
      </div>
      <p key={`intro-${role.key}`} className="text-sm font-bold text-slate-500 mb-5"
        style={{ animation: "rise 0.4s var(--ease-fluid) both" }}>
        {role.intro}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {role.moments.map((m, i) => (
          <div key={`${role.key}-${i}`}
            className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm"
            style={{ animation: `rise 0.5s var(--ease-fluid) ${i * 90}ms both` }}>
            <div className="p-4 bg-slate-50 border-b border-slate-200">
              <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-red-600 mb-1.5">
                <XCircle className="w-3.5 h-3.5" /> Before
              </div>
              <p className="text-[13px] text-slate-600 leading-relaxed">{m.before}</p>
            </div>
            <div className="p-4">
              <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-emerald-700 mb-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> After <ArrowRight className="w-3 h-3" />
              </div>
              <p className="text-[13px] text-slate-800 font-medium leading-relaxed">{m.after}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
