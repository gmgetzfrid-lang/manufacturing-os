// lib/__tests__/brandServer.test.ts
//
// A page someone outside opens shows the sending company's logo. These
// check that a request only ever gets the workspace it names (never
// another company's logo), the color the logo sits on, and the trim.

import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";

const store = new Map<string, Buffer>();
const orgs: Array<{ id: string; name: string }> = [];
const configs = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: { send: async (cmd: { input: { Key: string } }) => {
    const bytes = store.get(cmd.input.Key);
    if (!bytes) throw new Error("NoSuchKey");
    return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
  } },
}));

vi.mock("@/lib/supabaseAdmin", () => {
  function query(table: string) {
    const f: Record<string, unknown> = {};
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => { f[k] = v; return q; },
      limit: async (n: number) => ({ data: orgs.slice(0, n).map((o) => ({ id: o.id })), error: null }),
      maybeSingle: async () => {
        if (table === "orgs") return { data: orgs.find((o) => o.id === f.id) ?? null, error: null };
        const data = configs.get(f.org_id as string);
        return { data: data ? { data } : null, error: null };
      },
    };
    return q;
  }
  return { supabaseAdmin: { from: query } };
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** A logo: a colored disc on a clear (or solid) background, with margin. */
async function logo(color: string, background?: string): Promise<Buffer> {
  const bg = background ? `<rect width="200" height="120" fill="${background}"/>` : "";
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">${bg}<circle cx="100" cy="60" r="30" fill="${color}"/></svg>`)).png().toBuffer();
}

async function pixel(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3], w: info.width, h: info.height };
}

async function fresh() {
  vi.resetModules();
  return import("@/lib/brandServer");
}

beforeEach(() => {
  store.clear(); configs.clear(); orgs.length = 0;
  delete process.env.BRAND_ORG_ID;
});

describe("which workspace", () => {
  it("only the workspace the request names", async () => {
    orgs.push({ id: A, name: "Kern" }, { id: B, name: "Other" });
    const { brandFor } = await fresh();
    expect((await brandFor(new Request(`https://x/api/brand/logo?ws=${A}`)))?.orgId).toBe(A);
    expect(await brandFor(new Request("https://x/api/brand/logo"))).toBeNull();
    expect(await brandFor(new Request("https://x/api/brand/logo?ws=not-an-id"))).toBeNull();
  });

  it("never borrows another workspace's logo", async () => {
    orgs.push({ id: A, name: "Kern" }, { id: B, name: "Other" });
    configs.set(A, { logoPath: `orgs/${A}/branding/logo.png` });
    const { brandOf, logoLinkFor } = await fresh();
    expect((await brandOf(B))?.logoPath).toBeNull();
    expect(await logoLinkFor(B)).toBeNull();
    expect(await logoLinkFor(A)).toMatch(new RegExp(`^/api/brand/logo\\?ws=${A}&v=\\w+&plate=1$`));
  });

  it("ignores a logo path outside the workspace's own folder", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${B}/branding/logo.png` });
    const { brandOf } = await fresh();
    expect((await brandOf(A))?.logoPath).toBeNull();
  });
});

describe("the logo", () => {
  async function plated(color: string, background?: string) {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${A}/l.png`, updatedAt: "1" });
    store.set(`orgs/${A}/l.png`, await logo(color, background));
    const { brandOf, logoPng } = await fresh();
    return (await logoPng((await brandOf(A))!, true))!;
  }

  it("sits a dark logo on white", async () => {
    const corner = await pixel(await plated("#000972"), 12, 12);
    expect([corner.r, corner.g, corner.b]).toEqual([255, 255, 255]);
  });

  it("sits a white logo on dark", async () => {
    expect((await pixel(await plated("#ffffff"), 12, 12)).r).toBeLessThan(40);
  });

  it("keeps a logo's own solid background", async () => {
    const corner = await pixel(await plated("#ffffff", "#c8102e"), 12, 12);
    expect([corner.r, corner.g, corner.b]).toEqual([0xc8, 0x10, 0x2e]);
  });

  it("is trimmed of its margin, and the plate adds one back", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${A}/l.png`, updatedAt: "1" });
    store.set(`orgs/${A}/l.png`, await logo("#000972"));
    const { brandOf, logoPng } = await fresh();
    const bare = await pixel((await logoPng((await brandOf(A))!))!, 0, 0);
    expect(bare.w).toBeLessThan(80); // the 60 px disc, not the 200 px canvas
    const withPlate = await pixel((await logoPng((await brandOf(A))!, true))!, 0, 0);
    expect(withPlate.w).toBeGreaterThan(bare.w);
  });

  it("is nothing when the workspace has no logo, or it can't be read", async () => {
    orgs.push({ id: A, name: "Kern" });
    const { brandOf, logoPng } = await fresh();
    expect(await logoPng((await brandOf(A))!)).toBeNull();
    configs.set(A, { logoPath: `orgs/${A}/missing.png`, updatedAt: "2" });
    const again = await fresh();
    await expect(again.logoPng((await again.brandOf(A))!)).rejects.toThrow();
  });
});
