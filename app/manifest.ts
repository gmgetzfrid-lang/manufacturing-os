import type { MetadataRoute } from "next";

// Web App Manifest → makes Manufacturing OS installable ("Add to Home
// Screen") on a phone/tablet, the first step of field mode: a plant worker
// installs it like a native app. A scalable maskable SVG icon
// (/public/icon.svg) covers every size/density and the maskable purpose, so
// the install UX gets a real icon and adaptive shaping on Android instead of
// a cropped favicon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Manufacturing OS",
    short_name: "MfgOS",
    description: "Industrial document control, drafting workflow, and audit trail",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b1120",
    theme_color: "#ea580c",
    categories: ["business", "productivity", "utilities"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      { src: "/favicon.ico", sizes: "any", type: "image/x-icon" },
    ],
  };
}
