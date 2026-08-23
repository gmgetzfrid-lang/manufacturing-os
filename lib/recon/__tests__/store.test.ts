import { describe, expect, it } from "vitest";
import { packScene, unpackScene } from "../store";

describe("scene export file", () => {
  const manifest = { id: "scene-1", label: "Unit 100", pointCount: 3, nested: { a: [1, 2] } };
  const points = new Uint8Array([1, 2, 3, 250, 251, 252, 7, 8, 9]).buffer;

  it("round-trips a manifest and its payload", async () => {
    const back = await unpackScene(packScene(manifest, points));
    expect(back.manifest).toEqual(manifest);
    expect(new Uint8Array(back.points)).toEqual(new Uint8Array(points));
  });

  it("survives non-ASCII labels, whose UTF-8 length differs from the string length", async () => {
    const m = { label: "Área — cámara 1 · 3D" };
    const back = await unpackScene(packScene(m, points));
    expect(back.manifest).toEqual(m);
    expect(new Uint8Array(back.points)).toEqual(new Uint8Array(points));
  });

  it("rejects a file that is not a scene export", async () => {
    const junk = new Blob([new Uint8Array(64)]);
    await expect(unpackScene(junk)).rejects.toThrow(/not a 3D environment/);
  });

  it("rejects a future file version rather than misreading it", async () => {
    const good = new Uint8Array(await packScene(manifest, points).arrayBuffer());
    good[6] = 99; // version field, little-endian low byte
    await expect(unpackScene(new Blob([good]))).rejects.toThrow(/version 99/);
  });
});
