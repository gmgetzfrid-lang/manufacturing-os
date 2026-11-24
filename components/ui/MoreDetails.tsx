"use client";

// MoreDetails: the optional part of a form, folded. A form shows only what
// it needs to save (about 3 fields, design rule W1); everything optional
// sits behind one line that says how much is there and what is already
// filled, so nothing is hidden and nothing is asked up front. Opens by
// itself when any of it already holds a value.

import React, { useState } from "react";
import { ChevronRight } from "lucide-react";

export function MoreDetails({ label = "More details", filled = 0, total, children, defaultOpen }: {
  label?: string;
  /** How many of the folded fields already hold a value. */
  filled?: number;
  /** How many fields are folded. */
  total?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? filled > 0);
  const count = total != null ? (filled ? `${filled} of ${total} filled` : `${total} optional`) : filled ? `${filled} filled` : "optional";
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="inline-flex items-center gap-1.5 min-h-10 pointer-coarse:min-h-11 -ml-1 px-1 rounded-md text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
        <ChevronRight aria-hidden className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-90" : ""}`} />
        {label}
        <span className="font-normal text-[var(--color-text-muted)]">· {count}</span>
      </button>
      {open && <div className="mt-2 space-y-4 ui-reveal">{children}</div>}
    </div>
  );
}

export default MoreDetails;
