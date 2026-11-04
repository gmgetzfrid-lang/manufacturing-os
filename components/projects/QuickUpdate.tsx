"use client";

// Update by note - an optional box at the top of the Shift and Work tabs:
// type or say what happened ("E-02 channel head on the ground, they pulled
// it and washed it, staging to put it back. V-1 trays 50."), and the AI
// reads it into step updates (lib/quickUpdate). Nothing saves until every
// line has been checked here: which step, what changes, when, the shift it
// counts for, and your own words beside it. Anything it couldn't work out
// stops the Save until it's answered or left out.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, NotebookPen, Loader2, X, Check, AlertTriangle, Search } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import DateTimePicker from "@/components/projects/DateTimePicker";
import { supabase } from "@/lib/supabase";
import {
  stepCatalog, catalogText, parseReply, toLines, checkLine, saveEvents, defaultTimes, whenWords,
  type CatalogStep, type QuickLine, type RawReply,
} from "@/lib/quickUpdate";
import { saveSheetLine } from "@/lib/shiftSheetSave";
import { searchFilter } from "@/lib/fuzzySearch";
import { shiftAt, previousShift, type ShiftTimes } from "@/lib/shiftReport";
import { fmtInTz, toDateTimeInput, fromDateTimeInput } from "@/lib/scheduleTz";
import type { Milestone } from "@/types/schema";

const HIDE_KEY = "quickUpdate:hidden";
const draftKey = (p: string) => `quickUpdate:draft:${p}`;
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } } };

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

