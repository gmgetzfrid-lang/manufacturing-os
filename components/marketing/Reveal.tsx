"use client";

// Marketing-page motion primitives. Everything here is decoration for the
// public /about page — zero app logic. Scroll-reveal keeps the long story
// alive (sections wake up as you reach them) without a single dependency.

import React, { useEffect, useRef, useState } from "react";

/** Fades + rises children the first time they scroll into view. */
export function Reveal({ children, delay = 0, className = "" }: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      // No observer support: reveal on the next frame instead of hiding
      // content forever.
      const t = setTimeout(() => setShown(true), 0);
      return () => clearTimeout(t);
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) { setShown(true); obs.disconnect(); }
      },
      { threshold: 0.15 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} className={className} data-reveal
      style={shown
        ? { animation: `rise 0.6s var(--ease-fluid) ${delay}ms both` }
        : { opacity: 0 }}>
      {children}
    </div>
  );
}

/** The hero's rotating facility word — the "any facility" promise, animated. */
export function RotatingWord({ words, className = "" }: { words: string[]; className?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    // An infinite word-swap is exactly what prefers-reduced-motion asks
    // us not to do — settle on the last (most general) word instead.
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = setTimeout(() => setI(words.length - 1), 0);
      return () => clearTimeout(t);
    }
    const t = setInterval(() => setI((x) => (x + 1) % words.length), 2200);
    return () => clearInterval(t);
  }, [words.length]);
  return (
    <span key={i} className={`inline-block ${className}`}
      style={{ animation: "rise 0.45s var(--ease-fluid) both" }}>
      {words[i]}
    </span>
  );
}
