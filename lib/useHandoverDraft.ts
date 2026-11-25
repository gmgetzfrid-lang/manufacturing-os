"use client";

// The turnover draft — the meeting's decisions for the next shift — kept
// right under every way it can go wrong:
//   • every change is made to the LATEST decisions (two quick clicks, a
//     crew size typed then Add within a moment: neither loses the other)
//   • saves go out one at a time, in order; only the newest answer shows
//   • a save that lands after the shift has changed never touches the new
//     shift's draft
//   • a crew size being typed is saved when typing pauses, before Ship, and
//     when the report closes — never dropped
//   • Ship freezes what was handed over: the decisions as they stood, and
//     the crew and size in force (not a default that may change later)
//   • nothing is written until the saved decisions have been read: a tap
//     while loading, or after the load failed, would replace the meeting's
//     decisions with none (`loaded` / `failed`, and `retry`)

import { useCallback, useEffect, useRef, useState } from "react";
import { loadHandover, saveHandover, type Handover, type HandoverDecision } from "@/lib/shiftHandover";
import type { PullCrew } from "@/lib/shiftReport";
import { useSerialSave } from "@/lib/useSerialSave";

type Decisions = Record<string, HandoverDecision>;
type HoState = { key: string; data: Handover | null; err: string | null; loaded: boolean; loadErr: string | null };

