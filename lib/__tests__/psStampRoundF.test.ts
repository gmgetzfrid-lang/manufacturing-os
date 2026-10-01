// public-surfaces Round F — PS-STAMP (PKG-4 STAMP-PIPELINE).
//
//   * PHYS-5 — the viewer's "Download w/ Markup" ALWAYS stamps (watermark,
//     footer, verify QR), names the file _markup_UNCONTROLLED and records an
//     uncontrolled copy, the checkout holder included: markups are never the
//     controlled master.
//   * PHYS-11 / SHR-11 — publicOrigin(): NEXT_PUBLIC_SITE_URL, else Vercel's
//     PRODUCTION domain (never VERCEL_URL), else — in a browser only — the
//     page's own origin, else "" (a server with nothing configured). A
//     browser therefore always gets an absolute origin. A stamp with no
//     verify URL logs a warning, and a page with no QR never carries an
//     instruction to scan one. .env.example documents the variable as
//     required.
//   * TRX-14 / XEDGE-5 — the transmittal portal link is built on an origin
//     the recipient can open: the configured origin, else (browser) the
//     page's own address unless it is a Vercel deployment host or loopback.
//     The self-host Docker build can receive NEXT_PUBLIC_SITE_URL.
//   * PHYS-9 substrate — StampOptions.controlState drives the footer's main
//     line (and the default watermark); neither the main line nor the
//     watermark can say CONTROLLED COPY, whatever watermarkText a caller
//     passes.
//   * PHYS-13 — the viewer's phone QR is built on publicOrigin().
//
// The rotation fixture (PHYS-12 / DC PKG-13) and the title-block fixture
// (SHR-8) live in stampingRotation.test.ts.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFPage } from "pdf-lib";
import { publicOrigin, configuredPublicOrigin, recipientOrigin, isUnreachableRecipientHost } from "@/lib/publicOrigin";
import { applyStampToPdfDoc, stampMainLine, stampWatermark, claimsControlledCopy, withoutScanInstruction } from "@/lib/stamping";
import { transmittalPortalUrl, portalOriginConfigured, portalLinkAvailable } from "@/lib/transmittals";

const src = (p: string) => readFileSync(p, "utf8");

