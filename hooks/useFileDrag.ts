"use client";

// A drop box that answers back: while files are dragged over it, it lights
// up and says what will happen. Only file drags count (not text or rows).
import { useRef, useState } from "react";

export function useFileDrag(
  onFiles: (files: File[]) => void,
  disabled = false,
  /** Take the whole drop instead (e.g. to read dragged folders with their
   *  structure); onFiles is then not called. */
  onDropEvent?: (e: React.DragEvent) => void,
) {
  const [count, setCount] = useState(0);
  const depth = useRef(0);
  const isFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const bind = {
    onDragEnter: (e: React.DragEvent) => {
      if (disabled || !isFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setCount(Math.max(1, e.dataTransfer.items?.length ?? 1));
    },
    onDragOver: (e: React.DragEvent) => {
      if (disabled || !isFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!isFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setCount(0);
    },
    onDrop: (e: React.DragEvent) => {
      if (disabled || !isFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setCount(0);
      if (onDropEvent) { onDropEvent(e); return; }
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length) onFiles(files);
    },
  };
  return {
    over: count > 0,
    bind,
    /** Classes for the box while a file is over it. */
    ring: count > 0 ? "ring-2 ring-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "",
    /** What letting go will do. */
    say: count > 1 ? `Let go to add ${count} files` : "Let go to add it",
  };
}
