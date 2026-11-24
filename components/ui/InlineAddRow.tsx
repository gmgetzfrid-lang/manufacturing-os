"use client";

// InlineAddRow: add a line the way you would in a spreadsheet. A few boxes
// in one row under the list, each with its name above it, Enter
// adds it and the row is ready for the next one. Rows copied from Excel
// and pasted into the first box are added all at once. Anything else about
// the line is filled in later, on the line itself (design rules W1, F12).
//
// Only the boxes marked `required` must be filled; the rest can stay
// blank. A miss says which box and keeps everything typed (V2, V5).

import React, { useId, useRef, useState } from "react";
import { Plus, Check } from "lucide-react";
import { controlClass } from "@/components/ui/Field";
import { useDraft } from "@/hooks/useDraft";

export interface AddField {
  key: string;
  /** The box's name, shown above it, and the example when the box is
   *  empty and no placeholder is given. */
  label: string;
  placeholder?: string;
  /** "select": a pick from `options` (no typing); "date": the calendar
   *  opens on a click anywhere in the box. */
  type?: "text" | "date" | "number" | "select";
  /** The choices of a select; the first is what a blank box means. */
  options?: Array<{ value: string; label: string }>;
  /** Tailwind width for the box on wide screens ("w-28", "flex-1"). */
  width?: string;
  /** Suggestions while typing (work orders, people, units). */
  list?: string[];
  required?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}

/** What a save or paste says back: a plain string is a problem to fix;
 *  `{ ok: true, text }` is a result to confirm ("Added 12, skipped the
 *  header row"). */
export type AddResult = void | string | { ok: boolean; text: string };

export function InlineAddRow({ fields, onAdd, onPasteRows, addLabel = "Add", what = "line", disabled, disabledWhy, draftKey, wrap = false }: {
  /** Many boxes: wrap onto more lines at every width, not one long row. */
  wrap?: boolean;
  fields: AddField[];
  /** Save one line. Throw (or return a message) to keep the boxes as typed. */
  onAdd: (values: Record<string, string>) => Promise<AddResult>;
  /** Lines pasted from a spreadsheet, each split into its cells, in the
   *  order of `fields`. Without it, a paste is plain text. */
  onPasteRows?: (rows: string[][]) => Promise<AddResult>;
  addLabel?: string;
  /** The word for one line in messages ("material", "punch item"). */
  what?: string;
  disabled?: boolean;
  disabledWhy?: string;
  /** Keep what is typed but not yet added across a reload (per person). */
  draftKey?: string | null;
}) {
  const blank = () => Object.fromEntries(fields.map((f) => [f.key, ""]));
  const [v, setV] = useState<Record<string, string>>(blank);
  const draft = useDraft<Record<string, string>>(draftKey ?? null, v, setV, (x) => !Object.values(x).some((y) => y?.trim()));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const id = useId();

  const missing = fields.find((f) => f.required && !v[f.key]?.trim());
  const add = async () => {
    if (busy || disabled) return;
    if (missing) { setNote({ ok: false, text: `Type the ${missing.label.toLowerCase()} to add it.` }); return; }
    setBusy(true); setNote(null);
    try {
      const msg = await onAdd(Object.fromEntries(fields.map((f) => [f.key, v[f.key]?.trim() ?? ""])));
      if (typeof msg === "string" && msg) { setNote({ ok: false, text: msg }); return; }
      if (msg && typeof msg === "object" && !msg.ok) { setNote(msg); return; }
      const name = v[fields[0].key]?.trim();
      setV(blank());
      draft.clear();
      setNote(msg && typeof msg === "object" ? msg : { ok: true, text: name ? `Added ${name}.` : `Added the ${what}.` });
      first.current?.focus();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message || `The ${what} wasn't added. Try again.` });
    } finally { setBusy(false); }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (!onPasteRows) return;
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n]/.test(text.trim())) return; // one value: an ordinary paste
    e.preventDefault();
    const rows = text.replace(/\r/g, "").split("\n").map((l) => l.split("\t").map((c) => c.trim())).filter((r) => r.some(Boolean));
    if (!rows.length) return;
    setBusy(true); setNote(null);
    try {
      const msg = await onPasteRows(rows);
      setNote(typeof msg === "string" && msg ? { ok: false, text: msg }
        : msg && typeof msg === "object" ? msg
        : { ok: true, text: `Added ${rows.length} ${what}${rows.length === 1 ? "" : "s"}.` });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message || "The pasted lines weren't added. Try again." });
    } finally { setBusy(false); }
  };

  return (
    <div>
      <form
        onSubmit={(e) => { e.preventDefault(); void add(); }}
        className={`flex flex-wrap ${wrap ? "gap-x-2 gap-y-3" : "sm:flex-nowrap gap-2"} items-end`}
        aria-label={`Add a ${what}`}
      >
        {fields.map((f, i) => (
          <label key={f.key} className={`flex flex-col gap-1 min-w-0 ${f.width ?? (i === 0 ? "flex-1 min-w-[12rem]" : "w-full sm:w-36")}`}>
            {/* The box's name stays in sight while typing (rule F2). */}
            <span className="text-body font-medium text-[var(--color-text-muted)] truncate">{f.label}{f.required ? "" : <span className="font-normal"> (optional)</span>}</span>
            {f.type === "select" ? (
              <select
                value={v[f.key] ?? ""}
                disabled={disabled || busy}
                onChange={(e) => { setV((o) => ({ ...o, [f.key]: e.target.value })); if (note && !note.ok) setNote(null); }}
                className={controlClass}
              >
                {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                ref={i === 0 ? first : undefined}
                type={f.type === "number" ? "text" : f.type ?? "text"}
                inputMode={f.inputMode ?? (f.type === "number" ? "decimal" : undefined)}
                enterKeyHint={i === fields.length - 1 ? "done" : "next"}
                list={f.list?.length ? `${id}-${f.key}` : undefined}
                value={v[f.key] ?? ""}
                placeholder={f.placeholder ?? f.label}
                disabled={disabled || busy}
                onChange={(e) => { setV((o) => ({ ...o, [f.key]: e.target.value })); if (note && !note.ok) setNote(null); }}
                onPaste={i === 0 ? onPaste : undefined}
                // The calendar on a click anywhere in a date box, not only its icon.
                onClick={f.type === "date" ? (e) => { try { (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); } catch { /* the browser's own way */ } } : undefined}
                className={controlClass}
              />
            )}
            {f.list?.length ? <datalist id={`${id}-${f.key}`}>{f.list.map((o) => <option key={o} value={o} />)}</datalist> : null}
          </label>
        ))}
        <button
          type="submit"
          disabled={disabled || busy}
          className="ui-press shrink-0 inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
        >
          <Plus aria-hidden className="w-4 h-4" /> {busy ? "Adding" : addLabel}
        </button>
      </form>
      <p role={note && !note.ok ? "alert" : "status"} className={`min-h-5 mt-1 text-body ${note && !note.ok ? "font-medium text-[var(--state-overdue-text)]" : "text-[var(--color-text-muted)]"}`}>
        {disabled && disabledWhy ? disabledWhy
          : note ? <span className="inline-flex items-center gap-1.5">{note.ok && <Check aria-hidden className="w-4 h-4 text-[var(--state-released)]" />}{note.text}</span>
          : onPasteRows ? "Enter adds it. Rows copied from Excel can be pasted into the first box." : "Enter adds it."}
      </p>
    </div>
  );
}

export default InlineAddRow;