// ─── PHYS-5: the markup export is always an uncontrolled copy ──────────────
describe("PHYS-5 — a marked-up export is always stamped and recorded uncontrolled", () => {
  const v = src("components/viewers/FullScreenViewer.tsx");
  const fn = v.slice(v.indexOf("const downloadWithMarkup = async () => {"), v.indexOf("const requestMarkupDownload = () => {"));

  it("the stamp is unconditional — no checkout-state gate decides whether a redlined sheet is marked", () => {
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).not.toMatch(/stampNow/);
    expect(fn).not.toMatch(/determineControlState/);
    expect(fn).not.toMatch(/if \(\s*liveState/);
    // the stamp call sits directly in the try block, not under a condition
    expect(fn).toMatch(/\n {6}await applyStampToPdfDoc\(pdfDoc, \{\n {8}sourceBytes: pdfBytes \?\? undefined,/);
    expect(fn).toContain('watermarkText: "UNCONTROLLED — FOR REVIEW ONLY",');
    expect(fn).toContain("WITH MARKUPS at time of export — markups are not part of the controlled revision.");
  });

  it("the filename always carries the markup + UNCONTROLLED suffix", () => {
    expect(fn).toContain('const suffix = "_markup_UNCONTROLLED";');
    expect(fn).not.toMatch(/let suffix = "_markup";/);
    expect(fn).toMatch(/const stem = `\$\{docNumber \|\| title \|\| "document"\}\$\{rev \? `_Rev\$\{rev\}` : ""\}\$\{suffix\}`/);
  });

  it("the audit row records an uncontrolled copy with its expiry — never the holder's controlled state", () => {
    expect(fn).toMatch(/await logDownloadAudit\(\{[\s\S]*?state: "uncontrolled",\s*\n\s*expiresAt,\s*\n\s*\}\);/);
    expect(fn).not.toMatch(/state: liveState/);
  });

  it("the checkout holder skips only the modal, not the stamp", () => {
    const req = v.slice(v.indexOf("const requestMarkupDownload = () => {"), v.indexOf("if (!isOpen) return null;"));
    expect(req).toMatch(/if \(live === "controlled"\) \{[\s\S]*?STILL stamped[\s\S]*?void downloadWithMarkup\(\);/);
    expect(req).not.toMatch(/raw bake, no stamp/);
  });
});

// ─── PHYS-12 / PKG-13: one bake, rotation-aware, shared by both viewers ────
describe("PKG-13 — the viewer's markup export bakes through the shared rotation-aware bake", () => {
  it("downloadWithMarkup calls bakeMarkupIntoDoc and keeps no private copy of the unrotated bake", () => {
    const v = src("components/viewers/FullScreenViewer.tsx");
    const fn = v.slice(v.indexOf("const downloadWithMarkup = async () => {"), v.indexOf("const requestMarkupDownload = () => {"));
    expect(v).toContain('import { bakeMarkupIntoPdf, bakeMarkupIntoDoc } from "@/lib/markupExport";');
    expect(fn).toContain("await bakeMarkupIntoDoc(pdfDoc, states);");
    expect(fn).not.toMatch(/page\.drawImage\(img, \{ x: 0, y: 0, width, height \}\)/);
    expect(fn).not.toMatch(/new fabric\.StaticCanvas/);
    // bake first, then stamp the same document
    expect(fn.indexOf("await bakeMarkupIntoDoc(pdfDoc, states);")).toBeLessThan(fn.indexOf("await applyStampToPdfDoc(pdfDoc, {"));
  });
  it("lib/markupExport sizes the raster to the displayed page and lays it back with the page's rotation", () => {
    const m = src("lib/markupExport.ts");
    expect(m).toContain("const rotation = normalizeRotation(page.getRotation().angle);");
    expect(m).toContain("const { width, height } = displaySize(media.width, media.height, rotation);");
    expect(m).toContain("page.drawImage(img, { ...origin, width, height, rotate: degrees(rotation) });");
    expect(m).toMatch(/export async function bakeMarkupIntoPdf\([\s\S]*?await bakeMarkupIntoDoc\(pdfDoc, pageStates\);/);
  });
});

// ─── SHR-8: the server path's placement is stated, not implied ─────────────
describe("SHR-8 — the share route no longer claims a placement parity it cannot have", () => {
  it("the route header says the server stamp is placed blind, by the title-block-aware fallback", () => {
    const r = src("app/api/share/file/route.ts");
    expect(r).toContain("stamped with the same applyStampToPdfDoc as internal downloads — the same");
    expect(r).toContain("marks, but placed BLIND: a server has no DOM for the ink analysis the");
    expect(r).toContain("fallback (top-left, clear of the right-hand title block — SHR-8).");
  });
  it("lib/stamping falls back to fallbackInk + titleBlockReserve — never a constant that assumes a blank bottom-right", () => {
    const s = src("lib/stamping.ts");
    expect(s).toContain("const pageInk: PageInk = measured ?? fallbackInk(width, height);");
    expect(s).toContain("reserveRight: measured ? 0 : titleBlockReserve(width),");
    expect(s).not.toMatch(/FALLBACK_INK/);
    expect(src("lib/stampLayout.ts")).not.toMatch(/corners: \{ br: 0,/);
  });
});


// ─── PHYS-11 / SHR-11 / XEDGE-5: the public-origin contract ────────────────
const ORIGIN_ENV = ["NEXT_PUBLIC_SITE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"] as const;
function env(vars: Partial<Record<(typeof ORIGIN_ENV)[number], string>>) {
  for (const k of ORIGIN_ENV) vi.stubEnv(k, vars[k] ?? "");
}
function browserAt(origin: string) {
  vi.stubGlobal("window", { location: { origin, hostname: new URL(origin).hostname } });
}

describe("PHYS-11 — publicOrigin(): configured, else production, else (browser) the page, never VERCEL_URL", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("NEXT_PUBLIC_SITE_URL wins, trailing slashes stripped — on the server and in a browser", () => {
    env({ NEXT_PUBLIC_SITE_URL: "https://app.example.com/", VERCEL_PROJECT_PRODUCTION_URL: "prod.example.com" });
    expect(typeof window).toBe("undefined");
    expect(publicOrigin()).toBe("https://app.example.com");
    browserAt("https://mfgos-git-feature-team.vercel.app");
    expect(publicOrigin()).toBe("https://app.example.com");
  });

  it("server, NEXT_PUBLIC_SITE_URL unset: Vercel's PRODUCTION domain (set on Vercel, previews included, while the project exposes its system environment variables — the default), given https", () => {
    env({ VERCEL_PROJECT_PRODUCTION_URL: "app.example.com", VERCEL_URL: "mfgos-abc123-team.vercel.app" });
    expect(publicOrigin()).toBe("https://app.example.com");
    env({ VERCEL_PROJECT_PRODUCTION_URL: "https://app.example.com/" });
    expect(publicOrigin()).toBe("https://app.example.com");
  });

  it("never VERCEL_URL — a preview deployment's own host — and with nothing configured the server answers \"\" (no link)", () => {
    env({ VERCEL_URL: "mfgos-git-feature-team.vercel.app" });
    expect(publicOrigin()).toBe("");
    expect(configuredPublicOrigin()).toBe("");
    env({});
    expect(publicOrigin()).toBe("");
  });

  it("browser, nothing configured: the page's own origin on any host — a browser never gets \"\", so no caller builds a relative URL", () => {
    // lib/physicalBridge.ts, ShareLinkModal and RelatedPanel build
    // `${publicOrigin()}/…` with no "" check; a browser must always answer.
    env({});
    for (const o of ["https://mfgos.plant.example", "https://manufacturing-os-nu.vercel.app", "https://mfgos-git-feature-team.vercel.app", "http://localhost:3000"]) {
      browserAt(o);
      expect(publicOrigin()).toBe(o);
      expect(`${publicOrigin()}/verify-hold/h1`).toMatch(/^https?:\/\//);
    }
  });

  it("publicOrigin() itself refuses no host: the page origin is the browser's last answer (the recipient-host check is recipientOrigin's alone)", () => {
    const s = src("lib/publicOrigin.ts");
    expect(s).not.toMatch(/isVercelDeploymentHost/);
    const body = s.slice(s.indexOf("export function publicOrigin(): string {"), s.indexOf("export function isUnreachableRecipientHost"));
    expect(body).toContain('if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;');
    expect(body).not.toMatch(/isUnreachableRecipientHost|vercel\\\.app/);
  });

  it("browser on a preview host with the production domain exposed: the production origin", () => {
    env({ NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL: "app.example.com" });
    browserAt("https://mfgos-git-feature-team.vercel.app");
    expect(publicOrigin()).toBe("https://app.example.com");
  });

  it("configuredPublicOrigin() never answers with the page's own host", () => {
    env({});
    browserAt("https://mfgos.plant.example");
    expect(configuredPublicOrigin()).toBe("");
    env({ NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL: "app.example.com" });
    expect(configuredPublicOrigin()).toBe("https://app.example.com");
  });

  it(".env.example: the variable is required for the physical bridge, and the fallback it documents is the one implemented", () => {
    const e = src(".env.example");
    const misc = e.slice(e.indexOf("# ─── Misc (optional)"));
    expect(misc).not.toContain("NEXT_PUBLIC_SITE_URL");
    expect(e).toContain("# ─── Public origin (REQUIRED for the physical bridge)");
    expect(e).toContain("(VERCEL_PROJECT_PRODUCTION_URL) — never VERCEL_URL");
    expect(e).not.toMatch(/falls back\s*\n?#?\s*to VERCEL_URL/);
    expect(e).toMatch(/\nNEXT_PUBLIC_SITE_URL=\n/);
    expect(src("lib/publicOrigin.ts")).not.toMatch(/process\.env\.VERCEL_URL/);
  });
});

// ─── TRX-14 / XEDGE-5: the transmittal link, browser half ──────────────────
describe("TRX-14 / XEDGE-5 — the portal link is built on an origin the recipient can open", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("a Vercel deployment host or a loopback address is one an outside recipient cannot open", () => {
    for (const h of ["mfgos-git-feature-team.vercel.app", "manufacturing-os-nu.vercel.app", "VERCEL.APP", "localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1", "0.0.0.0", ""]) {
      expect(isUnreachableRecipientHost(h), h).toBe(true);
    }
    for (const h of ["mfgos.plant.example", "mfg-server", "10.0.0.12", "app.vercel.app.example.com", "notvercel.app"]) {
      expect(isUnreachableRecipientHost(h), h).toBe(false);
    }
  });

  it("nothing configured, a browser on a Vercel deployment host or loopback builds NO link (null) — though publicOrigin() there is the page", () => {
    env({});
    for (const o of ["https://mfgos-git-feature-team.vercel.app", "https://manufacturing-os-nu.vercel.app", "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      browserAt(o);
      expect(transmittalPortalUrl("tok"), o).toBeNull();
      expect(recipientOrigin(), o).toBe("");
      expect(portalLinkAvailable(), o).toBe(false);
      expect(publicOrigin(), o).toBe(o);
    }
    expect(portalOriginConfigured()).toBe(false);
  });

  it("nothing configured, OFF Vercel (self-hosted): the browser builds the link on its own address, as on the base — the server builds none and the email route refuses", () => {
    env({});
    browserAt("https://mfgos.plant.example");
    expect(transmittalPortalUrl("tok")).toBe("https://mfgos.plant.example/transmittal/tok");
    expect(portalLinkAvailable()).toBe(true);
    expect(portalOriginConfigured()).toBe(false); // so the toasts warn that the link uses this browser's address
    browserAt("http://mfg-server:3000");
    expect(transmittalPortalUrl("tok")).toBe("http://mfg-server:3000/transmittal/tok");
    vi.unstubAllGlobals();
    expect(typeof window).toBe("undefined");
    expect(transmittalPortalUrl("tok")).toBeNull();
    expect(portalLinkAvailable()).toBe(false);
  });

  it("exposure off: the server can build the production link while a browser on a preview host builds none", () => {
    env({ VERCEL_PROJECT_PRODUCTION_URL: "app.example.com" });
    expect(typeof window).toBe("undefined");
    expect(transmittalPortalUrl("tok")).toBe("https://app.example.com/transmittal/tok");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    browserAt("https://mfgos-git-feature-team.vercel.app");
    expect(transmittalPortalUrl("tok")).toBeNull();
    expect(portalOriginConfigured()).toBe(false);
    expect(portalLinkAvailable()).toBe(false);
  });

  it("on a preview deploy the link is the PRODUCTION link, the same one the server emails", () => {
    env({ NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL: "app.example.com", VERCEL_PROJECT_PRODUCTION_URL: "app.example.com" });
    browserAt("https://mfgos-git-feature-team.vercel.app");
    const fromBrowser = transmittalPortalUrl("tok");
    vi.unstubAllGlobals();
    expect(typeof window).toBe("undefined");
    expect(transmittalPortalUrl("tok")).toBe(fromBrowser);
    expect(fromBrowser).toBe("https://app.example.com/transmittal/tok");
    expect(portalOriginConfigured()).toBe(true);
  });

  it("NEXT_PUBLIC_SITE_URL set: every runtime and every host builds the configured link", () => {
    env({ NEXT_PUBLIC_SITE_URL: "https://mfg.yourplant.com/" });
    expect(transmittalPortalUrl("tok")).toBe("https://mfg.yourplant.com/transmittal/tok");
    for (const o of ["http://localhost:3000", "https://mfgos-git-feature-team.vercel.app", "https://mfgos.plant.example"]) {
      browserAt(o);
      expect(transmittalPortalUrl("tok"), o).toBe("https://mfg.yourplant.com/transmittal/tok");
    }
  });

  it("lib/transmittals builds the link on recipientOrigin; the toasts never advise copying a link this browser cannot build, and the button is disabled with the variable named", () => {
    const t = src("lib/transmittals.ts");
    expect(t).toContain('import { configuredPublicOrigin, recipientOrigin } from "@/lib/publicOrigin";');
    expect(t).toContain("try { origin = recipientOrigin(); } catch { origin = \"\"; }");
    expect(t).toContain("return !!configuredPublicOrigin();");
    const page = src("app/(protected)/transmittals/page.tsx");
    // The copy advice depends on whether THIS browser can build the link.
    expect(page).toContain("const linkHere = portalLinkAvailable();");
    expect(page).toContain('const NO_PORTAL_LINK_ADVICE = "set NEXT_PUBLIC_SITE_URL to the public site address and rebuild, then copy the portal link from this register";');
    expect(page).toContain('— ${linkHere ? "copy the portal link instead" : NO_PORTAL_LINK_ADVICE}`');
    expect(page).toContain('`no recipient email — ${linkHere ? "copy the portal link to send it" : NO_PORTAL_LINK_ADVICE}`');
    expect(page).not.toContain('notes.push("no recipient email — copy the portal link to send it");');
    expect(page).not.toContain("— copy the portal link instead`);");
    expect(page).toMatch(/if \(outcome\.portal === "ready" && !linkHere\) \{\s*\n\s*notes\.push\("this browser cannot build the portal link \(NEXT_PUBLIC_SITE_URL unset\) — the cover sheet carries none"\);/);
    // A link built on this browser's address (self-hosted, nothing configured) says so.
    expect(page).toContain('} else if (outcome.portal === "ready" && !portalOriginConfigured()) {');
    expect(page).toContain("NEXT_PUBLIC_SITE_URL is not set, so the copied link and the cover sheet use this browser's address — check it opens from outside before sending");
    expect(page).not.toContain("if this is a preview deploy the recipient cannot open it");
    // The Portal link button is not offered as an action that always fails.
    expect(page).toContain("disabled={!portalLinkAvailable()}");
    expect(page).toContain('"No portal link: this browser cannot build one (NEXT_PUBLIC_SITE_URL unset) — set it and rebuild"');
    expect(page).toContain('message: "This browser cannot build the portal link (NEXT_PUBLIC_SITE_URL unset)."');
    expect(page).not.toContain("This deployment has no public site URL configured.");
  });

  it("the self-host Docker build can receive NEXT_PUBLIC_SITE_URL (.env is excluded from the image, so a build arg is the only route)", () => {
    const dockerfile = src("Dockerfile");
    const build = dockerfile.slice(0, dockerfile.indexOf("RUN npm run build"));
    expect(build).toMatch(/\nARG NEXT_PUBLIC_SITE_URL\n/);
    expect(build).toContain("    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \\\n");
    const compose = src("docker-compose.yml");
    const args = compose.slice(compose.indexOf("      args:"), compose.indexOf("    image:"));
    expect(args).toContain("        NEXT_PUBLIC_SITE_URL: ${NEXT_PUBLIC_SITE_URL:-}");
    expect(src(".dockerignore")).toMatch(/\n\.env\n/);
    const doc = src("docs/SELF_HOST_DOCKER.md");
    expect(doc).toMatch(/\| `NEXT_PUBLIC_SITE_URL` \| \*\*build\*\* \(and runtime\) — \*\*required\*\*/);
    expect(doc).toContain("  --build-arg NEXT_PUBLIC_SITE_URL=https://mfg.yourplant.com \\\n");
  });
});

// ─── PHYS-11 / SHR-11: no QR → no instruction to scan one; never silent ────
describe("PHYS-11 / SHR-11 — the stamp never tells a reader to scan a QR it does not carry", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("withoutScanInstruction removes the instruction (sentence or em-dash clause) and keeps the facts", () => {
    expect(withoutScanInstruction("T-12 deliverable Rev 3 at time of printing — scan the QR to confirm it is still the latest."))
      .toBe("T-12 deliverable Rev 3 at time of printing. Confirm the current revision before use.");
    expect(withoutScanInstruction("SUPERSEDED REVISION — Rev 2. This is NOT the current revision; do not use for construction. Scan to verify."))
      .toBe("SUPERSEDED REVISION — Rev 2. This is NOT the current revision; do not use for construction. Confirm the current revision before use.");
    expect(withoutScanInstruction("2002-D-1 Rev 4 at time of download — a share always serves the current revision. Scan the QR to confirm it is still current."))
      .toBe("2002-D-1 Rev 4 at time of download — a share always serves the current revision. Confirm the current revision before use.");
    expect(withoutScanInstruction("Scan the QR to confirm it is still current.")).toBe("Confirm the current revision before use.");
  });

  it("leaves a notice without a scan instruction byte-identical — including a document number that contains SCAN", () => {
    for (const n of [
      "Rev 4 at time of issue — verify current revision before use.",
      "SCAN-001 Rev 3 at time of issue — verify current revision before use.",
      "Confirm the current revision with the issuer before use.",
    ]) expect(withoutScanInstruction(n)).toBe(n);
  });

  async function stampTexts(opts: Parameters<typeof applyStampToPdfDoc>[1]) {
    const texts: string[] = [];
    const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = proto.drawText;
    vi.spyOn(proto, "drawText").mockImplementation(function (this: PDFPage, ...a: unknown[]) { texts.push(a[0] as string); return orig.apply(this, a); });
    const d = await PDFDocument.create();
    d.addPage([1224, 792]);
    const pdf = await PDFDocument.load(await d.save());
    await applyStampToPdfDoc(pdf, opts);
    return texts.join("\n");
  }

  it("no verifyUrl (no public origin): a warning is logged, no QR caption, no scan instruction, a plain one instead", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const all = await stampTexts({
      timestamp: new Date(), watermarkText: "UNCONTROLLED COPY",
      footerNotice: "T-12 deliverable Rev 3 at time of download — scan the QR to confirm it is still the latest.",
    });
    expect(warn.mock.calls.some((c) => /no verifyUrl — this copy carries no verify QR/.test(String(c[0])))).toBe(true);
    expect(all).not.toMatch(/scan the QR/i);
    expect(all).not.toContain("SCAN TO VERIFY");
    expect(all).toContain("Confirm the current revision before use.");
  });

  it("a QR that could not be generated also drops the instruction", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(PDFDocument.prototype, "embedPng").mockRejectedValueOnce(new Error("png"));
    const all = await stampTexts({
      timestamp: new Date(), verifyUrl: "https://app.example.com/verify/d?v=v",
      footerNotice: "X Rev 4 as issued on transmittal TR-1. Scan the QR to confirm it is still current.",
    });
    expect(all).not.toMatch(/Scan the QR/);
    expect(all).not.toContain("SCAN TO VERIFY");
  });

  it("with a verify URL the QR, its caption and the caller's instruction all stay", async () => {
    const all = await stampTexts({
      timestamp: new Date(), verifyUrl: "https://app.example.com/verify/d?v=v",
      footerNotice: "X Rev 4 as issued on transmittal TR-1. Scan the QR to confirm it is still current.",
    });
    expect(all).toContain("SCAN TO VERIFY");
    expect(all).toContain("Scan the QR to confirm it is still current.");
  });
});

// ─── PHYS-9 substrate: one control state drives both marks ─────────────────
describe("PHYS-9 substrate — StampOptions.controlState drives the footer's main line", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("the default main line is the one every existing caller already gets", () => {
    const t = new Date("2026-10-01T10:00:00Z");
    expect(stampMainLine(undefined, t)).toBe(`UNCONTROLLED COPY • Downloaded: ${t.toLocaleString()} • Do Not Distribute`);
    expect(stampMainLine("uncontrolled", t)).toBe(stampMainLine(undefined, t));
  });
  it("review copies say so; no timestamp drops the empty 'Downloaded:' segment", () => {
    expect(stampMainLine("review", null)).toBe("UNCONTROLLED COPY — REVIEW ONLY • Do Not Distribute");
    expect(stampMainLine(undefined, undefined)).toBe("UNCONTROLLED COPY • Do Not Distribute");
  });
  it("no control state can produce the words CONTROLLED COPY without UN-", () => {
    for (const st of ["uncontrolled", "review", "controlled"] as Array<Parameters<typeof stampMainLine>[0]>) {
      expect(stampMainLine(st, new Date())).not.toMatch(/(^|[^N])CONTROLLED COPY/);
    }
  });
  it("a caller's watermark that claims CONTROLLED COPY is replaced by the state's watermark; every other watermark is printed as given", () => {
    expect(stampWatermark("CONTROLLED COPY", undefined)).toBe("UNCONTROLLED COPY");
    expect(stampWatermark("Controlled  copy", "review")).toBe("REVIEW ONLY — DO NOT DISTRIBUTE");
    expect(stampWatermark("NOT A CONTROLLED COPY", undefined)).toBe("UNCONTROLLED COPY");
    for (const w of ["UNCONTROLLED COPY", "Uncontrolled copy", "UNCONTROLLED — FOR REVIEW ONLY", "REVIEW ONLY - DO NOT DISTRIBUTE", ""]) {
      expect(claimsControlledCopy(w)).toBe(false);
      expect(stampWatermark(w, undefined)).toBe(w);
    }
    expect(stampWatermark(undefined, undefined)).toBe("UNCONTROLLED COPY");
    for (const w of ["CONTROLLED COPY", "Controlled copy", "UNCONTROLLED COPY", "REVIEW ONLY - DO NOT DISTRIBUTE"]) {
      for (const st of [undefined, "uncontrolled", "review"] as const) {
        expect(stampWatermark(w, st)).not.toMatch(/(^|[^N])CONTROLLED COPY/i);
      }
    }
  });
  it("end to end: the drafting download's \"CONTROLLED COPY\" watermark (requests/[id]/page.tsx) prints as UNCONTROLLED COPY, with a warning", async () => {
    const texts: Array<{ t: string; o: Record<string, unknown> }> = [];
    const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = proto.drawText;
    vi.spyOn(proto, "drawText").mockImplementation(function (this: PDFPage, ...a: unknown[]) { texts.push({ t: a[0] as string, o: a[1] as Record<string, unknown> }); return orig.apply(this, a); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = await PDFDocument.create();
    d.addPage([1224, 792]);
    const pdf = await PDFDocument.load(await d.save());
    await applyStampToPdfDoc(pdf, { watermarkText: "CONTROLLED COPY", timestamp: new Date(), verifyUrl: "https://app.example.com/verify-ticket/t" });
    const watermark = texts.find((x) => x.o.opacity === 0.15)!.t;
    const all = texts.map((x) => x.t).join("\n");
    expect(watermark.startsWith("UNCONTROLLED COPY")).toBe(true);
    expect(all).not.toMatch(/(^|[^N])CONTROLLED COPY/);
    expect(warn.mock.calls.some((c) => /claims a controlled copy/.test(String(c[0])))).toBe(true);
    // The stamper is the backstop whether or not the drafting caller (DF-P10's file) still passes the literal.
  });
  it("the drafting download's audit row records the watermark actually printed, not the literal the caller passed", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    const literal = 'file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "CONTROLLED COPY"';
    // the same expression the stamp is given …
    expect(page).toContain(`watermarkText: ${literal},`);
    // … is passed through the stamper's own rule before it is recorded
    expect(page).toContain(`? stampWatermark(${literal}, undefined)`);
    expect(page).not.toContain(`? (${literal})`);
    expect(page).toContain("import { downloadStampedPdf, stampWatermark } from '@/lib/stamping';");
    expect(stampWatermark("CONTROLLED COPY", undefined)).toBe("UNCONTROLLED COPY");
    expect(stampWatermark("REVIEW ONLY - DO NOT DISTRIBUTE", undefined)).toBe("REVIEW ONLY - DO NOT DISTRIBUTE");
  });
  it("controlState with no watermarkText drives the watermark too, so the two marks agree", async () => {
    const texts: Array<{ t: string; o: Record<string, unknown> }> = [];
    const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = proto.drawText;
    vi.spyOn(proto, "drawText").mockImplementation(function (this: PDFPage, ...a: unknown[]) { texts.push({ t: a[0] as string, o: a[1] as Record<string, unknown> }); return orig.apply(this, a); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = await PDFDocument.create();
    d.addPage([1224, 792]);
    const pdf = await PDFDocument.load(await d.save());
    await applyStampToPdfDoc(pdf, { controlState: "review", timestamp: new Date() });
    const watermark = texts.find((x) => x.o.opacity === 0.15)!.t;
    const footer = texts.filter((x) => x.o.opacity === 0.85).map((x) => x.t).join(" ");
    expect(watermark.startsWith("REVIEW ONLY — DO NOT DISTRIBUTE")).toBe(true);
    expect(footer.startsWith("UNCONTROLLED COPY — REVIEW ONLY")).toBe(true);
  });
  it("the footer's main line is derived, never the old hardcoded literal", () => {
    const s = src("lib/stamping.ts");
    expect(s).toContain("const mainText = stampMainLine(opts.controlState, opts.timestamp);");
    expect(s).not.toContain("const mainText = `UNCONTROLLED COPY • Downloaded:");
  });
});

// ─── PHYS-13: the viewer's phone QR ────────────────────────────────────────
describe("PHYS-13 — FullScreenViewer's phone QR is built on publicOrigin()", () => {
  it("no window.location.origin left in the viewer; the QR value is publicOrigin()-rooted, and a missing origin says so", () => {
    const v = src("components/viewers/FullScreenViewer.tsx");
    expect(v).not.toMatch(/window\.location\.origin/);
    expect(v).toContain("value={`${publicOrigin()}/documents/${docRecord.libraryId}?doc=${docRecord.id}`}");
    expect(v).toContain("No public site URL is configured (NEXT_PUBLIC_SITE_URL), so there is no link a phone could open.");
  });
});
