import { useCallback, useEffect, useState } from "react";
import { api, onEvent } from "./lib/api";
import type { AppState } from "./lib/types";
import { Boot } from "./screens/Boot";
import { Welcome } from "./screens/Welcome";
import { Shell } from "./Shell";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [enter, setEnter] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setState(await api<AppState>("state"));
      setFailed(null);
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, []);
  useEffect(() => {
    refresh();
    const offIndex = onEvent("index", () => refresh());
    const offNotice = onEvent("notice", () => refresh());
    return () => { offIndex(); offNotice(); };
  }, [refresh]);
  // Poll while the index is loading, in case an event is missed.
  useEffect(() => {
    if (!state || state.index.ready || state.index.error) return;
    const t = setInterval(refresh, 700);
    return () => clearInterval(t);
  }, [state, refresh]);

  if (!state) return <Boot message={failed ?? "Starting TracePoint…"} error={!!failed} />;
  if (!state.index.ready && !state.index.error && !enter) return <Boot message={state.index.message} />;
  if (!state.index.ready && !enter) return <Welcome state={state} refresh={refresh} onContinue={() => { window.location.hash = "/sources"; setEnter(true); }} />;
  return <Shell state={state} setState={setState} refresh={refresh} />;
}
