"use client";

// DocScanner: a phone document scanner, built by hand (no OpenCV, no new
// packages). The phone's own camera app takes the photo (so focus and
// flash work), we find the page, the person nudges the corners, and each
// page is squared up and cleaned to crisp black and white (or kept in
// color). Pages collect in a strip; Done hands back one PDF.
//
//   <DocScanner open={open} title="Scan the signed Exchanger closure"
//     onClose={() => setOpen(false)}
//     onDone={({ pdf, pages, qr }) => save(pdf)} />
//
// The pixel work lives in lib/scan (pure functions with tests). For each
// page only the squared-up original is kept, as a JPEG, so switching
// between black and white and color re-cleans from it without holding a
// large pixel buffer per page in a phone's memory.

import React from "react";
import { createPortal } from "react-dom";
import { Camera, ImageIcon, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { findPage } from "@/lib/scan/detect";
import { type ImageDataLike, toColor, toDocument, warp } from "@/lib/scan/enhance";
import { type Pt, type Quad, insetQuad, isConvex, orderQuad, outputSize } from "@/lib/scan/geometry";

type Mode = "bw" | "color";
type Step = "camera" | "adjust" | "pages";

export type DocScannerProps = {
  open: boolean;
  /** What's being scanned, shown at the top: "Scan the signed Exchanger closure". */
  title: string;
  /** "bw" for forms (default), "color" for photos. */
  mode?: Mode;
  onClose: () => void;
  /** The finished scan. `qr` is the text of a QR code found on the first page (when the browser can read QR codes), else null. */
  onDone: (out: { pdf: Uint8Array; pages: number; qr: string | null }) => void;
};

/** Long side of the working photo. Plenty for a 1700 x 2200 page and
 *  well inside a phone's canvas limits. */
const MAX_SIDE = 2600;
const JPEG_QUALITY = 0.82;
/** Trim a hair (0.5%) off the page's edge, as a copier does, so no line of desk shows. */
const EDGE_TRIM = 0.005;
/** Room around the photo so a corner handle at the very edge can still be grabbed. */
const PAD = 24;
const LOUPE = 112;
const CORNERS = ["Top left", "Top right", "Bottom right", "Bottom left"] as const;
const READING = "Reading the photo…";
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

type Photo = {
  /** The working photo (kept for the magnifier). */
  canvas: HTMLCanvasElement;
  pixels: ImageData;
  /** A smaller JPEG for the screen. */
  previewUrl: string;
  w: number;
  h: number;
  quad: Quad;
  confident: boolean;
};

type Page = {
  id: number;
  /** The squared-up photo before cleaning; the toggle re-cleans from this. */
  original: Blob;
  mode: Mode;
  jpeg: Uint8Array;
  w: number;
  h: number;
  thumb: string;
  qr: string | null;
};

type Problem = { title: string; next: string };

export default function DocScanner(props: DocScannerProps): React.JSX.Element | null {
  // Mounting the sheet only while open starts every scan from a clean slate.
  if (!props.open || typeof document === "undefined") return null;
  return <ScannerSheet {...props} />;
}

function ScannerSheet({ title, mode: startMode = "bw", onClose, onDone }: DocScannerProps) {
  const [step, setStep] = React.useState<Step>("camera");
  const [mode, setMode] = React.useState<Mode>(startMode);
  const [photo, setPhoto] = React.useState<Photo | null>(null);
  const [pages, setPages] = React.useState<Page[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<Problem | null>(null);
  const [removed, setRemoved] = React.useState<{ page: Page; at: number } | null>(null);
  const [confirmClose, setConfirmClose] = React.useState(false);
  /** Which button brought the last photo, so Retake and Add a page reopen the same one. */
  const [lastPick, setLastPick] = React.useState<"take" | "choose">("take");

  const panelRef = React.useRef<HTMLDivElement>(null);
  const takeRef = React.useRef<HTMLInputElement>(null);
  const chooseRef = React.useRef<HTMLInputElement>(null);
  const nextId = React.useRef(1);
  const alive = React.useRef(true);
  const titleId = React.useId();
  const hintId = React.useId();

  const n = pages.length;

  // Closing with pages scanned asks first; Escape steps back out of that ask.
  const requestClose = () => {
    if (confirmClose) { setConfirmClose(false); return; }
    if (n > 0) { setConfirmClose(true); return; }
    onClose();
  };
  useEscapeClose(requestClose);

  // While open: the page behind doesn't scroll, and focus goes back to
  // whatever opened the scanner when it closes.
  React.useEffect(() => {
    alive.current = true;
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      alive.current = false;
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);

  // Each step focuses its main control (marked data-autofocus), else the first one.
  React.useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    (panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel.querySelector<HTMLElement>(FOCUSABLE))?.focus();
  }, [step, confirmClose]);

  // The screen preview is a blob URL; let it go when the photo goes.
  const previewUrl = photo?.previewUrl;
  React.useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // Tab stays inside the dialog.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const list = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  /** Opens the camera (or the photo picker). Called straight from a tap,
   *  which the browser needs before it opens either. */
  const pick = (which: "take" | "choose") => {
    setLastPick(which);
    setProblem(null);
    (which === "take" ? takeRef : chooseRef).current?.click();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same photo can be picked again
    if (!file) return;
    setProblem(null);
    setBusy(READING);
    try {
      await nextPaint();
      const p = await loadPhoto(file);
      if (!alive.current) return;
      setPhoto(p);
      setStep("adjust");
    } catch {
      setStep("camera");
      setProblem({ title: "That photo couldn't be read.", next: "Try again." });
    } finally {
      setBusy(null);
    }
  };

  const retake = () => {
    setPhoto(null);
    setStep("camera");
    pick(lastPick);
  };

  const acceptPage = async () => {
    if (!photo) return;
    // Corners dragged past each other still make a page once put back in order.
    const quad = orderQuad(photo.quad);
    if (!isConvex(quad)) {
      setProblem({ title: "Those corners don't make a page.", next: "Drag each one to a corner of the page." });
      return;
    }
    setProblem(null);
    setBusy("Squaring up the page…");
    try {
      await nextPaint();
      const { w, h } = outputSize(quad);
      const flat = warp(photo.pixels, insetQuad(quad, EDGE_TRIM), w, h);
      const original = await canvasBlob(canvasOf(flat), "image/jpeg", 0.92);
      const cleaned = await cleanPage(flat, mode, null);
      if (!alive.current) return;
      const id = nextId.current++;
      setPages((ps) => [...ps, { id, original, mode, w, h, ...cleaned }]);
      setPhoto(null);
      setRemoved(null);
      setStep("pages");
    } catch {
      setProblem({ title: "That page couldn't be squared up.", next: "Try again." });
    } finally {
      setBusy(null);
    }
  };

  const switchMode = async (next: Mode) => {
    if (next === mode || busy) return;
    const prev = mode;
    setMode(next);
    setRemoved(null); // an undone page would come back in the old look
    if (!pages.some((p) => p.mode !== next)) return;
    setProblem(null);
    setBusy(next === "bw" ? "Making the pages black and white…" : "Putting the color back…");
    try {
      await nextPaint();
      const out: Page[] = [];
      for (const p of pages) out.push(p.mode === next ? p : await recolor(p, next));
      if (!alive.current) return;
      setPages(out);
    } catch {
      setMode(prev);
      setProblem({ title: "The pages couldn't be changed.", next: "Try again." });
    } finally {
      setBusy(null);
    }
  };

  const removePage = (id: number) => {
    const at = pages.findIndex((p) => p.id === id);
    if (at < 0) return;
    setRemoved({ page: pages[at], at });
    setPages(pages.filter((p) => p.id !== id));
  };

  const undoRemove = () => {
    if (!removed) return;
    const { page, at } = removed;
    setPages((ps) => { const c = ps.slice(); c.splice(Math.min(at, c.length), 0, page); return c; });
    setRemoved(null);
  };

  const addPage = () => {
    setRemoved(null);
    setStep("camera");
    pick(lastPick);
  };

  const finish = async () => {
    if (!n || busy) return;
    setProblem(null);
    setBusy("Making the PDF…");
    try {
      // pdf-lib only loads when a scan is finished, not with the page.
      const { pagesToPdf } = await import("@/lib/scan/toPdf");
      const pdf = await pagesToPdf(pages.map((p) => ({ jpeg: p.jpeg, w: p.w, h: p.h })));
      if (!alive.current) return;
      // The first page's code; failing that, the first one on any page.
      const qr = pages[0].qr ?? pages.find((p) => p.qr)?.qr ?? null;
      onDone({ pdf, pages: n, qr });
    } catch {
      setProblem({ title: "The PDF couldn't be made.", next: "Try again." });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const subtitle = step === "pages" ? (n ? pageWord(n) : "No pages yet") : `Page ${n + 1}`;
  const hint = step === "adjust" && photo
    ? photo.confident ? "Drag the corners to the page's edges." : "Couldn't find the page edges. Drag the corners to them."
    : null;

  return createPortal(
    <div className="fixed inset-0 z-[450] flex sm:items-center sm:justify-center sm:p-4">
      <div aria-hidden className="absolute inset-0 bg-[var(--color-ink)]/55" onClick={requestClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        className={`relative flex flex-col w-full h-full overflow-hidden bg-[var(--color-surface)] text-[var(--color-text)] sm:max-w-2xl sm:rounded-xl sm:border sm:border-[var(--color-border)] ui-float ui-float-in ${
          step === "adjust" ? "sm:h-[min(90dvh,860px)]" : "sm:h-auto sm:max-h-[90dvh]"
        }`}
      >
        {/* Title and close */}
        <div className="shrink-0 flex items-start gap-3 px-4 sm:px-5 pt-[max(12px,env(safe-area-inset-top))] sm:pt-4 pb-3 border-b border-[var(--color-border)]">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} title={title} className="font-display text-section leading-tight font-semibold line-clamp-2 break-words">{title}</h2>
            <p className="mt-0.5 text-body text-[var(--color-text-muted)]">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            title="Close"
            className="ui-press shrink-0 -mr-1 inline-flex items-center justify-center w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          >
            <X aria-hidden className="w-5 h-5" />
          </button>
        </div>

        {/* The step */}
        {step === "camera" && (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-8 flex flex-col items-center justify-center gap-4 text-center">
            <p className="max-w-sm text-reading text-[var(--color-text)]">
              Lay the page flat on a darker surface, in good light. Get all four corners in the photo.
            </p>
            {n > 0 && (
              <Button variant="ghost" onClick={() => setStep("pages")} disabled={!!busy}>
                Back to {pageWord(n)}
              </Button>
            )}
          </div>
        )}

        {step === "adjust" && photo && (
          <CornerEditor
            photo={photo}
            describedBy={hintId}
            disabled={!!busy}
            onChange={(quad) => setPhoto((p) => (p ? { ...p, quad } : p))}
          />
        )}

        {step === "pages" && (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 flex flex-col gap-4">
            <div role="radiogroup" aria-label="Look" className={`${bandSeg} self-start`}>
              {([["bw", "Black and white"], ["color", "Color"]] as const).map(([v, label]) => (
                <button key={v} type="button" role="radio" aria-checked={mode === v} disabled={!!busy}
                  onClick={() => switchMode(v)} className={`ui-press ${bandSegItem(mode === v)}`}>
                  {label}
                </button>
              ))}
            </div>
            {n === 0 ? (
              <p className="text-reading text-[var(--color-text-muted)]">No pages yet. Add a page to start the scan.</p>
            ) : (
              <ol className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {pages.map((p, i) => (
                  <li key={p.id} className="min-w-0 flex flex-col gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL the image optimizer can't take */}
                    <img
                      src={p.thumb}
                      alt={`Page ${i + 1}`}
                      className="w-full aspect-[17/22] object-contain rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)]"
                    />
                    <span className="text-body text-[var(--color-text-muted)]">Page {i + 1}</span>
                    <Button variant="secondary" size="sm" className="w-full" disabled={!!busy}
                      aria-label={`Remove page ${i + 1}`} onClick={() => removePage(p.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ol>
            )}
            {removed && (
              <p className="flex flex-wrap items-center gap-x-2 text-body text-[var(--color-text)]">
                Page {removed.at + 1} removed.
                <Button variant="tertiary" size="sm" onClick={undoRemove}>Undo</Button>
              </p>
            )}
          </div>
        )}

        {/* Status, then the actions, within thumb reach */}
        <div className="shrink-0 border-t border-[var(--color-border)] px-4 sm:px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:pb-4 flex flex-col gap-3">
          <div aria-live="polite">
            {busy ? (
              <p className="flex items-center gap-2 text-reading text-[var(--color-text-muted)]">
                <Loader2 aria-hidden className="w-4 h-4 shrink-0 animate-spin" />
                {busy}
              </p>
            ) : problem ? (
              <ErrorNote compact title={problem.title} next={problem.next} />
            ) : hint ? (
              <p id={hintId} className={`text-reading text-[var(--color-text)] ${photo?.confident ? "" : "font-medium"}`}>{hint}</p>
            ) : null}
          </div>

          {confirmClose ? (
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-reading font-medium">Discard {pageWord(n)}?</p>
                <p className="text-body text-[var(--color-text-muted)]">You can&apos;t undo this.</p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                <Button variant="secondary" data-autofocus onClick={() => setConfirmClose(false)}>Keep scanning</Button>
                <Button variant="danger" onClick={onClose}>Discard</Button>
              </div>
            </div>
          ) : step === "camera" ? (
            <div className="flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
              <Button data-autofocus className="w-full sm:w-auto min-h-12" loading={busy === READING && lastPick === "take"}
                disabled={!!busy} onClick={() => pick("take")}>
                <Camera aria-hidden className="w-5 h-5" />Take a photo
              </Button>
              <Button variant="secondary" className="w-full sm:w-auto" loading={busy === READING && lastPick === "choose"}
                disabled={!!busy} onClick={() => pick("choose")}>
                <ImageIcon aria-hidden className="w-4 h-4" />Choose a photo
              </Button>
            </div>
          ) : step === "adjust" ? (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
              <Button variant="secondary" disabled={!!busy} onClick={retake}>Retake</Button>
              <Button data-autofocus loading={!!busy} onClick={acceptPage}>Use this page</Button>
            </div>
          ) : n > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
              <Button variant="secondary" disabled={!!busy} onClick={addPage}>Add a page</Button>
              <Button data-autofocus loading={busy === "Making the PDF…"} disabled={!!busy} onClick={finish}>
                Done: {pageWord(n)}
              </Button>
            </div>
          ) : (
            <div className="flex sm:justify-end">
              <Button data-autofocus className="w-full sm:w-auto" disabled={!!busy} onClick={addPage}>Add a page</Button>
            </div>
          )}
        </div>

        {/* The phone's own camera app (capture), and a plain picker for
            desktops or photos already taken. Opened by the buttons above. */}
        <input ref={takeRef} type="file" accept="image/*" capture="environment" tabIndex={-1} aria-hidden className="sr-only" onChange={onFile} />
        <input ref={chooseRef} type="file" accept="image/*" tabIndex={-1} aria-hidden className="sr-only" onChange={onFile} />
      </div>
    </div>,
    document.body,
  );
}

// ── Corner editor ────────────────────────────────────────────────────

/** The photo fitted to the space, the page outlined, and a draggable
 *  handle on each corner. While dragging, a magnifier above the finger
 *  shows what's under it. Arrow keys move a focused corner (Shift for
 *  bigger steps), so dragging is never the only way. */
function CornerEditor({ photo, onChange, describedBy, disabled }: {
  photo: Photo;
  onChange: (q: Quad) => void;
  describedBy: string;
  disabled: boolean;
}) {
  const stageRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const loupeRef = React.useRef<HTMLCanvasElement>(null);
  const grab = React.useRef<{ i: number; dx: number; dy: number } | null>(null);
  const [box, setBox] = React.useState({ w: 0, h: 0 });
  const [active, setActive] = React.useState<number | null>(null);

  // Fit the photo in the stage, and again when the screen turns or resizes.
  // The observer reports the first size itself, before the first paint.
  React.useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const s = Math.min(Math.max(0, el.clientWidth - 2 * PAD) / photo.w, Math.max(0, el.clientHeight - 2 * PAD) / photo.h);
      setBox({ w: photo.w * s, h: photo.h * s });
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [photo.w, photo.h]);

  const scale = box.w > 0 ? box.w / photo.w : 0;
  const q = photo.quad;
  const shown = q.map((p) => ({ x: p.x * scale, y: p.y * scale }));

  const toPhoto = (clientX: number, clientY: number): Pt | null => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || !scale) return null;
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  };
  const place = (i: number, p: Pt) => {
    const next = q.slice() as Quad;
    next[i] = { x: clamp(p.x, 0, photo.w - 1), y: clamp(p.y, 0, photo.h - 1) };
    onChange(next);
  };
  const endDrag = () => { grab.current = null; setActive(null); };

  // The magnifier: the full-size photo around the corner, 2.5x the screen view.
  React.useEffect(() => {
    if (active === null || !scale) return;
    const c = loupeRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(LOUPE * dpr);
    c.height = Math.round(LOUPE * dpr);
    const span = LOUPE / (scale * 2.5);
    const p = q[active];
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(photo.canvas, p.x - span / 2, p.y - span / 2, span, span, 0, 0, c.width, c.height);
  }, [active, q, scale, photo.canvas]);

  const outline = shown.map((p) => `${p.x},${p.y}`).join(" ");
  const loupeAt = active === null ? null : {
    left: clamp(shown[active].x - LOUPE / 2, -PAD / 2, box.w - LOUPE + PAD / 2),
    // Above the finger; below it when the corner is near the top.
    top: shown[active].y - LOUPE - 36 >= -PAD / 2 ? shown[active].y - LOUPE - 36 : shown[active].y + 36,
  };

  return (
    <div ref={stageRef} className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-[var(--color-ink)] touch-none" style={{ padding: PAD }}>
      <div ref={boxRef} className="relative shrink-0" style={{ width: box.w, height: box.h }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a local blob URL of the photo just taken */}
        <img src={photo.previewUrl} alt="Your photo of the page" draggable={false} className="absolute inset-0 w-full h-full select-none" />
        {scale > 0 && (
          <svg aria-hidden className="absolute inset-0 pointer-events-none" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`}>
            {/* Dim what's outside the page, so the page reads at a glance. */}
            <path d={`M0 0H${box.w}V${box.h}H0Z M${shown.map((p) => `${p.x} ${p.y}`).join(" L")}Z`} fillRule="evenodd" style={{ fill: "var(--color-ink)", fillOpacity: 0.45 }} />
            <polygon points={outline} style={{ fill: "none", stroke: "var(--color-ink-fg)", strokeOpacity: 0.85, strokeWidth: 4, strokeLinejoin: "round" }} />
            <polygon points={outline} style={{ fill: "none", stroke: "var(--color-current)", strokeWidth: 2, strokeLinejoin: "round" }} />
          </svg>
        )}
        {scale > 0 && shown.map((p, i) => (
          <button
            key={i}
            type="button"
            aria-label={`${CORNERS[i]} corner`}
            aria-describedby={describedBy}
            disabled={disabled}
            className="absolute w-11 h-11 -translate-x-1/2 -translate-y-1/2 rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing touch-none select-none disabled:cursor-default"
            style={{ left: p.x, top: p.y }}
            onPointerDown={(e) => {
              if (e.button !== 0 || disabled) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              const at = toPhoto(e.clientX, e.clientY);
              if (!at) return;
              // Keep the corner where it is under the finger: no jump on touch.
              grab.current = { i, dx: q[i].x - at.x, dy: q[i].y - at.y };
              setActive(i);
            }}
            onPointerMove={(e) => {
              const g = grab.current;
              if (!g || g.i !== i) return;
              const at = toPhoto(e.clientX, e.clientY);
              if (at) place(i, { x: at.x + g.dx, y: at.y + g.dy });
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={(e) => {
              const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
              if (!dir) return;
              e.preventDefault();
              const step = Math.max(photo.w, photo.h) * (e.shiftKey ? 0.02 : 0.004);
              place(i, { x: q[i].x + dir[0] * step, y: q[i].y + dir[1] * step });
            }}
          >
            <span
              aria-hidden
              className={`block size-[18px] rounded-full bg-[var(--color-ink-fg)] ring-[3px] ring-[var(--color-current)] shadow-[0_0_0_5px_color-mix(in_srgb,var(--color-ink)_40%,transparent)] transition-transform ${active === i ? "scale-125" : ""}`}
            />
          </button>
        ))}
        {loupeAt && (
          <div aria-hidden className="absolute pointer-events-none rounded-full overflow-hidden border-2 border-[var(--color-ink-fg)] bg-[var(--color-ink)] ui-float"
            style={{ left: loupeAt.left, top: loupeAt.top, width: LOUPE, height: LOUPE }}>
            <canvas ref={loupeRef} className="block w-full h-full" />
            {/* Crosshair on the exact corner point. */}
            <span className="absolute left-1/2 top-1/2 w-4 h-0.5 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-current)]" />
            <span className="absolute left-1/2 top-1/2 w-0.5 h-4 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-current)]" />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Pixels in and out ────────────────────────────────────────────────

/** Lets the browser paint the working state before heavy work holds the thread. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function pageWord(k: number): string {
  return `${k} ${k === 1 ? "page" : "pages"}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Decodes a photo upright: "from-image" follows the camera's EXIF turn. */
async function decode(file: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; done: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch {
      // Older browsers: an <img> below, which follows EXIF on its own.
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

/** A canvas holding `src` shrunk to fit `maxSide`. `readBack` keeps it in
 *  memory the CPU can read fast (getImageData). */
function fitCanvas(src: CanvasImageSource, w: number, h: number, maxSide: number, readBack = false): HTMLCanvasElement {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext("2d", readBack ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error("No canvas");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function canvasOf(img: ImageDataLike): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("No canvas");
  const out = ctx.createImageData(img.width, img.height);
  out.data.set(img.data);
  ctx.putImageData(out, 0, 0);
  return c;
}

function canvasBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the image"))), type, quality),
  );
}

async function loadPhoto(file: Blob): Promise<Photo> {
  const d = await decode(file);
  try {
    if (!d.w || !d.h) throw new Error("Empty image");
    const canvas = fitCanvas(d.src, d.w, d.h, MAX_SIDE, true);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("No canvas");
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { quad, confident } = findPage(pixels);
    const preview = fitCanvas(canvas, canvas.width, canvas.height, 1600);
    const previewUrl = URL.createObjectURL(await canvasBlob(preview, "image/jpeg", 0.85));
    return { canvas, pixels, previewUrl, w: canvas.width, h: canvas.height, quad, confident };
  } finally {
    d.done();
  }
}

/** Cleans a squared-up page into its final JPEG, a thumbnail, and any QR
 *  code on it (when the browser can read them). */
async function cleanPage(flat: ImageDataLike, mode: Mode, knownQr: string | null): Promise<{ jpeg: Uint8Array; thumb: string; qr: string | null }> {
  const canvas = canvasOf(mode === "bw" ? toDocument(flat) : toColor(flat));
  const blob = await canvasBlob(canvas, "image/jpeg", JPEG_QUALITY);
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const thumb = fitCanvas(canvas, canvas.width, canvas.height, 320).toDataURL("image/jpeg", 0.8);
  const qr = knownQr ?? (await readQr(canvas));
  return { jpeg, thumb, qr };
}

/** The same page cleaned the other way, from its kept original. */
async function recolor(page: Page, mode: Mode): Promise<Page> {
  const d = await decode(page.original);
  try {
    const c = fitCanvas(d.src, d.w, d.h, Infinity, true);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("No canvas");
    const flat = ctx.getImageData(0, 0, c.width, c.height);
    return { ...page, ...(await cleanPage(flat, mode, page.qr)), mode };
  } finally {
    d.done();
  }
}

type QrReader = { detect(src: ImageBitmapSource): Promise<Array<{ rawValue?: string }>> };

/** The first QR code's text, using the browser's own reader where there
 *  is one (Chrome on Android, Safari 17+). Null when there's no reader,
 *  no code, or any error: a QR code is a bonus, never a blocker. */
async function readQr(src: HTMLCanvasElement): Promise<string | null> {
  if (typeof window === "undefined" || !("BarcodeDetector" in window)) return null;
  try {
    const Reader = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => QrReader }).BarcodeDetector;
    const found = await new Reader({ formats: ["qr_code"] }).detect(src);
    return found.find((f) => f.rawValue)?.rawValue ?? null;
  } catch {
    return null;
  }
}
