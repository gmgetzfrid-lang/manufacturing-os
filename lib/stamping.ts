import { PDFDocument, rgb, StandardFonts, degrees } from "pdf-lib";

export type StampOptions = {
  userLabel?: string;
  email?: string;
  timestamp?: Date;
  expiresAt?: Date | null;
  watermarkText?: string;
  /** Extra footer line — rev-at-issue + active-change warning. The paper
   *  copy on the desk should warn for itself. */
  footerNotice?: string;
  /** When set, a QR code linking here is stamped on every page so anyone in
   *  the field can scan the PRINT and instantly see whether it's still the
   *  current revision. Paper that verifies itself. */
  verifyUrl?: string;
};

function formatDate(d?: Date | null) {
  if (!d) return "";
  return d.toLocaleString();
}

function buildStampText(opts: StampOptions) {
  const parts = [];
  if (opts.watermarkText) parts.push(opts.watermarkText);
  if (opts.userLabel) parts.push(opts.userLabel);
  if (opts.email) parts.push(opts.email);
  if (opts.timestamp) parts.push(`Downloaded: ${formatDate(opts.timestamp)}`);
  if (opts.expiresAt) parts.push(`Expires: ${formatDate(opts.expiresAt)}`);
  return parts.filter(Boolean).join(" • ");
}

export async function applyStampToPdfDoc(pdfDoc: PDFDocument, opts: StampOptions): Promise<void> {
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const text = buildStampText(opts);

  // Verification QR — generated once, embedded on every page. Failure to
  // generate must never fail the stamp (the copy still goes out, just
  // without the scan affordance).
  let qrImage: Awaited<ReturnType<typeof pdfDoc.embedPng>> | null = null;
  if (opts.verifyUrl) {
    try {
      const { toDataURL } = await import("qrcode");
      const dataUrl = await toDataURL(opts.verifyUrl, { margin: 1, width: 256 });
      qrImage = await pdfDoc.embedPng(dataUrl);
    } catch (e) {
      console.warn("[stamping] QR generation failed (stamp continues without it)", e);
    }
  }

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = Math.max(14, Math.min(32, width / 18));
    page.drawText(text, {
      x: width * 0.1, y: height * 0.5,
      size: fontSize, font,
      color: rgb(0.2, 0.2, 0.2),
      opacity: 0.15,
      rotate: degrees(-30),
    });
    const footer = `UNCONTROLLED COPY • Downloaded: ${formatDate(opts.timestamp)} • Do Not Distribute`;
    page.drawText(footer, {
      x: width * 0.05, y: height * 0.04,
      size: Math.max(10, fontSize / 2.5),
      font,
      color: rgb(0.5, 0.0, 0.0),
      opacity: 0.8,
    });
    if (opts.footerNotice) {
      page.drawText(opts.footerNotice, {
        x: width * 0.05, y: height * 0.02,
        size: Math.max(9, fontSize / 3),
        font,
        color: rgb(0.55, 0.3, 0.0),
        opacity: 0.9,
      });
    }
    if (qrImage) {
      const qrSize = Math.max(42, Math.min(64, width / 12));
      const qrX = width - qrSize - width * 0.03;
      const qrY = height * 0.03;
      page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });
      page.drawText("SCAN TO VERIFY", {
        x: qrX - 2, y: qrY - Math.max(7, qrSize * 0.14),
        size: Math.max(5, qrSize * 0.11),
        font,
        color: rgb(0.25, 0.25, 0.25),
        opacity: 0.9,
      });
    }
  }
}

export async function stampPdf(url: string, opts: StampOptions): Promise<Blob> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    const source = await res.arrayBuffer();
    const pdfDoc = await PDFDocument.load(source);
    await applyStampToPdfDoc(pdfDoc, opts);
    const stamped = await pdfDoc.save();
    return new Blob([stamped as BlobPart], { type: "application/pdf" });
  } catch (error) {
    console.error("PDF Stamping Error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Failed to fetch")) {
      throw new Error("CORS_BLOCK: Unable to access file data for stamping. Check Firebase Storage CORS rules.");
    }
    throw error;
  }
}

export async function downloadStampedPdf(params: {
  url: string;
  filename: string;
  options: StampOptions;
}) {
  const blob = await stampPdf(params.url, params.options);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = params.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}