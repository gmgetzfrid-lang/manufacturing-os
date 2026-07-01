"use client";

// SignaturePad — a touchpad "sign your name" canvas. Works with mouse, finger,
// and stylus via pointer events. Emits the drawn signature as a PNG data URL on
// each stroke end (null when empty / cleared). High-DPI aware.

import React, { useRef, useState, useCallback, useEffect } from "react";
import { Eraser } from "lucide-react";

export default function SignaturePad({ onChange, height = 160, className = "" }: {
  onChange: (dataUrl: string | null) => void;
  height?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const inkRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, [height]);

  useEffect(() => { setup(); }, [setup]);

  // A resize changes the backing store and wipes the drawing — reset cleanly.
  useEffect(() => {
    const onResize = () => {
      setup();
      if (inkRef.current) { inkRef.current = false; setHasInk(false); onChange(null); }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setup, onChange]);

  const pointFrom = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    drawing.current = true;
    last.current = pointFrom(e);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !last.current) return;
    const p = pointFrom(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!inkRef.current) { inkRef.current = true; setHasInk(true); }
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    const canvas = canvasRef.current;
    if (canvas && inkRef.current) onChange(canvas.toDataURL("image/png"));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    inkRef.current = false;
    setHasInk(false);
    onChange(null);
  };

  return (
    <div className={className}>
      <div className="relative rounded-lg border border-[var(--color-border)] bg-white overflow-hidden">
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height, touchAction: "none", cursor: "crosshair", display: "block" }}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          onPointerCancel={end}
        />
        <div className="pointer-events-none absolute inset-x-6 bottom-7 border-b border-dashed border-slate-300" />
        {!hasInk && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-400 select-none">
            Sign here with your mouse, finger, or stylus
          </div>
        )}
      </div>
      <div className="flex justify-end mt-1">
        <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <Eraser className="w-3 h-3" /> Clear
        </button>
      </div>
    </div>
  );
}