type Rec = { start: () => void; stop: () => void; onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; lang: string; continuous: boolean; interimResults: boolean };
const speechCtor = (): (new () => Rec) | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export default function QuickUpdate({ milestones, tz, times, orgId, projectId, userId, userName, onSaved }: {
  milestones: Milestone[];
  tz: string; times: ShiftTimes;
  orgId: string; projectId: string; userId: string; userName?: string;
  /** After a save: read the schedule again. */
  onSaved: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    setHidden(store.get(HIDE_KEY) === "1");
    const d = store.get(draftKey(projectId));
    if (d) { setNote(d); setOpen(true); }
  }, [projectId]);
  const setDraft = (v: string) => { setNote(v); store.set(draftKey(projectId), v.trim() ? v : null); };

  // ── Speaking ──
  const recRef = useRef<Rec | null>(null);
  const [listening, setListening] = useState(false);
  const canSpeak = typeof window !== "undefined" && !!speechCtor();
  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const C = speechCtor();
    if (!C) return;
    const rec = new C();
    rec.lang = "en-US"; rec.continuous = true; rec.interimResults = false;
    const base = note.trim();
    let said = "";
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += `${said ? " " : ""}${e.results[i][0].transcript.trim()}`;
      setDraft([base, said].filter(Boolean).join(base && !/[.!?]$/.test(base) ? ". " : " "));
    };
    rec.onend = () => { setListening(false); recRef.current = null; };
    rec.onerror = () => { setListening(false); recRef.current = null; };
    recRef.current = rec;
    setListening(true);
    rec.start();
  };
  useEffect(() => () => recRef.current?.stop(), []);

  // ── Reading ──
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [review, setReview] = useState<{ cat: CatalogStep[]; lines: QuickLine[]; unplaced: RawReply["unplaced"]; at: number } | null>(null);
  const read = async () => {
    if (!note.trim()) return;
    recRef.current?.stop();
    setBusy(true); setErr(null);
    const now = Date.now();
    const cat = stepCatalog(milestones);
    const cur = shiftAt(now, tz, times), prev = previousShift(cur, tz, times);
    const sh = (w: typeof cur) => `${fmtInTz(w.start, tz, { weekday: "short", month: "short", day: "numeric" })} ${w.kind} shift (${fmtInTz(w.start, tz, { hour: "numeric", minute: "2-digit", hour12: true })} to ${fmtInTz(w.end, tz, { hour: "numeric", minute: "2-digit", hour12: true })})`;
    try {
      const res = await fetch("/api/projects/quick-update", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ orgId, projectId, note, catalog: catalogText(cat, tz), now, tz, shift: `This shift: ${sh(cur)}. Last shift: ${sh(prev)}.` }),
      });
      const body = (await res.json().catch(() => null)) as (RawReply & { error?: string }) | null;
      if (!res.ok || !body?.updates) throw new Error(body?.error || `Couldn't read it (HTTP ${res.status}). Your note is kept - try again.`);
      const d = defaultTimes({ now, tz, times })[0].at;
      // Cleaned again here: whatever comes back, nothing malformed reaches the lines.
      const { lines, unplaced } = toLines(parseReply(body), cat, d, { now, tz, times });
      setDefaultPick({ id: "now", at: d });
      setReview({ cat, lines, unplaced, at: now });
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  // ── The time for lines with no time said ──
  const [defaultPick, setDefaultPick] = useState<{ id: string; at: number }>({ id: "now", at: 0 });
  const choices = useMemo(() => (review ? defaultTimes({ now: review.at, tz, times }) : []), [review, tz, times]);
  const setDefault = (id: string, at: number) => {
    setDefaultPick({ id, at });
    setReview((r) => (r ? { ...r, lines: r.lines.map((l) => (l.timeFrom === "default" ? { ...l, at } : l)) } : r));
  };
  const edit = (id: string, patch: Partial<QuickLine>) => setReview((r) => (r ? { ...r, lines: r.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) } : r));

  // ── Saving ──
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ saved: number; warn: string[]; failed: string[] } | null>(null);
  const byId = useMemo(() => new Map((review?.cat ?? []).map((c) => [c.id, c])), [review]);
  const checks = useMemo(() => {
    const now = Date.now();
    return new Map((review?.lines ?? []).map((l) => [l.id, checkLine(l, l.stepId ? byId.get(l.stepId) : undefined, now, tz)]));
  }, [review, byId, tz]);
  const included = (review?.lines ?? []).filter((l) => l.include);
  const blocked = included.filter((l) => (checks.get(l.id)?.needs.length ?? 0) > 0);
  const ready = included.filter((l) => !(checks.get(l.id)?.needs.length));
  const save = async () => {
    if (!review || blocked.length) return;
    setSaving(true);
    const events = saveEvents(review.lines, review.cat, Date.now(), tz);
    let saved = 0;
    const warn: string[] = [], failed: string[] = [];
    for (const [id, ev] of events) {
      const name = byId.get(id)?.name ?? "A step";
      try {
        const w = await saveSheetLine(id, ev, { orgId, userId, userName });
        saved++;
        if (w) warn.push(`${name}: ${w}`);
      } catch (e) { failed.push(`${name}: ${(e as Error).message}`); }
    }
    setSaving(false);
    window.dispatchEvent(new Event("milestone-notes:changed"));
    onSaved();
    setDone({ saved, warn, failed });
    if (!failed.length) { setDraft(""); setReview(null); }
  };

  if (hidden) {
    return (
      <div className="flex justify-end">
        <button type="button" onClick={() => { setHidden(false); store.set(HIDE_KEY, null); }} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">
          Show Update by note
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
      {!open ? (
        <div className="flex items-center gap-2 px-3 py-2">
          <button type="button" onClick={() => setOpen(true)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
            <NotebookPen className="w-4 h-4 shrink-0 text-[var(--color-accent)]" />
            <span className="min-w-0">
              <span className="block text-[13px] font-bold text-[var(--color-text)]">Update by note</span>
              <span className="block text-[11.5px] text-[var(--color-text-muted)] truncate">Type or say what happened on the job. You check every line before it saves.</span>
            </span>
          </button>
          <button type="button" onClick={() => { setHidden(true); store.set(HIDE_KEY, "1"); }} className="shrink-0 text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Hide</button>
        </div>
      ) : (
        <div className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <NotebookPen className="w-4 h-4 text-[var(--color-accent)]" />
            <span className="flex-1 text-[13px] font-bold text-[var(--color-text)]">Update by note</span>
            <button type="button" onClick={() => { recRef.current?.stop(); setOpen(false); }} aria-label="Close" className="p-1 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
          </div>
          <textarea value={note} onChange={(e) => setDraft(e.target.value)} rows={4} aria-label="What happened"
            placeholder={"What happened? Name the equipment or WO, like you'd tell your relief.\nE-02 channel head is on the ground, they pulled it and washed it, staging to put it back.\nV-1 trays 50%. V-3 on hold, scaffold not built."}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={toggleMic} disabled={!canSpeak} title={canSpeak ? undefined : "Use the microphone on your phone's keyboard to speak into the box"}
              className={`inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border text-[13px] font-bold disabled:opacity-50 ${listening ? "border-rose-500 bg-rose-600 text-white" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
              {listening ? <><MicOff className="w-4 h-4" /> Stop</> : <><Mic className="w-4 h-4" /> Speak</>}
            </button>
            <button type="button" onClick={() => void read()} disabled={busy || !note.trim()}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Reading…</> : "Read it"}
            </button>
            {note && !busy && <button type="button" onClick={() => setDraft("")} className="text-[12px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Clear</button>}
            {!canSpeak && <span className="text-[11px] text-[var(--color-text-muted)]">To talk, use the mic on your keyboard.</span>}
          </div>
          {listening && <div className="text-[12px] font-semibold text-rose-700 dark:text-rose-300">Listening… say what happened, then tap Stop.</div>}
          {err && <div role="alert" className="text-[12px] font-semibold text-rose-700 dark:text-rose-300">{err}</div>}
          {done && (
            <div role="status" className={`rounded-lg px-3 py-2 text-[12px] ${done.failed.length ? "bg-rose-50 dark:bg-rose-950/40 text-rose-900 dark:text-rose-100" : "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-100"}`}>
              <b>{done.saved ? `Saved ${done.saved} step${done.saved === 1 ? "" : "s"}.` : "Nothing saved."}</b>
              {done.failed.map((f) => <div key={f}>Not saved: {f}</div>)}
              {done.warn.map((w) => <div key={w}>{w}</div>)}
              {done.failed.length > 0 && <div>Your note is kept. Fix the step by hand, or read it again.</div>}
            </div>
          )}
        </div>
      )}

      {review && (
        <Modal onClose={() => !saving && setReview(null)} size="xl" dismissable={!saving}>
          <ModalHeader icon={NotebookPen} title="Check before saving" subtitle="Each line is what your note says, matched to a step. Nothing saves until you tap Save." onClose={saving ? undefined : () => setReview(null)} />
          <ModalBody className="p-0">
            <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-slate-50 dark:bg-[var(--color-surface-2)] text-[12px]">
              <div className="font-bold text-[var(--color-text)]">No time in your note? Those lines go in at:</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {choices.map((c) => (
                  <button key={c.id} type="button" onClick={() => setDefault(c.id, c.at)} aria-pressed={defaultPick.id === c.id}
                    className={`rounded-full border px-2.5 py-1 font-semibold ${defaultPick.id === c.id ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface)]"}`}>
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="mt-2 max-w-sm">
                <DateTimePicker label="Or pick a time" tz={tz} times={times} value={defaultPick.id === "pick" ? toDateTimeInput(defaultPick.at, tz) : ""}
                  onChange={(v) => { const t = Date.parse(fromDateTimeInput(v, tz) ?? ""); if (Number.isFinite(t)) setDefault("pick", t); }} />
              </div>
            </div>
            <ul className="divide-y divide-[var(--color-border)]">
              {review.lines.map((l) => (
                <LineRow key={l.id} l={l} cat={review.cat} step={l.stepId ? byId.get(l.stepId) : undefined} check={checks.get(l.id)!} tz={tz} times={times}
                  defaultLabel={choices.find((c) => c.id === defaultPick.id)?.label ?? "the time picked"} choices={choices} onEdit={(p) => edit(l.id, p)} />
              ))}
              {review.lines.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">Nothing in the note matched a step.</li>}
            </ul>
            {review.unplaced.length > 0 && (
              <div className="px-4 py-3 border-t border-[var(--color-border)] bg-amber-50/60 dark:bg-amber-950/20">
                <div className="text-[12px] font-black uppercase tracking-wider text-amber-900 dark:text-amber-200">Couldn&apos;t place ({review.unplaced.length})</div>
                <ul className="mt-1 space-y-1 text-[12.5px] text-[var(--color-text)]">
                  {review.unplaced.map((u, i) => <li key={i}>“{u.text}” <span className="text-[var(--color-text-muted)]">- {u.why}</span></li>)}
                </ul>
                <div className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">Not saved. Say it again naming the equipment or WO, or update the step by hand.</div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <div className="w-full flex flex-wrap items-center gap-2">
              <span className="mr-auto text-[12.5px]">
                {blocked.length > 0
                  ? <b className="text-rose-700 dark:text-rose-300"><AlertTriangle className="inline w-4 h-4 -mt-0.5" /> Hold on: {blocked.length} line{blocked.length === 1 ? "" : "s"} need{blocked.length === 1 ? "s" : ""} you before anything saves. Answer, or untick.</b>
                  : <b className="text-[var(--color-text)]">{ready.length} line{ready.length === 1 ? "" : "s"} ready</b>}
              </span>
              <button type="button" disabled={saving} onClick={() => setReview(null)} className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Back to the note</button>
              <button type="button" disabled={saving || blocked.length > 0 || ready.length === 0} onClick={() => void save()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-[12.5px] font-bold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
                {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <><Check className="w-4 h-4" /> Save {ready.length}</>}
              </button>
            </div>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}

/** One line: the step, the change, when, and your words; what it needs. */
function LineRow({ l, cat, step, check, tz, times, defaultLabel, choices, onEdit }: {
  l: QuickLine; cat: CatalogStep[]; step: CatalogStep | undefined;
  check: { needs: string[]; nothing?: string; says: string };
  tz: string; times: ShiftTimes; defaultLabel: string;
  choices: Array<{ id: string; at: number; label: string }>;
  onEdit: (p: Partial<QuickLine>) => void;
}) {
  const [find, setFind] = useState("");
  const [changing, setChanging] = useState(false);
  const options = l.options.map((id) => cat.find((c) => c.id === id)).filter((c): c is CatalogStep => !!c);
  const found = find.trim() ? searchFilter(cat, find, (c) => `${c.wo} ${c.place} ${c.name} ${c.crew}`).slice(0, 6) : [];
  const needs = l.include ? check.needs : [];
  const clockOf = (t: number) => fmtInTz(t, tz, { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true });
  const pill = "rounded-full border px-2.5 py-1 text-[12px] font-semibold";
  return (
    <li className={`px-4 py-3 ${needs.length ? "bg-rose-50/60 dark:bg-rose-950/20" : ""} ${l.include ? "" : "opacity-70"}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={l.include} onChange={(e) => onEdit({ include: e.target.checked })} aria-label="Include this line"
          className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-accent)]" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* The step */}
          {step ? (
            <div>
              <div className="text-[11px] font-semibold text-[var(--color-text-muted)] break-words">{[step.wo ? `WO ${step.wo}` : null, step.place].filter(Boolean).join(" · ")}</div>
              <div className="text-[14px] font-bold text-[var(--color-text)] break-words">{step.name}</div>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-[12.5px] font-bold text-rose-800 dark:text-rose-200">Which step is it?</div>
              <div className="flex flex-wrap gap-1.5">
                {options.map((o) => <button key={o.id} type="button" onClick={() => onEdit({ stepId: o.id })} className={`${pill} border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]`}>{o.wo ? `WO ${o.wo} · ` : ""}{o.place ? `${o.place}: ` : ""}{o.name}</button>)}
              </div>
              <label className="relative block max-w-md">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Or find it: V-1, WO #, step" aria-label="Find the step"
                  className="w-full h-8 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] pl-7 pr-2 text-[12.5px]" />
              </label>
              {found.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {found.map((o) => <button key={o.id} type="button" onClick={() => { onEdit({ stepId: o.id, options: [] }); setFind(""); }} className={`${pill} border-[var(--color-accent)] text-[var(--color-text)]`}>{o.wo ? `WO ${o.wo} · ` : ""}{o.name}</button>)}
                </div>
              )}
            </div>
          )}
          {/* What changes */}
          <div className="text-[13px] font-semibold text-[var(--color-text)]">{check.says}{l.percentFrom === "words" && l.percent != null ? <span className="font-normal text-[var(--color-text-muted)]"> (from your words)</span> : null}</div>
          {l.action === "progress" && step && (l.percent == null || l.percentFrom === "guess") && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-[var(--color-text-muted)]">How far along?</span>
              {[...new Set([25, 50, 75, ...(l.suggest != null && l.suggest > step.pct && l.suggest < 100 ? [l.suggest] : [])])].filter((p) => p > step.pct).sort((a, b) => a - b).map((p) => (
                <button key={p} type="button" onClick={() => onEdit({ percent: p, percentFrom: "said" })} className={`${pill} ${l.percent === p ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "border-[var(--color-border-strong)] text-[var(--color-text)]"}`}>{p}%</button>
              ))}
              <input inputMode="numeric" aria-label="Percent" placeholder="%" className="h-8 w-16 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]"
                onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, "")); if (e.target.value && Number.isFinite(n)) onEdit({ percent: Math.min(100, n), percentFrom: "said" }); }} />
            </div>
          )}
          {l.action === "hold" && (
            <input defaultValue={l.reason ?? l.comment ?? ""} onChange={(e) => onEdit({ reason: e.target.value })} placeholder="Why is it on hold?" aria-label="Hold reason"
              className="w-full max-w-md h-8 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" />
          )}
          {/* When */}
          <div className="text-[12.5px]">
            {l.at != null ? (
              <span className="text-[var(--color-text)]">
                <b>{whenWords(l.at, tz, times)}</b>
                <span className="text-[var(--color-text-muted)]"> · {l.timeFrom === "said" ? `you said “${l.timeWords}”` : l.timeFrom === "picked" ? "picked" : `no time said: ${defaultLabel.split(",")[0].toLowerCase()}`}</span>
                {!changing && <button type="button" onClick={() => setChanging(true)} className="ml-2 font-semibold text-[var(--color-accent)] hover:underline">Change time</button>}
              </span>
            ) : l.ampm ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold text-rose-800 dark:text-rose-200">{l.timeWhy}</span>
                {l.ampm.map((t) => <button key={t} type="button" onClick={() => onEdit({ at: t, timeFrom: "picked", ampm: undefined })} className={`${pill} border-[var(--color-border-strong)] text-[var(--color-text)]`}>{clockOf(t)}</button>)}
              </span>
            ) : (
              <span className="font-semibold text-rose-800 dark:text-rose-200">{l.timeWhy ?? "When did it happen?"}</span>
            )}
            {(l.at == null || changing) && !l.ampm && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {choices.map((c) => <button key={c.id} type="button" onClick={() => onEdit({ at: c.at, timeFrom: "picked" })} className={`${pill} border-[var(--color-border-strong)] text-[var(--color-text)]`}>{c.label.split(",")[0]}</button>)}
              </div>
            )}
            {(l.at == null || changing || needs.some((n) => /time|started|AM or PM|when/i.test(n))) && (
              <div className="mt-1.5 max-w-sm">
                <DateTimePicker label="Pick when" tz={tz} times={times} value={l.at != null ? toDateTimeInput(l.at, tz) : ""}
                  onChange={(v) => { const t = Date.parse(fromDateTimeInput(v, tz) ?? ""); if (Number.isFinite(t)) onEdit({ at: t, timeFrom: "picked", ampm: undefined }); }} />
              </div>
            )}
          </div>
          {/* Your words */}
          <div className="text-[12px] italic text-[var(--color-text-muted)] break-words">“{l.evidence}”{l.comment && !l.expected && l.comment !== l.evidence ? ` · ${l.comment}` : ""}</div>
          {l.implied && <div className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">Probably done: your note doesn&apos;t say it. Tick to include.</div>}
          {l.expected && <div className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">Not entered as done: it hasn&apos;t happened yet. Kept as a comment.</div>}
          {check.nothing && <div className="text-[12px] text-[var(--color-text-muted)]">{check.nothing} Nothing changes; your words go on as a comment.</div>}
          {needs.length > 0 && (
            <ul className="text-[12px] font-semibold text-rose-800 dark:text-rose-200 list-disc pl-4">
              {needs.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}


