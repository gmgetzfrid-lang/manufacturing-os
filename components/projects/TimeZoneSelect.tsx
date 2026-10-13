"use client";

// TimeZoneSelect — pick the plant's IANA zone. Lists every zone the
// browser knows, shows the current short name ("CDT") beside the pick so
// a wrong choice is obvious, and offers a one-click "use this device's
// zone" for the common case of setting it up from the plant.

import React, { useMemo } from "react";
import { MapPin } from "lucide-react";
import { browserTimeZone, listTimeZones, tzAbbrev } from "@/lib/scheduleTz";

export default function TimeZoneSelect({ value, onChange, className, disabled }: {
  value: string;
  onChange: (tz: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  const zones = useMemo(() => {
    const list = listTimeZones();
    return value && !list.includes(value) ? [value, ...list] : list;
  }, [value]);
  const device = useMemo(() => browserTimeZone(), []);
  const abbr = value ? tzAbbrev(value) : "";

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="flex-1 min-w-0 h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none disabled:opacity-50"
      >
        {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
      </select>
      {abbr && abbr !== value && (
        <span className="shrink-0 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Current short name for this zone">{abbr}</span>
      )}
      {device !== value && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(device)}
          title={`Use this device's zone: ${device}`}
          className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-accent)] hover:underline disabled:opacity-50"
        >
          <MapPin className="w-3 h-3" /> Use mine
        </button>
      )}
    </div>
  );
}
