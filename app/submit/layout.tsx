// The contractor upload page sits outside the signed-in app frame. It still
// gets the corner upload card, so a failed upload offers the same one-tap
// Try again (with the same file) as everywhere else.
import { CornerDock } from "@/components/ui/CornerDock";
import UploadIndicator from "@/components/providers/UploadIndicator";

export default function SubmitLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <CornerDock />
      <UploadIndicator />
    </>
  );
}
