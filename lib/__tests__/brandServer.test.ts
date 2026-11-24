// lib/__tests__/brandServer.test.ts
//
// The app icon is made from the workspace's own logo. These check which
// workspace a request gets (never another company's logo), the color the
// logo sits on, and the plain fallback when there is no logo.

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
  it("uses the only workspace when nothing names one", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${A}/branding/logo.png`, updatedAt: "1" });
    const { brandFor } = await fresh();
    const { brand, shared } = await brandFor(new Request("https://x/api/brand/icon"));
    expect(brand?.orgId).toBe(A);
    expect(shared).toBe(false);
  });

  it("uses nobody's logo when there are two workspaces and none is named", async () => {
    orgs.push({ id: A, name: "Kern" }, { id: B, name: "Other" });
    configs.set(A, { logoPath: `orgs/${A}/branding/logo.png` });
    const { brandFor } = await fresh();
    expect((await brandFor(new Request("https://x/api/brand/icon"))).brand).toBeNull();
  });

  it("follows this device's cookie, and a named workspace over it", async () => {
    orgs.push({ id: A, name: "Kern" }, { id: B, name: "Other" });
    const { brandFor } = await fresh();
    const byCookie = await brandFor(new Request("https://x/api/brand/icon", { headers: { cookie: `a=1; mos_ws=${B}` } }));
    expect(byCookie.brand?.orgId).toBe(B);
    const named = await brandFor(new Request(`https://x/api/brand/icon?ws=${A}`, { headers: { cookie: `mos_ws=${B}` } }));
    expect(named.brand?.orgId).toBe(A);
    expect(named.shared).toBe(true);
  });

  it("never borrows another workspace's logo", async () => {
    orgs.push({ id: A, name: "Kern" }, { id: B, name: "Other" });
    configs.set(A, { logoPath: `orgs/${A}/branding/logo.png` });
    const { brandOf } = await fresh();
    expect((await brandOf(B))?.logoPath).toBeNull();
  });

  it("ignores a logo path outside the workspace's own folder", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${B}/branding/logo.png` });
    const { brandOf } = await fresh();
    expect((await brandOf(A))?.logoPath).toBeNull();
  });
});

describe("the icon", () => {
  it("puts a dark logo on white, full square for a phone", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${A}/l.png`, updatedAt: "1" });
    store.set(`orgs/${A}/l.png`, await logo("#000972"));
    const { brandOf, iconPng } = await fresh();
    const png = await iconPng(await brandOf(A), 180, "apple");
    const corner = await pixel(png, 0, 0);
    expect([corner.w, corner.h]).toEqual([180, 180]);
    expect([corner.r, corner.g, corner.b, corner.a]).toEqual([255, 255, 255, 255]);
    const middle = await pixel(png, 90, 90);
    expect(middle.b).toBeGreaterThan(100);
    expect(middle.r).toBeLessThan(40);
  });

  it("puts a white logo on a dark square", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${A}/l.png`, updatedAt: "1" });
    store.set(`orgs/${A}/l.png`, await logo("#ffffff"));
    const { brandOf, iconPng } = await fresh();
    const corner = await pixel(await iconPng(await brandOf(A), 192, "mask"), 2, 2);
    expect(corner.r).toBeLessThan(40);
  });

  it("keeps a logo's own solid background", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${A}/l.png`, updatedAt: "1" });
    store.set(`orgs/${A}/l.png`, await logo("#ffffff", "#c8102e"));
    const { brandOf, iconPng } = await fresh();
    const corner = await pixel(await iconPng(await brandOf(A), 192, "mask"), 2, 2);
    expect([corner.r, corner.g, corner.b]).toEqual([0xc8, 0x10, 0x2e]);
  });

  it("rounds the corners of the plain install icon", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${A}/l.png`, updatedAt: "1" });
    store.set(`orgs/${A}/l.png`, await logo("#000972"));
    const { brandOf, iconPng } = await fresh();
    expect((await pixel(await iconPng(await brandOf(A), 192, "any"), 0, 0)).a).toBe(0);
  });

  it("draws the plain fallback when there is no logo, or it can't be read", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${A}/missing.png` });
    const { brandOf, iconPng } = await fresh();
    for (const b of [null, await brandOf(A)]) {
      const p = await pixel(await iconPng(b, 64, "apple"), 1, 1);
      expect([p.w, p.r, p.a]).toEqual([64, 0x16, 255]);
    }
  });

  it("plates the logo for a page, trimmed of its margin", async () => {
    orgs.push({ id: A, name: "Kern" });
    configs.set(A, { logoPath: `orgs/${A}/l.png`, updatedAt: "1" });
    store.set(`orgs/${A}/l.png`, await logo("#000972"));
    const { brandOf, logoPng } = await fresh();
    const bare = await pixel((await logoPng((await brandOf(A))!))!, 0, 0);
    expect(bare.w).toBeLessThan(80); // the 60 px disc, not the 200 px canvas
    const plated = await pixel((await logoPng((await brandOf(A))!, true))!, 0, 0);
    expect(plated.w).toBeGreaterThan(bare.w);
  });
});
