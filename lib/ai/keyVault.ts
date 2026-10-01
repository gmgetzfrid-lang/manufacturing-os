// lib/ai/keyVault.ts
//
// At-rest protection for stored AI provider keys (ai_connections.api_key /
// embedding_api_key), using the same AES-256-GCM helper that already guards
// S3 credentials. Server-only — every reader of these columns goes through
// supabaseAdmin in an API route.
//
// Sealed values carry a "encv1:" prefix so legacy plaintext rows keep
// working: open() passes anything unprefixed straight through. Real provider
// keys ("sk-...", "AIza...") can never collide with the prefix.
//
// GOV-12 (DEC-18's production / development split): with
// EXPORT_ENCRYPTION_KEY unset (or not 64 hex characters) a PRODUCTION
// server refuses to store a key at all — lib/serverCrypto's own contract,
// "we never want plaintext secrets on disk by accident". Development still
// stores it with a warning so a local setup is not blocked. Existing
// plaintext rows keep decrypting (they pass through), and the connection
// route re-seals a row the next time it is saved with encryption configured.

import { encryptSecret, decryptSecret } from "@/lib/serverCrypto";

const PREFIX = "encv1:";

/** 32 bytes as 64 hex characters — the only shape getKey() can use. A
 *  64-character value that is not hex used to pass here and fail later. */
export function aiKeyCryptoConfigured(): boolean {
  return /^[0-9a-f]{64}$/i.test(process.env.EXPORT_ENCRYPTION_KEY || "");
}

/** Production refuses plaintext storage; development warns (DEC-18 shape). */
export function aiKeyPlaintextRefused(): boolean {
  return process.env.NODE_ENV === "production";
}

export const AI_KEY_STORAGE_MESSAGE =
  "AI keys are never stored unencrypted on this server — set EXPORT_ENCRYPTION_KEY " +
  "(64 hex characters; the same secret encrypts saved storage credentials) and save the key again. " +
  "Nothing was saved.";

export class AiKeyStorageError extends Error {
  constructor() { super(AI_KEY_STORAGE_MESSAGE); this.name = "AiKeyStorageError"; }
}

/** Can a key be stored right now — and will it be encrypted? Checked BEFORE
 *  a key is verified with a live call, so nothing is spent on a key the
 *  server would then refuse to keep. */
export function aiKeyStorageReady(): { ok: true; encrypted: boolean } | { ok: false; error: string } {
  if (aiKeyCryptoConfigured()) return { ok: true, encrypted: true };
  if (aiKeyPlaintextRefused()) return { ok: false, error: AI_KEY_STORAGE_MESSAGE };
  return { ok: true, encrypted: false };
}

/** True when a stored value is sealed (encv1:). */
export const isSealedAiKey = (stored: string | null | undefined): boolean => !!stored && stored.startsWith(PREFIX);

/** Encrypt a provider key for storage. Without EXPORT_ENCRYPTION_KEY:
 *  production throws AiKeyStorageError; development returns the key as-is
 *  with a server-log warning. */
export function sealAiKey(plain: string): string {
  if (!plain) return "";
  if (!aiKeyCryptoConfigured()) {
    if (aiKeyPlaintextRefused()) throw new AiKeyStorageError();
    console.warn(
      "EXPORT_ENCRYPTION_KEY not set — storing AI provider key UNENCRYPTED (development only; " +
      "a production server refuses). Set the env var (64-char hex) to encrypt keys at rest.",
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
