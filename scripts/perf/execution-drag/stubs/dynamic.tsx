// PERF-5 harness: stands in for next/dynamic in the bundle — React.lazy
// with the loader's default export.
import React, { Suspense } from "react";

type Loaded<P> = React.ComponentType<P> | { default: React.ComponentType<P> };
export default function dynamic<P extends object>(loader: () => Promise<Loaded<P>>, opts?: { loading?: () => React.ReactNode }) {
  const Lazy = React.lazy(async () => {
    const m = await loader();
    return { default: typeof m === "object" && "default" in m ? m.default : (m as React.ComponentType<P>) };
  });
  return function Dynamic(props: P) {
    return <Suspense fallback={opts?.loading ? opts.loading() : null}><Lazy {...(props as P & React.JSX.IntrinsicAttributes)} /></Suspense>;
  };
}
