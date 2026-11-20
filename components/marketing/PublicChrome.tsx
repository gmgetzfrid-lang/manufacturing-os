// The public pages' top bar and footer, in the brand's deep shade: the
// product mark, the sections of /about, and the two ways in.

import Link from "next/link";
import { Layout } from "lucide-react";
import { btnQuiet } from "@/components/admin/kit";

const wrap = "max-w-[1200px] mx-auto px-4 sm:px-6";

export function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="w-8 h-8 rounded-md grid place-items-center bg-[var(--color-text)] text-[var(--color-band)]">
        <Layout className="w-4 h-4" />
      </span>
      <span className="whitespace-nowrap font-display text-[18px] font-semibold text-[var(--color-text)]">Manufacturing OS</span>
    </span>
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
