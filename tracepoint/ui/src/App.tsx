import { useCallback, useEffect, useState } from "react";
import { api, onEvent } from "./lib/api";
import type { AppState } from "./lib/types";
import { Boot } from "./screens/Boot";
import { Login } from "./screens/Login";
import { ChangePassword } from "./screens/ChangePassword";
import { Shell } from "./Shell";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
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
    const offOut = onEvent("signed-out", () => refresh());
    return () => { offIndex(); offOut(); };
  }, [refresh]);
  // Poll while the index is loading, in case an event is missed.
  useEffect(() => {
    if (!state || state.index.ready || state.index.error) return;
    const t = setInterval(refresh, 700);
    return () => clearInterval(t);
  }, [state, refresh]);

  if (!state) return <Boot message={failed ?? "Starting TracePoint…"} error={!!failed} />;
  if (state.stage === "login") return <Login state={state} onDone={setState} />;
  if (state.stage === "change_password") return <ChangePassword state={state} onDone={setState} />;
  if (!state.index.ready) return <Boot message={state.index.message} error={!!state.index.error} />;
  return <Shell state={state} setState={setState} refresh={refresh} />;
}
