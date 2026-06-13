"use client";

// MentionableTextarea — drop-in textarea with @ autocomplete.
//
// When the user types "@", a floating list of org members appears. Picking
// one inserts the canonical `@[Name](uid)` token into the textarea (so the
// renderer can resolve mentions even if display names change later).
//
// Plain text is stored as-is in `value`. The parent reads `value` and the
// optional `mentionedUids` from onChange.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AtSign } from "lucide-react";
import { searchOrgUsers, extractMentionUids, type OrgUser } from "@/lib/notifications";
import { Textarea } from "@/components/ui/Field";

interface MentionableTextareaProps {
  value: string;
  onChange: (next: string, mentionedUids: string[]) => void;
  orgId: string;
  placeholder?: string;
  rows?: number;
  className?: string;
  disabled?: boolean;
  /** Optional id for the wrapping textarea (forwarded for label-htmlFor). */
  id?: string;
  autoFocus?: boolean;
}

export default function MentionableTextarea({
  value, onChange, orgId, placeholder, rows = 3, className, disabled, id, autoFocus,
}: MentionableTextareaProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [anchorOffset, setAnchorOffset] = useState<number>(0);  // caret position of the "@"

  // Look up users when the query changes
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      const list = await searchOrgUsers(orgId, query, 6);
      if (alive) {
        setUsers(list);
        setActiveIdx(0);
      }
    })();
    return () => { alive = false; };
  }, [open, query, orgId]);

  // Detect @… typing
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const caret = e.target.selectionStart ?? next.length;

    // Walk backwards from the caret looking for an @ that isn't preceded by
    // a word char (so emails like foo@bar.com don't trigger).
    let atIdx = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = next[i];
      if (ch === "@") {
        const prev = i === 0 ? " " : next[i - 1];
        if (/\s|[(,;]/.test(prev) || i === 0) atIdx = i;
        break;
      }
      if (/\s/.test(ch)) break;            // hit a space, no active mention
      if (ch === "[" || ch === "(" ) break; // inside an existing token
    }

    if (atIdx >= 0) {
      const after = next.slice(atIdx + 1, caret);
      // Only keep open if the @ run is short and contains no closing bracket
      if (!/[\]\)]/.test(after) && after.length < 32) {
        setQuery(after);
        setAnchorOffset(atIdx);
        setOpen(true);
      } else {
        setOpen(false);
      }
    } else {
      setOpen(false);
    }

    onChange(next, extractMentionUids(next));
  }, [onChange]);

  const insertMention = (user: OrgUser) => {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? value.length;
    const before = value.slice(0, anchorOffset);
    const after = value.slice(caret);
    const token = `@[${user.name}](${user.uid}) `;
    const next = before + token + after;
    onChange(next, extractMentionUids(next));
    setOpen(false);
    // Place caret after the inserted token
    requestAnimationFrame(() => {
      if (!ta) return;
      const newCaret = (before + token).length;
      ta.focus();
      ta.setSelectionRange(newCaret, newCaret);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || users.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % users.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + users.length) % users.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertMention(users[activeIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className={`relative ${className ?? ""}`}>
      <Textarea
        id={id}
        ref={taRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 150)}   // delay so click registers
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        className="resize-y"
      />
      <div className="absolute right-2 bottom-2 text-[10px] text-slate-400 flex items-center gap-1 pointer-events-none">
        <AtSign className="w-3 h-3" /> type @ to mention
      </div>

      {open && users.length > 0 && (
        <div className="absolute z-[300] mt-1 w-full max-w-xs bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
          <div className="px-3 py-1.5 text-[10px] font-black text-slate-500 uppercase tracking-widest bg-slate-50 border-b border-slate-200">
            Mention a user
          </div>
          <div className="max-h-60 overflow-y-auto divide-y divide-slate-100">
            {users.map((u, idx) => (
              <button
                key={u.uid}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => insertMention(u)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${idx === activeIdx ? "bg-[var(--color-accent-soft)]" : "hover:bg-slate-50"}`}
              >
                <span className="text-xs font-bold text-slate-900 truncate">{u.name}</span>
                <span className="text-[10px] text-slate-400 truncate flex-1">{u.email}</span>
                <span className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded shrink-0">{u.role}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
