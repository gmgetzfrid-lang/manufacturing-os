import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Load the .mpp readers from node_modules at runtime instead of bundling them
  // into the serverless function. @tensor-estate/tsmpp is ESM-only and pulls in
  // `cfb`; webpack-bundling them can compile fine but fail to resolve at runtime
  // on Vercel, which silently knocks the import onto the heuristic fallback
  // (wrong dates, no dependencies). Externalizing keeps the dynamic import
  // working in production.
  serverExternalPackages: ["@tensor-estate/tsmpp", "cfb"],
  // Tree-shake big barrel imports (we import from lucide-react in ~190 files)
  // so each route chunk only carries the icons it actually uses.
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns"],
  },
};

export default nextConfig;
