// Test helper for lib/__tests__/cornerDock.test.ts — a drawer that declares
// the right rail the way InspectorDrawer / HistoryDrawer do.
import React, { useRef } from "react";
import { useOccupyRightRail } from "@/components/ui/CornerDock";

export default function RailProbe({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useOccupyRightRail(ref, open);
  return <div ref={ref} />;
}
