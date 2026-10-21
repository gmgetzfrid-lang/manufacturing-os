"use client";

// LikeInKindField — the request form's two optional questions (drafting-flow
// DF-P6):
//
//   * The like-in-kind declaration (GAP-110, DEC-33, DEC-34): ONE optional
//     sentence the requester composes — what is being replaced with what. Not
//     a checkbox, not a picker, no canned text. Blank is the safe answer and
//     says so on the form: the request goes to engineering. Filled, it is
//     signed (an e-signature ceremony at submit) and becomes the record that
//     removes the engineering requirement — immutable once filed.
//   * The equipment the request names (intelligence GAP-312 / WIRE-7
//     criterion 1): tags, resolved against the equipment registry at submit
//     (lib/search.ts lookupTag — the ⌘K lookup, no AI call); a tag the
//     registry does not know is kept as typed and flagged. Never required.

import React from "react";
import { ShieldCheck, Wrench } from "lucide-react";
import { DECLARATION_BLANK_NOTE, LIKE_IN_KIND_MIN_CHARS, LIKE_IN_KIND_MAX_CHARS } from "@/lib/reviewModel";

/** Split what the requester typed into tags (commas, semicolons, new
 *  lines), trimmed, de-duplicated case-insensitively, at most `max`. Pure. */
export function parseEquipmentTags(raw: string, max = 25): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\n]+/)) {
    const t = part.trim();
    if (!t || t.length > 80) continue;
    const k = t.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export default function LikeInKindField({
  declaration, onDeclarationChange, equipment, onEquipmentChange, disabled,
}: {
  declaration: string;
  onDeclarationChange: (v: string) => void;
  equipment: string;
  onEquipmentChange: (v: string) => void;
  disabled?: boolean;
}) {
  const len = declaration.trim().length;
  return (
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 shadow-sm space-y-5">
      <div>
        <label htmlFor="request-declaration" className="flex items-center text-sm font-bold text-[var(--color-text)] mb-1">
          <ShieldCheck className="w-4 h-4 mr-2 text-emerald-600" />
          Like-in-kind declaration <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">(optional)</span>
        </label>
        <p className="text-xs text-[var(--color-text-muted)] mb-2">
          Only if you are putting back exactly what was there — already engineered, the same thing replaced. Say in your own words what is being replaced with what. You will sign it, and it stays on the request. <span className="font-semibold">{DECLARATION_BLANK_NOTE}</span>
        </p>
        <textarea
          id="request-declaration"
          data-testid="request-declaration"
          className="w-full p-3 h-20 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none resize-none text-sm"
          placeholder="e.g. Replacing the 6&quot; spiral-wound gasket on the P-101 discharge flange with an identical gasket — same size, rating and material."
          value={declaration}
          maxLength={LIKE_IN_KIND_MAX_CHARS}
          onChange={(e) => onDeclarationChange(e.target.value)}
          disabled={disabled}
        />
        {len > 0 && len < LIKE_IN_KIND_MIN_CHARS && (
          <p className="mt-1 text-[11px] text-amber-700">At least {LIKE_IN_KIND_MIN_CHARS} characters — what is being replaced with what. Or leave it blank.</p>
        )}
      </div>
      <div>
        <label htmlFor="request-equipment" className="flex items-center text-sm font-bold text-[var(--color-text)] mb-1">
          <Wrench className="w-4 h-4 mr-2 text-orange-500" />
          Equipment <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">(optional)</span>
        </label>
        <p className="text-xs text-[var(--color-text-muted)] mb-2">Equipment tags this work is on, separated by commas. The request will show the drawings each one appears on.</p>
        <input
          id="request-equipment"
          data-testid="request-equipment"
          className="w-full p-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-orange-500 outline-none text-sm"
          placeholder="e.g. P-101, FV-2201"
          value={equipment}
          onChange={(e) => onEquipmentChange(e.target.value)}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
