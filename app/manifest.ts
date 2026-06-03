import type { MetadataRoute } from "next";

// Web App Manifest → makes Manufacturing OS installable ("Add to Home
// Screen") on a phone/tablet, the first step of field mode: a plant worker
// installs it like a native app. (Proper 192/512 maskable PNG icons should be
// dropped in /public and added below for the best install experience; the
// favicon is referenced as a baseline.)
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Manufacturing OS",
    short_name: "MfgOS",
    description: "Industrial document control, drafting workflow, and audit trail",
    start_url: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0b1120",
    theme_color: "#ea580c",
    icons: [
      { src: "/favicon.ico", sizes: "any", type: "image/x-icon" },
    ],
  };
}
