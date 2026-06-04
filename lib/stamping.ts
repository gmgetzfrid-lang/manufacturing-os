import { PDFDocument, rgb, StandardFonts, degrees } from "pdf-lib";

export type StampOptions = {
  userLabel?: string;
  email?: string;
  timestamp?: Date;
  expiresAt?: Date | null;
  watermarkText?: string;
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