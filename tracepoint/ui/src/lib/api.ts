// Bridge to the TracePoint backend. In the Windows app the page is served by
// the exe itself (http://tp.localhost); in development by tpserve. Either
// way: POST /api/<command> with JSON, and server-pushed events arrive as
// window "tp:<name>" events.

export class ApiError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export async function api<T = unknown>(cmd: string, args: unknown = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args ?? {}) });
  } catch {
    throw new ApiError(0, "TracePoint's engine is not responding.");
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    if (res.status === 401) window.dispatchEvent(new CustomEvent("tp:signed-out"));
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

type Handler = (payload: any) => void;

export function onEvent(name: string, fn: Handler): () => void {
  const h = (e: Event) => fn((e as CustomEvent).detail);
  window.addEventListener(`tp:${name}`, h);
  return () => window.removeEventListener(`tp:${name}`, h);
}

// The exe calls window.__tp_emit(name, payload) via script injection.
(window as any).__tp_emit = (name: string, payload: unknown) => {
  window.dispatchEvent(new CustomEvent(`tp:${name}`, { detail: payload }));
};

// Development server: events over Server-Sent Events.
if (!(window as any).chrome?.webview) {
  try {
    const es = new EventSource("/events");
    es.onmessage = (m) => {
      try {
        const { name, payload } = JSON.parse(m.data);
        (window as any).__tp_emit(name, payload);
      } catch { /* ignore */ }
    };
  } catch { /* no SSE available */ }
}

export const fileUrl = (id: number, as?: string) => `/file/${id}${as ? `?as=${as}` : ""}`;
export const assetUrl = (name: string) => `/asset/${name}`;
