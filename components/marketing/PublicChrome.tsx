// The public pages' top bar and footer, in the brand's deep shade: the
// app logo, the sections of /about, and the two ways in.

import Link from "next/link";
import { btnQuiet } from "@/components/admin/kit";
import { SenderLogo } from "@/components/brand/WorkspaceLogo";
import { AppLogo, AppMark } from "@/components/brand/AppMark";

const wrap = "max-w-[1200px] mx-auto px-4 sm:px-6";

/** The app logo and name. These pages sit on the deep brand shade, so the
 *  tile gets its hairline. */
export function Logo() {
  return <AppLogo ring />;
}

/** The slim bar on a page someone opens from outside the company (a
 *  shared link, a transmittal, an upload link): the sending company's
 *  logo (its name when it has none) on the white top bar. The page says
 *  who sent it with useSender. */
export function PublicBar() {
  return (
    <header className="sticky top-0 z-30 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
      <div className="h-14 px-4 sm:px-6 flex items-center"><SenderLogo /></div>
    </header>
  );
}

/** The product's signature under a verdict screen (a printed QR checked
 *  in the field), white on the verdict's color. */
export function PublicSignature() {
  return (
    <p className="mt-10 inline-flex items-center gap-2 font-display text-[15px] font-semibold text-white">
      <AppMark size={22} ring /> Manufacturing OS
    </p>
  );
}

const SECTIONS = [
  ["#day", "Your day"], ["#capabilities", "What's inside"], ["#tour", "See it"],
  ["#trust", "Your data"], ["#honesty", "Compliance"], ["#security", "Security"],
] as const;

/** `base` is "" on /about (anchors on the page) and "/about" elsewhere. */
export function PublicNav({ base = "" }: { base?: string }) {
  return (
    <header className="surface-side sticky top-0 z-50">
      <div className={`${wrap} h-14 flex items-center gap-6`}>
        <Link href="/about" aria-label="Manufacturing OS home"><Logo /></Link>
        <nav aria-label="Sections" className="hidden lg:flex items-center gap-5 text-[14px] font-medium text-[var(--color-text-muted)]">
          {SECTIONS.map(([href, text]) => <a key={href} href={`${base}${href}`} className="hover:text-[var(--color-text)]">{text}</a>)}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Link href="/signup" className="max-sm:hidden text-[14px] font-semibold text-white hover:underline underline-offset-2">Create a workspace</Link>
          <Link href="/" className={btnQuiet}>Sign in</Link>
        </div>
      </div>
    </header>
  );
}

export function PublicFooter({ base = "" }: { base?: string }) {
  const col = "text-[13px] text-[var(--color-text-muted)] mb-2";
  const a = "text-[14px] text-[var(--color-text)] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2";
  return (
    <footer className="surface-side">
      <div className={`${wrap} py-10 grid grid-cols-2 md:grid-cols-4 gap-8`}>
        <div className="col-span-2">
          <Logo />
          <p className="mt-3 text-[14px] leading-snug text-[var(--color-text-muted)] max-w-sm">
            Document control, drafting workflow and an AI that has read your library. Leaving takes one click.
          </p>
        </div>
        <div>
          <div className={col}>Product</div>
          <ul className="space-y-1.5">
            {SECTIONS.map(([href, text]) => <li key={href}><a href={`${base}${href}`} className={a}>{text}</a></li>)}
            <li><Link href="/data-portability" className={a}>Data portability</Link></li>
          </ul>
        </div>
        <div>
          <div className={col}>Account</div>
          <ul className="space-y-1.5">
            <li><Link href="/" className={a}>Sign in</Link></li>
            <li><Link href="/signup" className={a}>Create a workspace</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-[var(--color-border)]">
        <div className={`${wrap} py-4 text-[13px] text-[var(--color-text-muted)]`}>
          &copy; {new Date().getFullYear()} Manufacturing OS. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
