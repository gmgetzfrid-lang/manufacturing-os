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

export async function stampPdf(url: string, opts: StampOptions): Promise<Blob> {
  try {
    const res = await fetch(url, { mode: 'cors' }); // Explicitly request CORS
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    
    const source = await res.arrayBuffer();
    const pdfDoc = await PDFDocument.load(source);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    const text = buildStampText(opts);

    for (const page of pages) {
      const { width, height } = page.getSize();
      const fontSize = Math.max(14, Math.min(32, width / 18));
      const opacity = 0.15;

      page.drawText(text, {
        x: width * 0.1,
        y: height * 0.5,
        size: fontSize,
        font,
        color: rgb(0.2, 0.2, 0.2),
        opacity,
        rotate: degrees(-30),
      });

      // FOOTER: UNCONTROLLED COPY + TIMESTAMP
      const footer = `UNCONTROLLED COPY • Downloaded: ${formatDate(opts.timestamp)} • Do Not Distribute`;
      page.drawText(footer, {
        x: width * 0.05,
        y: height * 0.04,
        size: Math.max(10, fontSize / 2.5),
        font,
        color: rgb(0.5, 0.0, 0.0), // Dark Red for visibility
        opacity: 0.8,
      });
    }

    const stamped = await pdfDoc.save();
    return new Blob([stamped as any], { type: "application/pdf" });

  } catch (error: any) {
    console.error("PDF Stamping Error:", error);
    if (error.message?.includes("Failed to fetch")) {
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