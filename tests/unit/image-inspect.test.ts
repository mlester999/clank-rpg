import { describe, expect, it } from "vitest";

import { AVATAR_MAX_BYTES, AVATAR_MAX_SIDE, inspectImage } from "@/domain/media/image";

import { EXE_HEADER, GIF_FILE, HTML_DOCUMENT, makeJpeg, makePng, makeWebp, SVG_WITH_SCRIPT } from "../support/images";

const problem = (r: ReturnType<typeof inspectImage>) => (r.ok ? null : r.problem);

describe("inspectImage — accepts real still images", () => {
  it("reads PNG type and dimensions from the bytes", () => {
    expect(inspectImage(makePng(200, 120))).toMatchObject({ ok: true, mime: "image/png", ext: "png", width: 200, height: 120 });
  });
  it("reads JPEG type and dimensions", () => {
    expect(inspectImage(makeJpeg(512, 512))).toMatchObject({ ok: true, mime: "image/jpeg", ext: "jpg", width: 512, height: 512 });
  });
  it("reads lossless WebP type and dimensions", () => {
    expect(inspectImage(makeWebp(256, 300))).toMatchObject({ ok: true, mime: "image/webp", ext: "webp", width: 256, height: 300 });
  });
});

describe("inspectImage — never trusts the declared type", () => {
  it("rejects a PNG that claims to be JPEG (and the reverse)", () => {
    expect(problem(inspectImage(makePng(), { declaredMime: "image/jpeg" }))).toBe("MIME_MISMATCH");
    expect(problem(inspectImage(makeJpeg(), { declaredMime: "image/png" }))).toBe("MIME_MISMATCH");
  });
  it("accepts a matching declared type (with parameters / the jpg alias) and a generic octet-stream", () => {
    expect(inspectImage(makePng(), { declaredMime: "image/png; charset=binary" }).ok).toBe(true);
    expect(inspectImage(makeJpeg(), { declaredMime: "image/jpg" }).ok).toBe(true);
    expect(inspectImage(makeWebp(), { declaredMime: "application/octet-stream" }).ok).toBe(true);
  });
  it("rejects an HTML/SVG/EXE/GIF payload even when it is labelled image/png", () => {
    for (const bad of [HTML_DOCUMENT, SVG_WITH_SCRIPT, EXE_HEADER, GIF_FILE]) {
      expect(problem(inspectImage(bad, { declaredMime: "image/png" }))).toBe("UNSUPPORTED_TYPE");
    }
  });
});

describe("inspectImage — rejects damaged, padded and hostile files", () => {
  it("rejects empty input and oversized input", () => {
    expect(problem(inspectImage(new Uint8Array()))).toBe("EMPTY");
    expect(problem(inspectImage(Buffer.concat([makePng(), Buffer.alloc(AVATAR_MAX_BYTES)])))).toBe("TOO_LARGE");
  });
  it("rejects a truncated PNG", () => {
    const png = makePng();
    expect(problem(inspectImage(png.subarray(0, png.length - 20)))).toBe("CORRUPT");
  });
  it("rejects data smuggled behind a valid image (polyglot)", () => {
    expect(problem(inspectImage(Buffer.concat([makePng(), HTML_DOCUMENT])))).toBe("CORRUPT");
    expect(problem(inspectImage(Buffer.concat([makeJpeg(), HTML_DOCUMENT])))).toBe("CORRUPT");
    expect(problem(inspectImage(Buffer.concat([makeWebp(), HTML_DOCUMENT])))).toBe("CORRUPT");
  });
  it("rejects a JPEG header with no frame or scan", () => {
    expect(problem(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9])))).toBe("CORRUPT");
  });
  it("rejects animated PNG and animated WebP", () => {
    const png = makePng();
    const idat = png.indexOf("IDAT") - 4;
    const actl = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("acTL"), Buffer.alloc(8), Buffer.alloc(4)]);
    expect(problem(inspectImage(Buffer.concat([png.subarray(0, idat), actl, png.subarray(idat)])))).toBe("ANIMATED");
    expect(problem(inspectImage(makeWebp(128, 128, { animated: true })))).toBe("ANIMATED");
  });
  it("enforces a sensible pixel range", () => {
    expect(problem(inspectImage(makePng(32, 32)))).toBe("TOO_SMALL");
    expect(problem(inspectImage(makePng(AVATAR_MAX_SIDE + 1, 100)))).toBe("DIMENSIONS_TOO_LARGE");
  });
});
