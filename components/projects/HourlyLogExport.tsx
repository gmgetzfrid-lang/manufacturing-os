"use client";

// HourlyLogExport — the Export button for the hourly shift log: pick the
// file (PDF on the letterhead, Word, Excel), it's made and saved.

import { useState } from "react";
import { Download } from "lucide-react";
import type { LogFormat } from "@/lib/hourlyLogFiles";

const NAMES: Record<LogFormat, string> = { pdf: "PDF", docx: "Word (.docx)", xlsx: "Excel (.xlsx)" };

export function HourlyLogExport({ formats, what, letterhead, onExport, label = "Export" }: {
  formats: LogFormat[];
  /** What's in the file: "Hourly log - Day shift Thu, Oct 29". */
  what: string;
  /** The project has a letterhead (the PDF and Word file go on it). */
  letterhead: boolean;
  /** Makes and saves the file; what to say after. */
  onExport: (f: LogFormat) => Promise<string>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<LogFormat | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const go = async (f: LogFormat) => {
    setOpen(false); setBusy(f); setMsg(null);
    try { setMsg(await onExport(f)); } catch (e) { setMsg(`Not exported: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  return (
    <span className="relative inline-flex">
      <button type="button" onClick={() => { setOpen((v) => !v); setMsg(null); }} aria-expanded={open} disabled={!!busy}
        title="Save the hourly shift log as a file"
        className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-60">
        <Download className="w-3.5 h-3.5" /> {busy ? "Exporting…" : label}
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-[40]" onClick={() => setOpen(false)} aria-hidden />
          <span className="absolute right-0 top-full mt-1 z-[41] w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-1.5 flex flex-col text-[12px]">
            <span className="px-2 pt-1 pb-1.5 text-[11px] text-[var(--color-text-muted)] leading-snug">{what}. Save as:</span>
            {formats.map((f) => (
              <button key={f} type="button" onClick={() => void go(f)} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] font-semibold">
                {NAMES[f]}
                {f !== "xlsx" && letterhead && <span className="ml-1.5 font-normal text-[var(--color-text-muted)]">on the letterhead</span>}
              </button>
            ))}
          </span>
        </>
      )}
      {msg && !open && <span role="status" className="absolute right-0 top-full mt-1 z-[39] whitespace-nowrap rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--color-text-muted)] shadow-sm">{msg}</span>}
    </span>
  );
}
