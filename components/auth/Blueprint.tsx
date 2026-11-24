"use client";

// The front door's drawing: a P&ID sheet on the brand's deep color that
// draws itself the way a CAD plot redraws, line by line, then keeps
// running: product moves through the lines in its flow direction and the
// column's level breathes, like a live control-room screen. Pointing at an
// instrument bubble lights it and says what it is (LT is a level
// transmitter: the real meaning of the letters, nothing invented).
//
// The whole sheet is decoration (aria-hidden). It plays in full once per
// session; after that it appears already drawn. With reduced motion it is
// simply the finished drawing.

import React, { useId } from "react";

type Dir = "r" | "l" | "u" | "d";

/** One stroke that draws itself, starting `d` seconds in. */
function Line({ d, at, dash, className = "" }: { d: string; at: number; dash?: string; className?: string }) {
  return dash
    ? <path d={d} strokeDasharray={dash} className={`bp-fade ${className}`} style={{ "--d": `${at + 0.3}s` } as React.CSSProperties} />
    : <path d={d} pathLength={1} className={`bp-draw ${className}`} style={{ "--d": `${at}s` } as React.CSSProperties} />;
}

function Arrow({ x, y, dir, at }: { x: number; y: number; dir: Dir; at: number }) {
  const p = { r: `M${x} ${y}l-8 -4v8z`, l: `M${x} ${y}l8 -4v8z`, u: `M${x} ${y}l-4 8h8z`, d: `M${x} ${y}l-4 -8h8z` }[dir];
  return <path d={p} className="bp-fill bp-fade" style={{ "--d": `${at}s` } as React.CSSProperties} />;
}

function Valve({ x, y, v = false, at }: { x: number; y: number; v?: boolean; at: number }) {
  return v
    ? <Line d={`M${x - 7} ${y - 10}h14l-14 20h14z`} at={at} />
    : <Line d={`M${x - 10} ${y - 7}v14l20 -14v14z`} at={at} />;
}

/** What the letters on a bubble mean (ISA 5.1), shown on hover or tap. */
const MEANS: Record<string, string> = {
  LT: "Level transmitter",
  LIC: "Level controller",
  PI: "Pressure gauge",
  TI: "Temperature gauge",
  FT: "Flow transmitter",
};

function Bubble({ x, y, tag, n, at, side = "r" }: { x: number; y: number; tag: string; n: string; at: number; side?: "r" | "l" }) {
  return (
    <g className="bp-tag">
      <circle cx={x} cy={y} r="26" className="bp-hit" />
      <circle cx={x} cy={y} r="19" pathLength={1} className="bp-draw bp-ring" style={{ "--d": `${at}s` } as React.CSSProperties} />
      <Line d={`M${x - 19} ${y}h38`} at={at + 0.15} />
      <text x={x} y={y - 5} className="bp-t bp-fade" style={{ "--d": `${at + 0.3}s` } as React.CSSProperties}>{tag}</text>
      <text x={x} y={y + 13} className="bp-t bp-fade" style={{ "--d": `${at + 0.3}s` } as React.CSSProperties}>{n}</text>
      <text x={side === "r" ? x + 28 : x - 28} y={y + 4} className={`bp-means ${side === "l" ? "is-left" : ""}`}>{MEANS[tag] ?? tag}-{n}</text>
    </g>
  );
}

