// The printed package's page sits outside the signed-in app. It keeps the
// corner upload card, so a failed send offers Try again with the same scan.
import { CornerDock } from "@/components/ui/CornerDock";
import UploadIndicator from "@/components/providers/UploadIndicator";

export const metadata = { title: "Work package", robots: { index: false, follow: false } };

export default function PackageLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <CornerDock />
      <UploadIndicator />
    </>
  );
}
