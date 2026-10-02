// Test helpers for lib/__tests__/cornerDock.test.ts — a drawer that declares
// the right rail the way InspectorDrawer / HistoryDrawer do, a bottom sheet
// that raises the dock and declares its action row the way the upload modals
// do, the shared Modal with its ModalFooter (alone, and opened by a modal
// that raises the dock), and a replica of an overlay that declares nothing
// (the admin/assets asset editor).
import React, { useRef } from "react";
import { useOccupyRightRail, useDockAvoid, useDockRaise } from "@/components/ui/CornerDock";
import { Modal, ModalFooter } from "@/components/ui/Modal";

export default function RailProbe({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useOccupyRightRail(ref, open);
  return <div ref={ref} />;
}

export function AvoidProbe() {
  const ref = useRef<HTMLDivElement>(null);
  useDockRaise(true);
  useDockAvoid(ref, true);
  return <div ref={ref} data-test-row=""><button>Upload All</button></div>;
}

export function ModalProbe() {
  return (
    <Modal onClose={() => {}} size="2xl">
      <ModalFooter><button>Upload All</button></ModalFooter>
    </Modal>
  );
}

/** An upload-starting modal composed from the shared Modal: it raises the
 *  dock while open, and its ModalFooter declares the row. */
export function RaisingModalProbe() {
  useDockRaise(true);
  return <ModalProbe />;
}

/** The classes of app/(protected)/admin/assets/page.tsx:1971-1973 (the asset
 *  editor): a right-anchored z-400 drawer with Save in its bottom-right
 *  corner, declaring neither a rail nor a row. */
export function AssetEditorProbe() {
  return (
    <div className="fixed inset-0 z-[400] flex" data-test-drawer="">
      <div className="relative ml-auto w-full max-w-xl flex flex-col h-dvh">
        <div className="flex-1">fields</div>
        <div className="flex items-center justify-between"><button>Save</button></div>
      </div>
    </div>
  );
}
