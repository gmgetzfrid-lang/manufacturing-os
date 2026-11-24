"use client";

// CountUp: a page's headline number runs up to its value when the page
// opens, and from the old value to the new one when it changes (a reload
// that finds one more overdue item ticks, it doesn't jump). About half a
// second, easing out. Only whole numbers ("8", "1,204"); anything else
// ("4 h", "62%", a link) is shown as given. Reduced motion: the value,
// at once. Screen readers get the real value, never the running one.

import React, { useEffect, useRef, useState } from "react";

const prefersReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const parse = (v: React.ReactNode): number | null => {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v !== "string" || !/^\s*-?\d{1,3}(?:,\d{3})*\s*$|^\s*-?\d+\s*$/.test(v)) return null;
  return Number(v.replace(/[,\s]/g, ""));
};

export function CountUp({ value }: { value: React.ReactNode }) {
  const target = parse(value);
  // The running value while it counts; null when it shows the value
  // itself. A first paint starts at 0 so nothing flashes the end value.
  const [running, setRunning] = useState<number | null>(() =>
    target !== null && target !== 0 && !prefersReduced() ? 0 : null);
  const from = useRef(0);

  useEffect(() => {
    if (target === null) return;
    // `from` moves only when a run finishes, so a run that's cut short
    // (React re-running the effect, a new value mid-count) starts again
    // from the last value that was fully shown.
    const start = from.current;
    if (start === target) return;
    if (prefersReduced()) { from.current = target; return; }
    const t0 = performance.now();
    const dur = Math.min(700, 380 + Math.abs(target - start) * 12);
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      setRunning(k < 1 ? Math.round(start + (target - start) * eased) : null);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  if (target === null) return <>{value}</>;
  return (
    <>
      <span aria-hidden>{(running ?? target).toLocaleString()}</span>
      <span className="sr-only">{target.toLocaleString()}</span>
    </>
  );
}

export default CountUp;