export function useHandoverDraft(o: {
  active: boolean; projectId: string; orgId: string; userId?: string;
  /** The shift handed to (decisions) and the one just ended (read-back). */
  hoKey: string; priorKey: string;
}) {
  const { active, projectId, orgId, userId, hoKey, priorKey } = o;
  const [ho, setHo] = useState<HoState>({ key: "", data: null, err: null, loaded: false, loadErr: null });
  const [reload, setReload] = useState(0);
  const [prior, setPrior] = useState<{ key: string; data: Handover | null }>({ key: "", data: null });
  const [pullDraft, setPullDraft] = useState<{ key: string; pull: PullCrew } | null>(null);
  const keyRef = useRef(hoKey);
  // The draft as last written here — what the next change builds on.
  const latest = useRef<{ key: string; decisions: Decisions; pull: PullCrew | null }>({ key: "", decisions: {}, pull: null });
  // The project and shift whose saved decisions were read: writes wait for it.
  const loadedKey = useRef<string | null>(null);
  const timer = useRef<{ t: ReturnType<typeof setTimeout>; fire: () => void } | null>(null);
  const serial = useSerialSave();

  useEffect(() => {
    keyRef.current = hoKey;
    if (!active) return;
    let alive = true;
    loadHandover(projectId, hoKey).then((d) => {
      if (!alive) return;
      latest.current = { key: hoKey, decisions: d?.decisions ?? {}, pull: d?.pull ?? null };
      loadedKey.current = `${projectId}|${hoKey}`;
      setHo({ key: hoKey, data: d, err: null, loaded: true, loadErr: null });
    }).catch((e: Error) => {
      if (!alive) return;
      // Not read: nothing may be written over it until it is.
      if (loadedKey.current === `${projectId}|${hoKey}`) loadedKey.current = null;
      setHo({ key: hoKey, data: null, err: null, loaded: false, loadErr: e.message || "failed" });
    });
    loadHandover(projectId, priorKey).then((d) => { if (alive) setPrior({ key: priorKey, data: d }); }).catch(() => undefined);
    return () => { alive = false; };
  }, [active, projectId, hoKey, priorKey, reload]);

  const write = useCallback((decisions: Decisions, pull: PullCrew | null, ship?: { snapshot: unknown; byName?: string } | "unship") => {
    if (!userId || !orgId) return Promise.resolve();
    const key = keyRef.current;
    // The saved decisions aren't read yet (or couldn't be): a write now
    // would wipe them.
    if (loadedKey.current !== `${projectId}|${key}`) return Promise.resolve();
    latest.current = { key, decisions, pull };
    setHo((cur) => {
      const was = cur.key === key ? cur.data : null;
      return { key, data: { shiftKey: key, decisions, pull, shippedAt: was?.shippedAt ?? null, shippedByName: was?.shippedByName ?? null }, err: null, loaded: true, loadErr: null };
    });
    return serial(
      () => saveHandover({ orgId, projectId, shiftKey: key, decisions, pull, ship, userId }),
      // Landed after the shift changed: not this shift's draft any more.
      (saved) => { if (keyRef.current === key) setHo((cur) => (cur.key === key ? { ...cur, data: saved, err: null } : cur)); },
      (e) => { if (keyRef.current === key) setHo((cur) => (cur.key === key ? { ...cur, err: e.message } : cur)); },
    );
  }, [userId, orgId, projectId, serial]);

  /** Read the saved decisions again, after a load that failed. */
  const retry = useCallback(() => {
    setHo((cur) => (cur.key === keyRef.current ? { ...cur, loadErr: null } : cur));
    setReload((n) => n + 1);
  }, []);

  const current = useCallback(() => (latest.current.key === keyRef.current ? latest.current : { key: keyRef.current, decisions: {}, pull: null }), []);

  /** Save a crew size being typed now, instead of when typing pauses. */
  const flush = useCallback(() => {
    const t = timer.current;
    if (!t) return;
    clearTimeout(t.t);
    timer.current = null;
    t.fire();
  }, []);

  /** Change the decisions, from the latest ones. */
  const update = useCallback((fn: (d: Decisions) => Decisions) => {
    flush();
    const c = current();
    return write(fn({ ...c.decisions }), c.pull);
  }, [write, flush, current]);

  /** The crew and size for pulled-forward work — saved when typing pauses. */
  const setPull = useCallback((p: PullCrew) => {
    const key = keyRef.current;
    setPullDraft({ key, pull: p });
    if (timer.current) clearTimeout(timer.current.t);
    const fire = () => {
      timer.current = null;
      setPullDraft(null);
      if (keyRef.current !== key) return;
      void write(current().decisions, p);
    };
    timer.current = { t: setTimeout(fire, 600), fire };
  }, [write, current]);

  /** Freeze and hand over: the decisions as prepared, and the crew in force. */
  const ship = useCallback((prepare: (d: Decisions) => Decisions, pullInForce: PullCrew | null, snapshot: () => unknown, byName?: string) => {
    flush();
    const c = current();
    return write(prepare(c.decisions), c.pull ?? pullInForce, { snapshot: snapshot(), byName });
  }, [write, flush, current]);

  const unship = useCallback(() => { flush(); const c = current(); return write(c.decisions, c.pull, "unship"); }, [write, flush, current]);

  // Leaving the report: a crew size still being typed is saved, not lost.
  useEffect(() => () => flush(), [flush]);
  // Another shift picked: a size typed for the last one goes to the last one.
  useEffect(() => { flush(); }, [hoKey, flush]);

  const mine: HoState = ho.key === hoKey ? ho : { key: hoKey, data: null, err: null, loaded: false, loadErr: null };
  return {
    decisions: mine.data?.decisions ?? EMPTY,
    /** This turnover's own crew and size (null = none set here). */
    savedPull: mine.data?.pull ?? null,
    pullDraft: pullDraft?.key === hoKey ? pullDraft.pull : null,
    shippedAt: mine.data?.shippedAt ?? null,
    shippedByName: mine.data?.shippedByName ?? null,
    err: mine.err,
    /** The saved decisions have been read: they can be changed and shipped. */
    loaded: mine.loaded,
    /** They couldn't be read: nothing is written; offer `retry`. */
    failed: !!mine.loadErr,
    retry,
    prior: prior.key === priorKey ? prior.data : null,
    update, setPull, ship, unship,
  };
}

const EMPTY: Decisions = {};