export function Blueprint({ className = "" }: { className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false" className={`bp-svg ${className}`}>
      <defs>
        <pattern id={`${id}g`} width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="currentColor" strokeWidth=".6" />
        </pattern>
        <pattern id={`${id}m`} width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M100 0H0V100" fill="none" stroke="currentColor" strokeWidth=".9" />
        </pattern>
        <clipPath id={`${id}col`}><rect x="392" y="70" width="76" height="330" rx="38" /></clipPath>
      </defs>

      {/* The drafting grid. */}
      <g className="bp-grid">
        <rect width="1200" height="800" fill={`url(#${id}g)`} opacity=".06" />
        <rect width="1200" height="800" fill={`url(#${id}m)`} opacity=".09" />
      </g>

      <g transform="translate(180 110)">
        {/* What's in the column, moving slowly. */}
        <g clipPath={`url(#${id}col)`}>
          <rect x="392" y="300" width="76" height="140" className="bp-level" />
        </g>

        <g className="bp-lines" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
          {/* Column with trays. */}
          <rect x="392" y="70" width="76" height="330" rx="38" pathLength={1} className="bp-draw" style={{ "--d": "0.05s" } as React.CSSProperties} />
          {[128, 168, 208, 248, 288, 328].map((y, i) => <Line key={y} d={`M398 ${y}h64`} dash="5 5" at={0.35 + i * 0.05} />)}
          {/* Overhead vapor to the reflux drum. */}
          <Line d="M430 70V36H180V78" at={0.25} />
          <Arrow x={300} y={36} dir="l" at={1.0} />
          <rect x="110" y="78" width="150" height="52" rx="26" pathLength={1} className="bp-draw" style={{ "--d": "0.4s" } as React.CSSProperties} />
          <Line d="M150 130v26" at={0.55} />
          {/* Reflux back to the column through the control valve. */}
          <Line d="M150 156v44h80" at={0.6} />
          <Line d="M262 200h130" at={0.7} />
          <Arrow x={360} y={200} dir="r" at={1.05} />
          <path d="M230 190l16 10-16 10zM262 190l-16 10 16 10z" className="bp-fill bp-fade" style={{ "--d": "0.8s" } as React.CSSProperties} />
          <Line d="M246 200v-22" at={0.8} />
          <path d="M232 178a14 14 0 0 1 28 0z" className="bp-fill bp-fade" style={{ "--d": "0.85s" } as React.CSSProperties} />
          {/* Level loop on the column, its signal to the valve. */}
          <Line d="M468 150h33" dash="2 4" at={0.7} />
          <Line d="M520 169v44" dash="2 4" at={0.75} />
          <Line d="M501 232h-60v-60H246" dash="2 4" at={0.8} />
          {/* Bottoms to the pump, and on. */}
          <Line d="M430 400v40h88" at={0.45} />
          <Valve x={476} y={440} at={0.7} />
          <circle cx="540" cy="452" r="22" pathLength={1} className="bp-draw" style={{ "--d": "0.6s" } as React.CSSProperties} />
          <Line d="M540 430h22v-40" at={0.75} />
          <Line d="M524 470l-8 18h48l-8-18" at={0.7} />
          <Arrow x={562} y={398} dir="u" at={1.1} />
          <Line d="M562 390V330h60" at={0.85} />
          <Line d="M600 309v21" dash="2 4" at={0.9} />
          {/* Reboiler, and its return to the column. */}
          <rect x="150" y="410" width="190" height="56" rx="28" pathLength={1} className="bp-draw" style={{ "--d": "0.3s" } as React.CSSProperties} />
          <Line d="M190 410v56M190 426h120M190 450h120" at={0.55} />
          <Line d="M310 426a12 12 0 0 1 0 24" at={0.65} />
          <Line d="M340 438h52V372" at={0.6} />
          <Arrow x={392} y={384} dir="u" at={1.1} />
          <Line d="M245 410v-26H130" at={0.65} />
          <Line d="M245 466v24H150" at={0.7} />
          <Arrow x={170} y={490} dir="l" at={1.15} />
          <Valve x={95} y={384} at={0.8} />
          <Line d="M85 384H40" at={0.85} />
          <Line d="M366 481v-43" dash="2 4" at={0.9} />
          {/* Feed, with its flow transmitter. */}
          <Line d="M30 300h362" at={0.15} />
          <Arrow x={300} y={300} dir="r" at={1.0} />
          <Valve x={70} y={300} at={0.5} />
          <Line d="M120 275v25" dash="2 4" at={0.6} />
        </g>

        {/* Product moving through the lines, in its flow direction. */}
        <g className="bp-flow" fill="none" strokeLinecap="round">
          <path d="M30 300h362" />
          <path d="M430 70V36H180V78" />
          <path d="M150 130v70h80M262 200h130" />
          <path d="M430 400v40h88" />
          <path d="M540 430h22V330h60" />
          <path d="M340 438h52V372" />
        </g>

        <g fill="none" stroke="currentColor" strokeWidth="1.5">
          <Bubble x={520} y={150} tag="LT" n="101" at={0.75} side="l" />
          <Bubble x={520} y={232} tag="LIC" n="101" at={0.8} side="l" />
          <Bubble x={600} y={290} tag="PI" n="102" at={0.95} side="l" />
          <Bubble x={366} y={500} tag="TI" n="204" at={0.9} />
          <Bubble x={120} y={256} tag="FT" n="310" at={0.65} side="r" />
        </g>
      </g>
    </svg>
  );
}

export default Blueprint;
