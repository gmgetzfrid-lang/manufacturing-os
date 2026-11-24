"use client";

// Loads the timing view (components/system/TimingPanel) only when this tab
// asked for it with ?timing=1; everyone else downloads nothing more.

import React, { useEffect, useState } from "react";
import { timingOn } from "@/lib/requestLog";

export default function TimingHost() {
  const [Panel, setPanel] = useState<React.ComponentType | null>(null);
  useEffect(() => {
    if (!timingOn()) return;
    let alive = true;
    void import("./TimingPanel").then((m) => { if (alive) setPanel(() => m.default); });
    return () => { alive = false; };
  }, []);
  return Panel ? <Panel /> : null;
}
