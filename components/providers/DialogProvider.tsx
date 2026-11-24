"use client";

// DialogProvider — async drop-in replacements for the browser's
// alert()/confirm()/prompt(), which the app used in ~90 places. The
// imperative API keeps call sites one-liners:
//
//   if (!(await appConfirm("Release this hold?"))) return;
//   const name = await appPrompt({ title: "Rename folder", defaultValue: cur });
//   await appAlert({ title: "Export failed", message: err.message, tone: "danger" });
//
// <DialogHost/> is mounted once in the protected layout. If a dialog is
// requested before the host mounts (or outside it), we fall back to the
// native dialog so callers never hang.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, HelpCircle, Info, X } from "lucide-react";
import { readDraft, clearDraft } from "@/hooks/useDraft";
import { Modal, ModalFooter } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { controlClass } from "@/components/ui/Field";

type Tone = "default" | "danger";

interface BaseOpts {
  title?: string;
  message?: React.ReactNode;
  tone?: Tone;
  confirmLabel?: string;
  cancelLabel?: string;
}
export interface PromptOpts extends BaseOpts {
  placeholder?: string;
  defaultValue?: string;
}

type Request = { id: number } & (
  | (BaseOpts & { kind: "alert"; resolve: (v: void) => void })
  | (BaseOpts & { kind: "confirm"; resolve: (v: boolean) => void })
  | (PromptOpts & { kind: "prompt"; resolve: (v: string | null) => void })
);

let nextId = 1;

let enqueue: ((r: Request) => void) | null = null;

const norm = (o: string | BaseOpts): BaseOpts => (typeof o === "string" ? { message: o } : o);

export function appAlert(opts: string | BaseOpts): Promise<void> {
  const o = norm(opts);
  if (!enqueue) {
    window.alert([o.title, typeof o.message === "string" ? o.message : ""].filter(Boolean).join("\n"));
    return Promise.resolve();
  }
  return new Promise((resolve) => enqueue!({ ...o, id: nextId++, kind: "alert", resolve }));
}

export function appConfirm(opts: string | BaseOpts): Promise<boolean> {
  const o = norm(opts);
  if (!enqueue) {
    return Promise.resolve(
      window.confirm([o.title, typeof o.message === "string" ? o.message : ""].filter(Boolean).join("\n"))
    );
  }
  return new Promise((resolve) => enqueue!({ ...o, id: nextId++, kind: "confirm", resolve }));
}

export function appPrompt(opts: string | PromptOpts): Promise<string | null> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  if (!enqueue) {
    return Promise.resolve(window.prompt(typeof o.message === "string" ? o.message : o.title || "", o.defaultValue));
  }
  return new Promise((resolve) => enqueue!({ ...o, id: nextId++, kind: "prompt", resolve }));
}

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const current = queue[0] ?? null;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r]);
    return () => {
      enqueue = null;
    };
  }, []);

  // A reason typed into a prompt survives a reload or leaving the page
  // (not when the prompt edits an existing value). Cleared once answered.
  const draftKey = current && current.kind === "prompt" && !current.defaultValue
    ? `prompt:${current.title ?? ""}|${typeof current.message === "string" ? current.message : ""}|${current.placeholder ?? ""}`
    : null;
  const settle = useCallback(
    (value: boolean | string | null) => {
      if (!current) return;
      if (draftKey) clearDraft(draftKey);
      if (current.kind === "alert") current.resolve();
      else if (current.kind === "confirm") current.resolve(value === true);
      else current.resolve(typeof value === "string" ? value : null);
      setQueue((q) => q.slice(1));
    },
    [current, draftKey]
  );

  if (!current) return null;

  const danger = current.tone === "danger";
  const Icon = current.kind === "alert" ? (danger ? AlertTriangle : Info) : danger ? AlertTriangle : HelpCircle;
  const cancel = () => settle(current.kind === "confirm" ? false : null);

  return (
    <Modal onClose={cancel} size="sm" zIndex={700}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          settle(current.kind === "prompt" ? (inputRef.current?.value ?? "") : true);
        }}
        className="relative p-5"
      >
        <button type="button" onClick={cancel} aria-label="Close"
          className="absolute top-3 right-3 p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-start gap-3 pr-6">
          {/* A plain icon, no tile: red only when the action can't be undone. */}
          <Icon aria-hidden className={`w-5 h-5 mt-0.5 shrink-0 ${danger ? "text-[var(--state-overdue)]" : "text-[var(--color-text-muted)]"}`} />
          <div className="min-w-0 flex-1">
            {current.title && <h2 className="text-reading leading-6 font-medium text-[var(--color-text)]">{current.title}</h2>}
            {current.message && (
              <div className={`text-body leading-5 text-[var(--color-text-muted)] ${current.title ? "mt-1" : ""}`}>
                {current.message}
              </div>
            )}
            {current.kind === "prompt" && (
              <input
                key={current.id}
                ref={inputRef}
                autoFocus
                defaultValue={(draftKey && readDraft<string>(draftKey)) || current.defaultValue}
                onInput={(e) => {
                  if (!draftKey) return;
                  const v = (e.target as HTMLInputElement).value;
                  try { if (v.trim()) localStorage.setItem(`draft:${draftKey}`, JSON.stringify(v)); else clearDraft(draftKey); } catch { /* private mode */ }
                }}
                placeholder={current.placeholder}
                className={`mt-3 ${controlClass}`}
              />
            )}
          </div>
        </div>
        <ModalFooter className="-mx-5 -mb-5 mt-5">
          {current.kind !== "alert" && (
            <Button type="button" variant="secondary" onClick={cancel}>
              {current.cancelLabel ?? "Cancel"}
            </Button>
          )}
          <Button type="submit" variant={danger ? "danger" : "primary"} autoFocus={current.kind !== "prompt"}>
            {current.confirmLabel ?? (current.kind === "alert" ? "OK" : "Confirm")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
