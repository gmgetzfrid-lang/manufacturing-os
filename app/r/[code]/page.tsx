"use client";

// /r/<code> - the page behind the QR on a printed work order package's
// cover: is every drawing in it still current, and send the signed forms
// back (scan with the phone). No account; the code opens this package only.

import React from "react";
import PackageReturns from "@/components/projects/packages/PackageReturns";

export default function PackagePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = React.use(params);
  return <PackageReturns code={decodeURIComponent(code)} />;
}
