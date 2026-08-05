// lib/ai/keyVault.ts
//
// At-rest protection for stored AI provider keys (ai_connections.api_key /
// embedding_api_key), using the same AES-256-GCM helper that already guards
// S3 credentials. Server-only — every reader of these columns goes through
// supabaseAdmin in an API route.
//
// Sealed values carry a "encv1:" prefix so legacy plaintext rows (and
// deployments without EXPORT_ENCRYPTION_KEY) keep working: open() passes
// anything unprefixed straight through. Real provider keys ("sk-...",
// "AIza...") can never collide with the prefix.

import { encryptSecret, decryptSecret } from "@/lib/serverCrypto";

const PREFIX = "encv1:";

function cryptoConfigured(): boolean {
  const hex = process.env.EXPORT_ENCRYPTION_KEY || "";
  return hex.length === 64;
}

/** Encrypt a provider key for storage. Falls back to plaintext (with a
 *  server-log warning) when EXPORT_ENCRYPTION_KEY isn't configured, so an
 *  unconfigured self-host degrades to today's behavior instead of breaking
 *  AI setup outright. */
export function sealAiKey(plain: string): string {
  if (!plain) return "";
  if (!cryptoConfigured()) {
    console.warn(
      "EXPORT_ENCRYPTION_KEY not set — storing AI provider key UNENCRYPTED. " +
      "Set the env var (64-char hex) to encrypt keys at rest.",
    );
    return plain;
  }
  return PREFIX + encryptSecret(plain);
}

/** Decrypt a stored provider key. Legacy plaintext rows pass through. */
export function openAiKey(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored;
  return decryptSecret(stored.slice(PREFIX.length));
}
