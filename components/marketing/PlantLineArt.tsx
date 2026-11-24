// A fragment of a P&ID, drawn in fine lines for the front door's brand
// side: a column with its trays, a reflux drum, a shell-and-tube
// exchanger, a pump, the control valve from the app mark, instrument
// bubbles with their tags, signal lines, flow arrows, a drafting grid and
// a corner of the title block. It is decoration (aria-hidden), drawn in
// currentColor at low strength so the form beside it stays the focus; the
// valve's actuator keeps the mark's warm accent, faintly.

"use client";

import React, { useId } from "react";
import { MARK_ACCENT } from "@/components/brand/AppMark";

/** An instrument bubble: a circle, the line through it (in the control
 *  room), the letters above and the loop number below. */
function Bubble({ x, y, tag, n }: { x: number; y: number; tag: string; n: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r="19" />
      <path d={`M${x - 19} ${y}h38`} />
      <text x={x} y={y - 5} className="pla-t">{tag}</text>
      <text x={x} y={y + 13} className="pla-t">{n}</text>
    </g>
  );
}

/** A flow arrow on a line, pointing along (dx, dy). */
function Arrow({ x, y, dir }: { x: number; y: number; dir: "r" | "l" | "u" | "d" }) {
  const p = { r: `M${x} ${y}l-8 -4v8z`, l: `M${x} ${y}l8 -4v8z`, u: `M${x} ${y}l-4 8h8z`, d: `M${x} ${y}l-4 -8h8z` }[dir];
  return <path d={p} className="pla-fill" />;
}

/** A gate valve on a line (horizontal or vertical). */
function Valve({ x, y, v = false }: { x: number; y: number; v?: boolean }) {
  return v
    ? <path d={`M${x - 7} ${y - 10}h14l-14 20h14z`} />
    : <path d={`M${x - 10} ${y - 7}v14l20 -14v14z`} />;
}

export function PlantLineArt({ className = "", style, preserveAspectRatio = "xMaxYMax slice" }: {
  className?: string;
  style?: React.CSSProperties;
  preserveAspectRatio?: string;
}) {
  // Pattern ids are per drawing, so two on a page never borrow each other's.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg viewBox="0 0 640 600" preserveAspectRatio={preserveAspectRatio} aria-hidden focusable="false" className={className} style={style}>
      <defs>
        <pattern id={`${id}g`} width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="currentColor" strokeWidth=".6" />
        </pattern>
        <pattern id={`${id}m`} width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M100 0H0V100" fill="none" stroke="currentColor" strokeWidth=".9" />
        </pattern>
      </defs>
      <style>{`
        .pla-t { font: 600 10px var(--font-display), "Barlow Semi Condensed", sans-serif; fill: currentColor; stroke: none; text-anchor: middle; }
        .pla-s { font: 400 9px var(--font-sans), "Barlow", sans-serif; fill: currentColor; stroke: none; }
        .pla-fill { fill: currentColor; stroke: none; }
      `}</style>

      {/* The drafting grid. */}
      <rect width="640" height="600" fill={`url(#${id}g)`} opacity=".05" />
      <rect width="640" height="600" fill={`url(#${id}m)`} opacity=".07" />

      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" opacity=".36">
        {/* Column with trays, and its nozzles. */}
        <rect x="392" y="70" width="76" height="330" rx="38" />
        <g strokeDasharray="5 5" opacity=".7">
          {[128, 168, 208, 248, 288, 328].map((y) => <path key={y} d={`M398 ${y}h64`} />)}
        </g>
        {/* Overhead vapor to the condenser, then the reflux drum. */}
        <path d="M430 70V36H180V78" />
        <Arrow x={300} y={36} dir="l" />
        <rect x="110" y="78" width="150" height="52" rx="26" />
        <path d="M150 130v26" />
        {/* Reflux back to the column through the control valve. */}
        <path d="M150 156v44h80" />
        <path d="M262 200h130" />
        <Arrow x={360} y={200} dir="r" />
        {/* The control valve (the app mark): bowtie, stem, actuator. */}
        <path d="M230 190l16 10-16 10zM262 190l-16 10 16 10z" className="pla-fill" />
        <path d="M246 200v-22" />
        <path d="M232 178a14 14 0 0 1 28 0z" fill={MARK_ACCENT} stroke="none" opacity=".75" />
        {/* Level loop on the column, its signal to the valve. */}
        <Bubble x={520} y={150} tag="LT" n="101" />
        <path d="M468 150h33" strokeDasharray="2 4" />
        <Bubble x={520} y={232} tag="LIC" n="101" />
        <path d="M520 169v44" strokeDasharray="2 4" />
        <path d="M501 232h-60v-60H246" strokeDasharray="2 4" opacity=".8" />
        {/* Bottoms to the pump. */}
        <path d="M430 400v40h88" />
        <Valve x={476} y={440} />
        <circle cx="540" cy="452" r="22" />
        <path d="M540 430h22v-40" />
        <path d="M524 470l-8 18h48l-8-18" />
        <Arrow x={562} y={398} dir="u" />
        <path d="M562 390V330h60" />
        <Bubble x={600} y={290} tag="PI" n="102" />
        <path d="M600 309v21" strokeDasharray="2 4" />
        {/* Reboiler: shell and tube, the return to the column. */}
        <rect x="150" y="410" width="190" height="56" rx="28" />
        <path d="M190 410v56M190 426h120M190 450h120" />
        <path d="M310 426a12 12 0 0 1 0 24" />
        <path d="M340 438h52V372" />
        <Arrow x={392} y={384} dir="u" />
        <path d="M245 410v-26H130" />
        <path d="M245 466v24H150" />
        <Arrow x={170} y={490} dir="l" />
        <Valve x={95} y={384} />
        <path d="M85 384H40" />
        <Bubble x={366} y={500} tag="TI" n="204" />
        <path d="M366 481v-43" strokeDasharray="2 4" />
        {/* Flow transmitter on the feed. */}
        <path d="M30 300h200" />
        <path d="M230 300h162" opacity=".9" />
        <Arrow x={300} y={300} dir="r" />
        <Bubble x={120} y={256} tag="FT" n="310" />
        <path d="M120 275v25" strokeDasharray="2 4" />
        <Valve x={70} y={300} />
      </g>

      {/* The title block, in the sheet's bottom-right corner. */}
      <g fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".3">
        <path d="M498 548h142M498 548v52M562 548v52M498 574h142" />
        <text x="505" y="565" className="pla-s">Unit 100</text>
        <text x="569" y="565" className="pla-s">100-PID-042</text>
        <text x="505" y="591" className="pla-s">Rev C</text>
        <text x="569" y="591" className="pla-s">Sheet 1 of 3</text>
      </g>
    </svg>
  );
}

export default PlantLineArt;
