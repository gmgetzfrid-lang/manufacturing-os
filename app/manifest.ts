import type { MetadataRoute } from "next";

// Web App Manifest → makes Manufacturing OS installable ("Add to Home
// Screen") on a phone/tablet, the first step of field mode: a plant worker
// installs it like a native app. The icons are the app mark (a control
// valve, white on navy, the actuator in the warm accent; see
// components/brand/AppMark.tsx): full-bleed PNGs with the valve inside the
// maskable safe zone, so Android's circle or squircle never clips it, and
// the rounded SVG for anything that takes a scalable icon. The splash
// screen is the mark's navy, so the icon sits on its own color.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Manufacturing OS",
    short_name: "MfgOS",
    description: "Industrial document control, drafting workflow, and audit trail",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#0b1f4d",
    theme_color: "#0b1f4d",
    categories: ["business", "productivity", "utilities"],
    icons: [
      // Raster PNGs first — desktop/Windows install + taskbar pinning use
      // these (an SVG-only manifest falls back to favicon.ico, which is why
      // the old install showed a generic icon).
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      // Scalable SVG as a bonus for browsers that honor it.
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
