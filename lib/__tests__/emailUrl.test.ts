import { describe, it, expect, afterEach, vi } from "vitest";
import { emailUrl } from "@/lib/emailUrl";

describe("emailUrl", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("puts the configured site in front of an app path", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com/");
    expect(emailUrl("/requests/1?c=2")).toBe("https://app.example.com/requests/1?c=2");
  });

  it("falls back to the production domain on the server", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "mos.example.com");
    expect(emailUrl("projects/9")).toBe("https://mos.example.com/projects/9");
  });

  it("leaves a full address alone", () => {
    expect(emailUrl("https://x.test/a")).toBe("https://x.test/a");
  });
});
