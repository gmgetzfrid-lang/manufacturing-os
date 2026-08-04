import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @napi-rs/canvas is a native binding (deep-read page rendering) — it must
  // load from node_modules at runtime; bundlers can't place .node binaries.
  serverExternalPackages: ["@napi-rs/canvas"],
  // Tree-shake big barrel imports (we import from lucide-react in ~190 files)
  // so each route chunk only carries the icons it actually uses.
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns"],
  },
};

export default nextConfig;
