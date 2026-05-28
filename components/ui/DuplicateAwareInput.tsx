"use client";

// DuplicateAwareInput — text input that debounces the value, queries
// the DB for an existing row matching it, and renders a subtle
// in-line indicator: empty → no badge, checking → spinner, available
// → small green check, duplicate → amber warning with "Edit existing"
// deep-link if the caller provides one.
//
// Designed for form fields that must be unique in some scope
// (asset.tag, plant.code, unit.code, document.document_number, etc.).
// Catches typos BEFORE the user hits Submit, instead of letting a
// 23505 unique-constraint error blow up.

import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, Loader2, ExternalLink } from "lucide-react";
import { checkForDuplicate, type DuplicateCheckParams } from "@/lib/inputValidation";

interface DuplicateAwareInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  value: string;
  onChange: (v: string) => void;
  /** When duplicates change state, this fires with the new conflict.
   *  Callers should disable Submit when isDuplicate is true. */
  onDuplicateChange?: (isDuplicate: boolean, existingId?: string) => void;
  /** Duplicate-check configuration. */
  check: Omit<DuplicateCheckParams, "value">;
  /** When duplicate is found, render a small "Edit existing" link
   *  the caller wires to its own router. */
  onEditExisting?: (existingId: string) => void;
  /** Debounce delay in ms. Default 300. */
  debounceMs?: number;
  /** Minimum length before the check fires. Default 2. */
  minLength?: number;
  /** Optional label for the conflict message. Defaults to "value". */
  fieldLabel?: string;
}

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "duplicate"; existingId?: string };

export default function DuplicateAwareInput({
  value, onChange, onDuplicateChange, check, onEditExisting,
  debounceMs = 300, minLength = 2, fieldLabel = "value",
  className = "", ...inputProps
}: DuplicateAwareInputProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  // Track the last-fired duplicate state so we don't spam onDuplicateChange
  // when only the value changes but the duplicate status doesn't.
  const lastReportedRef = useRef<boolean>(false);

  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length < minLength) {
      setState({ kind: "idle" });
      if (lastReportedRef.current) { onDuplicateChange?.(false); lastReportedRef.current = false; }
      return;
    }

    let alive = true;
    setState({ kind: "checking" });
    const handle = window.setTimeout(async () => {
      try {
        const r = await checkForDuplicate({ ...check, value: trimmed });
        if (!alive) return;
        if (r.isDuplicate) {
          setState({ kind: "duplicate", existingId: r.existingId });
          if (!lastReportedRef.current) { onDuplicateChange?.(true, r.existingId); lastReportedRef.current = true; }
        } else {
          setState({ kind: "available" });
          if (lastReportedRef.current) { onDuplicateChange?.(false); lastReportedRef.current = false; }
        }
      } catch {
        // On error, treat as idle (don't block the user from submitting;
        // the DB still has the constraint as a backstop).
        if (alive) setState({ kind: "idle" });
      }
    }, debounceMs);

    return () => { alive = false; window.clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, debounceMs, minLength, check.table, check.column, JSON.stringify(check.scope), check.excludeId]);

  // Visual state
  const borderClass =
    state.kind === "duplicate" ? "border-amber-400 ring-1 ring-amber-300/40" :
    state.kind === "available" ? "border-emerald-300" :
                                 "border-slate-300";

  return (
    <div className="space-y-1">
      <div className="relative">
        <input
          {...inputProps}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full pr-8 px-2.5 py-1.5 text-sm border ${borderClass} rounded focus:outline-none focus:ring-1 focus:ring-blue-500 ${className}`}
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
          {state.kind === "checking" && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
          {state.kind === "available" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
          {state.kind === "duplicate" && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
        </span>
      </div>
      {state.kind === "duplicate" && (
        <div className="text-[11px] text-amber-700 flex items-center gap-2">
          <span>A {fieldLabel} matching <b className="font-mono">{value.trim()}</b> already exists.</span>
          {onEditExisting && state.existingId && (
            <button
              type="button"
              onClick={() => onEditExisting(state.existingId!)}
              className="inline-flex items-center gap-1 underline hover:no-underline"
            >
              Edit existing <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
