import { deflateSync } from "node:zlib";

/**
 * A small, exact INDEXED PNG encoder (colour type 3 + tRNS) for sprite atlases. The generated art is posterised, so an atlas page holds a few
 * hundred colours at most; a palette PNG of it is the same pixels in about half the bytes of the RGBA PNG a canvas writes. Returns null when an
 * image has more than 256 distinct RGBA values (the caller then keeps the RGBA encoding) — never lossy.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodeIndexedPng(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Buffer | null {
  const index = new Map<number, number>();
  const palette: number[] = [];
  const px = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] as number;
    // fully transparent pixels all share one entry, whatever their colour bytes
    const key = a === 0 ? 0 : (((rgba[i * 4] as number) << 24) | ((rgba[i * 4 + 1] as number) << 16) | ((rgba[i * 4 + 2] as number) << 8) | a) >>> 0;
    let k = index.get(key);
    if (k === undefined) {
      if (palette.length >= 256) return null;
      k = palette.length;
      index.set(key, k);
      palette.push(key);
    }
    px[i] = k;
  }
  // unfiltered rows: for palette images, deflate does best on the raw indices (filtering them only adds noise)
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    raw.set(px.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed colour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const plte = Buffer.alloc(palette.length * 3);
  const trns = Buffer.alloc(palette.length);
  palette.forEach((c, i) => {
    plte[i * 3] = (c >>> 24) & 0xff;
    plte[i * 3 + 1] = (c >>> 16) & 0xff;
    plte[i * 3 + 2] = (c >>> 8) & 0xff;
    trns[i] = c & 0xff;
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("tRNS", trns),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
