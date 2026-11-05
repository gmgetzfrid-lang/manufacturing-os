"use client";

// Update by note - an optional box at the top of the Shift and Work tabs:
// type or say what happened ("E-02 channel head on the ground, they pulled
// it and washed it, staging to put it back. V-1 trays 50."), and the AI
// reads it into step updates (lib/quickUpdate). Nothing saves until every
// line has been checked here: which step, what changes, when, the shift it
// counts for, and your own words beside it. Anything it couldn't work out
// (which step) stops the Save until it's answered or left out. A pasted
// email with its own shift headers is read shift by shift, its sections
// picked (lib/emailShifts), into one check screen.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, NotebookPen, Loader2, X, Check, AlertTriangle, Search, Paperclip, FileText, Undo2, Plus } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import DateTimePicker from "@/components/projects/DateTimePicker";
import { supabase } from "@/lib/supabase";
import {
  stepCatalog, catalogText, parseReply, toLines, checkLine, saveEvents, defaultTimes, whenWords, spokenToTags, applyWords, lineComment, sayLine, mergeLines, toAll, stepsBefore, markAlready,
  type CatalogStep, type QuickLine, type RawReply,
} from "@/lib/quickUpdate";
import { splitShifts, partText, sectionsFound, partLabel, DEFAULT_OMIT, SECTION_WORD, type SectionKind, type ShiftPart } from "@/lib/emailShifts";
import { saveQuickStep, undoQuickStep, type SavedStep } from "@/lib/quickUpdateSave";
import { readNoteFile } from "@/lib/noteFiles";
import { notesFor } from "@/lib/milestones";
import { searchFilter } from "@/lib/fuzzySearch";
import { shiftAt, previousShift, shiftWindow, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { fmtInTz, toDateTimeInput, fromDateTimeInput, dayKey } from "@/lib/scheduleTz";
import type { Milestone } from "@/types/schema";

const HIDE_KEY = "quickUpdate:hidden";
/** This person's words for tags ("mee too" = E-2), learned from what they
 *  confirmed, per project on this device. */
const wordsKey = (p: string) => `quickUpdate:words:${p}`;
type Word = { said: string; as: string };
const draftKey = (p: string) => `quickUpdate:draft:${p}`;
/** The sections of a pasted email left out, remembered on this device. */
const OMIT_KEY = "quickUpdate:omit";
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
  const [words, setWords] = useState<Word[]>([]);
  useEffect(() => {
    try { const w = JSON.parse(store.get(wordsKey(projectId)) ?? "[]"); if (Array.isArray(w)) setWords(w.filter((x) => x && typeof x.said === "string" && typeof x.as === "string")); } catch { /* none */ }
  }, [projectId]);
  const keepWords = (w: Word[]) => { setWords(w); store.set(wordsKey(projectId), w.length ? JSON.stringify(w) : null); };
  const [showWords, setShowWords] = useState(false);
  const wordsRef = useRef<Word[]>([]);
  wordsRef.current = words;
  const [teach, setTeach] = useState({ said: "", as: "" });
  const addWord = () => {
    const said = teach.said.trim().toLowerCase(), as = teach.as.trim();
    if (!said || !as) return;
    keepWords([{ said, as }, ...words.filter((w) => w.said.toLowerCase() !== said)].slice(0, 60));
    setTeach({ said: "", as: "" });
  };

  // ── Speaking ──
  const recRef = useRef<Rec | null>(null);
  const [listening, setListening] = useState(false);
  // What it's hearing before the words are final: shown as you talk.
  const [hearing, setHearing] = useState("");
  const canSpeak = typeof window !== "undefined" && !!speechCtor();
  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const C = speechCtor();
    if (!C) return;
    const rec = new C();
    rec.lang = "en-US"; rec.continuous = true; rec.interimResults = true;
    const base = note.trim();
    let said = "";
    rec.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        // Tags said by letter ("echo two"), and the words it keeps hearing
        // that you've taught it ("mee too" = E-2), written as tags.
        const t = applyWords(spokenToTags(e.results[i][0].transcript.trim()), wordsRef.current);
        if (e.results[i].isFinal) said += `${said ? " " : ""}${t}`; else live += `${live ? " " : ""}${t}`;
      }
      setHearing(live);
      setDraft([base, said].filter(Boolean).join(base && !/[.!?]$/.test(base) ? ". " : " "));
    };
    rec.onend = () => { setListening(false); setHearing(""); recRef.current = null; };
    rec.onerror = () => { setListening(false); setHearing(""); recRef.current = null; };
    recRef.current = rec;
    setListening(true);
    rec.start();
  };
  useEffect(() => () => recRef.current?.stop(), []);

  // ── Reading ──
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [review, setReview] = useState<{ cat: CatalogStep[]; lines: QuickLine[]; unplaced: RawReply["unplaced"]; at: number; window?: ShiftWindow;
    /** A pasted email: the shifts read, in order, and any that couldn't be. */
    parts?: Array<{ key: string; label: string }>; failed?: string[] } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  // ── A pasted email with its own shift headers: each shift read on its
  // own, its times in that shift; sections can be left out. ──
  const [omit, setOmit] = useState<Set<SectionKind>>(() => new Set(DEFAULT_OMIT));
  useEffect(() => {
    try { const v = JSON.parse(store.get(OMIT_KEY) ?? "null"); if (Array.isArray(v)) setOmit(new Set(v as SectionKind[])); } catch { /* none */ }
  }, []);
  const flipOmit = (k: SectionKind) => setOmit((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); store.set(OMIT_KEY, JSON.stringify([...n])); return n; });
  const [skip, setSkip] = useState<Set<string>>(new Set());
  // ── Which shift the notes are about: now (typed or said as it happens),
  // or a log of a shift (a file typed up all day). In a log, a time with no
  // date is in that shift.
  const [from, setFrom] = useState<{ id: "now" } | { id: "shift"; w: ShiftWindow; auto?: boolean }>({ id: "now" });
  const [pickDay, setPickDay] = useState("");
  const sh = (w: ShiftWindow) => `${fmtInTz(w.start, tz, { weekday: "short", month: "short", day: "numeric" })} ${w.kind} shift`;
  const shSpan = (w: ShiftWindow) => `${sh(w)} (${fmtInTz(w.start, tz, { hour: "numeric", minute: "2-digit", hour12: true })} to ${fmtInTz(w.end, tz, { hour: "numeric", minute: "2-digit", hour12: true })})`;
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNowTick(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const curShift = shiftAt(nowTick, tz, times), lastShift = previousShift(curShift, tz, times);
  const fromWin = from.id === "shift" ? from.w : undefined;
  const parts = useMemo<ShiftPart[] | null>(() => (note.length > 40 ? splitShifts(note, tz, times, nowTick) : null), [note, tz, times, nowTick]);
  const found = useMemo(() => (parts ? sectionsFound(parts) : []), [parts]);

  // ── A file: its words go into the box first, to read and fix ──
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ name: string; chars: number }>>([]);
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setErr(null);
    let text = note.trim();
    let latest = 0;
    for (const f of Array.from(list)) {
      setFileBusy(`Reading ${f.name}…`);
      try {
        const r = await readNoteFile(f);
        let words = r.text;
        // Pictures (photos, scanned pages): copied out by the AI, 3 at a time.
        for (let i = 0; i < r.images.length; i += 3) {
          setFileBusy(`Copying out ${f.name}${r.images.length > 1 ? `, page ${i + 1} of ${r.images.length}` : ""}…`);
          const res = await fetch("/api/projects/quick-update", {
            method: "POST", headers: { "content-type": "application/json", ...(await authHeader()) },
            body: JSON.stringify({ orgId, projectId, action: "transcribe", images: r.images.slice(i, i + 3) }),
          });
          const b = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
          if (!res.ok || typeof b?.text !== "string") throw new Error(`${f.name}: ${b?.error ?? `couldn't copy out the page (HTTP ${res.status})`}`);
          words = [words, b.text].filter(Boolean).join("\n\n");
        }
        if (!words.trim()) throw new Error(`${f.name}: no words found in it.`);
        text = [text, words.trim()].filter(Boolean).join("\n\n");
        setFiles((cur) => [...cur, { name: f.name, chars: words.length }]);
        latest = Math.max(latest, f.lastModified || 0);
      } catch (e) { setErr((e as Error).message); }
    }
    setFileBusy(null);
    setDraft(text);
    // A file typed up over a shift: which shift, from when it was last saved
    // (said plainly, and changeable).
    if (latest && from.id === "now") setFrom({ id: "shift", w: shiftAt(Math.min(latest, Date.now()), tz, times), auto: true });
    if (fileRef.current) fileRef.current.value = "";
  };

  /** One read of the AI: the words, against the steps, for the shift given. */
  const ask = async (text: string, cat: CatalogStep[], now: number, win: ShiftWindow | undefined) => {
    const cur = shiftAt(now, tz, times), prev = previousShift(cur, tz, times);
    const res = await fetch("/api/projects/quick-update", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({
        orgId, projectId, note: text, catalog: catalogText(cat, tz), now, tz, shift: `This shift: ${shSpan(cur)}. Last shift: ${shSpan(prev)}.`,
        notesFrom: win ? `These notes are a log of the ${shSpan(win)}. A time written with no date is in that shift; on a night shift, times after midnight are the next morning.` : undefined,
        words,
      }),
    });
    const body = (await res.json().catch(() => null)) as (RawReply & { error?: string }) | null;
    if (!res.ok || !body?.updates) throw new Error(body?.error || `Couldn't read it (HTTP ${res.status}).`);
    return parseReply(body);
  };

  /** A pasted email: every shift in it read at once, each against its own
   *  shift (its times, its live steps), then one check screen. */
  const readParts = async (ps: ShiftPart[]) => {
    const now = Date.now();
    const leafIds = milestones.filter((m) => m.id && !milestones.some((k) => k.parentId === m.id)).map((m) => m.id!);
    const recent = await notesFor(leafIds).catch(() => []);
    const todo = ps.filter((p) => !skip.has(p.key)).map((p) => ({ p, text: partText(p, omit) })).filter((x) => x.text.trim());
    if (!todo.length) throw new Error("Nothing left to read: every shift or section is left out.");
    const results: Array<{ lines: QuickLine[]; unplaced: RawReply["unplaced"]; cat: CatalogStep[] } | null> = todo.map(() => null);
    const failed: string[] = [];
    let n = 0;
    const run = async (i: number) => {
      const { p, text } = todo[i];
      const label = partLabel(p.window, tz);
      const cat = stepCatalog(milestones, undefined, { now, window: p.window, notes: recent });
      try {
        const reply = await ask(text, cat, now, p.window);
        const tctx = { now, tz, times, window: p.window };
        const def = defaultTimes(tctx)[0];
        const r = toLines(reply, cat, def.at, tctx, text, words);
        results[i] = {
          cat,
          lines: r.lines.map((l) => ({ ...l, id: `${i}-${l.id}`, part: { key: p.key, label } })),
          unplaced: r.unplaced.map((u) => ({ ...u, why: `${label}: ${u.why}` })),
        };
      } catch (e) { failed.push(`${label}: ${(e as Error).message}`); }
      n++;
      setProgress(`Read ${n} of ${todo.length} shifts…`);
    };
    setProgress(`Reading ${todo.length} shift${todo.length === 1 ? "" : "s"}…`);
    // Two at a time: quick, and kind to the AI's limits.
    for (let i = 0; i < todo.length; i += 2) await Promise.all([run(i), ...(i + 1 < todo.length ? [run(i + 1)] : [])]);
    const ok = results.filter((r): r is NonNullable<typeof r> => !!r);
    if (!ok.length) throw new Error(`Couldn't read it. ${failed.join(" ")} Your note is kept - try again.`);
    // Newest shift first; the same thing said in two places, once.
    const order = todo.map((t, i) => ({ i, start: t.p.window.start })).sort((a, b) => b.start - a.start);
    const lines = markAlready(mergeLines(order.flatMap(({ i }) => results[i]?.lines ?? [])), ok[0].cat, now, tz);
    const unplaced = order.flatMap(({ i }) => results[i]?.unplaced ?? []);
    setDefaultPick({ id: "part", at: 0 });
    setReview({ cat: ok[0].cat, lines, unplaced, at: now, parts: order.filter(({ i }) => results[i]).map(({ i }) => ({ key: todo[i].p.key, label: partLabel(todo[i].p.window, tz) })), failed });
  };

  const read = async () => {
    if (!note.trim()) return;
    recRef.current?.stop();
    setBusy(true); setErr(null);
    if (parts?.length) {
      try { await readParts(parts); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); setProgress(null); }
      return;
    }
    const now = Date.now();
    const win = fromWin && fromWin.start <= now ? fromWin : undefined;
    // How the field has described each step lately helps match short notes.
    const leafIds = milestones.filter((m) => m.id && !milestones.some((k) => k.parentId === m.id)).map((m) => m.id!);
    const recent = await notesFor(leafIds).catch(() => []);
    const cat = stepCatalog(milestones, undefined, { now, window: win, notes: recent });
    const cur = shiftAt(now, tz, times), prev = previousShift(cur, tz, times);
    try {
      const res = await fetch("/api/projects/quick-update", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({
          orgId, projectId, note, catalog: catalogText(cat, tz), now, tz, shift: `This shift: ${shSpan(cur)}. Last shift: ${shSpan(prev)}.`,
          notesFrom: win ? `These notes are a log of the ${shSpan(win)}. A time written with no date is in that shift; on a night shift, times after midnight are the next morning.` : undefined,
          words,
        }),
      });
      const body = (await res.json().catch(() => null)) as (RawReply & { error?: string }) | null;
      if (!res.ok || !body?.updates) throw new Error(body?.error || `Couldn't read it (HTTP ${res.status}). Your note is kept - try again.`);
      const tctx = { now, tz, times, window: win };
      const first = defaultTimes(tctx)[0];
      // Cleaned again here: whatever comes back, nothing malformed reaches the lines.
      const { lines, unplaced } = toLines(parseReply(body), cat, first.at, tctx, note, words);
      setDefaultPick({ id: first.id, at: first.at });
      setReview({ cat, lines, unplaced, at: now, window: win });
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  // ── The time for lines with no time said ──
  const [defaultPick, setDefaultPick] = useState<{ id: string; at: number }>({ id: "now", at: 0 });
  const choices = useMemo(() => (review ? defaultTimes({ now: review.at, tz, times, window: review.window }) : []), [review, tz, times]);
  const setDefault = (id: string, at: number) => {
    setDefaultPick({ id, at });
    setReview((r) => (r ? { ...r, lines: r.lines.map((l) => (l.timeFrom === "default" ? { ...l, at } : l)) } : r));
  };
  const edit = (id: string, patch: Partial<QuickLine>) => setReview((r) => (r ? { ...r, lines: r.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) } : r));
  // A line by hand: one the AI missed, or words it couldn't place. You pick
  // the step, what happened and when.
  const addLine = (text: string, unplacedAt?: number) => setReview((r) => r ? {
    ...r,
    unplaced: unplacedAt == null ? r.unplaced : r.unplaced.filter((_, i) => i !== unplacedAt),
    lines: [...r.lines, {
      id: `add${Date.now()}`, stepId: null, options: [], action: text ? "comment" : "progress", percent: null, percentFrom: "said", suggest: null,
      reason: null, comment: null, evidence: text, implied: false, at: defaultPick.at, timeFrom: "default", timeWords: null, expected: false, include: true, added: true,
      ...(text ? { noteText: text } : {}),
    }],
  } : r);

  // ── Saving ──
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ saved: SavedStep[]; says: Record<string, string>; warn: string[]; failed: string[]; undone: Record<string, string>; note: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const undo = async (list: SavedStep[]) => {
    if (!done) return;
    setUndoing(true);
    const undone = { ...done.undone };
    // Newest first, so a step saved twice comes back in order.
    for (const s of [...list].reverse()) {
      if (undone[s.id]) continue;
      const r = await undoQuickStep(s).catch(() => "error" as const);
      undone[s.id] = r === "ok" ? "Undone" : r === "changed" ? "Changed since - fix it in the step's history" : r === "missing" ? "Undo needs the database update 20261109_history_remove.sql" : "Not undone - fix it in the step's history";
    }
    setDone({ ...done, undone });
    setUndoing(false);
    // All of it taken back: the note goes back in the box, to fix and read again.
    if (done.saved.every((s) => undone[s.id] === "Undone") && !note.trim()) setDraft(done.note);
    onSaved();
  };
  const byId = useMemo(() => new Map((review?.cat ?? []).map((c) => [c.id, c])), [review]);
  // Each line checked against its step as the lines before it leave it
  // (a hold at 2:30 makes "back on" at 3:30 a change).
  const checks = useMemo(() => {
    const now = Date.now();
    const before = stepsBefore(review?.lines ?? [], review?.cat ?? [], now, tz);
    return new Map((review?.lines ?? []).map((l) => [l.id, checkLine(l, l.stepId ? before.get(l.id) ?? byId.get(l.stepId) : undefined, now, tz)]));
  }, [review, byId, tz]);
  const included = (review?.lines ?? []).filter((l) => l.include);
  const blocked = included.filter((l) => (checks.get(l.id)?.needs.length ?? 0) > 0);
  const ready = included.filter((l) => !(checks.get(l.id)?.needs.length));
  const save = async () => {
    if (!review || blocked.length) return;
    setSaving(true);
    const events = saveEvents(review.lines, review.cat, Date.now(), tz);
    const saved: SavedStep[] = [];
    const says: Record<string, string> = {};
    const warn: string[] = [], failed: string[] = [];
    for (const [id, ev] of events) {
      const st = byId.get(id);
      const name = st?.name ?? "A step";
      says[id] = review.lines.filter((l) => l.include && l.stepId === id).map((l) => { const no = checks.get(l.id)?.nothing; return no ? `Comment only (${no.replace(/\.$/, "").toLowerCase()})` : sayLine(l, st); }).join(", ");
      try {
        const r = await saveQuickStep(id, name, ev, { status: st?.status ?? "planned", pct: st?.pct ?? 0 }, { orgId, userId, userName });
        saved.push(r);
        if (r.warn) warn.push(`${name}: ${r.warn}`);
      } catch (e) { failed.push(`${name}: ${(e as Error).message}`); }
    }
    // Words read as a tag and confirmed on its step: remembered for next time.
    const learned = review.lines.filter((l) => l.include && l.heard && !l.heard.known && l.stepId === l.heard.stepId).map((l) => ({ said: l.heard!.said, as: l.heard!.as }));
    if (learned.length) keepWords([...learned, ...words.filter((w) => !learned.some((x) => x.said.toLowerCase() === w.said.toLowerCase()))].slice(0, 60));
    setSaving(false);
    window.dispatchEvent(new Event("milestone-notes:changed"));
    onSaved();
    setDone({ saved, says, warn, failed, undone: {}, note });
    if (!failed.length) { setDraft(""); setReview(null); setFiles([]); setFrom({ id: "now" }); }
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
          <textarea value={note} onChange={(e) => setDraft(e.target.value)} rows={note.length > 400 ? 10 : 4} aria-label="What happened"
            placeholder={"What happened? Name the equipment or WO, like you'd tell your relief.\nE-02 channel head is on the ground, they pulled it and washed it, staging to put it back.\nV-1 trays 50%. V-3 on hold, scaffold not built."}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={toggleMic} disabled={!canSpeak} title={canSpeak ? undefined : "Use the microphone on your phone's keyboard to speak into the box"}
              className={`inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border text-[13px] font-bold disabled:opacity-50 ${listening ? "border-rose-500 bg-rose-600 text-white" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
              {listening ? <><MicOff className="w-4 h-4" /> Stop</> : <><Mic className="w-4 h-4" /> Speak</>}
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={!!fileBusy || busy}
              className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-[var(--color-border-strong)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
              <Paperclip className="w-4 h-4" /> Add a file
            </button>
            <input ref={fileRef} type="file" multiple className="hidden" aria-label="Add a file of notes"
              accept=".txt,.text,.md,.log,.csv,.tsv,.rtf,.docx,.xlsx,.xlsm,.xls,.pdf,image/*"
              onChange={(e) => void addFiles(e.target.files)} />
            <button type="button" onClick={() => void read()} disabled={busy || !!fileBusy || !note.trim()}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> {progress ?? "Reading…"}</> : parts?.length ? `Read all ${parts.filter((p) => !skip.has(p.key)).length} shift${parts.filter((p) => !skip.has(p.key)).length === 1 ? "" : "s"}` : "Read it"}
            </button>
            {note && !busy && <button type="button" onClick={() => setDraft("")} className="text-[12px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Clear</button>}
            {!canSpeak && <span className="text-[11px] text-[var(--color-text-muted)]">To talk, use the mic on your keyboard.</span>}
          </div>
          {listening && (
            <div className="text-[12px] text-rose-700 dark:text-rose-300">
              <b>Listening…</b> say what happened, then tap Stop. Noisy? Say tags by letter: “Echo 2”, “Victor 1”, “Papa Sierra Victor 209”.
              {hearing && <div className="mt-0.5 italic text-[var(--color-text-muted)]">Hearing: {hearing}</div>}
            </div>
          )}
          <div className="text-[11.5px] text-[var(--color-text-muted)]">
            <button type="button" onClick={() => setShowWords((v) => !v)} aria-expanded={showWords} className="font-semibold hover:text-[var(--color-text)]">Your words ({words.length})</button>
            {showWords && (
              <div className="mt-1 space-y-1.5">
                <div>What talk-to-text keeps getting wrong, and what you meant. It&apos;s fixed as you talk, and the reader knows it.</div>
                {words.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {words.map((w) => (
                      <li key={w.said} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5">
                        “{w.said}” = {w.as}
                        <button type="button" onClick={() => keepWords(words.filter((x) => x !== w))} aria-label={`Forget “${w.said}”`} className="p-0.5 hover:text-rose-700"><X className="w-3 h-3" /></button>
                      </li>
                    ))}
                  </ul>
                )}
                <form onSubmit={(e) => { e.preventDefault(); addWord(); }} className="flex flex-wrap items-center gap-1.5">
                  <span>It hears</span>
                  <input value={teach.said} onChange={(e) => setTeach((t) => ({ ...t, said: e.target.value }))} placeholder="mee too" aria-label="It hears"
                    className="h-8 w-28 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]" />
                  <span>I mean</span>
                  <input value={teach.as} onChange={(e) => setTeach((t) => ({ ...t, as: e.target.value }))} placeholder="E-2" aria-label="I mean"
                    className="h-8 w-24 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]" />
                  <button type="submit" disabled={!teach.said.trim() || !teach.as.trim()} className="h-8 rounded-md border border-[var(--color-border-strong)] px-2.5 font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Add word</button>
                </form>
              </div>
            )}
          </div>
          {fileBusy && <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> {fileBusy}</div>}
          {files.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]">
              {files.map((f, i) => <span key={`${f.name}${i}`} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5"><FileText className="w-3 h-3" /> {f.name} · {f.chars.toLocaleString()} characters</span>)}
              <span>Its words are in the box above: read them over and fix anything before you tap Read it.</span>
            </div>
          )}
          {/* A pasted email: the shifts it names, and its sections to read or leave out. */}
          {parts && parts.length > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-2 text-[12px] space-y-1.5">
              <div className="font-bold text-[var(--color-text)]">Found {parts.length} shift{parts.length === 1 ? "" : "s"} in your note, by its own dates and times:</div>
              <div className="flex flex-wrap gap-1.5">
                {parts.map((p) => {
                  const on = !skip.has(p.key);
                  return (
                    <label key={p.key} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold cursor-pointer ${on ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)] line-through"}`}>
                      <input type="checkbox" checked={on} onChange={() => setSkip((s0) => { const n = new Set(s0); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); return n; })} className="h-3.5 w-3.5 accent-[var(--color-accent)]" />
                      {partLabel(p.window, tz)}
                    </label>
                  );
                })}
              </div>
              {found.length > 0 && (
                <>
                  <div className="font-bold text-[var(--color-text)]">Read these parts:</div>
                  <div className="flex flex-wrap gap-1.5">
                    {found.map((f) => {
                      const on = !omit.has(f.kind);
                      return (
                        <label key={f.kind} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 cursor-pointer ${on ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-semibold text-[var(--color-text)]" : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
                          <input type="checkbox" checked={on} onChange={() => flipOmit(f.kind)} className="h-3.5 w-3.5 accent-[var(--color-accent)]" />
                          {SECTION_WORD[f.kind]} <span className="opacity-70">· {f.lines}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="text-[11.5px] text-[var(--color-text-muted)]">What you leave out stays out next time too. Anything already in the app comes in unticked.</div>
                </>
              )}
            </div>
          )}
          {/* Which shift the notes are about. */}
          {note.trim() && !parts?.length && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-2 text-[12px]">
              <div className="font-bold text-[var(--color-text)]">These notes are about:</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {([["now", "Now, as it happens", undefined], ["this", `This shift (${sh(curShift)})`, curShift], ["last", `Last shift (${sh(lastShift)})`, lastShift]] as const).map(([id, label, w]) => {
                  const on = id === "now" ? from.id === "now" : from.id === "shift" && from.w.start === w!.start;
                  return (
                    <button key={id} type="button" aria-pressed={on} onClick={() => setFrom(w ? { id: "shift", w } : { id: "now" })}
                      className={`rounded-full border px-2.5 py-1 font-semibold ${on ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface)]"}`}>{label}</button>
                  );
                })}
                <span className="inline-flex items-center gap-1">
                  <input type="date" value={pickDay} max={dayKey(nowTick, tz)} onChange={(e) => setPickDay(e.target.value)} aria-label="Another day"
                    className="h-7 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[12px]" />
                  {(["day", "night"] as const).map((k) => (
                    <button key={k} type="button" disabled={!pickDay} onClick={() => setFrom({ id: "shift", w: shiftWindow(pickDay, k, tz, times) })}
                      className="rounded-full border border-[var(--color-border-strong)] px-2 py-0.5 font-semibold text-[var(--color-text)] disabled:opacity-40">{k === "day" ? "Day" : "Night"}</button>
                  ))}
                </span>
              </div>
              <div className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                {from.id === "now" ? "A time with no date is the last time it came round: today, or last night."
                  : <>A log of the <b className="text-[var(--color-text)]">{shSpan(from.w)}</b>{from.auto ? " (from when the file was last saved - change it if that's wrong)" : ""}. Times with no date are in that shift.</>}
              </div>
            </div>
          )}
          {err && <div role="alert" className="text-[12px] font-semibold text-rose-700 dark:text-rose-300">{err}</div>}
          {done && (
            <div role="status" className={`rounded-lg px-3 py-2 text-[12px] ${done.failed.length ? "bg-rose-50 dark:bg-rose-950/40 text-rose-900 dark:text-rose-100" : "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-100"}`}>
              <div className="flex items-center gap-2">
                <b className="flex-1">{done.saved.length && done.saved.every((s) => done.undone[s.id] === "Undone") ? "All taken back. Your note is in the box to fix and read again." : done.saved.length ? `Saved ${done.saved.length} step${done.saved.length === 1 ? "" : "s"}.` : "Nothing saved."}</b>
                {done.saved.some((s) => !done.undone[s.id]) && (
                  <button type="button" disabled={undoing} onClick={() => void undo(done.saved)} className="inline-flex items-center gap-1 rounded-md border border-current px-2 py-0.5 font-bold disabled:opacity-50">
                    {undoing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Undo all
                  </button>
                )}
                <button type="button" onClick={() => setDone(null)} aria-label="Dismiss" className="p-0.5"><X className="w-3.5 h-3.5" /></button>
              </div>
              <ul className="mt-1 space-y-0.5">
                {done.saved.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className={done.undone[s.id] === "Undone" ? "line-through opacity-70" : ""}><b>{s.name}</b>: {done.says[s.id]}</span>
                    {done.undone[s.id]
                      ? <span className="font-semibold">{done.undone[s.id]}</span>
                      : <button type="button" disabled={undoing} onClick={() => void undo([s])} className="font-bold underline disabled:opacity-50">Undo</button>}
                  </li>
                ))}
              </ul>
              {done.failed.map((f) => <div key={f}>Not saved: {f}</div>)}
              {done.warn.map((w) => <div key={w}>{w}</div>)}
              {done.failed.length > 0 && <div>Your note is kept. Fix the step by hand, or read it again.</div>}
            </div>
          )}
        </div>
      )}

      {review && (
        <Modal onClose={() => !saving && setReview(null)} size="xl" dismissable={!saving}>
          <ModalHeader icon={NotebookPen} title="Check before saving" subtitle={`Each line is what your note says, matched to a step. Nothing saves until you tap Save.${review.window ? ` Notes from the ${sh(review.window)}.` : ""}`} onClose={saving ? undefined : () => setReview(null)} />
          <ModalBody className="p-0">
            {review.parts ? (
              <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-slate-50 dark:bg-[var(--color-surface-2)] text-[12px] text-[var(--color-text-muted)]">
                <b className="text-[var(--color-text)]">{review.parts.length} shift{review.parts.length === 1 ? "" : "s"} read from your note</b>, newest first. Times are read in their own shift; a line with no time goes in at the end of its shift.
                {(review.failed?.length ?? 0) > 0 && <div className="mt-1 font-semibold text-rose-700 dark:text-rose-300">Not read: {review.failed!.join(" · ")}. Go back and read it again for those.</div>}
              </div>
            ) : (
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
            )}
            <ul className="divide-y divide-[var(--color-border)]">
              {review.lines.map((l, i) => {
                const prev = review.lines[i - 1];
                const head = review.parts && l.part && l.part.key !== prev?.part?.key;
                const inPart = head ? review.lines.filter((x) => x.part?.key === l.part!.key) : [];
                return (
                  <React.Fragment key={l.id}>
                    {head && (
                      <li className="sticky top-0 z-[1] px-4 py-1.5 bg-[var(--color-surface-2)] text-[11.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
                        {l.part!.label} · {inPart.filter((x) => x.include).length} to save{inPart.some((x) => x.already) ? `, ${inPart.filter((x) => x.already).length} already in` : ""}
                      </li>
                    )}
                    <LineRow l={l} cat={review.cat} step={l.stepId ? byId.get(l.stepId) : undefined} check={checks.get(l.id)!} tz={tz} times={times}
                      defaultLabel={l.part ? `end of the ${l.part.label}` : choices.find((c) => c.id === defaultPick.id)?.label ?? "the time picked"} choices={choices}
                      onEdit={(p) => edit(l.id, p)} onAll={() => setReview((r) => (r ? { ...r, lines: r.lines.flatMap((x) => (x.id === l.id ? toAll(x) : [x])) } : r))} />
                  </React.Fragment>
                );
              })}
              {review.lines.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">Nothing in the note matched a step.</li>}
              <li className="px-4 py-2.5">
                <button type="button" onClick={() => addLine("")} className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-[var(--color-accent)] hover:underline"><Plus className="w-4 h-4" /> Add a line it missed</button>
              </li>
            </ul>
            {review.unplaced.length > 0 && (
              <div className="px-4 py-3 border-t border-[var(--color-border)] bg-amber-50/60 dark:bg-amber-950/20">
                <div className="text-[12px] font-black uppercase tracking-wider text-amber-900 dark:text-amber-200">Couldn&apos;t place ({review.unplaced.length})</div>
                <ul className="mt-1 space-y-1 text-[12.5px] text-[var(--color-text)]">
                  {review.unplaced.map((u, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                      <span>“{u.text}” <span className="text-[var(--color-text-muted)]">- {u.why}</span></span>
                      <button type="button" onClick={() => addLine(u.text, i)} className="font-bold text-[var(--color-accent)] hover:underline">Put it on a step</button>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">Not saved unless you put it on a step.</div>
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
function LineRow({ l, cat, step, check, tz, times, defaultLabel, choices, onEdit, onAll }: {
  l: QuickLine; cat: CatalogStep[]; step: CatalogStep | undefined;
  check: { needs: string[]; nothing?: string; says: string };
  tz: string; times: ShiftTimes; defaultLabel: string;
  choices: Array<{ id: string; at: number; label: string }>;
  onEdit: (p: Partial<QuickLine>) => void;
  /** The same words on every step it could be. */
  onAll?: () => void;
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
              {/* How it was found, when the note didn't name it outright. */}
              {l.found === "context" && l.context && <div className="text-[11.5px] text-[var(--color-text-muted)]">Equipment from earlier in your note: “{l.context}”</div>}
              {l.found === "only" && <div className="text-[11.5px] text-[var(--color-text-muted)]">Your note doesn&apos;t name the equipment: this is the only open step by that name.</div>}
              {l.found === "meaning" && <div className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-300">Matched by meaning (no word in common with the step&apos;s name). Check it&apos;s the right step.</div>}
              {l.woNote && <div className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-300">{l.woNote}</div>}
              {l.group && <div className="text-[11.5px] text-[var(--color-text-muted)]">Your note says this about {l.group} steps: it goes on each of them.</div>}
              <button type="button" onClick={() => onEdit({ stepId: null, options: l.options.length ? l.options : [step.id] })} className="text-[11.5px] font-semibold text-[var(--color-accent)] hover:underline">Wrong step? Pick another</button>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-[12.5px] font-bold text-rose-800 dark:text-rose-200">{l.heard && !l.heard.known && options.length === 1 ? `Heard “${l.heard.said}” as ${l.heard.as}. Is this the step?` : "Which step is it?"}</div>
              <div className="flex flex-wrap gap-1.5">
                {options.map((o) => (
                  <button key={o.id} type="button" onClick={() => onEdit({ stepId: o.id })} className="rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold text-left border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                    {o.wo ? `WO ${o.wo} · ` : ""}{o.place ? `${o.place}: ` : ""}{o.name}
                    <span className="font-normal text-[var(--color-text-muted)]"> · {o.status === "in_progress" ? `under way ${o.pct}%` : o.status === "completed" ? "done" : o.live ? "planned around now" : o.next ? "next up" : "not started"}</span>
                  </button>
                ))}
                {onAll && options.length > 1 && (
                  <button type="button" onClick={onAll} className="rounded-lg border border-dashed border-[var(--color-accent)] px-2.5 py-1.5 text-[12px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
                    All {options.length} of these
                  </button>
                )}
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
          {/* What changes: read from the note, changeable. */}
          <div className="text-[13px] font-semibold text-[var(--color-text)]">{check.says}{l.percentFrom === "words" && l.percent != null ? <span className="font-normal text-[var(--color-text-muted)]"> (from your words)</span> : null}{l.counts && l.percent != null ? <span className="font-normal text-[var(--color-text-muted)]"> (from your counts: {l.counts})</span> : null}</div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="What happened">
            {([["start", "Started"], ["progress", "%"], ["done", "Done"], ["hold", "On hold"], ["resume", "Back on"], ["comment", "Comment only"]] as const).map(([a, label]) => (
              <button key={a} type="button" aria-pressed={l.action === a}
                onClick={() => onEdit({ action: a, expected: false, ...(a === "progress" && l.action !== "progress" ? { percent: null, percentFrom: "said" } : {}) })}
                className={`rounded-md border px-2 py-0.5 text-[11.5px] font-semibold ${l.action === a ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{label}</button>
            ))}
          </div>
          {l.action === "progress" && step && l.percent != null && l.percentFrom !== "guess" && (
            <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              % now
              <input inputMode="numeric" aria-label="Percent" value={String(l.percent)} className="h-8 w-16 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]"
                onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, "")); onEdit({ percent: e.target.value.trim() === "" ? null : Math.min(100, Number.isFinite(n) ? n : 0), percentFrom: "said" }); }} />
            </label>
          )}
          {l.action === "progress" && step && (l.percent == null || l.percentFrom === "guess") && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-[var(--color-text-muted)]">Set a %? (not needed to save)</span>
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
          {/* Your words, and the comment that goes on the step (editable). */}
          {l.evidence && <div className="text-[12px] italic text-[var(--color-text-muted)] break-words">You said: “{l.evidence}”</div>}
          {l.heard && (step || l.heard.known) && <div className={`text-[11.5px] ${l.heard.known ? "text-[var(--color-text-muted)]" : "font-semibold text-amber-800 dark:text-amber-300"}`}>Heard “{l.heard.said}” as {l.heard.as}{l.heard.known ? " (your word for it)" : l.stepId === l.heard.stepId ? ". Remembered for next time when you save." : "."}</div>}
          <label className="block text-[11.5px] text-[var(--color-text-muted)]">
            Comment on the step
            <textarea rows={1} value={l.noteText !== undefined ? l.noteText ?? "" : lineComment(l)}
              onChange={(e) => onEdit({ noteText: e.target.value })} placeholder="No comment"
              className="mt-0.5 block w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12.5px] text-[var(--color-text)]" />
          </label>
          {l.implied && <div className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">Probably done: your note doesn&apos;t say it. Tick to include.</div>}
          {l.expected && <div className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">Not entered as done: it hasn&apos;t happened yet. Kept as a comment.</div>}
          {check.nothing && (l.already && !l.include
            ? <div className="text-[12px] text-[var(--color-text-muted)]">{l.already} Already in the app: left out. Tick it to add your words as a comment.</div>
            : <div className="text-[12px] text-[var(--color-text-muted)]">{check.nothing} Nothing changes; your words go on as a comment.</div>)}
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


