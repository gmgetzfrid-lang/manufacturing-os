"use client";

import Link from 'next/link';
import { Home, ArrowLeft } from 'lucide-react';
import { PageHero, heroPrimary, heroQuiet } from '@/components/ui/PageHero';

// A link that opens nothing: say so in one line, one way home, and a quiet
// way back to where they were.
export default function NotFound() {
  return (
    <main className="min-h-dvh bg-[var(--color-canvas)]">
      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-6 pb-28">
        <PageHero
          kicker="Page not found"
          title="Nothing here."
          sub="This link doesn’t open anything. The page may have moved. The search at the top of any page finds it by name or number."
          size="md"
          tools={
            <Link
              href="/"
              onClick={(e) => {
                // With history, go back; without it, the link goes home.
                if (typeof window !== 'undefined' && window.history.length > 1) {
                  e.preventDefault();
                  window.history.back();
                }
              }}
              className={heroQuiet}
            >
              <ArrowLeft className="h-4 w-4" /> Go back
            </Link>
          }
          primary={
            <Link href="/" className={heroPrimary}>
              <Home className="h-4 w-4" /> Go home
            </Link>
          }
        />
      </div>
    </main>
  );
}
