// lib/signinCheck.ts — browser side of /api/auth/after-signin: asks the
// server what the workspace's sign-in rules say about this session.

import { endOfDay } from "@/lib/signinPolicy";

export type SigninVerdict = { action: "ok" | "use_microsoft" | "expired" | "set_password" | "not_added" | "error"; expiresAt?: string | null };

export async function checkSignin(accessToken: string | null): Promise<SigninVerdict> {
  if (!accessToken) return { action: "ok" };
  try {
    const res = await fetch("/api/auth/after-signin", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      // The end of today here, in case a password must be replaced today.
      body: JSON.stringify({ expiresAt: endOfDay() }),
    });
    if (!res.ok) return { action: "error" };
    return (await res.json()) as SigninVerdict;
  } catch {
    // The check couldn't run. A fresh password sign-in fails closed (the
    // caller signs out); a remembered session just checks again later.
    return { action: "error" };
  }
}
