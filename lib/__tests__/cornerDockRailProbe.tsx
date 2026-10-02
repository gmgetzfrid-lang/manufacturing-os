// Test helpers for lib/__tests__/cornerDock.test.ts — a drawer that declares
// the right rail the way InspectorDrawer / HistoryDrawer do, a bottom sheet
// that declares its action row the way the upload modals do, and the shared
// Modal with its ModalFooter.
import React, { useRef } from "react";
import { useOccupyRightRail, useDockAvoid } from "@/components/ui/CornerDock";
import { Modal, ModalFooter } from "@/components/ui/Modal";

export default function RailProbe({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useOccupyRightRail(ref, open);
  return <div ref={ref} />;
}

export function AvoidProbe() {
  const ref = useRef<HTMLDivElement>(null);
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
