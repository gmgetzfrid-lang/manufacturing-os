"use client";

// How to record the clips.
//
// Capture quality decides whether reconstruction works at all — far more than
// any parameter in the pipeline. Almost every failure traced back to filming:
// walking too fast, panning from one spot instead of moving through the space,
// or clips that never overlap. So the guidance lives inside the app, next to the
// button, rather than in a README nobody opens.

import React from "react";
import { Camera, Check, Route, X } from "lucide-react";

const SHOTS = [
  {
    id: "A",
    title: "Main walkthrough",
    body:
      "Start several feet away from the main object. Walk slowly toward it, then all the way " +
      "around one side. Capture its front, its sides, and plenty of the room around it.",
  },
  {
    id: "B",
    title: "The opposite side",
    body:
      "Start somewhere else and walk around the other side of the same object, covering what " +
      "clip A could not see. Make sure a good part of what you film also appeared in clip A.",
  },
  {
    id: "C",
    title: "Corridor → room",
    body:
      "Start well down the hallway and walk slowly toward the room, continuing all the way to " +
      "the main object. This is the clip that ties the two areas into one space — do not skip it.",
  },
  {
    id: "D",
    title: "Room → corridor",
    body:
      "Start near the main object and walk back out down the hallway. This should retrace clip C " +
      "closely, which gives the reconstruction two independent looks at the same route.",
  },
  {
    id: "E",
    title: "Detail pass",
    body:
      "Walk around the main object again at a different height — lower or higher than before. " +
      "Capture cushions, seams, edges, nearby furniture, lamps, doors, and wall features.",
  },
];

const RULES = [
  "Walk slowly — roughly half your normal pace.",
  "Keep the camera steady and pointed mostly forward.",
  "Move through the space; do not just stand and pan.",
  "Avoid rapid turns — sweep gently when you change direction.",
  "Keep the lighting the same across every clip.",
  "Do not move furniture between clips.",
  "Keep other people out of the shot.",
  "Do not use digital zoom.",
  "Record at the highest quality your phone offers.",
  "Overlap generously — every clip should revisit areas another one covered.",
  "Film each important object from several angles.",
  "Include the surrounding walls and floor for spatial context.",
];

export default function CaptureGuide({ onClose }: { onClose?: () => void }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)]">
            <Camera className="h-4 w-4 text-sky-600" /> How to record the clips
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Five clips, roughly one to two minutes each. How you film matters far more than any
            setting in this tool.
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
            aria-label="Close capture guide"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {SHOTS.map((shot) => (
          <div
            key={shot.id}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-sky-600 text-[11px] font-black text-white">
                {shot.id}
              </span>
              <span className="text-xs font-black text-[var(--color-text)]">{shot.title}</span>
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">{shot.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-black text-[var(--color-text)]">
          <Check className="h-3.5 w-3.5 text-emerald-600" /> While filming
        </div>
        <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {RULES.map((rule) => (
            <li
              key={rule}
              className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]"
            >
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--color-text-faint)]" />
              {rule}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-xl border border-sky-300 bg-sky-50 px-3 py-2.5 dark:border-sky-900 dark:bg-sky-950/30">
        <Route className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600" />
        <div className="text-[11px] leading-relaxed text-sky-900 dark:text-sky-200">
          <b className="font-black">The single most common failure</b> is clips that never overlap.
          Reconstruction can only join two clips if it can recognise the same surfaces in both, so
          walk the same route more than once and let each clip cover ground the others already did.
        </div>
      </div>

      <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/30">
        <Camera className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
        <div className="text-[11px] leading-relaxed text-amber-900 dark:text-amber-200">
          <b className="font-black">iPhone users:</b> set Settings → Camera → Formats → Most
          Compatible before recording. The default &ldquo;High Efficiency&rdquo; HEVC format cannot
          be decoded by every browser, and there is no way to work around that from a web page.
        </div>
      </div>
    </div>
  );
}
